import init, { MeshNode } from "./wasm/meshwebllm_web.js";
import { POOL_NAME, bootstrapIds, testRelay } from "./config";
import type { Member } from "./types";
export class MeshSession {
  private readers: ReadableStreamDefaultReader[] = [];
  private constructor(readonly node: MeshNode) {}
  static async connect(
    changed: (members: Member[], neighbors: number) => void,
  ): Promise<MeshSession> {
    await init();
    // A fresh identity per tab prevents two open contributors from impersonating each other.
    const node = await MeshNode.spawn(
      undefined,
      POOL_NAME,
      bootstrapIds(),
      testRelay(),
    );
    const session = new MeshSession(node);
    const reader = node.rosterUpdates().getReader();
    session.readers.push(reader);
    const update = () => changed(node.roster() as Member[], node.neighbors());
    update();
    void (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
          update();
        }
      } catch (error) {
        console.warn("Pool update stopped", error);
      }
    })();
    return session;
  }
  async close() {
    for (const reader of this.readers) await reader.cancel().catch(() => {});
    await this.node.shutdown();
  }
}
