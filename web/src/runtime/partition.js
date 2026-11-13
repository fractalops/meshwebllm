import proto from "onnx-proto";
const { onnx } = proto;
export const CHUNK_BYTES = 1024 * 1024;
export const SOURCE = {
  url: "https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/resolve/12fd25f77366fa6b3b4b768ec3050bf629380bac/onnx/model_q4.onnx",
  repo: "HuggingFaceTB/SmolLM2-135M-Instruct",
  revision: "12fd25f77366fa6b3b4b768ec3050bf629380bac",
  sha256: "933577110303a2964096d19b6f15d3b4639bef7f99481ac0b61d9f3ad72f392a",
};
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Runs in the seeding browser, starting from the original, unsplit ONNX artifact.
// The published graph has no weights; every TensorProto is independently addressable.
export async function publishModel(bytes, config, put, progress = () => {}) {
  if ((await sha256(bytes)) !== SOURCE.sha256)
    throw new Error("Unexpected source model SHA-256");
  const model = onnx.ModelProto.decode(bytes);
  if (config.num_hidden_layers !== 30 || config.hidden_size !== 576)
    throw new Error("Only the tested SmolLM2 export is supported");
  const tensors = [];
  let total = 0;
  for (const tensor of model.graph.initializer) {
    const encoded = onnx.TensorProto.encode(tensor).finish();
    const chunks = [];
    for (let offset = 0; offset < encoded.length; offset += CHUNK_BYTES) {
      const slice = encoded.subarray(offset, offset + CHUNK_BYTES);
      chunks.push({ hash: await put(slice), bytes: slice.length });
    }
    tensors.push({ name: tensor.name, bytes: encoded.length, chunks });
    total += encoded.length;
    progress({ tensors: tensors.length, bytes: total });
  }
  model.graph.initializer = [];
  const graph = onnx.ModelProto.encode(model).finish();
  return {
    version: 1,
    source: SOURCE,
    config,
    graph: { hash: await put(graph), bytes: graph.length },
    tensors,
  };
}

// Graph reachability, rather than file slicing, defines a valid stage.
export function planStage(graphBytes, manifest, role, split = 15) {
  if (
    !["first", "second"].includes(role) ||
    !Number.isInteger(split) ||
    split < 1 ||
    split >= 30
  )
    throw new Error("Invalid stage assignment");
  validateManifest(manifest);
  const model = onnx.ModelProto.decode(graphBytes),
    graph = model.graph;
  if (graph.initializer.length)
    throw new Error("Graph metadata unexpectedly contains weights");
  const boundary = [
    `/model/layers.${split - 1}/post_attention_layernorm/output_3`,
    `/model/layers.${split - 1}/mlp/down_proj/MatMul/output_0`,
  ];
  const originals = new Map(graph.input.map((v) => [v.name, v]));
  const info = new Map(
    [...graph.valueInfo, ...graph.input, ...graph.output].map((v) => [
      v.name,
      v,
    ]),
  );
  for (const name of boundary)
    if (!info.has(name))
      info.set(
        name,
        onnx.ValueInfoProto.fromObject({
          name,
          type: {
            tensorType: {
              elemType: 1,
              shape: {
                dim: [
                  { dimParam: "batch_size" },
                  { dimParam: "sequence_length" },
                  { dimValue: 576 },
                ],
              },
            },
          },
        }),
      );
  const weights = new Map(manifest.tensors.map((t) => [t.name, t]));
  const producer = new Map();
  for (const node of graph.node)
    for (const output of node.output) if (output) producer.set(output, node);
  if (!boundary.every((n) => producer.has(n)))
    throw new Error("Unsupported graph boundary");
  const neededNodes = new Set(),
    neededWeights = new Set(),
    neededInputs = new Set(),
    visiting = new Set();
  function visit(name) {
    if (!name) return;
    if (role === "second" && boundary.includes(name)) {
      neededInputs.add(name);
      return;
    }
    if (weights.has(name)) {
      neededWeights.add(name);
      return;
    }
    if (originals.has(name)) {
      neededInputs.add(name);
      return;
    }
    const node = producer.get(name);
    if (!node) throw new Error(`Unresolved tensor: ${name}`);
    if (neededNodes.has(node)) return;
    if (visiting.has(node)) throw new Error("Cyclic graph");
    visiting.add(node);
    for (const input of node.input) visit(input);
    visiting.delete(node);
    neededNodes.add(node);
  }
  const owns = (n) => (role === "first" ? n < split : n >= split);
  const outputs = [
    ...(role === "first" ? boundary : ["logits"]),
    ...graph.output
      .filter(
        (v) =>
          v.name.startsWith("present.") && owns(Number(v.name.split(".")[1])),
      )
      .map((v) => v.name),
  ];
  outputs.forEach(visit);
  const layers = [
    ...new Set(
      [...neededWeights]
        .map((n) => /layers\.(\d+)\./.exec(n))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .filter((n) => n < 30),
    ),
  ].sort((a, b) => a - b);
  const expected = Array.from(
    { length: role === "first" ? split : 30 - split },
    (_, i) => i + (role === "first" ? 0 : split),
  );
  if (JSON.stringify(layers) !== JSON.stringify(expected))
    throw new Error(`Stage contains incorrect layer weights: ${layers}`);
  for (const name of neededInputs)
    if (
      name.startsWith("past_key_values.") &&
      !owns(Number(name.split(".")[1]))
    )
      throw new Error("Stage requires another stage’s cache");
  graph.node = graph.node.filter((n) => neededNodes.has(n));
  graph.input = [...neededInputs].map((n) => info.get(n));
  graph.output = outputs.map((n) => info.get(n));
  const values = new Set([
    ...neededInputs,
    ...outputs,
    ...graph.node.flatMap((n) => n.output),
  ]);
  graph.valueInfo = graph.valueInfo.filter((v) => values.has(v.name));
  graph.name = `libgrid-${role}-${split}`;
  if (role === "second") lastPositionLogits(model);
  return {
    model,
    role,
    split,
    layers,
    inputs: graph.input.map((v) => v.name),
    outputs,
    tensors: manifest.tensors.filter((t) => neededWeights.has(t.name)),
  };
}

