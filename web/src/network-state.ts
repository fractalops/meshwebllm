import type { Member } from "./types";

export interface ActivityEvent {
  id: number;
  at: number;
  worker: string;
  model: string;
  message: string;
}
export interface ActivitySample {
  at: number;
  active: number;
  queued: number;
}
export interface NetworkHistory {
  events: ActivityEvent[];
  samples: ActivitySample[];
}
export function workerStatus(member: Member): string {
  if (member.stale) return "Offline";
  if (typeof member.info.state === "object") return "Loading";
  if (member.info.state === "idle" && member.info.waiting >= 2)
    return "Queue full";
  return { idle: "Available", busy: "Answering", paused: "Paused" }[
    member.info.state
  ];
}
export function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Observed activity only: no inferred peer links or synthetic history. */
export class NetworkTimeline {
  history: NetworkHistory = { events: [], samples: [] };
  private previous = new Map<
    string,
    { status: string; model: string; served: number }
  >();
  private sequence = 0;
  observe(members: Member[], now = Date.now()): NetworkHistory {
    const events: ActivityEvent[] = [];
    const event = (worker: string, model: string, message: string) =>
      events.unshift({ id: ++this.sequence, at: now, worker, model, message });
    const next = new Map<
      string,
      { status: string; model: string; served: number }
    >();
    for (const member of members) {
      const current = {
        status: workerStatus(member),
        model: member.info.model,
        served: count(member.info.served),
      };
      const before = this.previous.get(member.id);
      if (!before) event(member.id, current.model, "Worker discovered");
      else if (
        current.status !== before.status ||
        current.model !== before.model
      )
        event(member.id, current.model, current.status);
      else if (current.served > before.served)
        event(
          member.id,
          current.model,
          `${current.served - before.served} request${current.served - before.served === 1 ? "" : "s"} completed`,
        );
      next.set(member.id, current);
    }
    for (const [id, before] of this.previous)
      if (!next.has(id)) event(id, before.model, "Worker left view");
    this.previous = next;
    let samples = this.history.samples;
    if (!samples.length || now - samples.at(-1)!.at >= 2000) {
      const live = members.filter((member) => !member.stale);
      samples = [
        ...samples,
        {
          at: now,
          active: live.reduce((n, m) => n + count(m.info.active), 0),
          queued: live.reduce((n, m) => n + count(m.info.waiting), 0),
        },
      ]
        .filter((sample) => sample.at >= now - 180_000)
        .slice(-90);
    }
    this.history = {
      events: [...events, ...this.history.events].slice(0, 50),
      samples,
    };
    return this.history;
  }
}

/** The current publisher appends this marker only for a split coordinator.
 * It describes the reported configuration, not independent stage health. */
export function executionMode(member: Member): string {
  return member.info.adapter.endsWith(" · 2 devices")
    ? "Two-device team"
    : "Single device";
}
export function relativeSeen(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
