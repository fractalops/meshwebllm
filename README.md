# meshwebllm

meshwebllm sends prompts to browser tabs that run a language model. Each tab runs [WebLLM](https://github.com/mlc-ai/web-llm) on its own GPU. The `meshwebllm` command connects to a tab over [iroh](https://www.iroh.computer) and prints the reply while the model writes it.

The web page shows the pool. It lists each worker tab with its status, load, completed requests and reported speed. Any visitor with WebGPU can click **Contribute my GPU**. The tab then downloads the model and takes prompts from the pool.

Connections are encrypted end to end. The worker tab must read a prompt to run it, so do not send secrets to a public pool.

## Install

You need Rust 1.85 or later.

```
cargo install --git https://github.com/fractalops/meshwebllm meshwebllm
```

## Start

A pool needs one always-on bootstrap node. New members use it to find each other.

1. On the Server, start a bootstrap node. It prints its endpoint ID.

   ```
   meshwebllm bootstrap
   ```

2. On a computer with a WebGPU browser, open the pool page and add the bootstrap ID to the address:

   ```
   https://mfundo.wtf/meshwebllm/?bootstrap=<ENDPOINT_ID>
   ```

   Click **Contribute my GPU**. The tab downloads Qwen3-4B (2.28 GB) and joins the pool as a worker.

3. On the Laptop, send a prompt:

   ```
   meshwebllm ask --bootstrap <ENDPOINT_ID> "Summarize the QUIC handshake in three sentences."
   ```

   Set `MESHWEBLLM_BOOTSTRAP` to skip the `--bootstrap` option.

For all commands and options, see the [reference](docs/reference.md).

## License

MIT or Apache-2.0, at your option. See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).
