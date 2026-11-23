// 整板扫描的判断逻辑 —— 纯函数,不碰网络 / 存储 / DOM,可直接 `node --test` 测。
// scanRunner.js 负责调用 Pi、存照片、写 localStorage;这里只回答这些问题:
//   1. 这一格怎么对焦、请求怎么发 (focusPlan / shotRequest)
//   2. 这张照片能不能算数 (judgeShot):孔位是否对正、孔身份是否核验、焦面依据是什么、能否直接用于分析
//   3. 扫完复查对焦,要撤销哪些本轮写入的记忆 (focusReview)
//   4. 扫完要不要修正板面地图、改成什么 (planShift)
// 原则:证据不完整就不改地图、不收窄对焦窗口、不删旧记忆;照片照存,但标 UNVERIFIED 并写明原因。

// ── 对焦 ──
// 实测 2026-11-23:孔底平面 8–10 mm,各格差 < 0.5 mm;板面马克笔字迹在低 ~5 mm 处,
// 孔下方另有一个假峰在高 ~3 mm 处 —— 都曾被宽窗口对焦抓走。
export const DEFAULT_FOCUS_Z = 10; // 还没有已知孔底平面时的窗口中心
export const PLANE_TOL_MM = 1.5; // 历史焦高的一致性容差 (不是「允许离焦多少」)
export const MIN_PLANE_VOTES = 2; // 至少几格互相一致,才算「已知孔底平面」
export const AF_RANGE_NEW = 3; // 平面未知:宽窗口,允许往外扩
export const AF_RANGE_KNOWN = 1.5; // 平面已知 / 手教高度:只在附近找,不往外扩

// ── 地图修正 ──
// 实测 2026-11-23:两次扫描各格偏差差 < 0.04 mm,是系统性的:整体平移 ~2.3 mm + 1–2% 旋转/缩放。
export const SHIFT_MIN_MM = 0.3; // 四角最大修正量小于它就不动
export const SHIFT_SPREAD_MM = 1.0; // 只平移时:离中位数 ≤ 它算「意见一致」
export const AFFINE_MAX_RES_MM = 0.5; // 仿射拟合后每个观测的残差上限
export const AFFINE_MAX_SLOPE = 0.05; // 每 mm 最多 0.05 mm (≈3° / 5%)
export const AFFINE_MIN_SPREAD_MM = 10; // 观测点在最窄方向也要铺开这么多 (标准差)
export const ROUND_SHIFT_MAX_PITCH = 0.35; // 单轮修正上限 (孔距的比例,按四角算),超过 = 该重新找板
export const TOTAL_SHIFT_MAX_PITCH = 0.45; // 相对基准地图 (上次找板/教角) 的累计修正上限 (按四角算)

const POSITION_OK = new Set(["confirmed", "aligned"]);
const FOCUS_BAD = new Set(["no_peak", "unknown", "off_plane"]);
// 焦面依据里,只有这两种是「本格自己的证据」
const BASIS_MEASURED = new Set(["peak", "reference"]);

// 一帧里看得到足够多孔、能做孔阵识别的板型 (和自动找板一致)。6 / 12 孔板一帧只有 1–2 个孔,
// 画面里的核验 (对正、板边、板角、按内容对焦) 都做不了 —— 不是「失败」,是「这种板型不检查」:
// App 让 Pi 只按地图拍 (align=false),照片不标 UNVERIFIED,也不跑板角核验。
export const CHECKABLE_FORMATS = new Set([24, 48, 96]);
export const isCheckable = (plate) => CHECKABLE_FORMATS.has(Number(plate?.format));

export const r2 = (v) => Math.round(v * 100) / 100;

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 自动对焦记忆 (plate.z) 里其他格的高度。手教高度 (plate.zTaught) 不参与 —— 手教只管那一格。
export const otherZs = (plate, key) =>
  Object.entries(plate.z || {})
    .filter(([k]) => k !== key)
    .map(([, v]) => v);