export async function assembleStage(plan, get, progress = () => {}) {
  let bytes = 0,
    count = 0;
  for (const tensor of plan.tensors) {
    const data = new Uint8Array(tensor.bytes);
    let offset = 0;
    for (const chunk of tensor.chunks) {
      const part = await get(chunk);
      if (part.length !== chunk.bytes)
        throw new Error("Truncated weight chunk");
      data.set(part, offset);
      offset += part.length;
    }
    if (offset !== tensor.bytes) throw new Error("Tensor byte count mismatch");
    const decoded = onnx.TensorProto.decode(data);
    if (decoded.name !== tensor.name)
      throw new Error("Tensor identity mismatch");
    plan.model.graph.initializer.push(decoded);
    bytes += data.length;
    count++;
    progress({ bytes, tensors: count, totalTensors: plan.tensors.length });
  }
  const output = onnx.ModelProto.encode(plan.model).finish();
  return output;
}

const LM_HEAD_INPUT = "/model/layers.30/final_norm_layernorm/output_0";
const LAST_POSITION = "/meshwebllm/last_position/output_0";

/**
 * Computes `logits` for the last input position only. Generation reads only
 * that row, but the published export runs the output head over every prompt
 * token and returns `[1, n, vocab]`. A 900-token prompt then allocates and
 * reads back about 177 MB. Applies to whole models and to the final stage.
 */
export function lastPositionLogits(model) {
  const graph = model.graph;
  const head = graph.node.find((n) => n.output[0] === "logits");
  if (
    !head ||
    head.opType !== "MatMul" ||
    head.input[0] !== LM_HEAD_INPUT ||
    graph.node.some((n) => n.output.includes(LAST_POSITION))
  )
    throw new Error("Unsupported output head");
  const int64 = (name, value) =>
    onnx.TensorProto.fromObject({
      name,
      dataType: onnx.TensorProto.DataType.INT64,
      dims: [1],
      int64Data: [value],
    });
  // Slice along the sequence axis from -1 to the end. Constants are nodes, not
  // initializers, so content-addressed weight manifests are unchanged.
  const constant = (name, value) =>
    onnx.NodeProto.fromObject({
      opType: "Constant",
      name: `${name}/Constant`,
      output: [name],
      attribute: [
        {
          name: "value",
          type: onnx.AttributeProto.AttributeType.TENSOR,
          t: int64(name, value),
        },
      ],
    });
  const names = ["starts", "ends", "axes"].map(
    (n) => `/meshwebllm/last_position/${n}`,
  );
  const slice = onnx.NodeProto.fromObject({
    opType: "Slice",
    name: "/meshwebllm/last_position/Slice",
    input: [LM_HEAD_INPUT, ...names],
    output: [LAST_POSITION],
  });
  const at = graph.node.indexOf(head);
  graph.node.splice(
    at,
    0,
    constant(names[0], -1),
    constant(names[1], Number.MAX_SAFE_INTEGER),
    constant(names[2], 1),
    slice,
  );
  head.input[0] = LAST_POSITION;
  const logits = graph.output.find((v) => v.name === "logits");
  const dims = logits?.type?.tensorType?.shape?.dim;
  if (dims?.length === 3)
    dims[1] = onnx.TensorShapeProto.Dimension.fromObject({ dimValue: 1 });
  return model;
}

/** The verified whole model, re-encoded to return only the last logits row. */
export function wholeModel(bytes) {
  return onnx.ModelProto.encode(
    lastPositionLogits(onnx.ModelProto.decode(bytes)),
  ).finish();
}

// Validate the invitation's metadata before allocating buffers or walking a graph.
export function validateManifest(m) {
  const validChunk = (c) =>
    c &&
    /^[0-9a-f]{64}$/.test(c.hash) &&
    Number.isSafeInteger(c.bytes) &&
    c.bytes > 0 &&
    c.bytes <= CHUNK_BYTES;
  if (
    m?.version !== 1 ||
    m.source?.sha256 !== SOURCE.sha256 ||
    m.source?.revision !== SOURCE.revision ||
    m.config?.hidden_size !== 576 ||
    m.config?.num_hidden_layers !== 30 ||
    m.config?.num_attention_heads !== 9 ||
    m.config?.num_key_value_heads !== 3 ||
    m.config?.vocab_size !== 49152 ||
    !validChunk(m.graph) ||
    !Array.isArray(m.tensors) ||
    m.tensors.length !== 486
  )
    throw new Error("Unsupported or invalid model manifest");
  let total = 0;
  const names = new Set();
  for (const t of m.tensors) {
    if (
      typeof t.name !== "string" ||
      t.name.length > 512 ||
      names.has(t.name) ||
      !Number.isSafeInteger(t.bytes) ||
      t.bytes < 1 ||
      t.bytes > 120_000_000 ||
      !Array.isArray(t.chunks) ||
      t.chunks.length < 1 ||
      t.chunks.length > 120 ||
      !t.chunks.every(validChunk) ||
      t.chunks.reduce((n, c) => n + c.bytes, 0) !== t.bytes
    )
      throw new Error("Invalid tensor manifest");
    names.add(t.name);
    total += t.bytes;
  }
  if (total !== 181867580) throw new Error("Unexpected model weight size");
}
