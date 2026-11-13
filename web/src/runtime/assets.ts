import { SOURCE, sha256 } from "./partition.js";
import { ModelStore } from "./store";
import type { ModelConfig, RuntimeOptions } from "./types";
const ROOT = `https://huggingface.co/${SOURCE.repo}/resolve/${SOURCE.revision}/`;
const MAX_BYTES = 190_000_000;
export async function sourceFile(
  path: string,
  store: ModelStore,
  options: RuntimeOptions,
): Promise<Uint8Array> {
  options.signal.throwIfAborted();
  const key = `source:${SOURCE.revision}:${path}`,
    cached = await store.read(key);
  if (
    cached &&
    (path !== "onnx/model_q4.onnx" || (await sha256(cached)) === SOURCE.sha256)
  )
    return cached;
  // A local mirror is useful for reproducible browser QA; never selected in production.
  const base =
    import.meta.env.DEV &&
    new URLSearchParams(location.search).has("local-model")
      ? `${import.meta.env.BASE_URL}model-fixture/`
      : ROOT;
  const response = await fetch(new URL(path, new URL(base, location.href)), {
    signal: options.signal,
  });
  if (!response.ok || !response.body)
    throw new Error(
      `Model download failed (HTTP ${response.status}). Try again; cached weights are kept.`,
    );
  // Content-Length can describe compressed HTTP bytes, not the decoded stream.
  const expected = path === "onnx/model_q4.onnx" ? 182068553 : 0;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      loaded += value.length;
      if (loaded > MAX_BYTES || (expected && loaded > expected))
        throw new Error("Unexpected model file size.");
      parts.push(value);
      options.progress({
        phase: "downloading",
        message: `Downloading ${path === "onnx/model_q4.onnx" ? "model weights" : "model vocabulary"}`,
        loaded,
        total: expected || undefined,
      });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (expected && loaded !== expected)
    throw new Error("Model download was interrupted. Try again.");
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  if (path === "onnx/model_q4.onnx" && (await sha256(bytes)) !== SOURCE.sha256)
    throw new Error("Model checksum does not match the published revision.");
  await store.write(key, bytes);
  return bytes;
}
export async function loadSource(store: ModelStore, options: RuntimeOptions) {
  const bytes = await sourceFile("onnx/model_q4.onnx", store, options);
  const config = JSON.parse(
    new TextDecoder().decode(await sourceFile("config.json", store, options)),
  ) as ModelConfig;
  return { bytes, config };
}