// 一组对焦高度里「互相一致」的最大一簇 (都在某个值 ± tol 内) 的中位数。
// 少于 MIN_PLANE_VOTES 个 → null (平面未知)。单独一格永远定不了平面。
// 有几簇一样大:它们的中位数彼此差 > tol → null (两个平面各说各的);否则取这几簇并集的中位数
// (和输入顺序无关)。
export function focusPlane(values, tol = PLANE_TOL_MM) {
  let bestN = 0;
  let tied = [];
  values.forEach((v) => {
    const idx = values.flatMap((w, j) => (Math.abs(w - v) <= tol ? [j] : []));
    if (idx.length > bestN) {
      bestN = idx.length;
      tied = [idx];
    } else if (idx.length === bestN) {
      tied.push(idx);
    }
  });
  if (bestN < MIN_PLANE_VOTES) return null;
  const meds = tied.map((idx) => median(idx.map((j) => values[j])));
  if (Math.max(...meds) - Math.min(...meds) > tol) return null;
  const union = [...new Set(tied.flat())];
  return median(union.map((j) => values[j]));
}

// 这一格的对焦计划。source 说明高度从哪来:
//   taught        用户给这一格手教的高度 (只用于这一格;窄窗口、不外扩)
//   own / plane   平面已知 (其他格里 ≥2 格一致):自己的记忆在平面附近就用它 (还有「够清晰就不对焦」),
//                 否则用平面;窄窗口、不外扩。离平面太远的旧记忆 → staleOwn (调用方清掉)。
//   taught_other  平面未知,但其他格有手教高度:以它们的中位数为中心,宽窗口、可外扩
//   default       平面未知:默认高度、宽窗口、可外扩 —— 不让任何单独一格的结果收窄别的格子
export function focusPlan(plate, key) {
  const plane = focusPlane(otherZs(plate, key));
  const own = plate.z?.[key];
  const taught = plate.zTaught?.[key];
  if (taught != null) {
    const ownNear = own != null && Math.abs(own - taught) <= PLANE_TOL_MM;
    return {
      z: taught,
      ref_sharp: ownNear ? plate.zSharp?.[key] : undefined,
      af_range: AF_RANGE_KNOWN,
      af_extend: false,
      staleOwn: false,
      plane,
      source: "taught",
    };
  }
  if (plane != null) {
    const ownOk = own != null && Math.abs(own - plane) <= PLANE_TOL_MM;
    return {
      z: ownOk ? own : plane,
      ref_sharp: ownOk ? plate.zSharp?.[key] : undefined,
      af_range: AF_RANGE_KNOWN,
      af_extend: false,
      staleOwn: own != null && !ownOk,
      plane,
      source: ownOk ? "own" : "plane",
    };
  }
  // 6/12 孔板不跑自动对焦,plate.z 里的值只可能是旧版手教的 → 当作这一格的手教高度
  if (!isCheckable(plate) && own != null) {
    return {
      z: own,
      ref_sharp: undefined,
      af_range: AF_RANGE_KNOWN,
      af_extend: false,
      staleOwn: false,
      plane: null,
      source: "taught",
    };
  }
  const otherTaught = Object.entries(plate.zTaught || {})
    .filter(([k]) => k !== key)
    .map(([, v]) => v);
  return {
    z: median(otherTaught) ?? DEFAULT_FOCUS_Z,
    ref_sharp: undefined,
    af_range: AF_RANGE_NEW,
    af_extend: true,
    staleOwn: false,
    plane: null,
    source: otherTaught.length ? "taught_other" : "default",
  };
}

