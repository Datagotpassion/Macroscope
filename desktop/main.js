// PlateScope 桌面 App (Electron 主进程)。
// 渲染层复用 frontend 构建产物;通过网络访问 Pi 的 API。
// 提供原生「选文件夹 + 写盘」给渲染层 (preload 暴露 window.desktop)。

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");

// 默认 Pi 地址 (可在 App 设置里改;也可用环境变量覆盖)
const DEFAULT_API_BASE = process.env.PLATESCOPE_API || "http://raspberrypi.local:8000";

// 用户上次连接的地址持久化到 userData/platescope-config.json —— 这样重启 App
// 后自动用同一地址连接,配合前端持续轮询即可自动重连,无需手动「连接」。
function configPath() {
  return path.join(app.getPath("userData"), "platescope-config.json");
}
function readSavedApi() {
  try {
    return JSON.parse(fsSync.readFileSync(configPath(), "utf8")).apiBase || null;
  } catch {
    return null;
  }
}

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
  // 优先用上次保存的地址,否则用默认
  e.returnValue = readSavedApi() || DEFAULT_API_BASE;
});

// 渲染层「连接」时把地址持久化,重启后仍然记得
ipcMain.handle("set-default-api", async (_e, url) => {
  try {
    await fs.writeFile(configPath(), JSON.stringify({ apiBase: url }), "utf8");
    return true;
  } catch {
    return false;
  }
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

// 追加一行到 CSV;文件不存在时先写表头
ipcMain.handle("append-csv", async (_e, { dir, name, header, row }) => {
  const filePath = path.join(dir, name);
  let prefix = "";
  try {
    await fs.access(filePath);
  } catch {
    prefix = header + "\n";
  }
  await fs.appendFile(filePath, prefix + row + "\n", "utf8");
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
