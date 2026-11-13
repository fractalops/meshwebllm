import { StagePeer } from "../wasm/meshwebllm_web.js";
import { SMOL_ID, testRelay } from "../config";
import {
  assembleStage,
  planStage,
  publishModel,
  validateManifest,
} from "./partition.js";
import { loadSource } from "./assets";
import { loadTokenizer } from "./onnx";
import { GpuSession } from "./gpu";
import { ModelStore } from "./store";
import { generateText, prepareGeneration, selectToken } from "./generation";
import { pack, unpack } from "./packet.js";
import { StageState } from "./stage-state";
import type {
  Chunk,
  Manifest,
  PeerAddress,
  Runtime,
  RuntimeOptions,
} from "./types";
export interface Invitation {
  version: 1;
  address: PeerAddress;
  manifest: Chunk;
  secret: string;
}
export interface SharedRuntime extends Runtime {
  invite?: Invitation;
}
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export function invitationUrl(invite: Invitation): string {
  const url = new URL(location.href);
  url.hash = `join=${btoa(JSON.stringify(invite))}`;
  return url.href;
}
export function readInvitation(hash: string): Invitation | undefined {
  if (!hash.startsWith("#join=")) return;
  if (hash.length > 6000) throw new Error("This invitation is too large.");
  const invite = JSON.parse(atob(hash.slice(6)));
  if (
    invite.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(invite.address?.id) ||
    !Array.isArray(invite.address?.addrs) ||
    invite.address.addrs.length > 8 ||
    !/^[0-9a-f]{64}$/.test(invite.manifest?.hash) ||
    !Number.isInteger(invite.manifest.bytes) ||
    invite.manifest.bytes < 1 ||
    invite.manifest.bytes > 1_048_576 ||
    !/^[0-9a-f-]{36}$/.test(invite.secret)
  )
    throw new Error("This invitation is not supported. Ask for a new link.");
  return invite;
}
async function rpc(
  peer: StagePeer,
  address: PeerAddress,
  message: unknown,
): Promise<any> {
  // Enrollment and liveness messages are idempotent. Never replay a GPU step.
  const safeToRetry = ["join", "heartbeat", "ready"].includes(
    (message as any).type,
  );
  for (let attempt = 0; ; attempt++) {
    try {
      const result = unpack(await peer.request(address, pack(message)));
      if (result.error) throw new Error(result.error);
      return result;
    } catch (error) {
      if (!safeToRetry || attempt === 1) throw error;
    }
  }
}

