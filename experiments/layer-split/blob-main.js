import init, { StagePeer } from "./artifacts/iroh/meshwebllm_web.js";
import {
  publishModel,
  planStage,
  assembleStage,
  sha256,
  SOURCE,
} from "./browser-partition.js";
import { BlobCache } from "./blob-cache.js";
import { pack, unpack } from "./packet.js";
import { tests } from "./test-prompts.js";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search),
  role = params.get("role") || "seed";
let peer,
  manifest,
  baseline,
  run,
  cache,
  plan,
  stageEvidence,
  allChunks,
  seedOriginal;
const stages = new Map();
const evidence = {
  version: 2,
  date: new Date().toISOString(),
  transport: "browser-blobs",
  role,
  userAgent: navigator.userAgent,
  events: [],
};
function note(message) {
  $("status").textContent = message;
  $("log").textContent += message + "\n";
  $("log").scrollTop = $("log").scrollHeight;
}
function fail(e) {
  $("status").className = "bad";
  note("FAIL — " + (e.stack || String(e)));
}
window.addEventListener("unhandledrejection", (e) => fail(e.reason));
window.addEventListener("error", (e) => fail(e.error || e.message));
function worker() {
  const w = new Worker(new URL("./model-worker.js", import.meta.url), {
    type: "module",
  });
  let id = 0;
  const pending = new Map();
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (p) {
      pending.delete(data.id);
      clearTimeout(p.timer);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    }
  };
  w.onerror = (e) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(e.message));
    }
    pending.clear();
  };
  const rpc = (method, args) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`Worker ${method} timed out`));
      }, 120000);
      pending.set(n, { resolve, reject, timer });
      w.postMessage({ id: n, method, args });
    });
  rpc.close = () => w.terminate();
  return rpc;
}
function best(a) {
  let n = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[n]) n = i;
  return n;
}
async function request(address, message) {
  const result = unpack(await peer.request(address, pack(message)));
  if (result.error) throw new Error(result.error);
  return result;
}
async function save(name, data) {
  $("results").textContent = JSON.stringify(data, null, 2);
  const response = await fetch("/save-results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, transport: name }),
  });
  if (!response.ok)
    throw new Error(`Saving evidence failed: HTTP ${response.status}`);
}
async function listen(handler) {
  while (true) {
    const job = await peer.nextJob();
    if (!job) return;
    let response;
    try {
      response = await handler(unpack(await job.payload()));
    } catch (e) {
      response = { error: e.stack || String(e) };
    }
    try {
      await job.respond(pack(response));
    } catch (e) {
      note("Reply failed: " + e.message);
    }
  }
}
async function makePeer(relay) {
  await init();
  const p = await StagePeer.spawn(relay || undefined);
  await p.online();
  return p;
}

async function startSeed() {
  $("publish").disabled = true;
  try {
    peer = await makePeer($("relay").value.trim());
    evidence.address = peer.address();
    listen(async (message) => {
      if (message.type === "ready") {
        stages.set(message.role, {
          address: message.address,
          evidence: message.evidence,
        });
        note(
          `${message.role}: READY · ${message.evidence.networkMiB.toFixed(1)} MiB fetched · ${message.evidence.layers.length} layers`,
        );
        $("summary").textContent = [...stages]
          .map(
            ([name, s]) =>
              `${name}: layers ${s.evidence.layers.join(",")} | ${s.evidence.cold.networkRequests} blob requests | ${s.evidence.sourceHttpRequests} model HTTP requests`,
          )
          .join("\n");
        $("compare").disabled = stages.size !== 2;
        $("verify-cache").disabled = stages.size !== 2;
        return { ok: true };
      }
      if (message.type === "progress") {
        note(`${message.role}: ${message.text}`);
        return { ok: true };
      }
      throw new Error("Unknown seed request");
    }).catch(fail);
    note("Loading original ONNX artifact in the seeding browser…");
    seedOriginal = new Uint8Array(
      await (await fetch(SOURCE.url)).arrayBuffer(),
    );
    const config = await (await fetch("/artifacts/source/config.json")).json();
    note("Indexing tensors and publishing verified blobs in this browser…");
    manifest = await publishModel(
      seedOriginal,
      config,
      (b) => peer.addBlob(b),
      (p) => {
        if (p.tensors % 30 === 0)
          note(
            `Published ${p.tensors} tensors · ${(p.bytes / 1048576).toFixed(1)} MiB`,
          );
      },
    );
    const encoded = new TextEncoder().encode(JSON.stringify(manifest));
    const hash = await peer.addBlob(encoded);
    evidence.manifest = {
      hash,
      bytes: encoded.length,
      graphBytes: manifest.graph.bytes,
      tensors: manifest.tensors.length,
      source: manifest.source,
    };
    const runId = crypto.randomUUID();
    for (const stage of ["first", "second"]) {
      const invite = {
        address: peer.address(),
        manifest: { hash, bytes: encoded.length },
        runId,
        split: 15,
        relay: $("relay").value.trim(),
      };
      const url = new URL("/blobs.html", location.origin);
      url.searchParams.set("role", stage);
      url.searchParams.set("invite", btoa(JSON.stringify(invite)));
      const link = document.createElement("a");
      link.className = "action";
      link.href = url.href;
      link.target = "_blank";
      link.textContent = `Open ${stage} stage`;
      $("invites").append(link);
    }
    note(
      `Seed ready: ${manifest.tensors.length} tensors, ${(manifest.graph.bytes / 1024).toFixed(0)} KiB graph. Open both stage links.`,
    );
    $("summary").textContent =
      "Model partitioning and chunk publication ran in this tab. Waiting for stage peers.";
  } catch (e) {
    fail(e);
    $("publish").disabled = false;
  }
}

