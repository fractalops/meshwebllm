# Keep the distributed runtime inside the product until its interface is exercised

Status: accepted, 2026-11-13.

The browser experiment proved a 15/15 SmolLM2 split, verified peer weight transfer and GPU execution. It did not supply conversation handling, contribution lifecycle, production asset paths or stage ownership.

The application now owns an internal `web/src/runtime` module with a small generation/disposal interface. Whole ONNX, WebLLM and paired ONNX are concrete adapters. The contribution controller consumes that interface and owns the single completion queue. UI state stays outside the runtime. Model preparation owns source pinning, verified content caching, graph partitioning and GPU initialization.

The existing `meshwebllm/infer/0` protocol stays unchanged. A team coordinator serves ordinary completion requests and emits ordinary response frames. Only stage RPC uses the new `meshwebllm/stage/1` ALPN. Stage commands are accepted only from the authenticated coordinator endpoint and carry generation IDs and ordered steps. Invitation secrets authorize enrollment, not arbitrary command execution.

Each open tab gets its own endpoint identity. Model caches persist independently of identities and invitations. Invitations use a URL fragment so the capability is not sent to the static web host.

Shared mode remains a preview. The small supported model has a large tied embedding/output-head matrix, so splitting its transformer layers does not halve artifact or GPU memory. Browser relays and activation readback add latency. A broader `libgrid` package should follow real use and a stable interface, not precede it.
