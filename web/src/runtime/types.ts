import type { CompletionRequest } from "../types";
export type Phase =
  | "downloading"
  | "preparing"
  | "pairing"
  | "ready"
  | "busy"
  | "paused"
  | "error"
  | "stopped";
export interface RuntimeProgress {
  phase: Phase;
  message: string;
  loaded?: number;
  total?: number;
}
export interface Completion {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}
export interface Runtime {
  generate(
    request: CompletionRequest,
    signal: AbortSignal,
    chunk: (text: string) => Promise<void>,
  ): Promise<Completion>;
  dispose(): Promise<void>;
}
export interface RuntimeOptions {
  signal: AbortSignal;
  progress: (progress: RuntimeProgress) => void;
  unavailable: (reason: string) => void;
}
export interface PeerAddress {
  id: string;
  addrs: unknown[];
}
export interface Chunk {
  hash: string;
  bytes: number;
}
export interface ModelConfig {
  hidden_size: number;
  num_hidden_layers: number;
  num_attention_heads: number;
  num_key_value_heads: number;
  vocab_size: number;
}
export interface Manifest {
  version: number;
  source: { sha256: string; revision: string };
  config: ModelConfig;
  graph: Chunk;
  tensors: Array<{ name: string; bytes: number; chunks: Chunk[] }>;
}
export interface TensorData {
  type: string;
  dims: number[];
  data: Float32Array;
}
export interface ForwardResult {
  logits?: Float32Array;
  tensors: Record<string, TensorData>;
  token?: number;
  cacheTensors: number;
  gpuDispatches: number;
  runMs: number;
  pastLength: number;
}
