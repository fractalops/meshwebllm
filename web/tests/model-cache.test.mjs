import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheModelWeights } from "../src/model-cache.ts";

const base = "https://huggingface.co/test/model/resolve/main/";
const manifest = [{ dataPath: "one.bin", nbytes: 4 }, { dataPath: "two.bin", nbytes: 4 }];

function setup(t, download) {
  const stored = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    async open(scope) {
      assert.equal(scope, "webllm/model");
      return {
        async match(url) { return stored.get(url)?.clone(); },
        async put(url, response) {
          // Consume the body as the browser does. Partial streams must not reach put.
          stored.set(url, new Response(await response.arrayBuffer()));
        },
        async add() { throw new Error("Cache.add() encountered a network error"); },
      };
    },
  };
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("tensor-cache.json")) return Response.json({ records: manifest });
    return download(url);
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; });
  return { stored, requests };
}

test("buffers downloads into WebLLM's cache without Cache.add and reports exact bytes", async (t) => {
  const { stored, requests } = setup(t, () => new Response(new Uint8Array([1, 2, 3, 4])));
  const progress = [];
  await cacheModelWeights("https://huggingface.co/test/model", (p) => progress.push(p));
  assert.deepEqual([...new Uint8Array(await stored.get(`${base}one.bin`).clone().arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(progress.at(-1), { loaded: 8, total: 8 });
  assert.equal(requests.length, 3);
  await cacheModelWeights(base, () => {});
  assert.equal(requests.length, 3, "warm load must not download cached files");
});

test("a dropped download is not cached; retry keeps completed shards", async (t) => {
  let dropped = false;
  const { stored, requests } = setup(t, (url) => {
    if (url.endsWith("two.bin") && !dropped) {
      dropped = true;
      let first = true;
      return new Response(new ReadableStream({
        pull(controller) {
          if (first) { first = false; controller.enqueue(new Uint8Array([1, 2])); }
          else controller.error(new TypeError("network disconnected"));
        },
      }));
    }
    return new Response(new Uint8Array(4));
  });
  await assert.rejects(cacheModelWeights(base, () => {}), /network disconnected/);
  assert.ok(stored.has(`${base}one.bin`));
  assert.ok(!stored.has(`${base}two.bin`));
  await cacheModelWeights(base, () => {});
  assert.equal(requests.filter((url) => url.endsWith("one.bin")).length, 1);
  assert.equal(requests.filter((url) => url.endsWith("two.bin")).length, 2);
});

for (const [name, response, error] of [
  ["HTTP failure", () => new Response("Unavailable", { status: 503 }), /HTTP 503/],
  ["truncated body", () => new Response(new Uint8Array(2)), /incomplete download/],
  ["oversized body", () => new Response(new Uint8Array(5)), /larger than expected/],
]) {
  test(`does not cache a shard after ${name}`, async (t) => {
    const { stored } = setup(t, response);
    await assert.rejects(cacheModelWeights(base, () => {}), error);
    assert.ok(!stored.has(`${base}one.bin`));
  });
}

test("replaces a cached shard with the wrong length", async (t) => {
  const { stored } = setup(t, () => new Response(new Uint8Array(4)));
  stored.set(`${base}one.bin`, new Response(new Uint8Array(1)));
  await cacheModelWeights(base, () => {});
  assert.equal((await stored.get(`${base}one.bin`).clone().arrayBuffer()).byteLength, 4);
});
