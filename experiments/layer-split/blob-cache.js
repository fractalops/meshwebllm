// Browser persistence is independent of the iroh-blobs in-memory seed store.
export class BlobCache {
  constructor(db, peer, address, verify) {
    this.db = db;
    this.peer = peer;
    this.address = address;
    this.verify = verify;
    this.stats = {
      networkRequests: 0,
      networkBytes: 0,
      cacheHits: 0,
      corruptEntries: 0,
    };
  }
  static async open(name, peer, address, verify) {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("chunks");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => resolve(r.result);
    });
    return new BlobCache(db, peer, address, verify);
  }
  async read(hash) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("chunks", "readonly");
      const r = tx.objectStore("chunks").get(hash);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async write(hash, bytes) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put(bytes, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async get(chunk, { offline = false } = {}) {
    const cached = await this.read(chunk.hash);
    if (
      cached &&
      cached.byteLength === chunk.bytes &&
      this.verify(cached, chunk.hash)
    ) {
      this.stats.cacheHits++;
      return cached;
    }
    if (cached) this.stats.corruptEntries++;
    if (offline)
      throw new Error(`Missing or corrupt offline chunk ${chunk.hash}`);
    const bytes = await this.peer.getBlob(
      this.address,
      chunk.hash,
      chunk.bytes,
    );
    if (!this.verify(bytes, chunk.hash))
      throw new Error("Downloaded blob failed hash verification");
    this.stats.networkRequests++;
    this.stats.networkBytes += bytes.length;
    await this.write(chunk.hash, bytes);
    return bytes;
  }
  async prefetch(chunks, progress = () => {}, offline = false) {
    const unique = [...new Map(chunks.map((c) => [c.hash, c])).values()];
    let next = 0,
      done = 0,
      bytes = 0;
    await Promise.all(
      Array.from({ length: 1 }, async () => {
        while (next < unique.length) {
          const chunk = unique[next++];
          await this.get(chunk, { offline });
          done++;
          bytes += chunk.bytes;
          progress({
            done,
            total: unique.length,
            bytes,
            stats: { ...this.stats },
          });
        }
      }),
    );
    return unique;
  }
  close() {
    this.db.close();
  }
}
