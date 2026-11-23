// 一键拍全板 (App 端编排):自检 → 逐格拍摄 → 保存到 PC → 失败的格子补拍一轮。
// 单格在 Pi 上一次完成 (移过去 → 对正 → 按需对焦 → 全分辨率照片),见 backend/scan.py。
// 每格对焦找到的高度 / 清晰度写回板面地图 (plate.z / plate.zSharp),下次先按它预测并
// 「清晰度够就不重新对焦」;板子有一点倾斜也能各格各用各的高度。
// Plate map 的「Scan plate」和延时巡扫共用这里。

import { scanPreflight, scanShot } from "./api";
import { loadStore, saveStore, listBlocks, blockCenter, cornersSet } from "./plateModel";
import { saveBytes } from "./save";

// 还没有对焦记忆时的预测高度:孔底平面 (2026-11-23 实测 9–10 mm)。拍过一次后用该板实测中位数。
export const DEFAULT_FOCUS_Z = 10;
// 扫描改了板面地图后广播,让一直挂载着的 PlateMap 重新读取,免得它用旧状态覆盖回去。
export const STORE_EVENT = "platescope-store-changed";

const two = (n) => String(n).padStart(2, "0");
// 文件名用的时间戳 2026-11-23_14-05-09
export const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_` +
  `${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
// 用 " - " 拼文件名并去掉文件系统非法字符
export const safeName = (parts) =>
  parts.filter(Boolean).join(" - ").replace(/[<>:"/\\|?*\n\r]/g, "").trim() + ".jpg";

const PITCH_MM = { 6: 39.12, 12: 26.01, 24: 19.3, 48: 13.08, 96: 9.0 };
const TRIES = 2; // 每格当轮最多试几次;整圈结束后失败的再补一轮

const findPlate = (id) => loadStore().plates.find((p) => p.id === id) || null;

// 同一时间只允许一次整板扫描 (例如延时巡扫正在跑时又点了 Plate map 的 Scan plate)。
// Pi 端每格是原子的,但两次扫描会一格一格交错着抢平台。
let activeScan = null; // 正在扫的板名

// 只在对焦确实找到峰时记下这格的高度和清晰度 (跳过对焦时不更新参考值,免得模糊慢慢「合法化」)
function rememberFocus(plateId, key, info) {
  if (!info?.af?.found || info.z == null) return;
  const s = loadStore();
  const plates = s.plates.map((p) => {
    if (p.id !== plateId) return p;
    const z = { ...(p.z || {}), [key]: info.z };
    const zSharp = { ...(p.zSharp || {}) };
    if (info.sharp != null) zSharp[key] = info.sharp;
    const zs = Object.values(z).sort((a, b) => a - b);
    return { ...p, z, zSharp, focusZ: zs[Math.floor(zs.length / 2)] };
  });
  saveStore({ ...s, plates });
  window.dispatchEvent(new Event(STORE_EVENT));
}

// 拍一整块板。
//   nameFor(block, camera) → 文件名 (必填;camera 为 "mock-forced" 时调用方可加 MOCK 前缀)
//   onProgress(text)        → 进度文字
//   shouldStop()            → 返回 true 时不再开始新的一格
// 返回 { plate, results: [{label, ok, file, info, error, tries}], ok, failed, ms }。
// 自检失败 (相机/Klipper/回零/画面全黑) 直接抛错 —— 一张都不拍。
export async function scanPlate(plateId, opts = {}) {
  if (activeScan) throw new Error(`a plate scan (${activeScan}) is already running`);
  const plate = findPlate(plateId);
  if (!plate) throw new Error("plate not found (deleted?)");
  if (!cornersSet(plate.ref)) {
    throw new Error(`${plate.name}: find the plate (or teach its corners) first`);
  }
  activeScan = plate.name;
  try {
    return await scanLocked(plate, opts);
  } finally {
    activeScan = null;
  }
}

async function scanLocked(plate, { nameFor, onProgress = () => {}, shouldStop = () => false }) {
  const t0 = Date.now();
  const plateId = plate.id;
  onProgress("Pre-flight check (homing if needed)…");
  await scanPreflight();

  const { tl, bl } = plate.ref;
  const len = Math.hypot(bl.x - tl.x, bl.y - tl.y) || 1;
  const rows = { rows_dx: (bl.x - tl.x) / len, rows_dy: (bl.y - tl.y) / len };
  const pitch_mm = PITCH_MM[plate.format] || 9.0;
  const blocks = listBlocks(plate);
  const results = new Map();

  const shootBlock = async (b, idx, retryPass) => {
    const cur = findPlate(plateId) || plate; // 每格都读最新的对焦记忆
    const c = blockCenter(cur, b);
    const z = cur.z?.[b.key] ?? cur.focusZ ?? DEFAULT_FOCUS_Z;
    let lastErr = "";
    for (let t = 1; t <= TRIES; t++) {
      if (shouldStop()) return;
      onProgress(
        `${retryPass ? "Retry " : ""}${b.label} (${idx + 1}/${blocks.length})` +
          `${t > 1 ? ` · try ${t}` : ""}: moving, aligning, focusing…`
      );
      try {
        const { blob, info, camera } = await scanShot({
          x: c.x,
          y: c.y,
          z,
          ...rows,
          row_half: (b.rLast - b.r0 + 1) % 2 === 0,
          col_half: (b.cLast - b.c0 + 1) % 2 === 0,
          pitch_mm,
          ref_sharp: cur.zSharp?.[b.key],
        });
        const file = nameFor(b, camera);
        await saveBytes(file, await blob.arrayBuffer());
        rememberFocus(plateId, b.key, info);
        results.set(b.key, { label: b.label, ok: true, file, info, tries: t });
        return;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    results.set(b.key, { label: b.label, ok: false, error: lastErr, tries: TRIES });
  };

  for (let i = 0; i < blocks.length && !shouldStop(); i++) await shootBlock(blocks[i], i, false);
  // 整圈结束后,失败的格子再补拍一轮 (偶发的网络/相机抖动多半已经过去)
  const failed = blocks.filter((b) => results.get(b.key)?.ok === false);
  for (const b of failed) {
    if (shouldStop()) break;
    await shootBlock(b, blocks.indexOf(b), true);
  }

  const list = blocks.map(
    (b) => results.get(b.key) || { label: b.label, ok: false, error: "stopped before this block" }
  );
  return {
    plate: plate.name,
    results: list,
    ok: list.filter((r) => r.ok).length,
    failed: list.filter((r) => !r.ok).length,
    ms: Date.now() - t0,
  };
}