async function startStage() {
  $("seed-controls").hidden = true;
  $("title").textContent =
    `${role === "first" ? "First" : "Second"} stage · browser peer`;
  const invite = JSON.parse(atob(params.get("invite")));
  note("Connecting to the seeding browser…");
  peer = await makePeer(invite.relay);
  const database = `libgrid-blobs-${invite.runId}-${role}`;
  cache = await BlobCache.open(database, peer, invite.address, (bytes, hash) =>
    StagePeer.verifyBlob(bytes, hash),
  );
  const stored = localStorage.getItem(database + "-evidence");
  const notify = (text) =>
    request(invite.address, { type: "progress", role, text }).catch(() => {});
  note("Fetching manifest and graph through iroh-blobs…");
  manifest = JSON.parse(
    new TextDecoder().decode(await cache.get(invite.manifest)),
  );
  const graph = await cache.get(manifest.graph);
  plan = planStage(graph, manifest, role, invite.split);
  allChunks = [
    invite.manifest,
    manifest.graph,
    ...plan.tensors.flatMap((t) => t.chunks),
  ];
  const unique = new Map(allChunks.map((c) => [c.hash, c]));
  const start = performance.now();
  note(
    `Browser selected layers ${plan.layers[0]}–${plan.layers.at(-1)}; downloading ${unique.size} unique blobs…`,
  );
  let last = 0;
  await cache.prefetch([...unique.values()], (p) => {
    if (performance.now() - last > 1000 || p.done === p.total) {
      last = performance.now();
      const text = `${p.done}/${p.total} chunks · ${(p.bytes / 1048576).toFixed(1)} MiB verified`;
      note(text);
      notify(text);
    }
  });
  const cold = { ...cache.stats };
  // A deliberately corrupted IndexedDB entry must be rejected and downloaded again.
  let corruption;
  if (!stored) {
    const chosen = [...unique.values()]
      .filter((c) => c.bytes > 0)
      .sort((a, b) => a.bytes - b.bytes)[0];
    const bad = (await cache.read(chosen.hash)).slice();
    bad[0] ^= 1;
    await cache.write(chosen.hash, bad);
    const before = { ...cache.stats };
    await cache.get(chosen);
    corruption = {
      rejected: cache.stats.corruptEntries - before.corruptEntries === 1,
      refetched: cache.stats.networkRequests - before.networkRequests === 1,
    };
    if (!corruption.rejected || !corruption.refetched)
      throw new Error("Corrupt cache entry was not repaired");
  }
  note("Assembling executable ONNX stage entirely in this browser…");
  const bytes = await assembleStage(plan, (c) =>
    cache.get(c, { offline: true }),
  );
  const modelSha256 = await sha256(bytes);
  run = worker();
  const spec = { outputs: plan.outputs, inputs: plan.inputs };
  const initialized = await run("init", {
    role,
    manifest: { config: manifest.config, models: { [role]: spec } },
    modelBytes: bytes,
  });
  const sourceHttpRequests = performance
    .getEntriesByType("resource")
    .filter((r) =>
      /\/artifacts\/(source|first\.onnx|second\.onnx|manifest\.json)/.test(
        r.name,
      ),
    ).length;
  if (sourceHttpRequests)
    throw new Error("A consumer fetched model data through HTTP");
  const details = {
    role,
    address: peer.address(),
    database,
    loadedAt: new Date().toISOString(),
    layers: plan.layers,
    modelBytes: bytes.length,
    modelSha256,
    sourceHttpRequests,
    uniqueBlobs: unique.size,
    selectedWeightBytes: plan.tensors.reduce((n, t) => n + t.bytes, 0),
    totalWeightBytes: manifest.tensors.reduce((n, t) => n + t.bytes, 0),
    cold,
    networkMiB: cold.networkBytes / 1048576,
    setupMs: performance.now() - start,
    corruption: corruption ?? JSON.parse(stored).corruption,
    adapter: initialized.adapter,
  };
  if (stored) {
    details.previousLoad = JSON.parse(stored);
    details.reloadUsedOnlyCache = cold.networkRequests === 0;
    if (!details.reloadUsedOnlyCache)
      throw new Error("Reload unexpectedly downloaded cached weights");
  }
  stageEvidence = details;
  localStorage.setItem(database + "-evidence", JSON.stringify(details));
  await save(`browser-blobs-${role}`, details);
  listen(async (message) => {
    if (message.type === "run") {
      const result = await run("run", message.args);
      if (result.logits) {
        result.token = best(result.logits);
        result.logitHash = await sha256(result.logits);
        delete result.logits;
      }
      return result;
    }
    if (message.type === "reset") {
      await run("reset");
      return { ok: true };
    }
    if (message.type === "offline") {
      const before = cache.stats.networkRequests;
      await cache.prefetch(allChunks, () => {}, true);
      const result = {
        verifiedBlobs: new Set(allChunks.map((c) => c.hash)).size,
        networkRequests: cache.stats.networkRequests - before,
      };
      stageEvidence.offline = result;
      await save(`browser-blobs-${role}`, stageEvidence);
      return result;
    }
    throw new Error("Unknown stage request");
  }).catch(fail);
  await request(invite.address, {
    type: "ready",
    role,
    address: peer.address(),
    evidence: details,
  });
  $("status").className = "good";
  note(`READY — ${role} stage assembled in browser; GPU session loaded.`);
  $("summary").textContent =
    `${plan.layers.length} layers · ${(bytes.length / 1048576).toFixed(1)} MiB stage\n${cold.networkRequests} peer blob requests · ${sourceHttpRequests} HTTP model requests\n${stored ? "Reload: all weights reused from IndexedDB" : "Corrupt-cache test: rejected and repaired"}\nReload this tab to test persistent cache reuse.`;
}

