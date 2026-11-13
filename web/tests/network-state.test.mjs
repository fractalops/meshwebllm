import test from "node:test";
import assert from "node:assert/strict";
import { NetworkTimeline } from "../src/network-state.ts";
const member = (state = "idle", active = 0) => ({
  id: "worker",
  stale: false,
  info: { model: "model", state, active, waiting: 0, served: 0 },
});
test("dashboard records observed transitions, excludes stale load, and bounds session history", () => {
  const timeline = new NetworkTimeline();
  timeline.observe([member()], 0);
  timeline.observe([member()], 1000);
  assert.equal(timeline.history.events.length, 1);
  assert.equal(timeline.history.samples.length, 1);
  timeline.observe([member("busy", 1)], 2000);
  assert.equal(timeline.history.events[0].message, "Answering");
  assert.equal(timeline.history.samples.at(-1).active, 1);
  timeline.observe([{ ...member("busy", 1), stale: true }], 4000);
  assert.equal(timeline.history.samples.at(-1).active, 0);
  timeline.observe([], 6000);
  assert.equal(timeline.history.events[0].message, "Worker left view");
  for (let i = 4; i < 120; i++)
    timeline.observe([member(i % 2 ? "busy" : "idle")], i * 2000);
  assert.equal(timeline.history.samples.length, 90);
  assert.equal(timeline.history.events.length, 50);
});
