/**
 * Turns this tab into a worker: loads the model, takes jobs from the Wasm
 * node, streams WebLLM output back, and announces status to the pool.
 */
import { CreateWebWorkerMLCEngine, type MLCEngineInterface } from "@mlc-ai/web-llm";
import type { Job, MeshNode } from "./wasm/meshwebllm_web.js";
import { HEARTBEAT_S, MODEL } from "./config";
import type { CompletionRequest, WorkerInfo, WorkerState } from "./types";

export type Log = (msg: string, cls?: string) => void;

export class Contributor {
  readonly startedAt = Date.now();
  state: WorkerState = { loading: { percent: 0 } };
  active = 0;
  served = 0;
  tokensOut = 0;
  /** Moving average of this tab's own generation speed. */
  tokensPerSec = 0;
  /** Tokens per second, one sample per second, for the sparkline. */
  readonly history: number[] = [];

  private engine?: MLCEngineInterface;
  private paused = false;
  private tokensThisSecond = 0;

  constructor(
    private readonly node: MeshNode,
    readonly adapter: string,
    private readonly log: Log,
  ) {}

  async start(): Promise<void> {
    this.announce();
    const timer = setInterval(() => this.announce(), HEARTBEAT_S * 1000);
    const sampler = setInterval(() => {
      this.history.push(this.tokensThisSecond);
      if (this.history.length > 60) this.history.shift();
      this.tokensThisSecond = 0;
    }, 1000);
    try {
      this.engine = await CreateWebWorkerMLCEngine(
        new Worker(new URL("./llm-worker.ts", import.meta.url), { type: "module" }),
        MODEL.id,
        {
          initProgressCallback: (p) => {
            const percent = Math.floor(p.progress * 100);
            const prev = this.state;
            this.state = { loading: { percent } };
            if (typeof prev !== "string" && Math.floor(prev.loading.percent / 10) !== Math.floor(percent / 10)) {
              this.announce();
            }
          },
        },
      );
    } catch (err) {
      clearInterval(timer);
      clearInterval(sampler);
      await this.node.leave();
      throw err;
    }
    this.state = "idle";
    this.node.setPaused(false);
    this.announce();
    this.log("model loaded, this tab now accepts jobs", "ok");
    void this.loop();
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
    } catch (err) {
      console.warn("announce failed", err);
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
          this.tokensThisSecond += 1;
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
        const rate = completion / secs;
        this.tokensPerSec = this.tokensPerSec ? 0.7 * this.tokensPerSec + 0.3 * rate : rate;
      }
      this.tokensOut += completion;
      this.active = 0;
      this.state = this.paused ? "paused" : "idle";
      this.announce();
    }
  }
}

/** GPU vendor and architecture as the browser reports them. */
export async function describeAdapter(): Promise<string | null> {
  if (!("gpu" in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const info = adapter.info;
  const parts = [info?.vendor, info?.architecture].filter((s) => s && s.length > 0);
  return parts.length ? parts.join(" · ") : "unknown gpu";
}