// 发给 Pi 的单格请求 (POST /api/scan/shot 的参数)。ctx = { axes, plate_rows, plate_cols, pitch_mm, full_res }。
// 6/12 孔板:align=false、af=false —— Pi 只按地图位置和计划高度拍。
export function shotRequest(plate, block, center, plan, ctx) {
  const req = {
    x: center.x,
    y: center.y,
    z: plan.z,
    ...ctx.axes,
    row_half: (block.rLast - block.r0 + 1) % 2 === 0,
    col_half: (block.cLast - block.c0 + 1) % 2 === 0,
    plate_rows: ctx.plate_rows,
    plate_cols: ctx.plate_cols,
    r0: block.r0,
    r1: block.rLast,
    c0: block.c0,
    c1: block.cLast,
    pitch_mm: ctx.pitch_mm,
    af_range: plan.af_range,
    af_extend: plan.af_extend,
    ref_sharp: plan.ref_sharp,
    full_res: ctx.full_res,
  };
  if (!isCheckable(plate)) Object.assign(req, { align: false, af: false });
  return req;
}

// 板角核验结果的状态。旧版 Pi 只有 ok:ok=false 当作 mismatch。
// 调用失败 (网络 / HTTP 错误) 由 scanRunner 记成 inconclusive —— 没拿到证据不等于地图错了。
export const cornerStatus = (corner) =>
  corner == null ? "none" : corner.status || (corner.ok ? "passed" : "mismatch");

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

// 焦面依据:这张照片的高度凭什么认为是对的
const BASIS = {
  refocused: "peak", // 本格扫 Z 找到了峰
  sharp_kept: "reference", // 本格清晰度 ≥ 本格历史峰值的 80%,没重扫
  plane_kept: "prediction", // 本格没有峰,沿用了预测高度 (平面 / 历史记忆) —— 没有本格证据
  empty: "no_content", // 孔里没东西,无从判断
  off: "none",
  no_peak: "none",
  unknown: "none",
  off_plane: "off_plane_peak",
  unchecked: "unchecked",
};

// 一张照片的验收。info = Pi 返回的 X-Shot;corner = 这一圈的板角核验结果 (null = 没核验)。
// 返回:
//   position       confirmed / aligned / edge_mismatch / unaligned / unchecked (Pi 判的,见 scan.py)
//   identity       verified  板角核验通过,本格没有冲突
//                  partial   板角没核验 / 看不清,但本格自己看到的板边一致 (只核验了一个方向)
//                  conflict  本格板边对不上 (不管板角结论如何)
//                  failed    板角核验对不上 (整张地图可能错开了整行/整列)
//                  unknown   没有任何身份证据
//   corner         这一圈板角核验的状态:passed / mismatch / inconclusive / none
//   focus          refocused / sharp_kept / plane_kept / empty / off / no_peak / unknown / off_plane / unchecked
//   focusBasis     peak / reference / prediction / no_content / none / off_plane_peak / unchecked
//   unverified     文件名要不要加 UNVERIFIED (有证据表明不对,或焦面不合格)
//   analysisReady  能否直接用于依赖孔内细节的分析:孔位对正 + 身份已核验 + 焦面有本格证据
//   remember       能不能把这格的对焦高度写进记忆
export function judgeShot(plate, key, info, corner) {
  const issues = [];
  const cs = cornerStatus(corner);
  if (!isCheckable(plate)) {
    return {
      position: "unchecked",
      identity: "unknown",
      corner: cs,
      focus: "unchecked",
      focusBasis: "unchecked",
      unverified: false,
      analysisReady: false,
      remember: false,
      issues: [`${plate?.format}-well plate: wells too large for in-frame checks (map position only)`],
    };
  }
  const position =
    info?.position ?? (Array.isArray(info?.align_error_mm) ? "aligned" : "unaligned");
  if (position === "unaligned") issues.push(`position: ${info?.position_note || "not aligned"}`);
  if (position === "edge_mismatch") issues.push(`plate edge: ${info?.position_note || "mismatch"}`);

  let identity = "unknown";
  if (cs === "mismatch") identity = "failed";
  else if (position === "edge_mismatch") identity = "conflict";
  else if (cs === "passed") identity = "verified";
  else if (position === "confirmed") identity = "partial";
  if (cs === "mismatch") issues.push(`corner check: ${corner.reason || "mismatch"}`);
  else if (cs === "inconclusive") issues.push(`corner check inconclusive: ${corner.reason || ""}`);

  let focus = focusOf(info);
  const plane = focusPlane(otherZs(plate, key));
  if (focus === "refocused" && plane != null && Math.abs(info.z - plane) > PLANE_TOL_MM) {
    focus = "off_plane";
  }
  // 平面已知、本格找不到峰、沿用的高度在平面附近 → 照片照存、不标 UNVERIFIED,但焦面依据只是
  // 「预测」,不算本格证据 (analysisReady = false)。2026-11-23 真机:A9 板面马克笔字迹让曲线一路
  // 往低处升,E5/E1 往高处升,从来找不到峰。
  if (focus === "no_peak" && plane != null && Math.abs(info.z - plane) <= PLANE_TOL_MM) {
    focus = "plane_kept";
    issues.push(
      `focus: no peak in this block; kept predicted Z ${info.z} (plane ${r2(plane)}) — not measured here`
    );
  }
  if (FOCUS_BAD.has(focus)) {
    const why = {
      no_peak: `no focus peak and the plate plane is unknown, kept Z ${info?.z}`,
      unknown: "focus not assessed (wells not recognised)",
      off_plane: `Z ${info?.z} is ${r2(Math.abs(info.z - plane))} mm off the plate's well-bottom plane (${r2(plane)})`,
    }[focus];
    issues.push(`focus: ${why}`);
  }
  const focusBasis = BASIS[focus] || "none";

  const positionOk = POSITION_OK.has(position);
  const identityBad = identity === "failed" || identity === "conflict";
  return {
    position,
    identity,
    corner: cs,
    focus,
    focusBasis,
    unverified: !positionOk || identityBad || FOCUS_BAD.has(focus),
    analysisReady: positionOk && identity === "verified" && BASIS_MEASURED.has(focusBasis),
    remember: focus === "refocused" && positionOk && !identityBad,
    issues,
  };
}

