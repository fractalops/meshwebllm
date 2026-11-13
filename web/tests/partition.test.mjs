import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import proto from "onnx-proto";
import {
  publishModel,
  planStage,
  assembleStage,
  sha256,
  CHUNK_BYTES,
  lastPositionLogits,
} from "../src/runtime/partition.js";
import * as ort from "onnxruntime-web";

ort.env.wasm.numThreads = 1;
const LM_HEAD_INPUT = "/model/layers.30/final_norm_layernorm/output_0";
// The pinned export's output head, reduced to hidden size 4 and vocabulary 3.
function tinyHead() {
  const { onnx } = proto;
  const value = (name, dims) =>
    onnx.ValueInfoProto.fromObject({
      name,
      type: {
        tensorType: {
          elemType: 1,
          shape: {
            dim: dims.map((d) =>
              typeof d === "number" ? { dimValue: d } : { dimParam: d },
            ),
          },
        },
      },
    });
  return onnx.ModelProto.fromObject({
    irVersion: 8,
    opsetImport: [{ domain: "", version: 14 }],
    graph: {
      name: "head",
      node: [
        {
          opType: "MatMul",
          name: "/lm_head/MatMul",
          input: [LM_HEAD_INPUT, "w"],
          output: ["logits"],
        },
      ],
      initializer: [
        {
          name: "w",
          dataType: 1,
          dims: [4, 3],
          floatData: [1, 0, 2, 0, 1, -1, 3, 1, 0, -2, 0.5, 1],
        },
      ],
      input: [value(LM_HEAD_INPUT, [1, "sequence_length", 4])],
      output: [value("logits", [1, "sequence_length", 3])],
    },
  });
}
test("output head returns only the last logits row, unchanged", async () => {
  const { onnx } = proto;
  const original = onnx.ModelProto.encode(tinyHead()).finish();
  const sliced = onnx.ModelProto.encode(lastPositionLogits(tinyHead())).finish();
  const hidden = Float32Array.from({ length: 5 * 4 }, (_, i) => Math.sin(i) * 3);
  const run = async (bytes) => {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
    });
    const out = await session.run({
      [LM_HEAD_INPUT]: new ort.Tensor("float32", hidden, [1, 5, 4]),
    });
    await session.release();
    return out.logits;
  };
  const full = await run(original),
    last = await run(sliced);
  assert.deepEqual(full.dims, [1, 5, 3]);
  assert.deepEqual(last.dims, [1, 1, 3]);
  assert.deepEqual([...last.data], [...full.data.slice(-3)]);
  const twice = lastPositionLogits(tinyHead());
  assert.throws(() => lastPositionLogits(twice), /Unsupported output head/);
  const other = tinyHead();
  other.graph.node[0].input[0] = "other";
  assert.throws(() => lastPositionLogits(other), /Unsupported output head/);
});

// The fixture store uses SHA-256 only to exercise graph/chunk logic in Node.
// Browser integration uses actual iroh-blobs BLAKE3 hashes and verified streams.
test("partition the pinned original model by graph dependencies", async (t) => {
  let source, config;
  try {
    source = await readFile(
      new URL(
        "../../experiments/layer-split/artifacts/source/onnx/model_q4.onnx",
        import.meta.url,
      ),
    );
    config = JSON.parse(
      await readFile(
        new URL(
          "../../experiments/layer-split/artifacts/source/config.json",
          import.meta.url,
        ),
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return t.skip(
        "Run setup-browser.sh to download the pinned model fixture",
      );
    throw error;
  }
  const store = new Map();
  const manifest = await publishModel(source, config, async (bytes) => {
    const hash = await sha256(bytes);
    store.set(hash, bytes.slice());
    return hash;
  });
  const graph = store.get(manifest.graph.hash);
  assert.equal(proto.onnx.ModelProto.decode(graph).graph.initializer.length, 0);
  assert.ok(
    manifest.tensors
      .flatMap((x) => x.chunks)
      .every((c) => c.bytes <= CHUNK_BYTES),
  );
  for (const split of [1, 15, 29]) {
    const first = planStage(graph, manifest, "first", split);
    const second = planStage(graph, manifest, "second", split);
    assert.deepEqual(
      [...first.layers, ...second.layers],
      Array.from({ length: 30 }, (_, i) => i),
    );
    const firstNames = new Set(first.tensors.map((x) => x.name));
    assert.ok(
      second.tensors
        .filter((x) => /layers\.\d+\./.test(x.name))
        .every((x) => !firstNames.has(x.name)),
    );
    assert.equal(
      first.outputs.filter((x) => x.startsWith("present.")).length,
      split * 2,
    );
    assert.equal(
      second.outputs.filter((x) => x.startsWith("present.")).length,
      (30 - split) * 2,
    );
    const heads = second.model.graph.node.filter((n) => n.opType === "Slice");
    assert.equal(heads.length, 1, "the final stage slices before its head");
    assert.equal(
      Number(
        second.model.graph.output.find((v) => v.name === "logits").type
          .tensorType.shape.dim[1].dimValue,
      ),
      1,
    );
    if (split === 15) {
      for (const plan of [first, second]) {
        const encoded = await assembleStage(plan, async (c) =>
          store.get(c.hash),
        );
        const rebuilt = proto.onnx.ModelProto.decode(encoded);
        assert.deepEqual(
          rebuilt.graph.initializer.map((x) => x.name),
          plan.tensors.map((x) => x.name),
        );
        assert.ok(encoded.length < source.length);
      }
    }
  }
  assert.throws(() => planStage(graph, manifest, "first", 0), /Invalid stage/);
  const missing = {
    ...manifest,
    tensors: manifest.tensors.filter((x) => !x.name.includes("layers.0.")),
  };
  assert.throws(
    () => planStage(graph, missing, "first"),
    /invalid model manifest/,
  );
  await assert.rejects(
    () => publishModel(new Uint8Array([1, 2, 3]), config, () => {}),
    /SHA-256/,
  );
  const plan = planStage(graph, manifest, "first");
  await assert.rejects(
    () => assembleStage(plan, async () => new Uint8Array()),
    /Truncated/,
  );
});
