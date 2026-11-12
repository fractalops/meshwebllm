/** Pool and model settings for the page. */

export const POOL_NAME = "meshwebllm/pool/v1";

export interface ModelSpec {
  id: string;
  downloadGB: number;
  vramGB: number;
}

/** Models the page accepts. Sizes are from the mlc-ai Hugging Face repos and WebLLM's config. */
export const MODELS: ModelSpec[] = [
  { id: "Qwen3-4B-q4f16_1-MLC", downloadGB: 2.28, vramGB: 3.4 },
  { id: "SmolLM2-360M-Instruct-q4f16_1-MLC", downloadGB: 0.21, vramGB: 0.4 },
];

/** The pool model. A `?model=ID` query selects another listed model for tests. */
export const MODEL: ModelSpec =
  MODELS.find((m) => m.id === new URLSearchParams(location.search).get("model")) ?? MODELS[0];

/** Seconds between two status announcements. Matches the core crate. */
export const HEARTBEAT_S = 10;
export const STALE_S = 30;

/**
 * Bootstrap nodes. A `?bootstrap=ID1,ID2` query overrides the build value,
 * which comes from the VITE_BOOTSTRAP environment variable.
 */
export function bootstrapIds(): string[] {
  const fromQuery = new URLSearchParams(location.search).get("bootstrap");
  const raw = fromQuery ?? (import.meta.env.VITE_BOOTSTRAP as string | undefined) ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
