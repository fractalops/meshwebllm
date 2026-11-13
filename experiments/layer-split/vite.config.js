import { defineConfig } from "vite";
import { writeFile, mkdir } from "node:fs/promises";
export default defineConfig({
  worker: { format: "es" },
  build: { rollupOptions: { input: ["index.html", "blobs.html"] } },
  server: { hmr: false, fs: { allow: ["../.."] } },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  plugins: [
    {
      name: "experiment-results",
      configureServer(server) {
        server.middlewares.use("/save-results", async (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end();
            return;
          }
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 2_000_000) {
              res.statusCode = 413;
              res.end();
              return;
            }
          }
          try {
            const data = JSON.parse(body);
            if (
              ![
                "local",
                "iroh",
                "browser-blobs",
                "browser-blobs-first",
                "browser-blobs-second",
              ].includes(data.transport)
            )
              throw new Error("Unknown transport");
            await mkdir("artifacts/results", { recursive: true });
            await writeFile(
              `artifacts/results/${data.transport}.json`,
              JSON.stringify(data, null, 2) + "\n",
            );
            res.end("saved");
          } catch {
            res.statusCode = 400;
            res.end("invalid result");
          }
        });
      },
    },
  ],
});
