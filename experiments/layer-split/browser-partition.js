import proto from "onnx-proto";
const { onnx } = proto;
export const CHUNK_BYTES = 1024 * 1024;
export const SOURCE = {
  url: "/artifacts/source/onnx/model_q4.onnx",
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
