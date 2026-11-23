// 一键拍全板 (App 端编排):自检 → 板角核验 → 逐格拍摄 → 验收 → 保存到 PC → 失败的格子补拍一轮
// → 扫后复查对焦 → 决定要不要修正地图。
// 单格在 Pi 上一次完成 (移过去 → 对正 → 按需对焦 → 全分辨率照片),见 backend/scan.py。
// 判断逻辑 (对焦计划 / 单格请求 / 单张验收 / 复查 / 地图修正) 在 scanLogic.js (纯函数,有测试)。
//
// 每张照片都有验收结果:孔位是否对正、孔身份是否核验 (板角)、焦面依据、能否直接用于分析。
// 有证据表明不对的照样保存,但文件名加 UNVERIFIED;全部结论和原因写进扫描记录 CSV。
// 对焦记忆 (plate.z / plate.zSharp):≥2 格一致才算知道孔底平面;手教高度 (plate.zTaught) 只管那一格。
// 板面地图:整圈完整、板角核验通过、每格都对正时,才按各格偏差修正 (四角单轮 / 累计都有上限,可撤销)。
// Plate map 的「Scan plate」和延时巡扫共用这里。

import { scanPreflight, scanShot, scanVerifyCorner } from "./api";
import { loadStore, saveStore, listBlocks, blockCenter, cornersSet, dims } from "./plateModel";
import { saveBytes, appendCsvRow, saveMode } from "./save";
import {
  DEFAULT_FOCUS_Z,
  cornerStatus,
  focusPlan,
  focusReview,
  isCheckable,
  judgeShot,
  markLateOffPlane,
  markUnverified,
  planShift,
  shotRequest,
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
// 扫描记录的文件名后缀 (列变了就升版本,免得追加到旧文件里列对不上)
export const SCAN_LOG_SUFFIX = "scan log v3";

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

// 写入 / 恢复这一格的自动对焦记忆。prev = {z, zSharp}:undefined 表示原来没有 → 删掉。
function setFocusMemory(plateId, key, z, zSharpVal) {
  updatePlate(plateId, (q) => {
    const zm = { ...(q.z || {}) };
    const zs = { ...(q.zSharp || {}) };
    if (z == null) delete zm[key];
    else zm[key] = z;
    if (zSharpVal == null) delete zs[key];
    else zs[key] = zSharpVal;
    return { ...q, z: zm, zSharp: zs };
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

// 本地时间 (带时区偏移),和文件名里的时间对得上:2026-11-23T15:30:57-05:00
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` +
    `${sign}${two(Math.floor(a / 60))}:${two(a % 60)}`
  );
}

// 扫描记录 (只在桌面 App 里写:浏览器没有追加,每行会变成一次下载)。
// 一行一格;另有「A1 corner check」「<格> post-scan focus check」「map decision」几种事件行。
const LOG_HEADER =
  "scan_id,time_utc,time_local,plate,block,ok,file,x,y,align_dx,align_dy,realigned,residual_mm," +
  "position,identity,corner,z_pred,z,focus,focus_basis,af_gain,content_wells,sharp,af_curve," +
  "unverified,analysis_ready,issues,error";
const csv = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const flag = (v) => (v == null ? "" : v ? 1 : 0);

// 返回 true = 写成功 (或不需要写);false = 写失败 (调用方汇总后在界面上提示)
async function logRow(log, r) {
  if (!log.name || saveMode() !== "desktop") return true;
  const i = r.info || {};
  const af = i.af || {};
  const v = r.verdict || {};
  const d = new Date();
  const row = [
    log.scanId,
    d.toISOString(),
    localIso(d),
    log.plate,
    r.label,
    flag(r.ok),
    r.file,
    i.x,
    i.y,
    i.align_error_mm?.[0],
    i.align_error_mm?.[1],
    i.aligned_to ? 1 : r.info ? 0 : "",
    i.residual_mm,
    v.position,
    v.identity,
    v.corner,
    i.z_pred,
    i.z,
    v.focus,
    v.focusBasis,
    af.gain,
    i.content_wells,
    i.sharp,
    (af.curve || []).map(([z, s]) => `${z}:${s}`).join(" "),
    flag(v.unverified),
    flag(v.analysisReady),
    (v.issues || []).join(" | "),
    r.error,
  ];
  try {
    await appendCsvRow(log.name, LOG_HEADER, row.map(csv).join(","));
    return true;
  } catch {
    log.failures += 1; // 不影响拍照,但要让用户知道
    return false;
  }
}

// 同一时间只允许一次整板扫描 (例如延时巡扫正在跑时又点了 Plate map 的 Scan plate)。
// Pi 端每格是原子的,但两次扫描会一格一格交错着抢平台。
let activeScan = null; // 正在扫的板名

// 拍一整块板。
//   nameFor(block, camera) → 文件名 (必填;camera 为 "mock-forced" 时调用方可加 MOCK 前缀)。
//                            验收不合格时这里会在扩展名前加 " - UNVERIFIED"。
//   logName                 → 扫描记录 CSV 文件名 (可选,只在桌面 App 写;用 SCAN_LOG_SUFFIX)
//   onProgress(text)        → 进度文字
//   shouldStop()            → 返回 true 时不再开始新的一格
// 返回 { scanId, plate, results: [{key, label, ok, file, info, verdict, prevFocus, error, tries}],
//        ok, failed, unverified, analysisReady, corner, lateFocus, shift, logFailures, ms }。
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
  const scanId = `${fileStamp(new Date(t0))}-${String(plateId).slice(-4)}`;
  const log = { name: logName, plate: plate.name, scanId, failures: 0 };
  onProgress("Pre-flight check (homing if needed)…");
  await scanPreflight();

  const axes = plateAxes(plate.ref);
  const { rows: plate_rows, cols: plate_cols } = dims(plate);
  const pitch_mm = PITCH_MM[plate.format] || 9.0;
  const ctx = { axes, plate_rows, plate_cols, pitch_mm, full_res: getFullRes() }; // 整次扫描用同一个分辨率
  const blocks = listBlocks(plate);
  const results = new Map();

  // 板角核验:地图上的 A1 外侧两个方向都应是板外。
  // null = 没核验 (这版 Pi 不支持,或 6/12 孔板一帧只有 1–2 个孔、做不了)。
  // 调用出错 → inconclusive (没拿到证据不等于地图错了)。
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
      corner = { ok: false, status: "inconclusive", reason: `corner check error: ${e.message || e}` };
    }
    if (corner) {
      await logRow(log, {
        label: "A1 corner check",
        ok: corner.ok,
        info: { x: plate.ref.tl.x, y: plate.ref.tl.y, align_error_mm: corner.a1_error_mm },
        verdict: { corner: cornerStatus(corner), issues: [corner.reason] },
      });
    }
  }

  const shootBlock = async (b, idx, retryPass) => {
    const cur = findPlate(plateId) || plate; // 每格都读最新的对焦记忆
    const plan = focusPlan(cur, b.key);
    if (plan.staleOwn) setFocusMemory(plateId, b.key, null, null); // 上次对错了平面的记忆:清掉
    const req = shotRequest(cur, b, blockCenter(cur, b), plan, ctx);
    let lastErr = "";
    for (let t = 1; t <= TRIES; t++) {
      if (shouldStop()) return;
      onProgress(
        `${retryPass ? "Retry " : ""}${b.label} (${idx + 1}/${blocks.length})` +
          `${t > 1 ? ` · try ${t}` : ""}: moving, aligning, focusing…`
      );
      try {
        const { blob, info, camera } = await scanShot(req);
        // 先验收再存:不合格的照样存,但文件名标出来
        const latest = findPlate(plateId) || cur;
        const verdict = judgeShot(latest, b.key, info, corner);
        let file = nameFor(b, camera);
        if (verdict.unverified) file = markUnverified(file);
        await saveBytes(file, await blob.arrayBuffer());
        // 写记忆前记下原来的值:扫后复查要撤销时恢复它,而不是直接删掉
        let prevFocus;
        if (verdict.remember) {
          prevFocus = { z: latest.z?.[b.key], zSharp: latest.zSharp?.[b.key] };
          setFocusMemory(plateId, b.key, info.z, info.sharp);
        }
        const r = { key: b.key, label: b.label, ok: true, file, info, verdict, prevFocus, tries: t };
        results.set(b.key, r);
        await logRow(log, r);
        return;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    const r = { key: b.key, label: b.label, ok: false, error: lastErr, tries: TRIES };
    results.set(b.key, r);
    await logRow(log, r);
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

  // 扫后复查对焦:只看本轮写进了记忆的格子;离平面太远的 → 恢复它写入前的记忆值,
  // 并在记录里补一条 (文件已经存了,改不了名;CSV 里这一行是最终结论,unverified=1)。
  const lateFocus = focusReview(list);
  for (const o of lateFocus) {
    setFocusMemory(plateId, o.key, o.prev.z, o.prev.zSharp);
    const r = list.find((x) => x.key === o.key);
    if (r) r.verdict = markLateOffPlane(r.verdict, o);
    await logRow(log, { ...r, label: `${o.label} post-scan focus check` });
  }

  // 修正板面地图 (证据不完整就不改);决定本身也写进记录
  const cur = findPlate(plateId) || plate;
  const shift = planShift(cur, list, { planned: blocks.length, pitch: pitch_mm, corner });
  if (shift.apply) {
    updatePlate(plateId, (q) => ({ ...q, refPrev: q.ref, refBase: shift.base, ref: shift.ref }));
  }
  const fmt = (v) => (v == null ? "" : v);
  await logRow(log, {
    label: "map decision",
    ok: shift.apply,
    verdict: {
      corner: cornerStatus(corner),
      issues: [
        `applied=${shift.apply ? 1 : 0}`,
        `kind=${fmt(shift.kind)}`,
        `obs_max_mm=${fmt(shift.obsMax)}`,
        `round_max_corner_mm=${fmt(shift.max)}`,
        `drift_from_base_mm=${fmt(shift.drift)}`,
        `mean_mm=${shift.mean ? shift.mean.join(" ") : ""}`,
        `reason=${shift.reason || "applied"}`,
      ],
    },
  });

  return {
    scanId,
    plate: plate.name,
    results: list,
    ok: list.filter((r) => r.ok).length,
    failed: list.filter((r) => !r.ok).length,
    unverified: list.filter((r) => r.ok && r.verdict?.unverified).length,
    analysisReady: list.filter((r) => r.ok && r.verdict?.analysisReady).length,
    corner,
    lateFocus,
    shift: {
      apply: shift.apply,
      reason: shift.reason,
      kind: shift.kind,
      mean: shift.mean,
      max: shift.max,
      drift: shift.drift,
    },
    logFailures: log.failures,
    ms: Date.now() - t0,
  };
}
