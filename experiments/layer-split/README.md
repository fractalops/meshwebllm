# Browser layer-split experiment

A real SmolLM2-135M inference split: layers 0–14 in one Web Worker, layers 15–29 in another. Each creates its own ONNX Runtime WebGPU session and loads only its stage graph. A third worker loads the original model as the correctness reference. All three use this Mac's physical GPU.

Two transports are available: serialized local worker messages and two browser iroh endpoints. The recorded initial run used `meshwebllm/experiment-stage/0`; rebuilding now uses the product’s `meshwebllm/stage/1` transport. The endpoints live in the coordinating page; GPU work lives in the two workers. The production completion protocol remains unchanged. The Rust stage binding is now part of the normal web crate; `layer-split-experiment` remains a compatibility feature for the setup script.

## Browser-prepared weights over iroh-blobs

The second experiment is `/blobs.html`. Its seed tab parses the **original unsplit ONNX model**, publishes a weight-free graph and independently hashed tensor chunks, and supplies two invitation links. Each consumer tab walks graph dependencies, selects its own contiguous layer range, fetches only the required chunks through **iroh-blobs**, verifies/persists them in IndexedDB, reconstructs its executable ONNX graph in JavaScript, and creates a WebGPU session. There is no Python model preparation in this path.

For developer setup, with Node/npm, `hf`, Rust/Wasm and wasm-bindgen available:

```sh
./setup-browser.sh
npm run dev
```

The setup downloads the original publisher artifact and config unchanged, installs dependencies, and builds the web binding. A deployed site could serve those same source artifacts; participants just open the site. The graph partitioner and tensor publication execute in the browser, not in setup. `onnx-proto` uses an explicit `protobufjs` override to avoid its obsolete transitive dependency; the actual model encode/decode and browser inference tests exercise that combination.

For a reproducible **one-Mac** run, start the optional loopback relay in another terminal:

```sh
cargo run --locked --manifest-path relay/Cargo.toml
```

Open <http://127.0.0.1:5174/blobs.html>, enter `http://127.0.0.1:3340` as the relay, and click **Publish model from this browser**. Open both stage links and keep all three tabs open. When both are ready:

1. Click **Compare distributed inference** for 24 exact full-logit hash comparisons against the original model.
2. Click **Verify cached weights offline** to validate all selected chunks with network fetching disabled. Preserve that cold-run report with `cp artifacts/results/browser-blobs.json artifacts/results/browser-blobs-cold.json`.
3. Reload both stage tabs. Each must reconstruct and load from its separate IndexedDB cache with **zero blob downloads**. Compare again to verify inference after reload.

The native relay is only a loopback transport fixture: no model bytes are prepared, stored persistently or executed there. The actual model providers, consumers and GPU workers are browser code. Leaving the relay field blank uses public relays. Public-relay metadata and some weight chunks transferred in the exploratory run, but full weight delivery was too slow to finish that route; the complete new distribution proof uses loopback. This is not a WAN throughput result.

Run `node summarize-browser.mjs` after the reload comparison to validate both reports and regenerate `browser-results.json`. The recorded run passed 24/24 exact comparisons cold and 24/24 after reload. Cold setup took about 107–115 seconds per stage; cached setup took about 5.7 seconds, with zero blob downloads. These are exploratory one-Mac measurements, not a benchmark. `browser-results.json` records the verified second experiment. Raw per-tab evidence lives in `artifacts/results/browser-blobs*.json`. The worker requires actual GPU dispatches and GPU-resident KV tensors; just obtaining a WebGPU adapter does not pass. Both cold loads deliberately corrupt one cached chunk, require hash rejection and refetch, and record the repair. Offline verification disables **blob fetching in our cache**, not the browser network or the relay used for control messages.

The browser seed still downloads and parses the full 182 MB original model in memory. Consumers fetch stage subsets, but both require the large shared embedding/output-head tensor, so each stage is still about 149 MB. Blobs are at most 1 MiB and represent encoded TensorProto segments; they are transport units, not executable layer boundaries. The manifest supplies the mapping. Content hashes establish integrity relative to the invitation; they do not establish publisher trust.

This is one provider and two consumers, not torrent-style multi-provider scheduling or DHT discovery. There is no arbitrary-model partitioner, automatic placement, stage failover, or streaming parse of the original. IndexedDB is best-effort browser storage and can be evicted. The seed store is in-memory; closing/reloading it invalidates its invitations. Vite hot reload is disabled so code edits cannot silently erase a live seed. `relay/` is a separate optional test crate, outside the production workspace.

Checks:

```sh
node --test packet.test.js browser-partition.test.js
npm audit
npm run build
```

The partition tests use the pinned original model and check dependency closure, layer ownership at cuts 1/15/29, reconstruction and corrupt/truncated input rejection. Only cut 15 has been exercised with GPU inference. The Node fixture store uses SHA-256 for its unit tests; the live browser uses the Rust iroh-blobs protocol and BLAKE3 verification.

## Earlier prebuilt-stage experiment

The following reproduces the first experiment with Python-prepared stage files and the local/iroh activation comparison. It is independent of the browser-prepared workflow above.

## Run

