import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发期把 /api 和 /ws 代理到后端 (uvicorn :8000),
// 这样前端 dev server (5173) 不用关心跨域。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
