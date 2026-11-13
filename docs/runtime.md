# Browser runtime

The runtime remains an internal module of meshwebllm. Its first consumer is the actual chat and contribution UI. There is no separate libgrid package yet.

## Boundaries

- `mesh-session.ts` owns a tab's fresh iroh identity, discovery and roster stream.
- `chat-client.ts` selects workers for the chosen model, cancels streams and retries only before any text arrives.
- `contributor.ts` owns one request-queue consumer across model changes, downloads, pause, stop and generation.
- `runtime/types.ts` defines generation, streaming and disposal. ONNX, paired ONNX and WebLLM implement it.
- `runtime/partition.js` derives executable stages from graph dependencies. Byte chunks are a transfer format, not an execution partition.
- `runtime/store.ts` persists verified objects in IndexedDB independently of a session identity.
- `crates/web/src/transport.rs` owns stage RPC and iroh-blobs transport. JavaScript owns model execution.

The completion protocol is still `meshwebllm/infer/0`. A paired coordinator is an ordinary worker to chat clients and the CLI. The invited stage is never advertised as a complete model. Team commands use a separate `meshwebllm/stage/1` ALPN.

## Model preparation and execution

The first ONNX contribution downloads the pinned, original SmolLM2 135M Q4 model and verifies its SHA-256. No Python conversion or native inference service is needed. The host separates graph metadata from serialized tensors and publishes content-addressed chunks of at most 1 MiB through iroh-blobs.

An invited browser gets the manifest and graph, follows dependencies for layers 15–29, fetches the required chunks, verifies them, and assembles its executable ONNX stage locally. Four bounded transfers run concurrently. Verified cached chunks are reused across new invitations. The network stream is Bao/BLAKE3 verified and bounded before accumulation; local cache reads are checked again.

The host runs layers 0–14 and sends two boundary tensors to the helper for each forward pass. The helper runs layers 15–29, selects the next token and returns it. Each stage keeps its own 30 KV tensors on its GPU. The host tokenizes the conversation and decodes streamed output. Whole-model mode uses 60 GPU KV tensors. Runtime checks require GPU dispatches and the expected cache count.

## Trust and lifecycle

An invitation carries a coordinator address, a manifest hash and a random enrollment secret in its URL fragment. Join requires an explicit click. The coordinator binds the first valid join to the authenticated iroh endpoint identity. The helper accepts stage commands only from the authenticated coordinator. Generation IDs and sequential step numbers protect the active KV state from overlapping or out-of-order commands.

Content hashes establish transfer integrity, not publisher trust. A peer can claim the pinned model's identity in its manifest; this preview does not independently reconstruct and authenticate every received weight against a signed upstream manifest. Pair only trusted devices. A model worker can read prompts it processes, and a stage receives tokens and activations. Transport encryption is not private inference.

Closing or stopping a contribution ends its session. Pause stops accepting work and cancels current generation. An unavailable partner removes the team from routing. Recovery uses a new team and invitation; verified cached weights survive. Automatic stage failover is not implemented.

## Limits

- Only the pinned 30-layer SmolLM2 135M graph is supported for splitting, at layer 15.
- Requests are limited to 1,024 tokens including output, with at most 512 output tokens.
- Both stages need the large tied embedding/output-head weights. Each stage artifact is about 149 MB; the host initially loads the complete 182 MB source. This does not halve peak memory.
- Activations cross the network for every generated token. Relay latency can make shared inference much slower than one GPU.
- Browser tabs can be throttled or suspended. Keep both visible while contributing.
- Discovery is bootstrap-assisted gossip. There is no DHT, multi-provider swarming or automatic stage placement.
- The two-browser checks below use one Mac. They do not establish cross-device speedup or hardware compatibility.

## Verification

Run the deterministic tests with the pinned model fixture:

```sh
./scripts/test-model-fixture.sh
npm --prefix web test
npm --prefix web run build
cargo test --workspace --exclude meshwebllm-web
```

Without the fixture, the tokenizer and model-partition integration tests explicitly skip. CI downloads the pinned fixture and runs them. The tests cover graph dependency partitions at layers 1, 15 and 29, reassembly, malformed packets, stage authorization/sequence, tokenizer output/EOS/context limits, model-aware routing, retry boundaries, stream cancellation and interrupted cache downloads.

Browser verification on an Apple Metal GPU, 2026-11-13:

- Whole ONNX chat generated “The capital of France is Paris.” with real WebGPU execution.
- The integrated shared UI transferred 148.9 MB to an empty, separate-origin browser cache through iroh-blobs and generated the same answer. This run used a local transport relay; inference remained in the two browsers.
- Leaving the helper immediately made the team unavailable for new chat requests.
- The optimized production bundle downloaded the original model from its pinned upstream URL, connected to the public pool and generated the same answer over the normal iroh completion path.
- The WebLLM 360M adapter downloaded its weights without Cache.add(), generated the Paris answer and supported immediate cancellation.
- The chat view was visually checked at a 390 × 844 mobile viewport.

The original numerical comparisons, GPU-dispatch evidence and token sequences remain in [the experiment results](../experiments/layer-split/README.md).

## Dependency maintenance

The pinned iroh-blobs/bao-tree stack depends on genawaiter, whose build-time diagnostic macro depends on unmaintained `proc-macro-error`. `deny.toml` records a narrow exception for [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html): an unmaintained-package advisory with no patched version. Replace the exception when the upstream dependency chain changes. Other advisory, license and source checks remain enabled.