Requirements: `uv`, `hf`, Node/npm, Rust with the `wasm32-unknown-unknown` target, `wasm-bindgen` 0.2.129, and WebGPU-capable Chrome. On macOS the Rust build also needs Homebrew LLVM. Model and stage files occupy about 480 MB, plus dependencies and build output.

From this directory:

```sh
./setup.sh
./build-iroh.sh
npm run dev
```

Open <http://127.0.0.1:5174>, choose a transport and click **Run correctness experiment**. Run both modes, then:

```sh
.venv/bin/python summarize.py
node --test packet.test.js
```

The setup pins the model revision and Python/npm dependencies. Generated models, downloads, Wasm, raw results and environments are ignored. The browser saves raw results through the loopback Vite server to `artifacts/results/`. `results.json` is the condensed checked evidence. `npm run build` is a bundling check; this experimental harness runs through the dev server, which serves model files and captures results.

`CARGO_TARGET_DIR` can point at an existing checkout's target directory when running `build-iroh.sh`, to reuse Rust build artifacts.

## What is checked

- Two prompts of 16 and 24 tokens, each followed by 11 single-token decode calls: 24 comparisons per mode. A fixed step count deliberately continues past EOS to exercise cache growth.
- Local mode compares all 49,152 final-position logits, rejects non-finite values, and requires the same greedy token. Its tolerance is 0.01; the observed maximum error was zero.
- iroh mode returns the greedy token and SHA-256 of the complete logit buffer. Every hash matched the baseline exactly. This avoids returning 192 KiB of logits per decode token.
- Each stage holds 30 KV tensors (key and value for 15 layers). Each output is required to be a GPU-buffer tensor; none is sent over iroh.
- The workers count actual `GPUComputePassEncoder.dispatchWorkgroups` calls. Passing requires non-zero counts for the baseline and both stages, in addition to a physical adapter and GPU-resident KV outputs. Optional GPU timestamp queries are not required.
- Extraction checks dependency closure and the exact transformer weight layer sets. No transformer-layer initializer is shared between stages. ORT validates operator support when loading. The generic ONNX checker rejects an existing nonstandard `SimplifiedLayerNormalization` declaration in the published optimized graph, so it is not used as a false validation claim.

The graph fuses each residual addition into the following normalization. The split therefore carries two `[1, sequence_length, 576]` float32 tensors: **4,608 bytes per decode token**, and 73,728 / 110,592 bytes for these prefills. Attention masks and positions are reconstructed locally from token count. This assumes an unpadded, batch-one sequence.

## Findings and limits

Both local and iroh runs matched exactly. See `results.json` for dates, adapter evidence, per-step timings, hashes of model artifacts and generated text. The first prompt generates “The capital of France is Paris.”

The full model is 182,068,553 bytes; each stage is about 148.7 MB. This is not a 50% weight-memory reduction: the source graph has a large unquantized tied embedding/output-head matrix, needed at both ends, and shared RoPE constants. The transformer weights themselves are partitioned. Artifact bytes are not measured GPU memory consumption.

The local split takes tens of milliseconds per decode step; the tested public-relay iroh route takes roughly 0.6 seconds. These are exploratory wall-clock measurements, with other applications running, not controlled benchmarks. Baseline timing includes the worker round trip and logit readback; split timing includes both worker calls, readback, serialization and transport. The first prefill includes cold shader/connection costs. An earlier diagnostic returning full logits and opening connections repeatedly took a median 3.9 seconds per decode; compact replies and connection reuse were changed together, so their individual contributions were not isolated.

The first experiment proves browser execution of separately prepared graphs, independent stage weights/KV state, and actual iroh activation transfer on one Mac. It does **not** prove pooled physical GPU memory, multi-device speedup, useful WAN latency, long-context behavior, failure recovery, batching, or production scheduling. The current iroh reply still includes diagnostic metadata. The first performance follow-up should compare nearby devices and relay routes; whole-model worker routing remains preferable for models that fit one device.

## MLC investigation

The downloaded `mlc-llm-nightly-cpu` 0.26.dev6 pipeline rewrite explicitly generates `runtime.disco.recv_from_prev_group`, `runtime.disco.send_to_next_group`, and `mlc.multi_gpu.DispatchFunctionByGroup`. `probe_mlc.py` audits those source constants without importing native libraries. It is a source audit, not a compilation result.

The native TVM wheel (`mlc-ai-nightly-cpu` 0.26.dev246) could not be imported on this Mac: the process exited 137; `codesign --verify` reported invalid signatures on its runtime and compiler libraries. No signature bypass or native compiler rebuild was attempted. ONNX was used for the working browser experiment. This does not establish that extending MLC is impossible; it establishes a working smaller route for the prototype.

Optional source audit, separate from the inference setup:

```sh
uv pip install --python .venv/bin/python --no-deps --find-links https://mlc.ai/wheels mlc-llm-nightly-cpu==0.26.dev6
.venv/bin/python probe_mlc.py
```

Primary sources: [MLC pipeline pass](https://github.com/mlc-ai/mlc-llm/blob/main/python/mlc_llm/compiler_pass/pipeline_parallel_rewrite.py), [ORT WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), [pinned SmolLM2 model](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/tree/12fd25f77366fa6b3b4b768ec3050bf629380bac).
