import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The operator UI is served by the node itself; in dev, Vite proxies the node's API.
const node = process.env.NODE_URL ?? "http://localhost:9300";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5174, proxy: { "/ui": node } },
  build: { outDir: "dist", emptyOutDir: true },
});