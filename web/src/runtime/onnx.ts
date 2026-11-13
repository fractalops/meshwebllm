import { Tokenizer } from "@huggingface/tokenizers";
import { SMOL_ID } from "../config";
import { loadSource, sourceFile } from "./assets";
import { wholeModel } from "./partition.js";
import { GpuSession } from "./gpu";
import { generateText, selectToken } from "./generation";
import { ModelStore } from "./store";
import type { Runtime, RuntimeOptions } from "./types";
export async function loadTokenizer(
  store: ModelStore,
  options: RuntimeOptions,
): Promise<Tokenizer> {
  const parse = (bytes: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(bytes));
  const json = parse(await sourceFile("tokenizer.json", store, options));
  const config = parse(
    await sourceFile("tokenizer_config.json", store, options),
  );
  return new Tokenizer(json, config);
}
export async function createOnnx(options: RuntimeOptions): Promise<Runtime> {
  const store = await ModelStore.open(),
    gpu = new GpuSession();
  const abort = () => gpu.dispose();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const { bytes, config } = await loadSource(store, options);
    const tokenizer = await loadTokenizer(store, options);
    options.progress({ phase: "preparing", message: "Preparing your GPU" });
    await gpu.init(
      "baseline",
      config,
      [
        "logits",
        ...Array.from({ length: 30 }, (_, i) => [
          `present.${i}.key`,
          `present.${i}.value`,
        ]).flat(),
      ],
      wholeModel(bytes),
    );
    options.signal.throwIfAborted();
    options.signal.removeEventListener("abort", abort);
    let active = false;
    return {
      async generate(request, signal, chunk) {
        if (active) throw new Error("This GPU is already generating.");
        active = true;
        try {
          await gpu.reset();
          return await generateText(
            tokenizer,
            SMOL_ID,
            request,
            signal,
            async (tokens, temperature) => {
              const r = await gpu.forward(tokens);
              if (!r.logits || !r.gpuDispatches || r.cacheTensors !== 60)
                throw new Error("GPU inference failed.");
              return selectToken(r.logits, temperature);
            },
            chunk,
          );
        } finally {
          await gpu.reset().catch(() => {});
          active = false;
        }
      },
      async dispose() {
        gpu.dispose();
      },
    };
  } catch (error) {
    gpu.dispose();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    store.close();
  }
}
