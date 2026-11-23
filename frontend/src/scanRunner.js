// 一键拍全板 (App 端编排):自检 → 板角核验 → 逐格拍摄 → 验收 → 保存到 PC → 失败的格子补拍一轮。
// 单格在 Pi 上一次完成 (移过去 → 对正 → 按需对焦 → 全分辨率照片),见 backend/scan.py。
// 判断逻辑 (对焦计划 / 单张验收 / 要不要修正地图) 在 scanLogic.js (纯函数,有测试)。
//
// 每张照片都有验收结果:孔位是否确认、孔身份是否核验 (板角)、焦面是否合格。不合格的照样保存,
// 但文件名加 UNVERIFIED,原因写进扫描记录 CSV;它们不进对焦记忆,也不参与修正地图。
// 对焦记忆 (plate.z / plate.zSharp):≥2 格一致才算知道孔底平面,之后各格按它预测、清晰度够就不对焦。
// 板面地图:整圈完整、板角核验通过、每格都对正时,才按各格偏差修正 (单轮 / 累计都有上限,可撤销)。
// Plate map 的「Scan plate」和延时巡扫共用这里。

import { scanPreflight, scanShot, scanVerifyCorner } from "./api";
import { loadStore, saveStore, listBlocks, blockCenter, cornersSet, dims } from "./plateModel";
import { saveBytes, appendCsvRow, saveMode } from "./save";
import {
  DEFAULT_FOCUS_Z,
  focusPlan,
  isCheckable,
  judgeShot,
  lateFocusOutliers,
  markUnverified,
  planShift,
} from "./scanLogic";

export { DEFAULT_FOCUS_Z };
// 扫描改了板面地图后广播,让一直挂载着的 PlateMap 重新读取,免得它用旧状态覆盖回去。
export const STORE_EVENT = "platescope-store-changed";

