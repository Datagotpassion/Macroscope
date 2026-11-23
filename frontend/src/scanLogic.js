// 整板扫描的判断逻辑 —— 纯函数,不碰网络 / 存储 / DOM,可直接 `node --test` 测。
// scanRunner.js 负责调用 Pi、存照片、写 localStorage;这里只回答三个问题:
//   1. 这一格怎么对焦 (focusPlan)
//   2. 这张照片能不能算数 (judgeShot):孔位是否确认、孔身份是否核验、焦面是否合格
//   3. 扫完要不要修正板面地图、改成什么 (planShift)
// 原则:证据不完整就不改地图、不收窄对焦窗口;照片照存,但标 UNVERIFIED 并写明原因。

// ── 对焦 ──
// 实测 2026-11-23:孔底平面 8–10 mm,各格差 < 0.5 mm;板面马克笔字迹在低 ~5 mm 处,
// 孔下方另有一个假峰在高 ~3 mm 处 —— 都曾被宽窗口对焦抓走。
export const DEFAULT_FOCUS_Z = 10; // 还没有已知孔底平面时的窗口中心
export const PLANE_TOL_MM = 1.5; // 离孔底平面超过它 = 对到了别的平面
export const MIN_PLANE_VOTES = 2; // 至少几格互相一致,才算「已知孔底平面」
export const AF_RANGE_NEW = 3; // 平面未知:宽窗口,允许往外扩
export const AF_RANGE_KNOWN = 1.5; // 平面已知:只在平面附近找,不往外扩

// ── 地图修正 ──
// 实测 2026-11-23:两次扫描各格偏差差 < 0.04 mm,是系统性的:整体平移 ~2.3 mm + 1–2% 旋转/缩放。
export const SHIFT_MIN_MM = 0.3; // 最大修正量小于它就不动
export const SHIFT_SPREAD_MM = 1.0; // 只平移时:离中位数 ≤ 它算「意见一致」
export const AFFINE_MAX_RES_MM = 0.5; // 仿射拟合后每个观测的残差上限
export const AFFINE_MAX_SLOPE = 0.05; // 每 mm 最多 0.05 mm (≈3° / 5%)
export const AFFINE_MIN_SPREAD_MM = 10; // 观测点在最窄方向也要铺开这么多 (标准差)
export const ROUND_SHIFT_MAX_PITCH = 0.35; // 单轮修正上限 (孔距的比例),超过 = 该重新找板
export const TOTAL_SHIFT_MAX_PITCH = 0.45; // 相对基准地图 (上次找板/教角) 的累计修正上限

const POSITION_OK = new Set(["confirmed", "aligned"]);
const FOCUS_BAD = new Set(["no_peak", "unknown", "off_plane"]);

// 一帧里看得到足够多孔、能做孔阵识别的板型 (和自动找板一致)。6 / 12 孔板一帧只有 1–2 个孔,
// 画面里的核验 (对正、板边、板角、按内容对焦) 都做不了 —— 不是「失败」,是「这种板型不检查」,
// 照片不标 UNVERIFIED (和以前一样只靠地图),也不跑板角核验。
export const CHECKABLE_FORMATS = new Set([24, 48, 96]);
export const isCheckable = (plate) => CHECKABLE_FORMATS.has(Number(plate?.format));

export const r2 = (v) => Math.round(v * 100) / 100;

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const otherZs = (plate, key) =>
  Object.entries(plate.z || {})
    .filter(([k]) => k !== key)
    .map(([, v]) => v);

// 一组对焦高度里「互相一致」的最大一簇 (都在某个值 ± tol 内) 的中位数。
// 少于 MIN_PLANE_VOTES 个、或有两簇一样大但不一致 → null (平面未知)。
// 单独一格永远定不了平面 —— 第一格对到假峰也不会带偏其他格。
export function focusPlane(values, tol = PLANE_TOL_MM) {
  let best = [];
  const ties = [];
  for (const v of values) {
    const c = values.filter((w) => Math.abs(w - v) <= tol);
    if (c.length > best.length) {
      best = c;
      ties.length = 0;
      ties.push(median(c));
    } else if (c.length === best.length) {
      ties.push(median(c));
    }
  }
  if (best.length < MIN_PLANE_VOTES) return null;
  const m = median(best);
  if (ties.some((t) => Math.abs(t - m) > tol)) return null; // 两个平面各说各的
  return m;
}