// 扫完复查对焦:早拍的格子当时平面还未知,现在用整圈结果再看一遍。
// 只让「本轮实际写进了记忆」的格子 (verdict.remember) 投票,也只撤销它们 —— 板角失败、孔位不对的
// 格子从来没写过记忆,不能拿它们的峰去删别的格子的旧记忆。撤销 = 恢复本轮写入前的值 (r.prevFocus)。
// 返回 [{ key, label, z, plane, prev }]。
export function focusReview(results) {
  const voters = results.filter((r) => r.ok && r.verdict?.remember && r.info?.z != null);
  const plane = focusPlane(voters.map((r) => r.info.z));
  if (plane == null) return [];
  return voters
    .filter((r) => Math.abs(r.info.z - plane) > PLANE_TOL_MM)
    .map((r) => ({ key: r.key, label: r.label, z: r.info.z, plane: r2(plane), prev: r.prevFocus || {} }));
}

// 复查判定离开平面后的最终 verdict (CSV / 汇总都用它)
export function markLateOffPlane(verdict, o) {
  return {
    ...verdict,
    focus: "off_plane",
    focusBasis: "off_plane_peak",
    unverified: true,
    analysisReady: false,
    remember: false,
    issues: [...(verdict?.issues || []), `focus (post-scan check): Z ${o.z} is off the well-bottom plane ${o.plane}`],
  };
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

// 地图的四个角:A1 (tl) / A<末列> (tr) / <末行>1 (bl),第四角 <末行><末列> (br) 由平行四边形补出。
// 仿射位移场在平行四边形里的最大位移一定出现在四个角上,所以单轮 / 累计上限都按四角算
// (旧版只看三角,第四角 H12 可以越限,2026-11-23 复核)。
export const fourCorners = (ref) => ({
  tl: ref.tl,
  tr: ref.tr,
  bl: ref.bl,
  br: { x: ref.tr.x + ref.bl.x - ref.tl.x, y: ref.tr.y + ref.bl.y - ref.tl.y },
});
const maxCornerDistance = (a, b) =>
  Math.max(...["tl", "tr", "bl", "br"].map((k) => Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y)));

