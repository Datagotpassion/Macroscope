// 后端 API 封装。所有路径都是相对的,生产时同源,开发时由 Vite 代理。

export async function getStatus() {
  const r = await fetch("/api/status");
  return r.json();
}

export async function capture() {
  const r = await fetch("/api/capture");
  if (!r.ok) throw new Error("capture failed");
  return r.json();
}

export async function getWells() {
  const r = await fetch("/api/wells");
  return r.json();
}

export async function saveFrame(experiment) {
  const r = await fetch(`/api/save?experiment=${encodeURIComponent(experiment)}`, {
    method: "POST",
  });
  if (!r.ok) throw new Error((await r.json()).detail || "save failed");
  return r.json();
}

export async function startTimelapse(experiment, interval) {
  const r = await fetch(
    `/api/timelapse/start?experiment=${encodeURIComponent(experiment)}&interval=${interval}`,
    { method: "POST" }
  );
  return r.json();
}

export async function stopTimelapse(experiment) {
  const r = await fetch(
    `/api/timelapse/stop?experiment=${encodeURIComponent(experiment)}`,
    { method: "POST" }
  );
  return r.json();
}

export async function listExperiments() {
  const r = await fetch("/api/experiments");
  return r.json();
}

export async function listFrames(name) {
  const r = await fetch(`/api/experiments/${encodeURIComponent(name)}/frames`);
  return r.json();
}

// 图像 URL (带 cache-buster)
export const plateImageUrl = (annotate = false) =>
  `/api/plate/image?annotate=${annotate}&t=${Date.now()}`;
export const wellImageUrl = (label) =>
  `/api/well/${encodeURIComponent(label)}/image?t=${Date.now()}`;
export const frameUrl = (exp, frame) =>
  `/api/experiments/${encodeURIComponent(exp)}/frames/${encodeURIComponent(frame)}`;

// WebSocket 预览
export function openPreview(onFrame) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/preview`);
  ws.binaryType = "blob";
  ws.onmessage = (ev) => onFrame(URL.createObjectURL(ev.data));
  return ws;
}
