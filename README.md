# meshwebllm

**Choose a model and chat. Let the network choose the worker.**

[Open meshwebllm](https://mfundo.wtf/meshwebllm/)

meshwebllm runs language models on browser GPUs and connects them over [iroh](https://www.iroh.computer). Chat directly in the browser, contribute your GPU, or pair two browsers to run different parts of a model. No inference server or local daemon is needed by browser participants.

The chat view selects ready workers for the chosen model and streams their replies. The Network view shows the contributing workers. Messages are encrypted in transit; the worker processing a request can read them. Conversation history stays in the current tab. The sidebar keeps separate conversations when you change models; reloading clears them. Stop ends a reply immediately, and **Use prompt again** puts an interrupted request back in the composer.

## Contribute

Choose a model and click **Share compute**. The browser downloads the model once, caches it, and prepares a WebGPU session. Keep the tab visible. Pause suspends requests; Stop releases the GPU session.

| Model | Runtime | Approximate download | Execution |
| --- | --- | --- | --- |
| SmolLM2 135M | ONNX Runtime WebGPU | 182 MB | Whole model or two-browser preview |
| SmolLM2 360M | WebLLM | 210 MB | Whole model |
| Qwen3 4B | WebLLM | 2.28 GB | Whole model; about 3.4 GB GPU memory |

The 135M model is a small demonstration model, not a general-purpose assistant. Its current runtime limits each request to 1,024 tokens including the reply. Start a new chat when that limit is reached.

## Share a model across browsers

Select SmolLM2 135M, click **Share compute**, and choose **With another device**. The host prepares the first 15 transformer layers and creates an invitation. Open that invitation on another WebGPU-capable browser and click **Join this team**. The invited browser fetches only its required tensor chunks over iroh-blobs and builds the remaining 15 layers in-browser. Both sides keep their KV caches on their own GPU.

Once both devices are ready, the team accepts ordinary chat requests. Chat users still choose a model; they do not select layers or peers. Stop either contribution to end the team. Closing a host invalidates its invitation. If a device disconnects, start a new team; cached verified weights can be reused.

This is a **preview**, not a promise of faster inference or half the memory. Both stages need a large shared embedding/output-head tensor, leaving each stage around 149 MB. The host initially reads the complete model. DHT discovery, multi-provider downloads, automatic layer placement and stage failover are not implemented. Only pair devices you trust.

## Run your own pool

A public pool uses an always-on bootstrap node for discovery:

```sh
cargo install --git https://github.com/fractalops/meshwebllm meshwebllm
meshwebllm bootstrap
```

Open the page with `?bootstrap=<ENDPOINT_ID>`. A build can set `VITE_BOOTSTRAP` instead. Without a bootstrap, a tab can still run and chat with its own worker; other workers will not automatically discover it.

The CLI remains compatible with browser workers, including team coordinators:

```sh
meshwebllm ask --bootstrap <ENDPOINT_ID> "Explain peer-to-peer networking briefly."
```

The browser selects by model. The CLI selects from available workers unless you supply `--worker`; see the [reference](docs/reference.md).

## Develop

Use Node.js 22.18+, Rust 1.91+, the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` matching Cargo.lock. macOS also needs Homebrew LLVM.

```sh
./scripts/build-wasm.sh
cd web
npm ci
npm run dev
```

The dev server disables file watching so edits cannot silently reload a live provider and destroy its invitation. Restart the dev server and reload explicitly after changes.

The interface uses Svelte 5 and the unstyled `@ui-sdk/svelte` components for model selection, dialogs, forms, and progress. `App.svelte` owns the page lifecycle; `chat-state.ts` owns tab-local conversations and cancellation. Markdown replies are sanitized before rendering. Component tests exercise the SDK’s named controls and the actual chat/sharing flows.

The runtime lives inside the app for now: [architecture decision](docs/adr/0001-browser-runtime-in-product.md), [runtime design and verification](docs/runtime.md). The original [experiments](experiments/layer-split/README.md) retain the numerical correctness evidence.

```sh
cargo test --workspace --exclude meshwebllm-web
npm --prefix web test
npm --prefix web run build
```

GitHub Actions builds and deploys the web app to GitHub Pages on `main`. The repository variable `MESHWEBLLM_BOOTSTRAP` configures public discovery.

## License

MIT or Apache-2.0. Model weights retain their upstream licenses.
