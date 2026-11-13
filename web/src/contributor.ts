import type { Job, MeshNode } from "./wasm/meshwebllm_web.js";
import type { ModelSpec } from "./config";
import type { CompletionRequest, WorkerInfo } from "./types";
import type { Runtime, RuntimeOptions, RuntimeProgress } from "./runtime/types";
import { createOnnx } from "./runtime/onnx";
import { createSplit, joinSplit, type Invitation } from "./runtime/split";

/** One queue consumer survives contribution changes; model sessions never own the queue. */
export class Contributor {
  progress: RuntimeProgress = {
    phase: "stopped",
    message: "Your GPU is not contributing",
  };
  model?: ModelSpec;
  mode: "whole" | "shared" | "helper" = "whole";
  invite?: Invitation;
  startedAt = 0;
  served = 0;
  tokensOut = 0;
  tokensPerSec = 0;
  private runtime?: Runtime;
  private loading?: AbortController;
  private generation?: AbortController;
  private version = 0;
  private paused = false;
  private sampler: ReturnType<typeof setInterval>;
  constructor(
    private node: MeshNode,
    readonly adapter: string,
    private changed: () => void,
  ) {
    this.sampler = setInterval(() => this.announce(), 1000);
    void this.loop();
  }
  get running() {
    return this.progress.phase !== "stopped";
  }
  get canPause() {
    return (
      !!this.runtime &&
      this.mode !== "helper" &&
      this.progress.phase !== "error"
    );
  }
  get isPaused() {
    return this.paused;
  }
  get busy() {
    return !!this.generation;
  }
  info(): WorkerInfo | undefined {
    if (!this.model || !this.running || this.mode === "helper") return;
    const phase = this.progress.phase;
    const state =
      phase === "ready"
        ? "idle"
        : phase === "busy"
          ? "busy"
          : phase === "paused" || phase === "error"
            ? "paused"
            : {
                loading: {
                  percent: this.progress.total
                    ? Math.min(
                        99,
                        Math.floor(
                          ((this.progress.loaded ?? 0) / this.progress.total) *
                            100,
                        ),
                      )
                    : 0,
                },
              };
    return {
      model: this.model.id,
      state,
      adapter: `${this.adapter}${this.mode === "shared" ? " · 2 devices" : ""}`,
      active: this.busy ? 1 : 0,
      waiting: this.node.waiting(),
      served: this.served,
      tokensOut: this.tokensOut,
      tokensPerSec: this.tokensPerSec,
      uptimeSecs: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
  private announce() {
    const info = this.info();
    if (info) this.node.announce(info);
    this.changed();
  }
  private update(progress: RuntimeProgress) {
    this.progress = progress;
    this.announce();
  }
  async start(
    model: ModelSpec,
    mode: "whole" | "shared" | "helper",
    invite?: Invitation,
  ): Promise<void> {
    if (this.running) throw new Error("Stop the current contribution first.");
    const version = ++this.version;
    this.model = model;
    this.mode = mode;
    this.startedAt = Date.now();
    this.paused = false;
    this.served = 0;
    this.tokensOut = 0;
    this.tokensPerSec = 0;
    const loading = new AbortController();
    this.loading = loading;
    this.node.setPaused(true);
    this.update({ phase: "preparing", message: "Getting ready" });
    let unavailable = false;
    const options: RuntimeOptions = {
      signal: loading.signal,
      progress: (p) => {
        if (this.version === version && !unavailable) this.update(p);
      },
      unavailable: (reason) => {
        if (this.version !== version || unavailable) return;
        unavailable = true;
        this.node.setPaused(true);
        this.generation?.abort();
        this.update({ phase: "error", message: reason });
        this.loading?.abort();
        const runtime = this.runtime;
        this.runtime = undefined;
        void runtime?.dispose().catch(() => {});
      },
    };
    try {
      const runtime =
        mode === "helper"
          ? await joinSplit(invite!, options)
          : mode === "shared"
            ? await createSplit(options, (i) => {
                if (this.version !== version) return;
                this.invite = i;
                this.changed();
              })
            : model.runtime === "onnx"
              ? await createOnnx(options)
              : await (
                  await import("./runtime/webllm")
                ).createWebLlm(model.id, options);
      if (this.version !== version || loading.signal.aborted) {
        await runtime.dispose();
        return;
      }
      this.runtime = runtime;
      this.loading = undefined;
      if (this.progress.phase === "error") {
        await runtime.dispose();
        this.runtime = undefined;
        return;
      }
      this.node.setPaused(mode === "helper");
      this.update({
        phase: "ready",
        message:
          mode === "helper"
            ? this.progress.message
            : mode === "shared"
              ? "Team ready · both devices connected"
              : "Your GPU is ready to answer",
      });
    } catch (error) {
      if (this.version === version && !loading.signal.aborted) {
        this.loading = undefined;
        this.update({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        await this.node.leave().catch(() => {});
      }
    }
  }
  async stop(): Promise<void> {
    ++this.version;
    this.node.setPaused(true);
    this.loading?.abort();
    this.loading = undefined;
    this.generation?.abort();
    const runtime = this.runtime;
    this.runtime = undefined;
    this.invite = undefined;
    this.paused = false;
    this.update({ phase: "stopped", message: "Your GPU is not contributing" });
    await this.node.leave().catch(() => {});
    await runtime?.dispose();
  }
  pause() {
    if (!this.canPause) return;
    this.paused = !this.paused;
    this.node.setPaused(this.paused);
    if (this.paused) this.generation?.abort();
    this.update({
      phase: this.paused ? "paused" : "ready",
      message: this.paused
        ? "Contribution paused"
        : "Your GPU is ready to answer",
    });
  }
  async dispose() {
    clearInterval(this.sampler);
    await this.stop();
  }
  private async loop() {
    for (;;) {
      const job = await this.node.nextJob();
      if (!job) return;
      await this.serve(job);
    }
  }
  private async serve(job: Job) {
    const runtime = this.runtime,
      version = this.version;
    if (
      !runtime ||
      this.paused ||
      this.mode === "helper" ||
      this.progress.phase === "error"
    ) {
      await job.fail("Paused", "This worker is not ready.").catch(() => {});
      return;
    }
    const signal = new AbortController();
    this.generation = signal;
    void job
      .cancelled()
      .then((cancelled) => {
        if (cancelled) signal.abort();
      })
      .catch(() => {});
    const started = performance.now();
    this.update({ phase: "busy", message: "Answering a request" });
    try {
      const request = (await job.request()) as CompletionRequest;
      const result = await runtime.generate(
        request,
        signal.signal,
        async (text) => {
          signal.signal.throwIfAborted();
          try {
            await job.chunk(text);
          } catch (error) {
            signal.abort();
            throw error;
          }
        },
      );
      signal.signal.throwIfAborted();
      await job.done(
        result.model,
        result.prompt_tokens,
        result.completion_tokens,
      );
      this.served++;
      this.tokensOut += result.completion_tokens;
      this.tokensPerSec =
        result.completion_tokens / ((performance.now() - started) / 1000);
    } catch (error) {
      await job
        .fail(
          signal.signal.aborted ? "Paused" : "Inference",
          signal.signal.aborted
            ? "Generation stopped."
            : error instanceof Error
              ? error.message
              : String(error),
        )
        .catch(() => {});
    } finally {
      if (this.generation === signal) this.generation = undefined;
      if (
        this.version === version &&
        (this.progress.phase as string) !== "error"
      )
        this.update({
          phase: this.paused ? "paused" : "ready",
          message: this.paused
            ? "Contribution paused"
            : "Ready for the next request",
        });
    }
  }
}
export interface GpuCheck {
  name: string;
  onnxProblem: string | null;
  webllmProblem: string | null;
}
export async function checkGpu(): Promise<GpuCheck> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter || adapter.info.isFallbackAdapter)
    return {
      name: "WebGPU unavailable",
      onnxProblem:
        "Contributing needs WebGPU. Try a recent Chrome or Edge browser.",
      webllmProblem:
        "Contributing needs WebGPU. Try a recent Chrome or Edge browser.",
    };
  const name =
    [adapter.info.vendor, adapter.info.architecture]
      .filter(Boolean)
      .join(" · ") || "WebGPU";
  const problem =
    adapter.limits.maxStorageBufferBindingSize < 120_000_000
      ? "This GPU cannot hold the model’s shared embedding."
      : null;
  const limits: [keyof GPUSupportedLimits, number][] = [
    ["maxStorageBuffersPerShaderStage", 10],
    ["maxComputeWorkgroupStorageSize", 32768],
    ["maxStorageBufferBindingSize", 1 << 27],
    ["maxBufferSize", 1 << 28],
  ];
  const failed = limits.find(
    ([limit, min]) => (adapter.limits[limit] as number) < min,
  );
  return {
    name,
    onnxProblem: problem,
    webllmProblem: failed
      ? "This browser’s GPU limits are too low for WebLLM. Try Chrome or Edge."
      : null,
  };
}
