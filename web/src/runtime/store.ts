import { StagePeer } from "../wasm/meshwebllm_web.js";
import type { Chunk, PeerAddress, RuntimeOptions } from "./types";

/** Content-addressed, cross-visit model cache. Identity and invitations do not affect cache keys. */
export class ModelStore {
  downloaded = 0;
  reused = 0;
  constructor(private db: IDBDatabase) {}
  static async open(): Promise<ModelStore> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open("meshwebllm.models.v1", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("objects");
      r.onerror = () =>
        reject(
          new Error(
            "Browser storage is unavailable. Allow site storage and try again.",
          ),
        );
      r.onsuccess = () => resolve(new ModelStore(r.result));
    });
  }
  read(key: string): Promise<Uint8Array | undefined> {
    return new Promise((resolve, reject) => {
      const r = this.db.transaction("objects").objectStore("objects").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  write(key: string, bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("objects", "readwrite");
      tx.objectStore("objects").put(bytes.slice(), key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          new Error(
            "Could not save model weights. Free some browser storage and try again.",
          ),
        );
    });
  }
  async blob(
    chunk: Chunk,
    peer: StagePeer,
    address: PeerAddress,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    const saved = await this.read(chunk.hash);
    if (
      saved?.length === chunk.bytes &&
      StagePeer.verifyBlob(saved, chunk.hash)
    ) {
      this.reused += saved.length;
      return saved;
    }
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try {
        const bytes = await peer.getBlob(address, chunk.hash, chunk.bytes);
        signal.throwIfAborted();
        if (
          bytes.length !== chunk.bytes ||
          !StagePeer.verifyBlob(bytes, chunk.hash)
        )
          throw new Error("Weight verification failed.");
        await this.write(chunk.hash, bytes);
        this.downloaded += bytes.length;
        return bytes;
      } catch (error) {
        last = error;
      }
    }
    throw new Error(
      `Could not receive weights from the other device. Keep both tabs open and retry. ${String(last)}`,
    );
  }
  async prefetch(
    chunks: Chunk[],
    peer: StagePeer,
    address: PeerAddress,
    options: RuntimeOptions,
  ) {
    const unique = [...new Map(chunks.map((c) => [c.hash, c])).values()];
    const total = unique.reduce((n, c) => n + c.bytes, 0);
    let loaded = 0,
      next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < unique.length) {
          const c = unique[next++];
          await this.blob(c, peer, address, options.signal);
          loaded += c.bytes;
          options.progress({
            phase: "downloading",
            message: "Receiving verified weights from the other device",
            loaded,
            total,
          });
        }
      }),
    );
  }
  close() {
    this.db.close();
  }
}
