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

### Address options

| Query | Description |
|---|---|
| `?bootstrap=ID1,ID2` | Bootstrap nodes. It overrides the value set at build time. |
| `?model=ID` | Model for this tab. Accepted values: `Qwen3-4B-q4f16_1-MLC` (default) and `SmolLM2-360M-Instruct-q4f16_1-MLC`. |

Workers with different models are in the same pool. The `ask` command does not choose by model.

### Keys

| Key | Action |
|---|---|
| `↑` `↓` or `j` `k` | Select a worker |
| `/` | Search by endpoint ID, adapter or status |
| `s` | Filter by status |
| `a` | Filter by GPU adapter |
| `o` | Change the sort order |
| `c` | Contribute this GPU |
| `p` | Pause or resume this worker |
| `Esc` | Clear selection and filters |

### Worker tab

- To contribute, the browser must support WebGPU and allow at least 10 storage buffers per shader stage. WebLLM needs this for every model. The page checks the GPU on load and disables **Contribute my GPU** with the reason when the browser does not meet it. Chrome and Edge on a recent GPU usually do.
- The tab keeps its secret key in `localStorage`, so its endpoint ID stays the same across visits.
- The model runs in a Web Worker. The browser caches the model files after the first download.
- The tab runs one completion at a time. Two more requests can wait. Further requests get a `Busy` error.
- When you pause, the running completion stops and its client gets a `Paused` error.
- Browsers can freeze hidden tabs. Keep the worker tab visible.

### Columns

Each worker reports its own status, counters and speed. Other members cannot check these numbers. Columns marked `*` show reported values.

| Column | Description |
|---|---|
| Adapter | GPU vendor and architecture as the browser reports them. Browsers do not report the GPU model. |
| Status | `loading N%`, `idle`, `busy`, `paused` or `stale`. |
| Load | Running and waiting jobs. |
| Jobs | Running jobs, then waiting jobs after `+`. |
| Served | Completed requests since the tab started. |
| Tokens | Generated tokens since the tab started. |
| tok/s | Moving average of the worker's generation speed. |
| Beat | Seconds since the latest announcement. |

## Pool membership

- Members join a gossip topic derived from the pool name.
- A worker sends a signed status announcement every 10 seconds and at once when its state changes.
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

You need Rust with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` at the same version as the `wasm-bindgen` crate in `Cargo.lock`, and Node.js 22. On macOS, also install LLVM (`brew install llvm`). Apple clang cannot compile C code for wasm32.

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
```

## Deployment

The `Pages` workflow builds the page and publishes it to GitHub Pages on each push to `main`. Set the repository variable `MESHWEBLLM_BOOTSTRAP` to a comma-separated list of bootstrap endpoint IDs. The page then works without the `?bootstrap=` option.