// 这一格的对焦计划。
//   平面已知 (其他格里 ≥2 格一致):自己的记忆在平面附近就用它 (还有「够清晰就不对焦」),
//     否则用平面;窄窗口、不外扩。离平面太远的旧记忆 → staleOwn (调用方清掉)。
//   平面未知:默认高度、宽窗口、可外扩 —— 不让任何单独一格的结果收窄别的格子。
export function focusPlan(plate, key) {
  const plane = focusPlane(otherZs(plate, key));
  const own = plate.z?.[key];
  if (plane != null) {
    const ownOk = own != null && Math.abs(own - plane) <= PLANE_TOL_MM;
    return {
      z: ownOk ? own : plane,
      ref_sharp: ownOk ? plate.zSharp?.[key] : undefined,
      af_range: AF_RANGE_KNOWN,
      af_extend: false,
      staleOwn: own != null && !ownOk,
      plane,
    };
  }
  return {
    z: DEFAULT_FOCUS_Z,
    ref_sharp: undefined,
    af_range: AF_RANGE_NEW,
    af_extend: true,
    staleOwn: false,
    plane: null,
  };
}

// 旧版 Pi 没有 info.focus:从 af 推断
function focusOf(info) {
  if (info?.focus) return info.focus;
  const af = info?.af;
  if (!af) return "unknown";
  if (af.found) return "refocused";
  if (af.ran) return "no_peak";
  if (/sharp enough/.test(af.reason || "")) return "sharp_kept";
  if (/no wells with content/.test(af.reason || "")) return "empty";
  if (/autofocus off/.test(af.reason || "")) return "off";
  return "unknown";
}

// 一张照片的验收。info = Pi 返回的 X-Shot;corner = 这一圈的板角核验结果
// ({ok, reason} / null = 这版 Pi 不支持,没核验)。
// 返回 { position, identity, focus, unverified, remember, issues }:
//   position  confirmed / aligned / edge_mismatch / unaligned (Pi 判的,见 scan.py)
//   identity  verified (板角或本格板边核验通过) / failed (板角核验失败) / unknown
//   focus     refocused / sharp_kept / empty / off / no_peak / unknown / off_plane
//   unverified  文件名要不要加 UNVERIFIED
//   remember    能不能把这格的对焦高度记下来
export function judgeShot(plate, key, info, corner) {
  const issues = [];
  if (!isCheckable(plate)) {
    return {
      position: "unchecked",
      identity: "unknown",
      focus: "unchecked",
      unverified: false,
      remember: false,
      issues: [`${plate?.format}-well plate: wells too large for in-frame checks (map position only)`],
    };
  }
  const position =
    info?.position ?? (Array.isArray(info?.align_error_mm) ? "aligned" : "unaligned");
  if (position === "unaligned") issues.push(`position: ${info?.position_note || "not aligned"}`);
  if (position === "edge_mismatch") issues.push(`plate edge: ${info?.position_note || "mismatch"}`);

  let identity = "unknown";
  if (corner && !corner.ok) {
    identity = "failed"; // 板角对不上:整张地图可能错开了整行/整列,本格的单向板边核验不能推翻它
    issues.push(`corner check: ${corner.reason || "failed"}`);
  } else if (corner?.ok || position === "confirmed") {
    identity = "verified";
  }

  let focus = focusOf(info);
  const plane = focusPlane(otherZs(plate, key));
  if (focus === "refocused" && plane != null && Math.abs(info.z - plane) > PLANE_TOL_MM) {
    focus = "off_plane";
  }
  if (FOCUS_BAD.has(focus)) {
    const why = {
      no_peak: `no focus peak, kept Z ${info?.z}`,
      unknown: "focus not assessed (wells not recognised)",
      off_plane: `Z ${info?.z} is ${r2(Math.abs(info.z - plane))} mm off the plate's well-bottom plane (${r2(plane)})`,
    }[focus];
    issues.push(`focus: ${why}`);
  }

  const positionOk = POSITION_OK.has(position);
  return {
    position,
    identity,
    focus,
    unverified: !positionOk || identity === "failed" || FOCUS_BAD.has(focus),
    remember: focus === "refocused" && positionOk && identity !== "failed",
    issues,
  };
}

// 扫完之后复查对焦:用这一圈「找到了峰」的高度定平面,早拍的格子 (当时平面还未知) 如果离平面
// 太远,补记一条问题。返回 [{ key, label, z, plane }]。
export function lateFocusOutliers(results) {
  const found = results.filter((r) => r.ok && r.verdict?.focus === "refocused" && r.info?.z != null);
  const plane = focusPlane(found.map((r) => r.info.z));
  if (plane == null) return [];
  return found
    .filter((r) => Math.abs(r.info.z - plane) > PLANE_TOL_MM)
    .map((r) => ({ key: r.key, label: r.label, z: r.info.z, plane: r2(plane) }));
}

