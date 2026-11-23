// 一键拍全板 (App 端编排):自检 → 逐格拍摄 → 保存到 PC → 失败的格子补拍一轮。
// 单格在 Pi 上一次完成 (移过去 → 对正 → 按需对焦 → 全分辨率照片),见 backend/scan.py。
// 每格对焦找到的高度 / 清晰度写回板面地图 (plate.z / plate.zSharp),下次先按它预测并
// 「清晰度够就不重新对焦」;板子有一点倾斜也能各格各用各的高度。
// 整块板一致地偏了 (板子被碰过) → 扫完把板面地图整体平移,下次直接到位。
// Plate map 的「Scan plate」和延时巡扫共用这里。

import { scanPreflight, scanShot } from "./api";
import { loadStore, saveStore, listBlocks, blockCenter, cornersSet } from "./plateModel";
import { saveBytes, appendCsvRow, saveMode } from "./save";

// 还没有对焦记忆时的预测高度:孔底平面 (2026-11-23 实测 8–10 mm)。拍过一次后用该板实测中位数。
export const DEFAULT_FOCUS_Z = 10;
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

// 对焦 (实测 2026-11-23:各格孔底高度差 < 0.5 mm;板面马克笔字迹在低 ~5 mm 处,
// 孔下方另有一个假峰在高 ~3 mm 处 —— 都曾被宽窗口对焦抓走)
const PLANE_TOL_MM = 1.5; // 和板上其他格的中位数差超过它 = 对到了别的平面,不记、不用
const AF_RANGE_NEW = 3; // 这块板还没有对焦记忆:宽窗口,允许往外扩
const AF_RANGE_KNOWN = 1.5; // 已有记忆:只在孔底平面附近找,不往外扩

// 板子位置:扫完用各格的对正偏差修正板面地图。实测 (2026-11-23) 两次扫描各格偏差差 < 0.04 mm,
// 是系统性的:整体平移 ~2.3 mm + 1–2% 的旋转/缩放。优先拟合「平移 + 线性」(仿射),
// 拟合不可靠就退回只平移 (中位数,≥ 2/3 的格子离它 ≤ SHIFT_SPREAD)。最大修正量 < SHIFT_MIN 就不动。
const SHIFT_MIN_MM = 0.3;
const SHIFT_SPREAD_MM = 1.0;
const AFFINE_MAX_RES_MM = 0.5; // 仿射拟合后每格残差都要 ≤ 它 (有一格测错就不用仿射)
const AFFINE_MAX_SLOPE = 0.05; // 每 mm 最多 0.05 mm (≈3° / 5%),再大多半是测错了
const AFFINE_MIN_SPREAD_MM = 10; // 格子中心在最窄的方向也要铺开这么多 (标准差),斜率才定得准

const r2 = (v) => Math.round(v * 100) / 100;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const findPlate = (id) => loadStore().plates.find((p) => p.id === id) || null;

function updatePlate(plateId, fn) {
  const s = loadStore();
  saveStore({ ...s, plates: s.plates.map((p) => (p.id === plateId ? fn(p) : p)) });
  window.dispatchEvent(new Event(STORE_EVENT));
}

const otherZs = (plate, key) =>
  Object.entries(plate.z || {})
    .filter(([k]) => k !== key)
    .map(([, v]) => v);

// 这格的对焦计划:自己的记忆 (和其他格一致时) → 其他格的中位数 → 默认值。
// 自己的记忆和其他格差太多 = 上次对到了别的平面:不用它,也不用它的清晰度参考。
function focusPlan(plate, key) {
  const others = otherZs(plate, key);
  const plane = median(others);
  const own = plate.z?.[key];
  const ownOk = own != null && (others.length < 2 || Math.abs(own - plane) <= PLANE_TOL_MM);
  const known = ownOk || others.length > 0;
  return {
    z: ownOk ? own : plane ?? DEFAULT_FOCUS_Z,
    ref_sharp: ownOk ? plate.zSharp?.[key] : undefined,
    af_range: known ? AF_RANGE_KNOWN : AF_RANGE_NEW,
    af_extend: !known,
    staleOwn: own != null && !ownOk,
  };
}

