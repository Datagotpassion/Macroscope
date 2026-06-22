import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发期把 /api 和 /ws 代理到后端 (uvicorn :8000),
// 这样前端 dev server (5173) 不用关心跨域。
export default defineConfig({
  plugins: [react()],
  // 相对路径,这样打包后的页面既能被 Pi 在 "/" 下托管,
  // 也能在 Electron 里用 file:// 直接加载。
  base: "./",
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