// 偏差 e (平台 mm) 对位置 p 的最小二乘仿射拟合 e ≈ t + J·(p − p̄)。观测点没铺开就 null。
export function fitAffine(ps, es) {
  const n = ps.length;
  const avg = (arr, k) => arr.reduce((s, v) => s + v[k], 0) / n;
  const pc = [avg(ps, 0), avg(ps, 1)];
  const t = [avg(es, 0), avg(es, 1)];
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  const c = [
    [0, 0],
    [0, 0],
  ]; // c[k][i] = Σ (p_k − p̄_k)·e_i
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
  const at = (p) =>
    [0, 1].map((i) => t[i] + J[i][0] * (p[0] - pc[0]) + J[i][1] * (p[1] - pc[1]));
  return { at, J };
}

// 扫完后要不要修正板面地图。只在证据完整时才改:
//   - 计划的每一格都拍成了 (停止 / 缺格的轮次不改);
//   - 这一圈板角核验通过 (孔身份对);
//   - 每格都对正了 (position confirmed / aligned);
//   - 单轮修正 ≤ ROUND_SHIFT_MAX_PITCH × 孔距,相对基准地图累计 ≤ TOTAL_SHIFT_MAX_PITCH × 孔距。
// 观测 = 各格对正时测到的偏差 (修正前,= 地图预测位置的误差) + 板角核验测到的 A1 偏差。
// 返回 { apply, reason, kind?, mean?, max?, ref?, base? }:apply=false 时 reason 说明为什么不改。
export function planShift(plate, results, { planned, pitch, corner }) {
  const done = results.filter((r) => r.ok).length;
  if (done < planned) {
    return { apply: false, reason: `incomplete scan (${done}/${planned} blocks) — map not changed` };
  }
  if (!corner) return { apply: false, reason: "corner check not available — map not changed" };
  if (!corner.ok) return { apply: false, reason: "corner check failed — map not changed" };
  const notAligned = results.filter((r) => !POSITION_OK.has(r.verdict?.position));
  if (notAligned.length) {
    return {
      apply: false,
      reason: `${notAligned.length} block(s) not aligned (${notAligned.map((r) => r.label).join(", ")}) — map not changed`,
    };
  }
  const ps = [];
  const es = [];
  for (const r of results) {
    if (Array.isArray(r.info?.align_error_mm) && r.info.x != null) {
      ps.push([r.info.x, r.info.y]);
      es.push(r.info.align_error_mm);
    }
  }
  const tl = plate.ref?.tl;
  if (tl && Array.isArray(corner.a1_error_mm)) {
    ps.push([tl.x, tl.y]);
    es.push(corner.a1_error_mm);
  }
  if (ps.length < 2) return { apply: false, reason: "too few observations — map not changed" };

  let fix = null;
  let kind = "shift";
  const f = ps.length >= 4 ? fitAffine(ps, es) : null;
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
    if (agree < Math.max(2, Math.ceil((es.length * 2) / 3))) {
      return { apply: false, reason: "blocks disagree on the plate offset — map not changed" };
    }
    fix = () => m;
  }
  const fixes = ps.map(fix);
  const max = Math.max(...fixes.map((d) => Math.hypot(d[0], d[1])));
  const mean = [0, 1].map((i) => r2(fixes.reduce((s, d) => s + d[i], 0) / fixes.length));
  if (max < SHIFT_MIN_MM) {
    return { apply: false, reason: `map within ${r2(max)} mm — no change needed`, kind, mean, max: r2(max) };
  }
  if (max > ROUND_SHIFT_MAX_PITCH * pitch) {
    return {
      apply: false,
      reason: `correction of ${r2(max)} mm is too large for one round — re-find the plate`,
      kind,
      mean,
      max: r2(max),
    };
  }
  const mv = (c) => {
    const d = fix([c.x, c.y]);
    return { ...c, x: r2(c.x + d[0]), y: r2(c.y + d[1]) };
  };
  const ref = { ...plate.ref, tl: mv(plate.ref.tl), tr: mv(plate.ref.tr), bl: mv(plate.ref.bl) };
  const base = plate.refBase || plate.ref;
  const drift = Math.max(
    ...["tl", "tr", "bl"].map((k) => Math.hypot(ref[k].x - base[k].x, ref[k].y - base[k].y))
  );
  if (drift > TOTAL_SHIFT_MAX_PITCH * pitch) {
    return {
      apply: false,
      reason: `map would drift ${r2(drift)} mm from the last found/taught position — re-find the plate`,
      kind,
      mean,
      max: r2(max),
    };
  }
  return { apply: true, reason: "", kind, mean, max: r2(max), ref, base };
}

// 照片文件名加上 UNVERIFIED 标记 (加在扩展名前)
export const markUnverified = (name) => name.replace(/(\.[A-Za-z0-9]+)$/, " - UNVERIFIED$1");
