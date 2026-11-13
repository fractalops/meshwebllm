# Reference

## Commands

### `meshwebllm ask`

Sends one prompt and prints the reply to standard output while it arrives.

```
meshwebllm ask [OPTIONS] [PROMPT]
```

If you omit `PROMPT`, the command reads the prompt from standard input.

| Option | Description |
|---|---|
| `-w, --worker <ID>` | Send the prompt to this worker. The pool is not used. |
| `--bootstrap <ID>` | Bootstrap node to join the pool. Repeat it or separate IDs with commas. Environment: `MESHWEBLLM_BOOTSTRAP`. |
| `--pool <NAME>` | Pool name. Default: `meshwebllm/pool/v1`. |
| `--system <TEXT>` | System message to send before the prompt. |
| `--max-tokens <N>` | Maximum number of tokens to generate. |
| `--temperature <T>` | Sampling temperature. |
| `--wait <S>` | Seconds to wait for a worker to appear in the pool. Default: 15. |
| `--connect-timeout <S>` | Seconds to wait for a connection to one worker. Default: 30. |
| `-v, --verbose` | Print the worker, model and token counts to standard error. |

Without `--worker`, the command joins the pool and orders the workers:

1. Idle workers, fastest first by reported speed.
2. Busy workers, shortest queue first.

Paused, loading and stale workers are not used. If a worker is busy, paused or cannot be reached, the command tries the next one. It tries at most 3 workers. If a worker fails after it has sent text, the command stops and does not retry, so you never see the same text twice.

The command exits with status 0 when the reply is complete and 1 on an error.

### `meshwebllm peers`

Joins the pool, listens for 12 seconds, and prints the workers.

```
meshwebllm peers [--wait <S>] [--bootstrap <ID>] [--pool <NAME>]
```

### `meshwebllm bootstrap`

Runs an always-on pool member. Other members connect to it first. It prints joins, leaves and timeouts.

```
meshwebllm bootstrap [--key-file <PATH>] [--bootstrap <ID>] [--pool <NAME>]
```

The node keeps its secret key in `--key-file`. The default is `~/.config/meshwebllm/bootstrap.key`. The endpoint ID stays the same while the file exists. The command creates the file with mode 0600 if it does not exist. You can run more than one bootstrap node. Give each node the IDs of the others with `--bootstrap`.

### Logs

Set `MESHWEBLLM_LOG` to a tracing filter, for example `MESHWEBLLM_LOG=meshwebllm_core=debug`. Logs go to standard error.

## Web page

Choose a model and chat. Routing uses only non-stale workers advertising that exact model; idle workers are preferred, followed by short queues. It tries up to three candidates before any text arrives and never silently retries a partial answer. Stop cancels the response. Only completed turns are included in follow-ups; changing models starts a new conversation.

**Share compute** offers whole-model execution, and a two-browser shared preview for SmolLM2 135M. GPU checks run before downloading. Downloads report progress and caches survive visits. ONNX peer weights are content-verified; WebLLM shards are length-checked. Stop during preparation cancels loading. Pause interrupts active generation and rejects new jobs; resume makes the existing session available again. Stop ends the contribution and releases its GPU worker.

The **Network** view shows workers, their models, availability, and adapter. Connection details show the local endpoint and pool. A shared team is advertised as one worker only when both stages are ready. An invited stage does not advertise a complete model. Worker availability is self-reported.

| Query | Description |
| --- | --- |
| `?bootstrap=ID1,ID2` | Overrides the build-time bootstrap list. An empty value creates a standalone local pool. |
| `?model=ID` | Selects a listed model: `SmolLM2-135M-Instruct-ONNX-Q4` (default), `SmolLM2-360M-Instruct-q4f16_1-MLC`, or `Qwen3-4B-q4f16_1-MLC`. |
| `#join=…` | Invitation capability for the second stage. Open it only for a host you trust. The fragment is not sent to the static host. |

Each tab has a fresh endpoint identity. Verified model caches use content hashes and revision keys independently of that identity. No conversation history or prompt data is persisted by the app. Browsers can suspend hidden tabs; keep contributors visible. A disconnected shared team must be restarted; it cannot currently recover KV state or replace a missing stage.

The ONNX preview uses the pinned SmolLM2 tokenizer and chat template, EOS stopping, greedy decoding in Precise mode, and temperature/top-k sampling in Creative mode. It supports 1,024 tokens including the reply and at most 512 generated tokens per request; the chat UI requests up to 256. WebLLM handles the other models through the same runtime interface.

## Pool membership

- Members join a gossip topic derived from the pool name.
- An idle worker sends a signed heartbeat every 10 seconds. Status changes wake the sender. Worker announcements are limited to one every 2 seconds, including replies to new members. Each message is at most 2 KB.
- Contributions report queue state and counters once a second. The page reads the roster when the Wasm node signals a change.
- Replayed and reordered status and leave messages are ignored. Sequence floors remain for ten minutes after a worker leaves or expires; a replay after that window can briefly reappear until expiry.
- Members check each signature against the sender's endpoint ID and drop messages that fail.
- A worker that sends nothing for 30 seconds is shown as stale. After 45 seconds it is removed.
- A worker that leaves on purpose sends a leave message and is removed at once.
- Observers do not announce themselves. Only workers appear in the list.

## Network

- Every member is an iroh endpoint. The endpoint ID is the public key of the node.
- Browser tabs connect through iroh relay servers. Browsers cannot send UDP, so they cannot make direct connections. The relay cannot read the traffic.
- The command-line tool and the bootstrap node use the public n0 relays and address lookup.

## Wire format

ALPN: `meshwebllm/infer/0`. Each completion uses one bidirectional QUIC stream.

1. The client writes one `Request` frame and finishes its send side.
2. The worker writes zero or more `Chunk` frames.
3. The worker writes one `Done` or `Error` frame and finishes.

A frame is a 4-byte big-endian length and a [postcard](https://docs.rs/postcard) body. The largest frame is 1 MiB. The types are in `crates/core/src/proto.rs`.

| Error code | Meaning |
|---|---|
| `Busy` | The worker queue is full. |
| `Paused` | The worker is paused. |
| `BadRequest` | The request has no messages. |
| `Inference` | The model failed. |

If the stream ends before `Done` or `Error`, the client reports an incomplete completion.

## Build from source

You need Rust with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` at the same version as the `wasm-bindgen` crate in `Cargo.lock`, and Node.js 22.18 or later. On macOS, also install LLVM (`brew install llvm`). Apple clang cannot compile C code for wasm32.

Build and run the command-line tool:

```
cargo run -p meshwebllm -- --help
```

Build the web page:

```
./scripts/build-wasm.sh
cd web
npm ci
npm run dev
```

Run the tests:

```
cargo test --workspace --exclude meshwebllm-web
npm --prefix web test
```

## Deployment

The `Pages` workflow builds the page and publishes it to GitHub Pages on each push to `main`. Set the repository variable `MESHWEBLLM_BOOTSTRAP` to a comma-separated list of bootstrap endpoint IDs. The page then works without the `?bootstrap=` option.
