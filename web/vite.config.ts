import { defineConfig } from "vite";
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  worker: { format: "es" },
  // Reloading a live provider destroys its peer identity and in-memory seed store.
  server: {
    hmr: false,
    watch: null,
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
  },
  plugins: [
    {
      name: "local-model-fixture",
      configureServer(server) {
        server.middlewares.use("/model-fixture/", (req, res, next) => {
          const path = (req.url ?? "").split("?")[0].replace(/^\//, "");
          if (
            ![
              "onnx/model_q4.onnx",
              "config.json",
              "tokenizer.json",
              "tokenizer_config.json",
            ].includes(path)
          )
            return next();
          const file = fileURLToPath(
            new URL(
              `../experiments/layer-split/artifacts/source/${path}`,
              import.meta.url,
            ),
          );
          try {
            res.setHeader("Content-Length", statSync(file).size);
            res.setHeader("Content-Type", "application/octet-stream");
            createReadStream(file).pipe(res);
          } catch {
            res.statusCode = 404;
            res.end("Download the pinned experiment fixture first.");
          }
        });
      },
    },
  ],
});