// 扫完后要不要修正板面地图。只在证据完整时才改:
//   - 计划的每一格都拍成了 (停止 / 缺格的轮次不改);
//   - 这一圈板角核验通过 (孔身份对);
//   - 每格都对正了 (position confirmed / aligned);
//   - 四角的单轮修正 ≤ ROUND_SHIFT_MAX_PITCH × 孔距,四角相对基准地图的累计漂移 ≤ TOTAL_SHIFT_MAX_PITCH × 孔距。
// 观测 = 各格对正时测到的偏差 (修正前,= 地图预测位置的误差) + 板角核验测到的 A1 偏差。
// 返回 { apply, reason, kind?, mean?, max? (四角最大单轮修正), drift? (四角相对基准的最大漂移), ref?, base? }。
export function planShift(plate, results, { planned, pitch, corner }) {
  const done = results.filter((r) => r.ok).length;
  if (done < planned) {
    return { apply: false, reason: `incomplete scan (${done}/${planned} blocks) — map not changed` };
  }
  const cs = cornerStatus(corner);
  if (cs !== "passed") return { apply: false, reason: `corner check ${cs} — map not changed` };
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
  const cur = fourCorners(plate.ref);
  const moves = Object.values(cur).map((c) => fix([c.x, c.y]));
  const max = Math.max(...moves.map((d) => Math.hypot(d[0], d[1])));
  const mean = [0, 1].map((i) => r2(moves.reduce((s, d) => s + d[i], 0) / moves.length));
  const base = plate.refBase || plate.ref;
  // 「值不值得改」看实际拍摄的位置 (各格中心 + A1) 上的拟合修正 —— 证据在那里;
  // 「改得安不安全」(下面两道上限) 看四角。四角是外推值,会放大噪声:2026-11-23 真机一轮正常扫描,
  // 拍摄位置上最大只要 0.298 mm,外推到 A12 是 0.362 mm,按四角判断就把 A5 的局部偏差学进了地图。
  const obsMax = Math.max(...ps.map((p) => Math.hypot(...fix(p))));
  const info = { kind, mean, max: r2(max), obsMax: r2(obsMax) };
  if (obsMax < SHIFT_MIN_MM) {
    return {
      apply: false,
      reason: `blocks within ${r2(obsMax)} mm of the map — no change needed`,
      ...info,
      drift: r2(maxCornerDistance(cur, fourCorners(base))),
    };
  }
  if (max > ROUND_SHIFT_MAX_PITCH * pitch) {
    return {
      apply: false,
      reason: `correction of ${r2(max)} mm (four-corner max) is too large for one round — re-find the plate`,
      ...info,
    };
  }
  const mv = (c) => {
    const d = fix([c.x, c.y]);
    return { ...c, x: r2(c.x + d[0]), y: r2(c.y + d[1]) };
  };
  const ref = { ...plate.ref, tl: mv(plate.ref.tl), tr: mv(plate.ref.tr), bl: mv(plate.ref.bl) };
  const drift = maxCornerDistance(fourCorners(ref), fourCorners(base));
  if (drift > TOTAL_SHIFT_MAX_PITCH * pitch) {
    return {
      apply: false,
      reason: `map would drift ${r2(drift)} mm (four-corner max) from the last found/taught position — re-find the plate`,
      ...info,
      drift: r2(drift),
    };
  }
  return { apply: true, reason: "", ...info, drift: r2(drift), ref, base };
}

// 照片文件名加上 UNVERIFIED 标记 (加在扩展名前)
export const markUnverified = (name) => name.replace(/(\.[A-Za-z0-9]+)$/, " - UNVERIFIED$1");