const two = (n) => String(n).padStart(2, "0");
// 文件名用的时间戳 2026-11-23_14-05-09
export const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_` +
  `${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
// 用 " - " 拼文件名并去掉文件系统非法字符
export const safeName = (parts, ext = ".jpg") =>
  parts.filter(Boolean).join(" - ").replace(/[<>:"/\\|?*\n\r]/g, "").trim() + ext;

// 最终照片 12MP (4056x3040,Pi 端临时切相机模式) 还是 3MP (2028x1520)。记在本机,默认 12MP。
const FULL_RES_KEY = "platescope_scan_12mp";
export const getFullRes = () => {
  try {
    return localStorage.getItem(FULL_RES_KEY) !== "0";
  } catch {
    return true;
  }
};
export const setFullRes = (on) => {
  try {
    localStorage.setItem(FULL_RES_KEY, on ? "1" : "0");
  } catch {
    /* 存不下就只在这次生效 */
  }
};

const PITCH_MM = { 6: 39.12, 12: 26.01, 24: 19.3, 48: 13.08, 96: 9.0 };
const TRIES = 2; // 每格当轮最多试几次;整圈结束后失败的再补一轮

const findPlate = (id) => loadStore().plates.find((p) => p.id === id) || null;

function updatePlate(plateId, fn) {
  const s = loadStore();
  saveStore({ ...s, plates: s.plates.map((p) => (p.id === plateId ? fn(p) : p)) });
  window.dispatchEvent(new Event(STORE_EVENT));
}

function rememberFocus(plateId, key, info) {
  updatePlate(plateId, (q) => {
    const z = { ...(q.z || {}), [key]: info.z };
    const zSharp = { ...(q.zSharp || {}) };
    if (info.sharp != null) zSharp[key] = info.sharp;
    else delete zSharp[key];
    return { ...q, z, zSharp };
  });
}

function forgetFocus(plateId, key) {
  updatePlate(plateId, (q) => {
    const z = { ...(q.z || {}) };
    const zSharp = { ...(q.zSharp || {}) };
    delete z[key];
    delete zSharp[key];
    return { ...q, z, zSharp };
  });
}

// 板面地图「行 / 列」方向 (平台坐标的单位向量):A1→<末行>1、A1→A<末列>
function plateAxes(ref) {
  const { tl, tr, bl } = ref;
  const unit = (p) => {
    const dx = p.x - tl.x;
    const dy = p.y - tl.y;
    const n = Math.hypot(dx, dy) || 1;
    return [dx / n, dy / n];
  };
  const [rows_dx, rows_dy] = unit(bl);
  const [cols_dx, cols_dy] = unit(tr);
  return { rows_dx, rows_dy, cols_dx, cols_dy };
}

// 扫描记录 (只在桌面 App 里写:浏览器没有追加,每行会变成一次下载)。
// 表头和旧版不同,调用方的文件名带 "v2",免得追加到旧文件里列对不上。
const LOG_HEADER =
  "time,plate,block,ok,file,x,y,align_dx,align_dy,realigned,residual_mm,position,identity," +
  "z_pred,z,focus,af_gain,content_wells,sharp,af_curve,unverified,issues,error";
const csv = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
async function logRow(logName, plateName, r) {
  if (!logName || saveMode() !== "desktop") return;
  const i = r.info || {};
  const af = i.af || {};
  const v = r.verdict || {};
  const row = [
    new Date().toISOString(),
    plateName,
    r.label,
    r.ok ? 1 : 0,
    r.file,
    i.x,
    i.y,
    i.align_error_mm?.[0],
    i.align_error_mm?.[1],
    i.aligned_to ? 1 : 0,
    i.residual_mm,
    v.position,
    v.identity,
    i.z_pred,
    i.z,
    v.focus ?? af.reason,
    af.gain,
    i.content_wells,
    i.sharp,
    (af.curve || []).map(([z, s]) => `${z}:${s}`).join(" "),
    v.unverified ? 1 : r.ok ? 0 : "",
    (v.issues || []).join(" | "),
    r.error,
  ];
  try {
    await appendCsvRow(logName, LOG_HEADER, row.map(csv).join(","));
  } catch {
    /* 记录写不进去不影响拍照 */
  }
}

// 同一时间只允许一次整板扫描 (例如延时巡扫正在跑时又点了 Plate map 的 Scan plate)。
// Pi 端每格是原子的,但两次扫描会一格一格交错着抢平台。
let activeScan = null; // 正在扫的板名

// 拍一整块板。
//   nameFor(block, camera) → 文件名 (必填;camera 为 "mock-forced" 时调用方可加 MOCK 前缀)。
//                            验收不合格时这里会在扩展名前加 " - UNVERIFIED"。
//   logName                 → 扫描记录 CSV 文件名 (可选,只在桌面 App 写)
//   onProgress(text)        → 进度文字
//   shouldStop()            → 返回 true 时不再开始新的一格
// 返回 { plate, results: [{key, label, ok, file, info, verdict, error, tries}], ok, failed,
//        unverified, corner, lateFocus, shift, ms }。
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

async function scanLocked(plate, { nameFor, logName, onProgress = () => {}, shouldStop = () => false }) {
  const t0 = Date.now();
  const plateId = plate.id;
  onProgress("Pre-flight check (homing if needed)…");
  await scanPreflight();

  const axes = plateAxes(plate.ref);
  const { rows: plate_rows, cols: plate_cols } = dims(plate);
  const pitch_mm = PITCH_MM[plate.format] || 9.0;
  const blocks = listBlocks(plate);
  const results = new Map();
  const full_res = getFullRes(); // 整次扫描用同一个分辨率

  // 板角核验:地图上的 A1 外侧两个方向都应是板外。
  // null = 没核验 (这版 Pi 不支持,或 6/12 孔板一帧只有 1–2 个孔、做不了)。
  let corner = null;
  if (!shouldStop() && isCheckable(plate)) {
    onProgress("Checking the A1 corner against the plate map…");
    try {
      corner = await scanVerifyCorner({
        x: plate.ref.tl.x,
        y: plate.ref.tl.y,
        z: focusPlan(plate, blocks[0].key).z,
        ...axes,
        plate_rows,
        plate_cols,
        pitch_mm,
      });
    } catch (e) {
      corner = { ok: false, reason: e.message || String(e) };
    }
    if (corner) {
      const a1 = corner.a1_error_mm;
      await logRow(logName, plate.name, {
        label: "A1 corner check",
        ok: corner.ok,
        info: { x: plate.ref.tl.x, y: plate.ref.tl.y, align_error_mm: a1 },
        verdict: { identity: corner.ok ? "verified" : "failed", issues: [corner.reason] },
      });
    }
  }

  const shootBlock = async (b, idx, retryPass) => {
    const cur = findPlate(plateId) || plate; // 每格都读最新的对焦记忆
    const c = blockCenter(cur, b);
    const plan = focusPlan(cur, b.key);
    if (plan.staleOwn) forgetFocus(plateId, b.key); // 上次对错了平面的记忆:清掉
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
          z: plan.z,
          ...axes,
          row_half: (b.rLast - b.r0 + 1) % 2 === 0,
          col_half: (b.cLast - b.c0 + 1) % 2 === 0,
          plate_rows,
          plate_cols,
          r0: b.r0,
          r1: b.rLast,
          c0: b.c0,
          c1: b.cLast,
          pitch_mm,
          af_range: plan.af_range,
          af_extend: plan.af_extend,
          ref_sharp: plan.ref_sharp,
          full_res,
        });
        // 先验收再存:不合格的照样存,但文件名标出来
        const verdict = judgeShot(findPlate(plateId) || cur, b.key, info, corner);
        let file = nameFor(b, camera);
        if (verdict.unverified) file = markUnverified(file);
        await saveBytes(file, await blob.arrayBuffer());
        if (verdict.remember) rememberFocus(plateId, b.key, info);
        const r = { key: b.key, label: b.label, ok: true, file, info, verdict, tries: t };
        results.set(b.key, r);
        await logRow(logName, plate.name, r);
        return;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    const r = { key: b.key, label: b.label, ok: false, error: lastErr, tries: TRIES };
    results.set(b.key, r);
    await logRow(logName, plate.name, r);
  };

  for (let i = 0; i < blocks.length && !shouldStop(); i++) await shootBlock(blocks[i], i, false);
  // 整圈结束后,失败的格子再补拍一轮 (偶发的网络/相机抖动多半已经过去)
  const failed = blocks.filter((b) => results.get(b.key)?.ok === false);
  for (const b of failed) {
    if (shouldStop()) break;
    await shootBlock(b, blocks.indexOf(b), true);
  }

  const list = blocks.map(
    (b) =>
      results.get(b.key) || { key: b.key, label: b.label, ok: false, error: "stopped before this block" }
  );

  // 扫完复查对焦:早拍的格子当时还不知道孔底平面,现在用整圈的结果再看一遍。
  // 文件已经存了 (改不了名),在记录里补一条,并清掉它的对焦记忆。
  const lateFocus = lateFocusOutliers(list);
  for (const o of lateFocus) {
    forgetFocus(plateId, o.key);
    const r = list.find((x) => x.key === o.key);
    if (r?.verdict) {
      r.verdict = {
        ...r.verdict,
        focus: "off_plane",
        unverified: true,
        issues: [...r.verdict.issues, `focus (post-scan check): Z ${o.z} vs plane ${o.plane}`],
      };
    }
    await logRow(logName, plate.name, {
      label: `${o.label} post-scan focus check`,
      ok: true,
      file: r?.file,
      info: { z: o.z },
      verdict: { focus: "off_plane", issues: [`Z ${o.z} is off the well-bottom plane ${o.plane}`] },
    });
  }

  // 修正板面地图 (证据不完整就不改,原因放在 shift.reason)
  const cur = findPlate(plateId) || plate;
  const shift = planShift(cur, list, { planned: blocks.length, pitch: pitch_mm, corner });
  if (shift.apply) {
    updatePlate(plateId, (q) => ({ ...q, refPrev: q.ref, refBase: shift.base, ref: shift.ref }));
  }

  return {
    plate: plate.name,
    results: list,
    ok: list.filter((r) => r.ok).length,
    failed: list.filter((r) => !r.ok).length,
    unverified: list.filter((r) => r.ok && r.verdict?.unverified).length,
    corner,
    lateFocus,
    shift: { apply: shift.apply, reason: shift.reason, kind: shift.kind, mean: shift.mean, max: shift.max },
    ms: Date.now() - t0,
  };
}