// 只在对焦确实找到峰、且和其他格一致时记下这格的高度和清晰度
// (跳过对焦时不更新参考值,免得模糊慢慢「合法化」)。返回 "saved" | "off-plane" | null。
function rememberFocus(plateId, key, info) {
  if (!info?.af?.found || info.z == null) return null;
  const p = findPlate(plateId);
  if (!p) return null;
  const others = otherZs(p, key);
  if (others.length >= 2 && Math.abs(info.z - median(others)) > PLANE_TOL_MM) return "off-plane";
  updatePlate(plateId, (q) => {
    const z = { ...(q.z || {}), [key]: info.z };
    const zSharp = { ...(q.zSharp || {}) };
    if (info.sharp != null) zSharp[key] = info.sharp;
    return { ...q, z, zSharp };
  });
  return "saved";
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

// 偏差 e (平台 mm) 对位置 p 的最小二乘仿射拟合 e ≈ t + J·(p − p̄)。格子没铺开就 null。
// 返回 { at(p) → 该处的修正量 [dx, dy], J }。
function fitAffine(ps, es) {
  const n = ps.length;
  const avg = (arr, k) => arr.reduce((s, v) => s + v[k], 0) / n;
  const pc = [avg(ps, 0), avg(ps, 1)];
  const t = [avg(es, 0), avg(es, 1)];
  let sxx = 0, sxy = 0, syy = 0;
  const c = [[0, 0], [0, 0]]; // c[k][i] = Σ (p_k − p̄_k)·e_i
  ps.forEach((p, j) => {
    const d = [p[0] - pc[0], p[1] - pc[1]];
    sxx += d[0] * d[0];
    sxy += d[0] * d[1];
    syy += d[1] * d[1];
    for (let k = 0; k < 2; k++) for (let i = 0; i < 2; i++) c[k][i] += d[k] * es[j][i];
  });
  const lamMin = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  if (lamMin / n < AFFINE_MIN_SPREAD_MM ** 2) return null;
  const det = sxx * syy - sxy * sxy;
  // J[i][k] = ∂e_i/∂p_k = (S⁻¹·c)[k][i],S = [[sxx, sxy], [sxy, syy]]
  const J = [0, 1].map((i) => [
    (syy * c[0][i] - sxy * c[1][i]) / det,
    (sxx * c[1][i] - sxy * c[0][i]) / det,
  ]);
  const at = (p) => [0, 1].map((i) => t[i] + J[i][0] * (p[0] - pc[0]) + J[i][1] * (p[1] - pc[1]));
  return { at, J };
}

// 扫完后:按各格对正时测到的偏差修正板面地图 (三个角一起变换),下次直接到位。
// 返回 { kind: "affine" | "shift", mean: [dx, dy], max } 或 null (没必要 / 不可靠)。
function learnShift(plateId, results) {
  const pts = results.filter((r) => Array.isArray(r.info?.align_error_mm) && r.info.x != null);
  if (pts.length < 2) return null;
  const ps = pts.map((r) => [r.info.x, r.info.y]);
  const es = pts.map((r) => r.info.align_error_mm);
  let fix = null;
  let kind = "shift";
  const f = pts.length >= 4 ? fitAffine(ps, es) : null;
  if (f && f.J.flat().every((v) => Math.abs(v) <= AFFINE_MAX_SLOPE)) {
    const ok = ps.every((p, j) => {
      const q = f.at(p);
      return Math.hypot(es[j][0] - q[0], es[j][1] - q[1]) <= AFFINE_MAX_RES_MM;
    });
    if (ok) [fix, kind] = [f.at, "affine"];
  }
  if (!fix) {
    const m = [median(es.map((e) => e[0])), median(es.map((e) => e[1]))];
    const agree = es.filter((e) => Math.hypot(e[0] - m[0], e[1] - m[1]) <= SHIFT_SPREAD_MM).length;
    if (agree < Math.max(2, Math.ceil((es.length * 2) / 3))) return null; // 不一致:不动地图
    fix = () => m;
  }
  const fixes = ps.map(fix);
  const max = Math.max(...fixes.map((d) => Math.hypot(d[0], d[1])));
  if (max < SHIFT_MIN_MM) return null;
  const mv = (c) => {
    const d = fix([c.x, c.y]);
    return { ...c, x: r2(c.x + d[0]), y: r2(c.y + d[1]) };
  };
  updatePlate(plateId, (q) => ({
    ...q,
    ref: { ...q.ref, tl: mv(q.ref.tl), tr: mv(q.ref.tr), bl: mv(q.ref.bl) },
  }));
  const mean = [0, 1].map((i) => r2(fixes.reduce((s, d) => s + d[i], 0) / fixes.length));
  return { kind, mean, max: r2(max) };
}

// 扫描记录 (只在桌面 App 里写:浏览器没有追加,每行会变成一次下载)
const LOG_HEADER =
  "time,plate,block,ok,file,x,y,align_dx,align_dy,realigned,z_pred,z,focus,af_gain,content_wells,sharp,af_curve,error";
const csv = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
async function logRow(logName, plateName, r) {
  if (!logName || saveMode() !== "desktop") return;
  const i = r.info || {};
  const af = i.af || {};
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
    i.z_pred,
    i.z,
    af.found ? `refocused${r.focus === "off-plane" ? " (off-plane, not saved)" : ""}` : af.reason,
    af.gain,
    i.content_wells,
    i.sharp,
    (af.curve || []).map(([z, s]) => `${z}:${s}`).join(" "),
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
//   nameFor(block, camera) → 文件名 (必填;camera 为 "mock-forced" 时调用方可加 MOCK 前缀)
//   logName                 → 扫描记录 CSV 文件名 (可选,只在桌面 App 写)
//   onProgress(text)        → 进度文字
//   shouldStop()            → 返回 true 时不再开始新的一格
// 返回 { plate, results: [{label, ok, file, info, error, tries, focus}], ok, failed, shift, ms }。
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

  const { tl, bl } = plate.ref;
  const len = Math.hypot(bl.x - tl.x, bl.y - tl.y) || 1;
  const rows = { rows_dx: (bl.x - tl.x) / len, rows_dy: (bl.y - tl.y) / len };
  const pitch_mm = PITCH_MM[plate.format] || 9.0;
  const blocks = listBlocks(plate);
  const results = new Map();
  const full_res = getFullRes(); // 整次扫描用同一个分辨率

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
          ...rows,
          row_half: (b.rLast - b.r0 + 1) % 2 === 0,
          col_half: (b.cLast - b.c0 + 1) % 2 === 0,
          pitch_mm,
          af_range: plan.af_range,
          af_extend: plan.af_extend,
          ref_sharp: plan.ref_sharp,
          full_res,
        });
        const file = nameFor(b, camera);
        await saveBytes(file, await blob.arrayBuffer());
        const focus = rememberFocus(plateId, b.key, info);
        const r = { label: b.label, ok: true, file, info, tries: t, focus };
        results.set(b.key, r);
        await logRow(logName, plate.name, r);
        return;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    const r = { label: b.label, ok: false, error: lastErr, tries: TRIES };
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
    (b) => results.get(b.key) || { label: b.label, ok: false, error: "stopped before this block" }
  );
  return {
    plate: plate.name,
    results: list,
    ok: list.filter((r) => r.ok).length,
    failed: list.filter((r) => !r.ok).length,
    shift: learnShift(plateId, list),
    ms: Date.now() - t0,
  };
}
