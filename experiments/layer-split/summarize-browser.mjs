import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const read = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`./artifacts/results/${name}.json`, import.meta.url),
    ),
  );
const cold = await read("browser-blobs-cold");
const warm = await read("browser-blobs");
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};
for (const run of [cold, warm]) {
  assert.equal(run.passed, true);
  const steps = run.tests.flatMap((t) => t.steps);
  assert.equal(steps.length, 24);
  let previous = [0, 0, 0];
  for (const row of steps) {
    assert.ok(row.exact);
    assert.equal(row.baselineHash, row.splitHash);
    assert.equal(row.baselineToken, row.splitToken);
    assert.deepEqual(row.cacheTensors, [30, 30]);
    row.gpuDispatches.forEach((count, i) => assert.ok(count > previous[i]));
    previous = row.gpuDispatches;
    if (row.step > 0) assert.equal(row.activationBytes, 4608);
  }
}
const stageReport = {};
for (const role of ["first", "second"]) {
  const c = cold.stages[role],
    w = warm.stages[role];
  assert.equal(c.sourceHttpRequests, 0);
  assert.equal(w.sourceHttpRequests, 0);
  assert.equal(c.cold.networkRequests, c.uniqueBlobs);
  assert.deepEqual(c.corruption, { rejected: true, refetched: true });
  assert.equal(w.reloadUsedOnlyCache, true);
  assert.equal(w.cold.networkRequests, 0);
  assert.equal(w.cold.networkBytes, 0);
  assert.equal(c.modelSha256, w.modelSha256);
  assert.deepEqual(cold.offline[role], {
    verifiedBlobs: c.uniqueBlobs,
    networkRequests: 0,
  });
  stageReport[role] = {
    layers: c.layers,
    modelBytes: c.modelBytes,
    modelSha256: c.modelSha256,
    selectedWeightBytes: c.selectedWeightBytes,
    totalWeightBytes: c.totalWeightBytes,
    uniqueBlobs: c.uniqueBlobs,
    cold: c.cold,
    corruption: c.corruption,
    coldSetupMs: c.setupMs,
    reloadSetupMs: w.setupMs,
    reload: w.cold,
    sourceHttpRequests: w.sourceHttpRequests,
    offline: cold.offline[role],
    adapter: c.adapter,
  };
}
assert.notEqual(cold.stages.first.address.id, cold.stages.second.address.id);
assert.notEqual(cold.address.id, cold.stages.first.address.id);
assert.notEqual(cold.address.id, cold.stages.second.address.id);
const summarizeRun = (run) => ({
  exactComparisons: run.tests.flatMap((t) => t.steps).length,
  decodeMedianMs: median(
    run.tests
      .flatMap((t) => t.steps)
      .filter((s) => s.step > 0)
      .map((s) => s.splitMs),
  ),
  tests: run.tests,
});
const report = {
  version: 1,
  verifiedAt: new Date().toISOString(),
  passed: true,
  experiment:
    "Browser-prepared SmolLM2 stages and iroh-blobs weight distribution",
  environment: {
    userAgent: warm.userAgent,
    relay: warm.address.addrs,
    devices: 1,
    browserTabs: 3,
  },
  manifest: cold.manifest,
  stages: stageReport,
  coldInference: summarizeRun(cold),
  cachedInference: summarizeRun(warm),
  limits: [
    "One Mac and one physical GPU; this does not prove multi-device memory pooling or speedup.",
    "Complete distribution used a loopback iroh relay. Public-relay bulk transfer remains unproven.",
    "Seed parses the full original model in browser memory; no streaming import.",
    "Pinned model export only; GPU execution verified at the 15/15 layer split.",
    "Each stage still needs the large shared embedding/output head; model bytes are not measured GPU memory.",
    "One seed provider; no DHT, swarming, automatic placement or failover.",
    "Offline test disables blob fetching, while control messages still use the relay.",
  ],
};
await writeFile(
  new URL("./browser-results.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Verified ${report.coldInference.exactComparisons} cold + ${report.cachedInference.exactComparisons} cached comparisons; both reloads downloaded zero blobs.`,
);
