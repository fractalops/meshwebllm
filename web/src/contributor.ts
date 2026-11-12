/**
 * Turns this tab into a worker: loads the model, takes jobs from the Wasm
 * node, streams WebLLM output back, and announces status to the pool.
 */
import { CreateWebWorkerMLCEngine, type MLCEngineInterface } from "@mlc-ai/web-llm";
import type { Job, MeshNode } from "./wasm/meshwebllm_web.js";
import { MODEL } from "./config";
import type { CompletionRequest, WorkerInfo, WorkerState } from "./types";

export type Log = (msg: string, cls?: string) => void;

export class Contributor {
  readonly startedAt = Date.now();
  state: WorkerState = { loading: { percent: 0 } };
  active = 0;
  served = 0;
  tokensOut = 0;
  /** Runtime-reported decoding speed while a job is running. */
  tokensPerSec = 0;

  private engine?: MLCEngineInterface;
  private paused = false;
  progressText = "";
  private sampling = false;

  constructor(
    private readonly node: MeshNode,
    readonly adapter: string,
    private readonly log: Log,
    private readonly changed: () => void,
  ) {}

  async start(): Promise<void> {
    this.announce();
    const sampler = setInterval(() => void this.sample(), 500);
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const worker = new Worker(new URL("./llm-worker.ts", import.meta.url), { type: "module" });
        try {
          this.progressText = `Loading model. Attempt ${attempt} of 3.`;
          this.changed();
          this.engine = await CreateWebWorkerMLCEngine(worker, MODEL.id, {
            initProgressCallback: (p) => {
              const percent = Math.max(0, Math.min(100, Math.floor(p.progress * 100)));
              this.state = { loading: { percent } };
              this.progressText = `Attempt ${attempt} of 3 · ${percent}% · ${p.text}`;
              this.announce();
            },
          });
          break;
        } catch (err) {
          worker.terminate();
          if (attempt === 3) throw new Error(`Model load failed after 3 attempts. ${String(err)}`);
          const delay = 2 ** attempt;
          this.progressText = `Download failed. Retrying in ${delay} seconds. Attempt ${attempt + 1} of 3.`;
          this.log(this.progressText, "busy");
          this.changed();
          await new Promise((resolve) => setTimeout(resolve, delay * 1000));
        }
      }
    } catch (err) {
      clearInterval(sampler);
      await this.node.leave().catch(() => {});
      throw err;
    }
    this.state = "idle";
    this.node.setPaused(false);
    this.announce();
    this.log("model loaded, this tab now accepts jobs", "ok");
    void this.loop().finally(() => clearInterval(sampler));
  }

  setPaused(paused: boolean): void {
    if (typeof this.state !== "string") return;
    this.paused = paused;
    this.node.setPaused(paused);
    if (paused) this.engine?.interruptGenerate();
    this.state = paused ? "paused" : this.active ? "busy" : "idle";
    this.announce();
    this.log(paused ? "you paused this worker" : "you resumed this worker", paused ? "busy" : "ok");
  }

  get isPaused(): boolean {
    return this.paused;
  }

  info(): WorkerInfo {
    return {
      state: this.state,
      model: MODEL.id,
      adapter: this.adapter,
      active: this.active,
      waiting: this.node.waiting(),
      served: this.served,
      tokensOut: this.tokensOut,
      tokensPerSec: Math.round(this.tokensPerSec * 10) / 10,
      uptimeSecs: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private announce(): void {
    try {
      this.node.announce(this.info());
      this.changed();
    } catch (err) {
      console.warn("announce failed", err);
    }
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      if (this.active && this.engine) {
        const stats = await this.engine.runtimeStatsText();
        const rate = Number(/decoding: ([\d.]+) tokens\/sec/.exec(stats)?.[1]);
        if (this.active && Number.isFinite(rate)) this.tokensPerSec = rate;
      }
      this.announce();
    } catch (err) {
      console.warn("worker status failed", err);
    } finally {
      this.sampling = false;
    }
  }

  private async loop(): Promise<void> {
    for (;;) {
      const job = await this.node.nextJob();
      if (!job) return;
      if (this.paused) {
        await job.fail("Paused", "worker is paused").catch(() => {});
        continue;
      }
      await this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    const engine = this.engine!;
    const req = (await job.request()) as CompletionRequest;
    this.active = 1;
    this.state = "busy";
    this.tokensPerSec = 0;
    this.announce();
    const started = performance.now();
    let completion = 0;
    let prompt = 0;
    try {
      const chunks = await engine.chat.completions.create({
        messages: req.messages.map((m) => ({
          role: m.role.toLowerCase() as "system" | "user" | "assistant",
          content: m.content,
        })),
        max_tokens: req.max_tokens ?? undefined,
        temperature: req.temperature ?? undefined,
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const chunk of chunks) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) {
          await job.chunk(text);

        }
        if (chunk.usage) {
          prompt = chunk.usage.prompt_tokens;
          completion = chunk.usage.completion_tokens;
        }
      }
      if (this.paused) {
        await job.fail("Paused", "worker was paused during the job");
      } else {
        await job.done(MODEL.id, prompt, completion);
        this.served += 1;
      }
    } catch (err) {
      await job.fail("Inference", String(err)).catch(() => {});
      this.log(`job failed: ${String(err)}`, "bad");
    } finally {
      const secs = (performance.now() - started) / 1000;
      if (completion > 0 && secs > 0) {
        this.tokensPerSec = completion / secs;
      }
      this.tokensOut += completion;
      this.active = 0;
      this.state = this.paused ? "paused" : "idle";
      this.announce();
    }
  }
}

/** The GPU as the browser reports it, and whether WebLLM can run on it. */
export interface GpuCheck {
  /** Vendor and architecture, for example "apple · metal-3". */
  name: string;
  /** Why WebLLM cannot run here, or null when it can. */
  problem: string | null;
}

/**
 * Device limits that WebLLM 0.2.88 requires. Its runtime throws when the
 * adapter reports less. The values are copied from its device setup code.
 */
const REQUIRED_LIMITS: [keyof GPUSupportedLimits, number][] = [
  ["maxStorageBuffersPerShaderStage", 10],
  ["maxComputeWorkgroupStorageSize", 32 << 10],
  ["maxStorageBufferBindingSize", 1 << 27],
  ["maxBufferSize", 1 << 28],
];

/** Checks the GPU before the model is downloaded. Returns null without WebGPU. */
export async function checkGpu(): Promise<GpuCheck | null> {
  if (!("gpu" in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const info = adapter.info;
  const parts = [info?.vendor, info?.architecture].filter((s) => s && s.length > 0);
  const name = parts.length ? parts.join(" · ") : "unknown gpu";
  for (const [limit, required] of REQUIRED_LIMITS) {
    const actual = adapter.limits[limit] as number;
    if (actual < required) {
      if (limit === "maxStorageBuffersPerShaderStage" && actual === 9 && info?.vendor.toLowerCase().includes("apple")) {
        return { name, problem: "Firefox limits this on Apple silicon Macs. Use Chrome or Edge." };
      }
      return { name, problem: `this browser allows ${limit}=${actual}, WebLLM needs ${required}` };
    }
  }
  return { name, problem: null };
}
