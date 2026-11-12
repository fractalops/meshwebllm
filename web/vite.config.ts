import { defineConfig } from "vite";

// Relative base so the site works under any GitHub Pages path.
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  worker: { format: "es" },
});