async function listen(
  peer: StagePeer,
  signal: AbortSignal,
  handler: (message: any, remote: string) => Promise<unknown>,
) {
  while (!signal.aborted) {
    const job = await peer.nextJob();
    if (!job) return;
    try {
      const remote = await job.peer();
      const message = unpack(await job.payload());
      const result = await handler(message, remote);
      await job.respond(pack(result));
    } catch (error) {
      await job
        .respond(
          pack({
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .catch(() => {});
    }
  }
}
async function peerFor(options: RuntimeOptions) {
  const peer = await StagePeer.spawn(testRelay());
  try {
    options.signal.throwIfAborted();
    await peer.online();
    return peer;
  } catch (error) {
    await peer.shutdown();
    throw error;
  }
}
async function assemble(
  plan: ReturnType<typeof planStage>,
  store: ModelStore,
  options: RuntimeOptions,
) {
  options.progress({
    phase: "preparing",
    message: "Building your half of the model",
  });
  return assembleStage(plan, async (c: Chunk) => {
    options.signal.throwIfAborted();
    const b = await store.read(c.hash);
    if (!b || b.length !== c.bytes || !StagePeer.verifyBlob(b, c.hash))
      throw new Error(
        "Cached weights failed verification. Try preparing the model again.",
      );
    return b;
  });
}
export async function createSplit(
  options: RuntimeOptions,
  onInvite: (invite: Invitation) => void,
): Promise<SharedRuntime> {
  const store = await ModelStore.open(),
    gpu = new GpuSession();
  let peer: StagePeer | undefined;
  let helper: PeerAddress | undefined;
  let alive = Date.now();
  let disposed = false;
  let active = false;
  const closed = new AbortController();
  const abort = () => {
    closed.abort();
    gpu.dispose();
    void peer?.shutdown();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    peer = await peerFor(options);
    const p = peer;
    const { bytes, config } = await loadSource(store, options);
    const tokenizer = await loadTokenizer(store, options);
    options.progress({
      phase: "preparing",
      message: "Preparing verified weights to share",
    });
    const manifest = (await publishModel(
      bytes,
      config,
      async (b: Uint8Array) => {
        options.signal.throwIfAborted();
        const hash = await p.addBlob(b);
        await store.write(hash, b);
        return hash;
      },
    )) as Manifest;
    const manifestBytes = encode(manifest),
      hash = await p.addBlob(manifestBytes);
    await store.write(hash, manifestBytes);
    const graph = (await store.read(manifest.graph.hash))!;
    const plan = planStage(graph, manifest, "first", 15),
      model = await assemble(plan, store, options);
    await gpu.init("first", config, plan.outputs as string[], model);
    options.signal.throwIfAborted();
    const invite: Invitation = {
      version: 1,
      address: p.address(),
      manifest: { hash, bytes: manifestBytes.length },
      secret: crypto.randomUUID(),
    };
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => (ready = resolve));
    void listen(p, closed.signal, async (message, remote) => {
      if (message.secret !== invite.secret)
        throw new Error("Invalid invitation.");
      if (message.type === "join") {
        if (message.address?.id !== remote || (helper && helper.id !== remote))
          throw new Error("This team already has a second device.");
        helper = message.address;
        alive = Date.now();
        return { ok: true };
      }
      if (!helper || helper.id !== remote)
        throw new Error("Join this team first.");
      if (message.type === "ready") {
        alive = Date.now();
        ready();
        return { ok: true };
      }
      if (message.type === "heartbeat") {
        alive = Date.now();
        return { ok: true };
      }
      if (message.type === "leave") {
        options.unavailable(
          "The other device left. Stop this team and invite it again.",
        );
        helper = undefined;
        return { ok: true };
      }
      throw new Error("Unsupported team message.");
    }).catch((error) => {
      if (!disposed) options.unavailable(String(error));
    });
    onInvite(invite);
    options.progress({
      phase: "pairing",
      message: "Waiting for the other device to load its half",
    });
    await Promise.race([
      waiting,
      new Promise<never>((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      ),
    ]);
    options.signal.throwIfAborted();
    heartbeat = setInterval(() => {
      if (!disposed && Date.now() - alive > 120_000)
        options.unavailable(
          "The other device is offline. Keep both tabs visible, then start a new team.",
        );
    }, 5000);
    options.signal.removeEventListener("abort", abort);
    return {
      invite,
      async generate(request, signal, chunk) {
        if (active) throw new Error("This team is already generating.");
        if (!helper || disposed || Date.now() - alive > 120_000)
          throw new Error("The other device is unavailable.");
        prepareGeneration(tokenizer, request);
        active = true;
        const address = helper,
          id = crypto.randomUUID();
        let step = 0;
        try {
          await gpu.reset();
          await rpc(p, address, { type: "begin", id });
          return await generateText(
            tokenizer,
            SMOL_ID,
            request,
            signal,
            async (tokens, temperature) => {
              const first = await gpu.forward(tokens);
              signal.throwIfAborted();
              if (!first.gpuDispatches || first.cacheTensors !== 30)
                throw new Error("First stage GPU inference failed.");
              const second = await rpc(p, address, {
                type: "step",
                id,
                step: step++,
                tokens,
                temperature,
                tensors: first.tensors,
              });
              if (!second.gpuDispatches || second.cacheTensors !== 30)
                throw new Error("Second stage GPU inference failed.");
              return second.token;
            },
            chunk,
          );
        } catch (error) {
          if (!signal.aborted)
            options.unavailable(
              `Team interrupted: ${error instanceof Error ? error.message : String(error)}`,
            );
          throw error;
        } finally {
          await gpu.reset().catch(() => {});
          await rpc(p, address, { type: "end", id }).catch(() => {});
          active = false;
        }
      },
      async dispose() {
        disposed = true;
        closed.abort();
        clearInterval(heartbeat);
        gpu.dispose();
        await p.shutdown();
      },
    };
  } catch (error) {
    disposed = true;
    abort();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    store.close();
  }
}

/** The invited device runs only layers 15–29; it is not advertised as a complete model. */
export async function joinSplit(
  invite: Invitation,
  options: RuntimeOptions,
): Promise<SharedRuntime> {
  const store = await ModelStore.open(),
    gpu = new GpuSession();
  let peer: StagePeer | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let lastCommand = Date.now();
  const closed = new AbortController();
  const state = new StageState(invite.address.id);
  const abort = () => {
    closed.abort();
    gpu.dispose();
    void peer?.shutdown();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    peer = await peerFor(options);
    const p = peer;
    await rpc(p, invite.address, {
      type: "join",
      secret: invite.secret,
      address: p.address(),
    });
    let beating = false,
      lastHeartbeat = Date.now();
    heartbeat = setInterval(async () => {
      if (beating || disposed) return;
      beating = true;
      try {
        await rpc(p, invite.address, {
          type: "heartbeat",
          secret: invite.secret,
        });
        lastHeartbeat = Date.now();
      } catch {
        if (!disposed && Date.now() - lastHeartbeat > 120_000)
          options.unavailable(
            "The host is unreachable. Keep both tabs open, then rejoin the team.",
          );
      } finally {
        beating = false;
      }
    }, 5000);
    options.progress({
      phase: "downloading",
      message: "Receiving the model manifest",
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await store.blob(invite.manifest, p, invite.address, options.signal),
      ),
    ) as Manifest;
    validateManifest(manifest);
    options.progress({
      phase: "downloading",
      message: "Receiving the model graph",
    });
    const graph = await store.blob(
        manifest.graph,
        p,
        invite.address,
        options.signal,
      ),
      plan = planStage(graph, manifest, "second", 15);
    await store.prefetch(
      plan.tensors.flatMap((t: any) => t.chunks),
      p,
      invite.address,
      options,
    );
    const model = await assemble(plan, store, options);
    await gpu.init("second", manifest.config, plan.outputs as string[], model);
    options.signal.throwIfAborted();
    void listen(p, closed.signal, async (message, remote) => {
      state.authorize(remote);
      lastCommand = Date.now();
      if (message.type === "begin") {
        state.begin(remote, message.id);
        await gpu.reset();
        options.progress({
          phase: "busy",
          message: "Running the second half of a reply",
        });
        return { ok: true };
      }
      if (message.type === "end") {
        state.end(remote, message.id);
        await gpu.reset();
        options.progress({
          phase: "ready",
          message: "Paired · layers 15–29 ready",
        });
        return { ok: true };
      }
      if (message.type === "step") {
        state.next(remote, message.id, message.step);
        if (
          !Array.isArray(message.tokens) ||
          message.tokens.length < 1 ||
          message.tokens.length > 1024 ||
          !message.tokens.every(
            (t: any) => Number.isInteger(t) && t >= 0 && t < 49152,
          ) ||
          !Number.isFinite(message.temperature) ||
          message.temperature < 0 ||
          message.temperature > 2
        )
          throw new Error("Invalid stage input.");
        const result = await gpu.forward(message.tokens, message.tensors);
        if (result.pastLength > 1024 || !result.logits)
          throw new Error("Stage context limit exceeded.");
        return {
          token: selectToken(result.logits, message.temperature),
          gpuDispatches: result.gpuDispatches,
          cacheTensors: result.cacheTensors,
        };
      }
      throw new Error("Unsupported stage command.");
    }).catch((error) => {
      if (!disposed) options.unavailable(String(error));
    });
    await rpc(p, invite.address, { type: "ready", secret: invite.secret });
    options.signal.removeEventListener("abort", abort);
    options.progress({
      phase: "ready",
      message: `Paired · layers 15–29 · ${(store.downloaded / 1e6).toFixed(1)} MB received, ${(store.reused / 1e6).toFixed(1)} MB reused`,
    });
    // Bound abandoned KV state. Every generation still explicitly resets before use.
    const idle = setInterval(() => {
      if (Date.now() - lastCommand > 90_000) {
        state.clear();
        void gpu.reset().catch(() => {});
        lastCommand = Date.now();
      }
    }, 15_000);
    return {
      async generate() {
        throw new Error("This tab is a model stage. Chat through the host.");
      },
      async dispose() {
        disposed = true;
        closed.abort();
        clearInterval(heartbeat);
        clearInterval(idle);
        gpu.dispose();
        await rpc(p, invite.address, {
          type: "leave",
          secret: invite.secret,
        }).catch(() => {});
        await p.shutdown();
      },
    };
  } catch (error) {
    disposed = true;
    clearInterval(heartbeat);
    abort();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    store.close();
  }
}
