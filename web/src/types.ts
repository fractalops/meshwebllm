/** Shapes shared with the Wasm module. They mirror the core crate. */

export type WorkerState =
  | { loading: { percent: number } }
  | "idle"
  | "busy"
  | "paused";

export interface WorkerInfo {
  state: WorkerState;
  model: string;
  adapter: string;
  active: number;
  waiting: number;
  served: number;
  tokensOut: number;
  tokensPerSec: number;
  uptimeSecs: number;
}

export interface Member {
  id: string;
  info: WorkerInfo;
  firstSeenMs: number;
  lastSeenMs: number;
  stale: boolean;
}

export interface PoolEvent {
  kind: "joined" | "left" | "stale" | "expired";
  id: string;
}

export interface ChatMessage {
  role: "System" | "User" | "Assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  max_tokens: number | null;
  temperature: number | null;
}

export function stateName(s: WorkerState): "loading" | "idle" | "busy" | "paused" {
  return typeof s === "string" ? s : "loading";
}

export function shortId(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
