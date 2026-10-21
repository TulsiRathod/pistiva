import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console calls the platform under /api; in dev Vite proxies it, in Docker nginx does.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PLATFORM_URL ?? "http://localhost:8080",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
