import * as ort from "onnxruntime-web/webgpu";

ort.env.wasm.numThreads = 1;
import ortWasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
ort.env.wasm.wasmPaths = { wasm: ortWasmUrl };
let session,
  spec,
  config,
  cache = {},
  pastLength = 0;
let gpuDispatches = 0;
// Count real WebGPU compute commands; timestamp-query profiling is optional on browsers.
const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...args) {
  gpuDispatches++;
  return dispatch.apply(this, args);
};

function reset() {
  for (const t of Object.values(cache)) t.dispose();
  cache = {};
  pastLength = 0;
}

async function init({ role, manifest, modelBytes }) {
  config = manifest.config;
  spec = manifest.models[role];
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter || adapter.info.isFallbackAdapter)
    throw new Error("A physical WebGPU adapter is required");
  ort.env.webgpu.adapter = adapter;
  const locations = Object.fromEntries(
    spec.outputs
      .filter((n) => n.startsWith("present."))
      .map((n) => [n, "gpu-buffer"]),
  );
  session = await ort.InferenceSession.create(modelBytes ?? spec.url, {
    executionProviders: ["webgpu"],
    preferredOutputLocation: locations,
    graphOptimizationLevel: "all",
  });
  return {
    role,
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      description: adapter.info.description,
    },
    inputs: session.inputNames,
    outputs: session.outputNames,
  };
}

async function run({ tokens, tensors = {} }) {
  const feeds = {};
  const length = tokens.length;
  if (length < 1 || pastLength + length > 1024)
    throw new Error("Stage context limit exceeded.");
  for (const name of session.inputNames) {
    if (name === "input_ids")
      feeds[name] = new ort.Tensor(
        "int64",
        BigInt64Array.from(tokens, BigInt),
        [1, length],
      );
    else if (name === "attention_mask")
      feeds[name] = new ort.Tensor(
        "int64",
        new BigInt64Array(pastLength + length).fill(1n),
        [1, pastLength + length],
      );
    else if (name === "position_ids")
      feeds[name] = new ort.Tensor(
        "int64",
        BigInt64Array.from(tokens, (_, i) => BigInt(pastLength + i)),
        [1, length],
      );
    else if (name.startsWith("past_key_values."))
      feeds[name] =
        cache[name] ??
        new ort.Tensor("float32", new Float32Array(), [
          1,
          config.num_key_value_heads,
          0,
          config.hidden_size / config.num_attention_heads,
        ]);
    else if (tensors[name])
      feeds[name] = new ort.Tensor(
        tensors[name].type,
        tensors[name].data,
        tensors[name].dims,
      );
    else throw new Error(`Missing input ${name}`);
  }
  const dispatchStart = gpuDispatches;
  const start = performance.now();
  const output = await session.run(feeds);
  const runMs = performance.now() - start;
  const boundary = {};
  let logits;
  const readStart = performance.now();
  for (const [name, value] of Object.entries(output)) {
    if (name.startsWith("present.")) {
      const input = name.replace("present.", "past_key_values.");
      if (value.location !== "gpu-buffer")
        throw new Error(`KV cache left GPU: ${name} (${value.location})`);
      cache[input]?.dispose();
      cache[input] = value;
    } else {
      const data = await value.getData();
      if (name === "logits") logits = data.slice(-config.vocab_size);
      else
        boundary[name] = {
          type: value.type,
          dims: value.dims,
          data: data.slice(),
        };
      value.dispose();
    }
  }
  // Only CPU-owned input tensors are disposed; cached GPU inputs were released above.
  for (const [name, value] of Object.entries(feeds))
    if (!name.startsWith("past_key_values.")) value.dispose();
  pastLength += length;
  return {
    logits,
    tensors: boundary,
    runMs,
    readbackMs: performance.now() - readStart,
    gpuDispatches: gpuDispatches - dispatchStart,
    cacheTensors: Object.keys(cache).length,
    pastLength,
  };
}

self.onmessage = async ({ data: { id, method, args } }) => {
  try {
    const result =
      method === "init"
        ? await init(args)
        : method === "run"
          ? await run(args)
          : method === "reset"
            ? reset()
            : method === "dispose"
              ? (reset(), await session?.release())
              : (() => {
                  throw new Error("Unknown worker method");
                })();
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e.stack || String(e) });
  }
};
