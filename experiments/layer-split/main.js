import { pack, unpack } from "./packet.js";

const button = document.querySelector("#run");
const status = document.querySelector("#status");
const log = document.querySelector("#log");
const results = document.querySelector("#results");
let workers = [],
  peers = [],
  peerLoop;
function worker() {
  const w = new Worker(new URL("./model-worker.js", import.meta.url), {
    type: "module",
  });
  workers.push(w);
  let sequence = 0;
  const pending = new Map();
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (p) {
      pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    }
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message));
    pending.clear();
  };
  return (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      w.postMessage({ id, method, args });
    });
}
function argmax(a) {
  let best = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
  return best;
}
async function digest(a) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", a))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function compare(a, b) {
  if (a.length !== b.length || !a.length)
    throw new Error("Logit size mismatch");
  let maxAbs = 0,
    sum = 0,
    finite = true;
  for (let i = 0; i < a.length; i++) {
    const e = Math.abs(a[i] - b[i]);
    maxAbs = Math.max(maxAbs, e);
    sum += e * e;
    finite &&= Number.isFinite(a[i]) && Number.isFinite(b[i]);
  }
  return {
    maxAbs,
    rms: Math.sqrt(sum / a.length),
    finite,
    baselineToken: argmax(a),
    splitToken: argmax(b),
  };
}
function note(text) {
  status.textContent = text;
  log.textContent += `${text}\n`;
}
async function irohRoute(stage1) {
  const { default: init, StagePeer } = await import(
    "./artifacts/iroh/meshwebllm_web.js"
  );
  await init();
  const source = await StagePeer.spawn(),
    target = await StagePeer.spawn();
  peers = [source, target];
  // Let the relay address become available before handing it to the requester.
  let address;
  for (let i = 0; i < 100; i++) {
    address = target.address();
    if (JSON.stringify(address).includes("https://")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  note(
    `iroh peers: ${source.endpointId().slice(0, 12)} → ${target.endpointId().slice(0, 12)}`,
  );
  peerLoop = (async () => {
    while (true) {
      const job = await target.nextJob();
      if (!job) break;
      let response;
      try {
        response = await stage1("run", unpack(await job.payload()));
        response.logitHash = await digest(response.logits);
        response.token = argmax(response.logits);
        delete response.logits;
      } catch (e) {
        response = { error: String(e) };
      }
      await job.respond(pack(response));
    }
  })();
  peerLoop.catch((e) => note(`iroh responder stopped: ${e.message}`));
  return {
    address,
    source: source.endpointId(),
    target: target.endpointId(),
    run: async (args) => {
      const request = pack(args);
      const start = performance.now();
      const response = await source.request(address, request);
      const result = unpack(response);
      if (result.error) throw new Error(result.error);
      return {
        ...result,
        roundTripMs: performance.now() - start,
        requestBytes: request.byteLength,
        responseBytes: response.byteLength,
      };
    },
  };
}
button.onclick = async () => {
  button.disabled = true;
  log.textContent = "";
  results.textContent = "";
  status.className = "";
  const evidence = {
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    transport: document.querySelector("#transport").value,
    tests: [],
  };
  try {
    const manifest = await (await fetch("/artifacts/manifest.json")).json();
    evidence.model = manifest.source;
    evidence.artifacts = manifest.models;
    const baseline = worker(),
      first = worker(),
      second = worker();
    evidence.workers = [];
    for (const [role, run] of [
      ["baseline", baseline],
      ["first", first],
      ["second", second],
    ]) {
      note(`Loading ${role} weights and WebGPU session…`);
      evidence.workers.push(await run("init", { role, manifest }));
    }
    let route;
    if (evidence.transport === "iroh") {
      note("Connecting browser iroh peers…");
      route = await irohRoute(second);
      evidence.peers = {
        address: route.address,
        source: route.source,
        target: route.target,
      };
    }
    for (const test of manifest.tests) {
      await Promise.all([baseline("reset"), first("reset"), second("reset")]);
      const steps = [];
      let tokens = test.tokens;
      for (let step = 0; step < test.steps; step++) {
        const baselineStart = performance.now();
        const reference = await baseline("run", { tokens });
        const baselineMs = performance.now() - baselineStart;
        const start = performance.now();
        const a = await first("run", { tokens });
        const transferStart = performance.now();
        const args = { tokens, tensors: a.tensors };
        // Round-trip serialization is also exercised by the local control.
        const b = route
          ? await route.run(args)
          : await second("run", unpack(pack(args)));
        const splitMs = performance.now() - start;
        const comparison = route
          ? {
              exactHashMatch: (await digest(reference.logits)) === b.logitHash,
              baselineToken: argmax(reference.logits),
              splitToken: b.token,
              finite: reference.logits.every(Number.isFinite),
            }
          : compare(reference.logits, b.logits);
        const activationBytes = Object.values(a.tensors).reduce(
          (n, t) => n + t.data.byteLength,
          0,
        );
        const row = {
          step,
          prefill: step === 0,
          inputTokens: tokens.length,
          ...comparison,
          baselineMs,
          baselineSessionMs: reference.runMs,
          firstMs: a.runMs,
          secondMs: b.runMs,
          splitMs,
          boundaryAndSecondMs: performance.now() - transferStart,
          activationBytes,
          requestBytes: b.requestBytes,
          responseBytes: b.responseBytes,
          roundTripMs: b.roundTripMs,
          cacheTensors: [a.cacheTensors, b.cacheTensors],
          gpuDispatches: [
            reference.gpuDispatches,
            a.gpuDispatches,
            b.gpuDispatches,
          ],
        };
        steps.push(row);
        note(
          `${test.name} ${step === 0 ? "prefill" : `decode ${step}`}: token ${comparison.splitToken} · ${route ? (comparison.exactHashMatch ? "exact SHA-256 match" : "HASH MISMATCH") : `max logit Δ ${comparison.maxAbs.toExponential(2)}`} · ${activationBytes} activation bytes · ${splitMs.toFixed(0)} ms split`,
        );
        if (
          !comparison.finite ||
          comparison.baselineToken !== comparison.splitToken ||
          (route ? !comparison.exactHashMatch : comparison.maxAbs > 0.01)
        )
          throw new Error("Split diverged from baseline");
        tokens = [comparison.baselineToken];
      }
      evidence.tests.push({ name: test.name, steps });
    }
    if (
      evidence.tests.some((t) => t.steps.at(-1).gpuDispatches.some((n) => !n))
    )
      throw new Error("No WebGPU dispatch evidence");
    evidence.passed = true;
    note(
      "PASS — all greedy tokens match; every logit within tolerance; both stage KV caches remain on GPU.",
    );
    status.className = "good";
  } catch (e) {
    evidence.passed = false;
    evidence.error = e.stack || String(e);
    note(`FAIL — ${e.message}`);
    status.className = "bad";
  } finally {
    results.textContent = JSON.stringify(evidence, null, 2);
    await fetch("/save-results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evidence),
    }).catch(() => {});
    for (const peer of peers) await peer.shutdown();
    peers = [];
    workers.forEach((w) => w.terminate());
    workers = [];
    button.disabled = false;
  }
};
