import test from "node:test";
import assert from "node:assert/strict";
import { ChatStateController } from "../src/chat-state.ts";
const worker = {
  id: "worker",
  stale: false,
  info: { model: "model-a", state: "idle", waiting: 0, tokensPerSec: 0 },
};
const done = {
  Done: { model: "model-a", prompt_tokens: 1, completion_tokens: 1 },
};

test("changing models preserves conversations and each model's history", async () => {
  const chat = new ChatStateController("model-a");
  chat.updateNetwork(
    {
      complete: async () =>
        new ReadableStream({
          start(c) {
            c.enqueue({ Chunk: { text: "Hello" } });
            c.enqueue(done);
            c.close();
          },
        }),
    },
    [worker],
  );
  chat.draft("Hi");
  await chat.send();
  const first = chat.current.id;
  chat.setModel("model-b");
  assert.equal(chat.current.messages.length, 0);
  chat.select(first);
  assert.equal(chat.current.model, "model-a");
  assert.equal(chat.current.messages[1].text, "Hello");
});

test("stopping allows a new request immediately and ignores the cancelled stream", async () => {
  const chat = new ChatStateController("model-a");
  let old,
    requests = [];
  chat.updateNetwork(
    {
      complete: async (_id, request) => {
        requests.push(request);
        if (requests.length === 1)
          return new ReadableStream({
            start(c) {
              old = c;
              c.enqueue({ Chunk: { text: "Partial" } });
            },
          });
        return new ReadableStream({
          start(c) {
            c.enqueue({ Chunk: { text: "Fresh" } });
            c.enqueue(done);
            c.close();
          },
        });
      },
    },
    [worker],
  );
  chat.draft("First");
  const first = chat.send();
  await new Promise((resolve) => setTimeout(resolve, 0));
  chat.stop();
  assert.equal(chat.state.busy, false);
  chat.draft("Second");
  await chat.send();
  await first;
  assert.deepEqual(requests[1].messages, [{ role: "User", content: "Second" }]);
  assert.equal(chat.current.messages[1].status, "stopped");
  assert.equal(chat.current.messages[3].text, "Fresh");
  assert.throws(() => old.enqueue({ Chunk: { text: "Late" } }));
});
