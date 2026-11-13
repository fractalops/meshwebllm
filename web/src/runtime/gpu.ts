import type { ForwardResult, ModelConfig } from "./types";

/** One isolated GPU session, with bounded RPC and deterministic teardown. */
export class GpuSession {
  private worker = new Worker(new URL("./model-worker.js", import.meta.url), {
    type: "module",
  });
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private disposed = false;
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
    this.worker.onerror = (e) =>
      this.fail(new Error(e.message || "The GPU worker stopped."));
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  call<T>(method: string, args?: unknown): Promise<T> {
    if (this.disposed)
      return Promise.reject(new Error("GPU session is closed."));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "The GPU did not respond. Stop contributing and try again.",
          ),
        );
      }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }
  async init(
    role: string,
    config: ModelConfig,
    outputs: string[],
    modelBytes: Uint8Array,
  ): Promise<void> {
    await this.call("init", {
      role,
      manifest: { config, models: { [role]: { outputs } } },
      modelBytes,
    });
  }
  forward(tokens: number[], tensors?: ForwardResult["tensors"]) {
    return this.call<ForwardResult>("run", { tokens, tensors });
  }
  reset() {
    return this.call<void>("reset");
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.fail(new Error("GPU session closed."));
  }
}