async function compare() {
  $("compare").disabled = true;
  const records = [];
  try {
    note("Loading the original model into a separate baseline GPU worker…");
    baseline = worker();
    await baseline("init", {
      role: "baseline",
      manifest: {
        config: manifest.config,
        models: {
          baseline: {
            outputs: [
              "logits",
              ...Array.from({ length: 30 }, (_, i) => [
                `present.${i}.key`,
                `present.${i}.value`,
              ]).flat(),
            ],
          },
        },
      },
      modelBytes: seedOriginal,
    });
    const first = stages.get("first").address,
      second = stages.get("second").address;
    for (const test of tests) {
      await baseline("reset");
      await request(first, { type: "reset" });
      await request(second, { type: "reset" });
      let tokens = test.tokens;
      const steps = [];
      for (let step = 0; step < test.steps; step++) {
        const reference = await baseline("run", { tokens });
        const start = performance.now();
        const a = await request(first, { type: "run", args: { tokens } });
        const b = await request(second, {
          type: "run",
          args: { tokens, tensors: a.tensors },
        });
        const expected = await sha256(reference.logits),
          exact = expected === b.logitHash;
        const row = {
          step,
          inputTokens: tokens.length,
          exact,
          baselineToken: best(reference.logits),
          splitToken: b.token,
          activationBytes: Object.values(a.tensors).reduce(
            (n, t) => n + t.data.byteLength,
            0,
          ),
          splitMs: performance.now() - start,
          gpuDispatches: [
            reference.gpuDispatches,
            a.gpuDispatches,
            b.gpuDispatches,
          ],
          cacheTensors: [a.cacheTensors, b.cacheTensors],
          baselineHash: expected,
          splitHash: b.logitHash,
        };
        if (
          !exact ||
          row.baselineToken !== row.splitToken ||
          row.gpuDispatches.some((n) => !n) ||
          row.cacheTensors.some((n) => n !== 30)
        )
          throw new Error("Distributed output or GPU evidence mismatch");
        steps.push(row);
        tokens = [b.token];
        note(
          `${test.name} step ${step}: exact logits · token ${b.token} · ${row.splitMs.toFixed(0)} ms`,
        );
      }
      records.push({ name: test.name, steps });
    }
    evidence.stages = Object.fromEntries(
      [...stages].map(([k, v]) => [k, v.evidence]),
    );
    evidence.tests = records;
    evidence.passed = true;
    await save("browser-blobs", evidence);
    $("status").className = "good";
    note(
      "PASS — browser-built stages, peer-fetched weights, real GPU inference, and all 24 logit hashes match.",
    );
    $("summary").textContent =
      "24 / 24 exact logit comparisons\n2 independent stage tabs · 30 GPU KV tensors each\nNo consumer HTTP model downloads · no Python model preparation\nWeight bytes transferred through iroh-blobs; activations through iroh streams.";
  } catch (e) {
    evidence.passed = false;
    evidence.error = e.stack || String(e);
    await save("browser-blobs", evidence);
    fail(e);
  } finally {
    baseline?.close();
    baseline = undefined;
    $("compare").disabled = false;
  }
}
$("publish").onclick = startSeed;
$("compare").onclick = compare;
$("verify-cache").onclick = async () => {
  try {
    const results = {};
    for (const [role, stage] of stages)
      results[role] = await request(stage.address, { type: "offline" });
    evidence.offline = results;
    await save("browser-blobs", evidence);
    note("PASS — both stage caches verified with network fetching disabled.");
  } catch (e) {
    fail(e);
  }
};
if (role !== "seed") startStage().catch(fail);
