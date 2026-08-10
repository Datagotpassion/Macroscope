// 后端 API 封装。
//
// API 目标地址是可配置的:
//   - 浏览器从 Pi 提供页面时:base = ""(同源,相对路径)。
//   - Electron 桌面 App 里:页面是本地加载的,必须用绝对地址指到 Pi,
//     例如 http://raspberrypi.local:8000 —— 存在 localStorage,可在设置里改。

export function apiBase() {
  if (typeof window !== "undefined") {
    // Electron preload 可注入默认地址
    if (window.desktop && window.desktop.defaultApiBase && !localStorage.getItem("platescope_api_base")) {
      return window.desktop.defaultApiBase.replace(/\/+$/, "");
    }
    const saved = localStorage.getItem("platescope_api_base");
    if (saved) return saved.replace(/\/+$/, "");
  }
  return "";
}

export function setApiBase(url) {
  const clean = (url || "").replace(/\/+$/, "");
  localStorage.setItem("platescope_api_base", clean);
  // 桌面 App:同时持久化到主进程,重启后自动用同一地址(不依赖 localStorage 存活)
  if (typeof window !== "undefined" && window.desktop && window.desktop.setApiBase) {
    window.desktop.setApiBase(clean);
  }
}

export function isDesktop() {
  return typeof window !== "undefined" && !!window.desktop;
}

const u = (path) => apiBase() + path;

export async function getStatus() {
  const r = await fetch(u("/api/status"));
  return r.json();
}

export async function capture() {
  const r = await fetch(u("/api/capture"));
  if (!r.ok) throw new Error("capture failed");
  return r.json();
}

export async function getWells() {
  const r = await fetch(u("/api/wells"));
  return r.json();
}

export async function saveFrame(experiment) {
  const r = await fetch(u(`/api/save?experiment=${encodeURIComponent(experiment)}`), {
    method: "POST",
  });
  if (!r.ok) throw new Error((await r.json()).detail || "save failed");
  return r.json();
}

export async function startTimelapse(experiment, interval) {
  const r = await fetch(
    u(`/api/timelapse/start?experiment=${encodeURIComponent(experiment)}&interval=${interval}`),
    { method: "POST" }
  );
  return r.json();
}

export async function stopTimelapse(experiment) {
  const r = await fetch(
    u(`/api/timelapse/stop?experiment=${encodeURIComponent(experiment)}`),
    { method: "POST" }
  );
  return r.json();
}

// 全分辨率单孔静帧 (分支 B:轮询刷新,最高清晰度)
export const wellSnapshotUrl = (cx, cy, r) =>
  u(`/api/well/snapshot?cx=${cx.toFixed(5)}&cy=${cy.toFixed(5)}&r=${r.toFixed(5)}&t=${Date.now()}`);

// 跳动检测 (F16):抓一段高帧率序列分析收缩频率。期间相机独占,预览暂停。
export async function detectBeat(cx, cy, r, duration = 8) {
  const res = await fetch(
    u(`/api/well/beat?cx=${cx.toFixed(5)}&cy=${cy.toFixed(5)}&r=${r.toFixed(5)}&duration=${duration}`),
    { method: "POST" }
  );
  if (!res.ok) throw new Error("beat detection failed");
  return res.json();
}

// 实时预览硬件数字变焦 (单孔高清检视)
export async function setPreviewRoi(cx, cy, r) {
  await fetch(
    u(`/api/preview/roi?cx=${cx.toFixed(5)}&cy=${cy.toFixed(5)}&r=${r.toFixed(5)}`),
    { method: "POST" }
  );
}

export async function clearPreviewRoi() {
  await fetch(u("/api/preview/roi/clear"), { method: "POST" });
}

export async function listExperiments() {
  const r = await fetch(u("/api/experiments"));
  return r.json();
}

export async function listFrames(name) {
  const r = await fetch(u(`/api/experiments/${encodeURIComponent(name)}/frames`));
  return r.json();
}

// 最近一帧的原始图 (用于保存到 PC,不重新拍摄)
export const frameLatestUrl = () => u(`/api/frame/latest?t=${Date.now()}`);

export async function fetchLatestFrameBlob() {
  const r = await fetch(frameLatestUrl());
  if (!r.ok) throw new Error("no buffered frame");
  return r.blob();
}

// 图像 URL (带 cache-buster)
export const plateImageUrl = (annotate = false) =>
  u(`/api/plate/image?annotate=${annotate}&t=${Date.now()}`);
export const wellImageUrl = (label) =>
  u(`/api/well/${encodeURIComponent(label)}/image?t=${Date.now()}`);

// 按归一化坐标裁剪 (手动网格的单孔放大)。r 放大一点带点余量。
export const cropUrl = (cx, cy, r) =>
  u(`/api/crop?cx=${cx.toFixed(5)}&cy=${cy.toFixed(5)}&r=${(r * 1.3).toFixed(5)}&t=${Date.now()}`);
export const frameUrl = (exp, frame) =>
  u(`/api/experiments/${encodeURIComponent(exp)}/frames/${encodeURIComponent(frame)}`);

// ── 运动平台 (CoreXY + Z, 通过 Moonraker) ──

export async function stageStatus() {
  const r = await fetch(u("/api/stage/status"));
  return r.json();
}

async function stagePost(path) {
  const r = await fetch(u(path), { method: "POST" });
  if (!r.ok) {
    let detail = "stage command failed";
    try {
      detail = (await r.json()).detail || detail;
    } catch {
      /* 非 JSON 错误体忽略 */
    }
    throw new Error(detail);
  }
  return r.json();
}

export const stageJog = (axis, distance, feed = 600) =>
  stagePost(`/api/stage/jog?axis=${axis}&distance=${distance}&feed=${feed}`);

export function stageMove({ x, y, z, feed = 1200 }) {
  const p = new URLSearchParams();
  if (x != null) p.set("x", x);
  if (y != null) p.set("y", y);
  if (z != null) p.set("z", z);
  p.set("feed", feed);
  return stagePost(`/api/stage/move?${p.toString()}`);
}

export const stageHome = (axes = "XYZ") =>
  stagePost(`/api/stage/home?axes=${axes}`);
export const stageStop = () => stagePost("/api/stage/stop");
export const stageFirmwareRestart = () =>
  stagePost("/api/stage/firmware_restart");

// WebSocket 预览
export function openPreview(onFrame) {
  const base = apiBase();
  let wsUrl;
  if (base) {
    wsUrl = base.replace(/^http/, "ws") + "/ws/preview";
  } else {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    wsUrl = `${proto}://${location.host}/ws/preview`;
  }
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "blob";
  ws.onmessage = (ev) => onFrame(URL.createObjectURL(ev.data));
  return ws;
}
