import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import proto from "onnx-proto";
import {
  publishModel,
  planStage,
  assembleStage,
  sha256,
  CHUNK_BYTES,
} from "./browser-partition.js";
import { BlobCache } from "./blob-cache.js";

// The fixture store uses SHA-256 only to exercise graph/chunk logic in Node.
// Browser integration uses actual iroh-blobs BLAKE3 hashes and verified streams.
test("partition the pinned original model by graph dependencies", async (t) => {
  let source, config;
  try {
    source = await readFile(
      new URL("./artifacts/source/onnx/model_q4.onnx", import.meta.url),
    );
    config = JSON.parse(
      await readFile(
        new URL("./artifacts/source/config.json", import.meta.url),
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT")
      return t.skip(
        "Run setup-browser.sh to download the pinned model fixture",
      );
    throw error;
  }
  const store = new Map();
  const manifest = await publishModel(source, config, async (bytes) => {
    const hash = await sha256(bytes);
    store.set(hash, bytes.slice());
    return hash;
  });
  const graph = store.get(manifest.graph.hash);
  assert.equal(proto.onnx.ModelProto.decode(graph).graph.initializer.length, 0);
  assert.ok(
    manifest.tensors
      .flatMap((x) => x.chunks)
      .every((c) => c.bytes <= CHUNK_BYTES),
  );
  for (const split of [1, 15, 29]) {
    const first = planStage(graph, manifest, "first", split);
    const second = planStage(graph, manifest, "second", split);
    assert.deepEqual(
      [...first.layers, ...second.layers],
      Array.from({ length: 30 }, (_, i) => i),
    );
    const firstNames = new Set(first.tensors.map((x) => x.name));
    assert.ok(
      second.tensors
        .filter((x) => /layers\.\d+\./.test(x.name))
        .every((x) => !firstNames.has(x.name)),
    );
    assert.equal(
      first.outputs.filter((x) => x.startsWith("present.")).length,
      split * 2,
    );
    assert.equal(
      second.outputs.filter((x) => x.startsWith("present.")).length,
      (30 - split) * 2,
    );
    if (split === 15) {
      for (const plan of [first, second]) {
        const encoded = await assembleStage(plan, async (c) =>
          store.get(c.hash),
        );
        const rebuilt = proto.onnx.ModelProto.decode(encoded);
        assert.deepEqual(
          rebuilt.graph.initializer.map((x) => x.name),
          plan.tensors.map((x) => x.name),
        );
        assert.ok(encoded.length < source.length);
      }
    }
  }
  assert.throws(() => planStage(graph, manifest, "first", 0), /Invalid stage/);
  const missing = {
    ...manifest,
    tensors: manifest.tensors.filter((x) => !x.name.includes("layers.0.")),
  };
  assert.throws(() => planStage(graph, missing, "first"), /Unresolved tensor/);
  await assert.rejects(
    () => publishModel(new Uint8Array([1, 2, 3]), config, () => {}),
    /SHA-256/,
  );
  const plan = planStage(graph, manifest, "first");
  await assert.rejects(
    () => assembleStage(plan, async () => new Uint8Array()),
    /Truncated/,
  );
});

test("cache rejects corruption, repairs from peer, and enforces offline reads", async () => {
  const entries = new Map();
  let fetches = 0;
  const good = new Uint8Array([1, 2, 3]);
  const cache = new BlobCache(
    null,
    {
      getBlob: async () => {
        fetches++;
        return good.slice();
      },
    },
    {},
    (bytes) => bytes.every((v, i) => v === good[i]),
  );
  cache.read = async (hash) => entries.get(hash);
  cache.write = async (hash, bytes) => entries.set(hash, bytes);
  const chunk = { hash: "test", bytes: 3 };
  await cache.get(chunk);
  await cache.get(chunk, { offline: true });
  assert.equal(fetches, 1);
  entries.set("test", new Uint8Array([9, 2, 3]));
  await assert.rejects(
    () => cache.get(chunk, { offline: true }),
    /Missing or corrupt offline/,
  );
  assert.equal(fetches, 1);
  await cache.get(chunk);
  assert.equal(fetches, 2);
  assert.equal(cache.stats.corruptEntries, 2);
  await cache.prefetch([chunk, chunk], () => {}, true);
  assert.equal(fetches, 2);
});
