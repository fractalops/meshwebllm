import { expect, test, vi } from "vitest";
import { Contributor } from "./contributor";
import { MODELS } from "./config";
import type { MeshNode, Job } from "./wasm/meshwebllm_web.js";

const runtime = vi.hoisted(() => ({ generate: vi.fn(), dispose: vi.fn() }));
vi.mock("./runtime/onnx", () => ({ createOnnx: async () => runtime }));
vi.mock("./runtime/split", () => ({
  createSplit: vi.fn(),
  joinSplit: vi.fn(),
}));

test("a requester stopping its stream aborts active inference before the next chunk", async () => {
  let deliver!: (job: Job) => void;
  let cancel!: (cancelled: boolean) => void;
  let started!: () => void;
  const generating = new Promise<void>((resolve) => {
    started = resolve;
  });
  let observed!: AbortSignal;
  runtime.generate.mockImplementation(async (_request, signal: AbortSignal) => {
    observed = signal;
    started();
    await new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  runtime.dispose.mockResolvedValue(undefined);
  const first = new Promise<Job>((resolve) => {
    deliver = resolve;
  });
  const node = {
    nextJob: vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValue(new Promise(() => {})),
    setPaused: vi.fn(),
    announce: vi.fn(),
    leave: vi.fn().mockResolvedValue(undefined),
    waiting: () => 0,
  };
  const contributor = new Contributor(
    node as unknown as MeshNode,
    "Test GPU",
    () => {},
  );
  try {
    await contributor.start(MODELS[0], "whole");
    const job = {
      cancelled: () =>
        new Promise<boolean>((resolve) => {
          cancel = resolve;
        }),
      request: vi
        .fn()
        .mockResolvedValue({ messages: [{ role: "User", content: "Hello" }] }),
      fail: vi.fn().mockResolvedValue(undefined),
      chunk: vi.fn(),
      done: vi.fn(),
    };
    deliver(job as unknown as Job);
    await generating;
    cancel(true);
    await vi.waitFor(() => expect(observed.aborted).toBe(true));
    await vi.waitFor(() => expect(contributor.busy).toBe(false));
    expect(job.chunk).not.toHaveBeenCalled();
    expect(job.done).not.toHaveBeenCalled();
    expect(contributor.progress.phase).toBe("ready");
  } finally {
    await contributor.dispose();
  }
});
