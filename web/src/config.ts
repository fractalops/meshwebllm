export const POOL_NAME = "meshwebllm/pool/v1";
export const SMOL_ID = "SmolLM2-135M-Instruct-ONNX-Q4";
export interface ModelSpec {
  id: string;
  name: string;
  description: string;
  downloadMB: number;
  runtime: "onnx" | "webllm";
  shared: boolean;
}
export const MODELS: ModelSpec[] = [
  {
    id: SMOL_ID,
    name: "SmolLM2 · 135M",
    description:
      "A small model for quick experiments. Run it here or split its layers with a friend.",
    downloadMB: 182,
    runtime: "onnx",
    shared: true,
  },
  {
    id: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    name: "SmolLM2 · 360M",
    description: "A lightweight chat model running on one browser GPU.",
    downloadMB: 210,
    runtime: "webllm",
    shared: false,
  },
  {
    id: "Qwen3-4B-q4f16_1-MLC",
    name: "Qwen3 · 4B",
    description:
      "More capable, with a larger download. Needs about 3.4 GB of GPU memory.",
    downloadMB: 2280,
    runtime: "webllm",
    shared: false,
  },
];
export const initialModel = () =>
  MODELS.find(
    (m) => m.id === new URLSearchParams(location.search).get("model"),
  ) ?? MODELS[0];
export function bootstrapIds(): string[] {
  return (
    new URLSearchParams(location.search).get("bootstrap") ??
    import.meta.env.VITE_BOOTSTRAP ??
    ""
  )
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
}
/** Local test overrides are not accepted by the deployed app. */
export function testRelay(): string | undefined {
  return import.meta.env.DEV
    ? (new URLSearchParams(location.search).get("relay") ?? undefined)
    : undefined;
}
