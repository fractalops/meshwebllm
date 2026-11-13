import { Tokenizer } from "@huggingface/tokenizers";
import type { ChatMessage, CompletionRequest } from "../types.ts";
import type { Completion } from "./types.ts";
export const CONTEXT_LIMIT = 1024;
/** The pinned SmolLM2 chat template. Roles are data, not arbitrary template input. */
export function formatChat(messages: ChatMessage[]): string {
  if (!messages.length || messages.length > 64)
    throw new Error("Use between 1 and 64 messages.");
  const defaultSystem = {
    role: "System",
    content:
      "You are a helpful AI assistant named SmolLM, trained by Hugging Face",
  };
  const list =
    messages[0].role === "System" ? messages : [defaultSystem, ...messages];
  return (
    list
      .map((m) => {
        if (
          !["System", "User", "Assistant"].includes(m.role) ||
          typeof m.content !== "string" ||
          m.content.length > 16000
        )
          throw new Error("Invalid chat message.");
        return `<|im_start|>${m.role.toLowerCase()}\n${m.content}<|im_end|>\n`;
      })
      .join("") + "<|im_start|>assistant\n"
  );
}
export function selectToken(
  logits: Float32Array,
  temperature: number,
  random = () => Math.random(),
): number {
  let best = 0;
  for (let i = 0; i < logits.length; i++) {
    if (!Number.isFinite(logits[i]))
      throw new Error("The model returned invalid logits.");
    if (logits[i] > logits[best]) best = i;
  }
  if (temperature === 0) return best;
  // Top-k sampling bounds the tail; temperature is applied in log-space.
  const top = Array.from(logits, (score, id) => ({ score, id }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
  const weights = top.map((t) =>
    Math.exp((t.score - top[0].score) / temperature),
  );
  let n = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < top.length; i++) {
    n -= weights[i];
    if (n <= 0) return top[i].id;
  }
  return top.at(-1)!.id;
}
/** Validate before starting either GPU stage so a bad request cannot disable a team. */
export function prepareGeneration(
  tokenizer: Tokenizer,
  request: CompletionRequest,
) {
  const tokens = tokenizer.encode(formatChat(request.messages), {
    add_special_tokens: false,
  }).ids;
  const max = request.max_tokens ?? 256,
    temperature = request.temperature ?? 0.7;
  if (!Number.isInteger(max) || max < 1 || max > 512)
    throw new Error("Choose between 1 and 512 output tokens.");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    throw new Error("Temperature must be between 0 and 2.");
  if (tokens.length + max > CONTEXT_LIMIT)
    throw new Error(
      "This preview supports 1,024 tokens including the reply. Start a new chat or use a shorter prompt.",
    );
  return { tokens, max, temperature };
}
export async function generateText(
  tokenizer: Tokenizer,
  model: string,
  request: CompletionRequest,
  signal: AbortSignal,
  forward: (tokens: number[], temperature: number) => Promise<number>,
  chunk: (text: string) => Promise<void>,
): Promise<Completion> {
  signal.throwIfAborted();
  const { tokens, max, temperature } = prepareGeneration(tokenizer, request);
  const output: number[] = [];
  let text = "",
    input = tokens;
  for (let step = 0; step < max; step++) {
    signal.throwIfAborted();
    const token = await forward(input, temperature);
    signal.throwIfAborted();
    if (!Number.isInteger(token) || token < 0 || token >= 49152)
      throw new Error("The model returned an invalid token.");
    if (token === 2 || token === 0) break;
    output.push(token);
    input = [token];
    // Decode the growing buffer so split UTF-8 sequences are not emitted as replacement characters.
    const decoded = tokenizer
      .decode(output, {
        skip_special_tokens: true,
        clean_up_tokenization_spaces: false,
      })
      .replace(/\uFFFD+$/, "");
    if (!decoded.startsWith(text))
      throw new Error("Tokenizer produced an unstable text prefix.");
    const delta = decoded.slice(text.length);
    if (delta) await chunk(delta);
    text = decoded;
  }
  return {
    model,
    prompt_tokens: tokens.length,
    completion_tokens: output.length,
  };
}
