/** Cache layout used by the pinned WebLLM 0.2.88 runtime. */
const MODEL_CACHE = "webllm/model";

interface Shard {
  dataPath: string;
  nbytes: number;
}

export interface DownloadProgress {
  loaded: number;
  total: number;
}

/**
 * Buffer one shard before Cache.put: Chrome can reject Cache.add's streaming
 * download even when fetch and a complete-body cache write both succeed.
 * Keep completed shards in WebLLM's cache so engine retries reuse them.
 */
export async function cacheModelWeights(
  modelUrl: string,
  progress: (value: DownloadProgress) => void,
): Promise<void> {
  let base = modelUrl.endsWith("/") ? modelUrl : `${modelUrl}/`;
  if (!base.match(/.+\/resolve\/.+\//)) base += "resolve/main/";
  const cache = await caches.open(MODEL_CACHE);
  const manifestUrl = new URL("tensor-cache.json", base).href;
  let manifest = await cache.match(manifestUrl);
  if (!manifest) {
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`Model manifest: HTTP ${response.status}`);
    manifest = new Response(await response.arrayBuffer());
    await cache.put(manifestUrl, manifest.clone());
  }
  const { records } = await manifest.json() as { records: Shard[] };
  if (!Array.isArray(records) || !records.length || records.some((r) =>
    typeof r.dataPath !== "string" || !Number.isSafeInteger(r.nbytes) || r.nbytes <= 0)) {
    throw new Error("Invalid model download manifest.");
  }
  const total = records.reduce((sum, shard) => sum + shard.nbytes, 0);
  let loaded = 0;
  progress({ loaded, total });
  for (const shard of records) {
    const url = new URL(shard.dataPath, base).href;
    const cached = await cache.match(url);
    if (cached && (await cached.arrayBuffer()).byteLength === shard.nbytes) {
      loaded += shard.nbytes;
      progress({ loaded, total });
      continue;
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${shard.dataPath}: HTTP ${response.status}`);
    if (!response.body) throw new Error(`${shard.dataPath}: empty download.`);
    const bytes = new Uint8Array(shard.nbytes);
    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > bytes.byteLength) {
          throw new Error(`${shard.dataPath}: download is larger than expected.`);
        }
        bytes.set(value, received);
        received += value.byteLength;
        progress({ loaded: loaded + received, total });
      }
      if (received !== shard.nbytes) {
        throw new Error(`${shard.dataPath}: incomplete download (${received}/${shard.nbytes} bytes).`);
      }
      await cache.put(url, new Response(bytes));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    loaded += received;
  }
}
