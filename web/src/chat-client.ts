import type { CompletionRequest, Member } from "./types.ts";

export interface Completion {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}
export type ChatFrame =
  | { Chunk: { text: string } }
  | { Done: Completion }
  | { Error: { code: string; message: string } };
export interface ChatNode {
  complete(
    worker: string,
    request: CompletionRequest,
  ): Promise<ReadableStream<ChatFrame>>;
}

/** Use only workers that can accept this model; prefer idle, then short queues. */
export function chatCandidates(
  members: Member[],
  model: string,
  target = "",
): Member[] {
  return members
    .filter(
      (m) =>
        !m.stale &&
        m.info.model === model &&
        (!target || m.id === target) &&
        (m.info.state === "idle" || m.info.state === "busy") &&
        m.info.waiting < 2,
    )
    .sort(
      (a, b) =>
        Number(a.info.state === "busy") - Number(b.info.state === "busy") ||
        a.info.waiting - b.info.waiting ||
        b.info.tokensPerSec - a.info.tokensPerSec,
    );
}

/** Retry another worker only before it has sent text, as the CLI does. */
export async function completeChat(
  node: ChatNode,
  candidates: Member[],
  request: CompletionRequest,
  signal: AbortSignal,
  onWorker: (id: string) => void,
  onChunk: (text: string) => void,
): Promise<Completion> {
  let lastError = new Error(
    "No worker is ready. Contribute a GPU or wait for one to join.",
  );
  for (const member of candidates.slice(0, 3)) {
    signal.throwIfAborted();
    onWorker(member.id);
    let reader: ReadableStreamDefaultReader<ChatFrame> | undefined;
    let receivedText = false;
    let retryable = true;
    const cancel = () => {
      void reader?.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const connecting = node.complete(member.id, request);
      const stream = await new Promise<ReadableStream<ChatFrame>>(
        (resolve, reject) => {
          const aborted = () =>
            reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
          signal.addEventListener("abort", aborted, { once: true });
          connecting.then(
            (value) => {
              signal.removeEventListener("abort", aborted);
              if (signal.aborted) {
                void value.cancel().catch(() => {});
                aborted();
              } else resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", aborted);
              reject(error);
            },
          );
          if (signal.aborted) aborted();
        },
      );
      if (signal.aborted) {
        await stream.cancel();
        signal.throwIfAborted();
      }
      reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done)
          throw new Error("The worker disconnected before the reply finished.");
        if ("Chunk" in value) {
          if (value.Chunk.text) {
            receivedText = true;
            onChunk(value.Chunk.text);
          }
        } else if ("Done" in value) {
          return value.Done;
        } else if ("Error" in value) {
          retryable =
            value.Error.code === "Busy" || value.Error.code === "Paused";
          throw new Error(value.Error.message);
        }
      }
    } catch (err) {
      signal.throwIfAborted();
      lastError = err instanceof Error ? err : new Error(String(err));
      if (receivedText || !retryable) throw lastError;
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
  throw lastError;
}
