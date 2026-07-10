import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3939",
      "/mcp": "http://127.0.0.1:3939"
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        assetFileNames(assetInfo) {
          return assetInfo.name === "cloud.css"
            ? "assets/cloud.css"
            : "assets/[name]-[hash][extname]";
        }
      },
      input: {
        local: path.resolve(import.meta.dirname, "index.html"),
        cloud: path.resolve(import.meta.dirname, "cloud.html"),
        cloudApp: path.resolve(import.meta.dirname, "cloud-app.html")
      }
    }
  }
});
