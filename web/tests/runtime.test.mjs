import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Tokenizer } from "@huggingface/tokenizers";
import {
  formatChat,
  generateText,
  selectToken,
} from "../src/runtime/generation.ts";
import { StageState } from "../src/runtime/stage-state.ts";
import { chatCandidates, completeChat } from "../src/chat-client.ts";
const fixture = new URL(
  "../../experiments/layer-split/artifacts/source/",
  import.meta.url,
);

test("stage authorization and sequencing protect the shared KV cache", () => {
  const state = new StageState("host"),
    id = "12345678-1234-1234-1234-123456789012";
  assert.throws(() => state.begin("stranger", id), /different coordinator/);
  state.begin("host", id);
  assert.throws(() => state.begin("host", id), /already active/);
  assert.throws(() => state.next("host", id, 1), /Out-of-order/);
  state.next("host", id, 0);
  assert.throws(() => state.next("host", id, 0), /Out-of-order/);
  assert.throws(() => state.end("stranger", id), /different coordinator/);
  state.end("host", id);
  assert.throws(() => state.next("host", id, 1), /Out-of-order/);
});

test("chat template uses the published SmolLM structure and preserves roles", () => {
  assert.equal(
    formatChat([{ role: "User", content: "Hi" }]),
    "<|im_start|>system\nYou are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>\n<|im_start|>user\nHi<|im_end|>\n<|im_start|>assistant\n",
  );
  assert.ok(
    formatChat([
      { role: "System", content: "Be brief" },
      { role: "User", content: "Hi" },
    ]).startsWith("<|im_start|>system\nBe brief"),
  );
  assert.throws(
    () => formatChat([{ role: "bogus", content: "Hi" }]),
    /Invalid/,
  );
});

test("sampling respects precise mode and rejects invalid logits", () => {
  assert.equal(selectToken(new Float32Array([1, 4, 2]), 0), 1);
  assert.equal(
    selectToken(new Float32Array([1, 4, 2]), 0.7, () => 0),
    1,
  );
  assert.throws(
    () => selectToken(new Float32Array([NaN, 1]), 0),
    /invalid logits/,
  );
});

// The previous full-sort sampler. The single-pass sampler must choose the same token.
function sortedTopK(logits, temperature, random) {
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
  return top.at(-1).id;
}
test("top-k sampling matches the full-sort reference, including ties", () => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const [vocab, levels] of [
    [49152, 0],
    [3, 0],
    [41, 0],
    [500, 6],
    [2000, 50],
  ]) {
    for (let trial = 0; trial < 20; trial++) {
      // Quantized scores create many equal logits, which exercises stable tie order.
      const logits = Float32Array.from({ length: vocab }, () =>
        levels ? Math.floor(next() * levels) : next() * 30 - 15,
      );
      for (const temperature of [0.05, 0.7, 2]) {
        const draws = [0, 1, next(), next(), next()];
        for (const d of draws)
          assert.equal(
            selectToken(logits, temperature, () => d),
            sortedTopK(logits, temperature, () => d),
            `vocab ${vocab}, temperature ${temperature}, draw ${d}`,
          );
      }
    }
  }
  assert.throws(
    () => selectToken(new Float32Array([1, -Infinity, 2]), 0.7),
    /invalid logits/,
  );
});

test("generation decodes real tokenizer output, stops at EOS and honors cancellation", async (t) => {
  let json, config;
  try {
    json = JSON.parse(await readFile(new URL("tokenizer.json", fixture)));
    config = JSON.parse(
      await readFile(new URL("tokenizer_config.json", fixture)),
    );
  } catch (e) {
    if (e.code === "ENOENT")
      return t.skip(
        "Optional pinned tokenizer integration fixture is not downloaded.",
      );
    throw e;
  }
  const tokenizer = new Tokenizer(json, config);
  const outputs = [
    ...tokenizer.encode("Hello, world!", { add_special_tokens: false }).ids,
    2,
  ];
  let at = 0,
    text = "";
  const req = {
    messages: [{ role: "User", content: "Hi" }],
    max_tokens: 32,
    temperature: 0,
  };
  const result = await generateText(
    tokenizer,
    "test",
    req,
    new AbortController().signal,
    async () => outputs[at++],
    async (chunk) => (text += chunk),
  );
  assert.equal(text, "Hello, world!");
  assert.equal(result.completion_tokens, outputs.length - 1);
  assert.ok(result.prompt_tokens > 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () =>
      generateText(
        tokenizer,
        "test",
        req,
        abort.signal,
        async () => {
          throw new Error("should not run");
        },
        async () => {},
      ),
    { name: "AbortError" },
  );
  await assert.rejects(
    () =>
      generateText(
        tokenizer,
        "test",
        {
          ...req,
          messages: [{ role: "User", content: "Hello ".repeat(1100) }],
        },
        new AbortController().signal,
        async () => 0,
        async () => {},
      ),
    /1,024/,
  );
});

const member = (id, model = "wanted", state = "idle") => ({
  id,
  stale: false,
  info: { model, state, waiting: 0, tokensPerSec: 10 },
});
test("chat routes only to ready matching models", () => {
  const stale = { ...member("stale"), stale: true };
  assert.deepEqual(
    chatCandidates(
      [
        member("other", "other"),
        member("paused", "wanted", "paused"),
        member("busy", "wanted", "busy"),
        member("ready"),
        stale,
      ],
      "wanted",
    ).map((m) => m.id),
    ["ready", "busy"],
  );
});
const stream = (frames) =>
  new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(f);
      c.close();
    },
  });
test("retry before text, never after a partial response", async () => {
  let calls = 0,
    text = "";
  const node = {
    complete: async () => {
      calls++;
      return calls === 1
        ? stream([{ Error: { code: "Busy", message: "busy" } }])
        : stream([
            { Chunk: { text: "hello" } },
            {
              Done: { model: "wanted", prompt_tokens: 1, completion_tokens: 1 },
            },
          ]);
    },
  };
  await completeChat(
    node,
    [member("one"), member("two")],
    {},
    new AbortController().signal,
    () => {},
    (s) => (text += s),
  );
  assert.equal(calls, 2);
  assert.equal(text, "hello");
  calls = 0;
  await assert.rejects(
    () =>
      completeChat(
        {
          complete: async () => {
            calls++;
            return stream([{ Chunk: { text: "partial" } }]);
          },
        },
        [member("one"), member("two")],
        {},
        new AbortController().signal,
        () => {},
        () => {},
      ),
    /disconnected/,
  );
  assert.equal(calls, 1);
});

test("stop releases the chat immediately even while a worker connection is pending", async () => {
  let resolve,
    cancelled = false;
  const node = { complete: () => new Promise((r) => (resolve = r)) };
  const controller = new AbortController();
  const request = completeChat(
    node,
    [member("worker")],
    {},
    controller.signal,
    () => {},
    () => {},
  );
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  resolve(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(cancelled);
});

// The real WebLLM worker can be terminated while next() or model initialization
// is pending; its RPC layer does not reject those promises on termination.
test("termination releases a pending worker call without waiting for a reply", async () => {
  const { withAbort } = await import("../src/runtime/abort.ts");
  const closed = new AbortController();
  let rejectWorker;
  const workerCall = new Promise((_, reject) => {
    rejectWorker = reject;
  });
  const pending = withAbort(workerCall, closed.signal);
  closed.abort();
  await assert.rejects(pending, { name: "AbortError" });
  rejectWorker(new Error("late worker error"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    await withAbort(
      Promise.resolve("next request"),
      new AbortController().signal,
    ),
    "next request",
  );
});
