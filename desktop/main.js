// PlateScope 桌面 App (Electron 主进程)。
// 渲染层复用 frontend 构建产物;通过网络访问 Pi 的 API。
// 提供原生「选文件夹 + 写盘」给渲染层 (preload 暴露 window.desktop)。

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");

// 默认 Pi 地址 (可在 App 设置里改;也可用环境变量覆盖)
const DEFAULT_API_BASE = process.env.PLATESCOPE_API || "http://raspberrypi.local:8000";

let win;

function rendererEntry() {
  // 开发:指向 Vite dev server;打包:resources/renderer;未打包直跑:frontend/dist
  if (process.env.VITE_DEV_SERVER_URL) return { url: process.env.VITE_DEV_SERVER_URL };
  if (app.isPackaged)
    return { file: path.join(process.resourcesPath, "renderer", "index.html") };
  return { file: path.join(__dirname, "..", "frontend", "dist", "index.html") };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const entry = rendererEntry();
  if (entry.url) win.loadURL(entry.url);
  else win.loadFile(entry.file);
}

// ── IPC (在窗口加载前就注册好) ──

ipcMain.on("get-default-api", (e) => {
  e.returnValue = DEFAULT_API_BASE;
});

ipcMain.handle("choose-folder", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle("save-image", async (_e, { dir, name, bytes }) => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.from(bytes));
  return filePath;
});

// ── 生命周期 ──

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
