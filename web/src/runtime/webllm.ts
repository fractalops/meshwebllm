import { CreateWebWorkerMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import { withAbort } from "./abort";
import { cacheModelWeights } from "../model-cache";
import type { Runtime, RuntimeOptions } from "./types";
export async function createWebLlm(
  modelId: string,
  options: RuntimeOptions,
): Promise<Runtime> {
  const model = prebuiltAppConfig.model_list.find(
    (m) => m.model_id === modelId,
  );
  if (!model) throw new Error("Unknown model.");
  await cacheModelWeights(
    model.model,
    ({ loaded, total }) =>
      options.progress({
        phase: "downloading",
        message: "Downloading model weights",
        loaded,
        total,
      }),
    options.signal,
  );
  options.signal.throwIfAborted();
  const worker = new Worker(new URL("../llm-worker.ts", import.meta.url), {
    type: "module",
  });
  const closed = new AbortController();
  const abort = () => {
    closed.abort();
    worker.terminate();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const engine = await withAbort(
      CreateWebWorkerMLCEngine(worker, modelId, {
        initProgressCallback: (p) =>
          options.progress({ phase: "preparing", message: p.text }),
      }),
      options.signal,
    );
    options.signal.throwIfAborted();
    let active = false;
    return {
      async generate(request, signal, chunk) {
        if (active) throw new Error("This GPU is already generating.");
        active = true;
        signal = AbortSignal.any([signal, closed.signal]);
        const interrupt = () => {
          void engine.interruptGenerate();
        };
        signal.addEventListener("abort", interrupt, { once: true });
        let closeStream: (() => Promise<unknown>) | undefined;
        try {
          signal.throwIfAborted();
          let prompt = 0,
            completion = 0;
          const stream = await withAbort(
            engine.chat.completions.create({
              messages: request.messages.map((m) => ({
                role: m.role.toLowerCase() as "user" | "assistant" | "system",
                content: m.content,
              })),
              max_tokens: Math.min(request.max_tokens ?? 256, 512),
              temperature: request.temperature ?? 0.7,
              stream: true,
              stream_options: { include_usage: true },
            }),
            closed.signal,
          );
          const iterator = stream[Symbol.asyncIterator]();
          closeStream = () => iterator.return?.() ?? Promise.resolve();
          for (;;) {
            const { value: frame, done } = await withAbort(
              iterator.next(),
              signal,
            );
            if (done) break;
            signal.throwIfAborted();
            const text = frame.choices[0]?.delta?.content;
            if (text) await chunk(text);
            if (frame.usage) {
              prompt = frame.usage.prompt_tokens;
              completion = frame.usage.completion_tokens;
            }
          }
          return {
            model: modelId,
            prompt_tokens: prompt,
            completion_tokens: completion,
          };
        } finally {
          signal.removeEventListener("abort", interrupt);
          engine.interruptGenerate();
          // Close the worker-side iterator before accepting another generation.
          // Disposal also cancels this cleanup if the worker has been terminated.
          if (closeStream)
            await withAbort(closeStream(), closed.signal).catch(() => {});
          active = false;
        }
      },
      async dispose() {
        closed.abort();
        worker.terminate();
      },
    };
  } catch (error) {
    worker.terminate();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
  }
}
