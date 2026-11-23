// scanLogic 的测试:`npm test` (node --test,不需要额外依赖)。
// 包含两次独立审查 (2026-11-23) 的离线复现场景和真机测试里遇到的情况。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AF_RANGE_KNOWN,
  AF_RANGE_NEW,
  DEFAULT_FOCUS_Z,
  focusPlane,
  focusPlan,
  focusReview,
  fourCorners,
  judgeShot,
  markLateOffPlane,
  markUnverified,
  planShift,
  shotRequest,
} from "./scanLogic.js";

// 96 孔板,4×4 分格 = 6 格 (2 行 × 3 列),A→H 朝 −X,1→12 朝 −Y (和真机一样)
const REF = { tl: { x: 213.5, y: 197.1 }, tr: { x: 213.5, y: 98.1 }, bl: { x: 150.5, y: 197.1 } };
const KEYS = ["0,0", "0,1", "0,2", "1,2", "1,1", "1,0"];
const CENTERS = {
  "0,0": [200, 183.6], "0,1": [200, 147.6], "0,2": [200, 111.6],
  "1,2": [164, 111.6], "1,1": [164, 147.6], "1,0": [164, 183.6],
};
const plateWith = (extra = {}) => ({ format: 96, ref: REF, z: {}, zSharp: {}, ...extra });
const shot = (key, err, extra = {}) => ({
  key,
  label: key,
  ok: true,
  info: { x: CENTERS[key][0], y: CENTERS[key][1], align_error_mm: err, z: 10, ...extra.info },
  verdict: { position: "aligned", focus: "refocused", ...extra.verdict },
});
const CORNER_OK = { ok: true, status: "passed", a1_error_mm: [2.3, 0], reason: "ok" };
const CORNER_BAD = { ok: false, status: "mismatch", reason: "plate edge not where the map puts A1" };
const CORNER_UNSURE = { ok: false, status: "inconclusive", reason: "could not see the plate edge" };

// ── 对焦平面 / 对焦计划 ──

test("one block alone never defines the focus plane", () => {
  assert.equal(focusPlane([13]), null);
  assert.equal(focusPlane([10, 13]), null); // 两格不一致
  assert.equal(focusPlane([10, 10.4]), 10.2);
  assert.equal(focusPlane([10, 10.2, 13, 13.1]), null); // 两簇一样大,各说各的
  assert.equal(focusPlane([10, 10.2, 10.1, 13]), 10.1);
});

test("review 2 Q3: focus plane does not depend on input order; a 2 mm tilt still gives a plane", () => {
  assert.equal(focusPlane([8, 9, 10, 11]), 9.5);
  assert.equal(focusPlane([11, 10, 9, 8]), 9.5);
  assert.equal(focusPlane([8, 8.4, 8.8, 9.2, 9.6, 10]), 9);
  assert.equal(focusPlane([8, 8, 10, 10]), null);
});

test("review 1: first block accepted at Z=13 must not narrow the next block's window", () => {
  const plan = focusPlan(plateWith({ z: { "0,0": 13 } }), "0,1");
  assert.equal(plan.z, DEFAULT_FOCUS_Z);
  assert.equal(plan.af_range, AF_RANGE_NEW);
  assert.equal(plan.af_extend, true);
  assert.ok(plan.z - plan.af_range <= 10 && 10 <= plan.z + plan.af_range);
});

test("two agreeing blocks define the plane; the window narrows around it", () => {
  const plan = focusPlan(plateWith({ z: { "0,0": 10, "0,1": 10.4 } }), "0,2");
  assert.equal(plan.z, 10.2);
  assert.equal(plan.af_range, AF_RANGE_KNOWN);
  assert.equal(plan.af_extend, false);
});

test("own memory far from the plane is stale and not used", () => {
  const p = plateWith({ z: { "0,0": 10, "0,1": 10.2, "0,2": 13 }, zSharp: { "0,2": 99 } });
  const plan = focusPlan(p, "0,2");
  assert.equal(plan.staleOwn, true);
  assert.equal(plan.z, 10.1);
  assert.equal(plan.ref_sharp, undefined);
  const ok = focusPlan(plateWith({ z: { "0,0": 10, "0,1": 10.2, "0,2": 10.3 }, zSharp: { "0,2": 50 } }), "0,2");
  assert.equal(ok.z, 10.3);
  assert.equal(ok.ref_sharp, 50);
});

test("review 2 #3: a hand-taught Z is used for that block — and is what the shot request sends", () => {
  for (const format of [6, 12, 96]) {
    const p = plateWith({ format, zTaught: { "0,0": 7.8 } });
    const plan = focusPlan(p, "0,0");
    assert.equal(plan.z, 7.8, `format ${format}`);
    assert.equal(plan.source, "taught");
    const blk = { r0: 0, rLast: 0, c0: 0, cLast: 0 };
    const req = shotRequest(p, blk, { x: 1, y: 2 }, plan, { axes: {}, plate_rows: 3, plate_cols: 4, pitch_mm: 26, full_res: true });
    assert.equal(req.z, 7.8, `format ${format}`);
    if (format === 96) assert.equal(req.align, undefined);
    else assert.deepEqual([req.align, req.af], [false, false]); // 6/12 孔:只按地图拍
  }
});

test("a hand-taught Z for one block does not narrow the others", () => {
  const plan = focusPlan(plateWith({ zTaught: { "0,0": 7.8 } }), "0,1");
  assert.equal(plan.z, 7.8); // 以它为中心…
  assert.equal(plan.af_range, AF_RANGE_NEW); // …但仍是宽窗口、可外扩
  assert.equal(plan.af_extend, true);
  assert.equal(plan.source, "taught_other");
});

test("6/12-well plates: a height taught with the old version (stored in z) is still used", () => {
  const plan = focusPlan(plateWith({ format: 12, z: { "0,0": 7.8 } }), "0,0");
  assert.equal(plan.z, 7.8);
});

// ── 单张验收 ──

test("review 1: uniform gray frame is saved but UNVERIFIED and not remembered", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "unaligned", focus: "unknown", z: 10 }, CORNER_OK);
  assert.deepEqual([v.unverified, v.remember, v.analysisReady], [true, false, false]);
  assert.ok(v.issues.some((s) => s.startsWith("position")));
  assert.ok(v.issues.some((s) => s.startsWith("focus")));
});

test("a failed corner check marks every photo, even an edge-confirmed one", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "confirmed", focus: "refocused", z: 10 }, CORNER_BAD);
  assert.deepEqual([v.identity, v.corner, v.unverified, v.remember], ["failed", "mismatch", true, false]);
});

test("an inconclusive corner check is not evidence that the map is wrong", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "aligned", focus: "refocused", z: 10 }, CORNER_UNSURE);
  assert.deepEqual([v.identity, v.corner, v.unverified, v.analysisReady], ["unknown", "inconclusive", false, false]);
  const c = judgeShot(plateWith(), "0,0", { position: "confirmed", focus: "refocused", z: 10 }, CORNER_UNSURE);
  assert.equal(c.identity, "partial"); // 本格板边只核验了一个方向
});

test("review 2 Q4: corner passed but this block's edge disagrees → identity 'conflict', not 'verified'", () => {
  const v = judgeShot(plateWith(), "0,0",
    { position: "edge_mismatch", position_note: "row index -1", focus: "refocused", z: 10 }, CORNER_OK);
  assert.deepEqual([v.identity, v.corner, v.unverified, v.remember], ["conflict", "passed", true, false]);
});

test("aligned + corner passed + focus peak → verified, remembered, analysis-ready", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "aligned", focus: "refocused", z: 10 }, CORNER_OK);
  assert.deepEqual([v.identity, v.focusBasis, v.unverified, v.remember, v.analysisReady],
    ["verified", "peak", false, true, true]);
});

test("without a corner check (old Pi) identity is unknown; not flagged, not analysis-ready", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "aligned", focus: "sharp_kept", z: 10 }, null);
  assert.deepEqual([v.identity, v.corner, v.unverified, v.analysisReady], ["unknown", "none", false, false]);
});

test("refocusing onto another plane is flagged once the plane is known", () => {
  const p = plateWith({ z: { "0,1": 10, "0,2": 10.2 } });
  const v = judgeShot(p, "0,0", { position: "aligned", focus: "refocused", z: 13 }, CORNER_OK);
  assert.deepEqual([v.focus, v.unverified, v.remember], ["off_plane", true, false]);
});

test("real machine: no peak on a known plane → kept, not flagged, but only a prediction", () => {
  // 2026-11-23:A1 / A5 / E9 在 7.6–8.1 mm;A9 板面有马克笔字迹,曲线一路往低处升、找不到峰
  const p = plateWith({ z: { "0,0": 8.025, "0,1": 8.106, "1,2": 7.612 } });
  const v = judgeShot(p, "0,2", { position: "confirmed", focus: "no_peak", z: 8.025 }, CORNER_OK);
  assert.deepEqual([v.focus, v.focusBasis, v.unverified, v.remember, v.analysisReady],
    ["plane_kept", "prediction", false, false, false]);
});

test("review 2 #4: kept own old Z 9.4 near plane 8.0 with no peak is NOT analysis-ready", () => {
  const p = plateWith({ z: { "0,0": 7.9, "0,1": 8.1, "0,2": 9.4 } });
  assert.equal(focusPlan(p, "0,2").z, 9.4);
  const v = judgeShot(p, "0,2", { position: "aligned", focus: "no_peak", z: 9.4, sharp: 0.2 }, CORNER_OK);
  assert.equal(v.focus, "plane_kept");
  assert.equal(v.analysisReady, false);
});

test("no peak while the plane is still unknown stays flagged", () => {
  const v = judgeShot(plateWith({ z: { "0,0": 8.0 } }), "0,1", { position: "aligned", focus: "no_peak", z: 10 }, CORNER_OK);
  assert.deepEqual([v.focus, v.unverified], ["no_peak", true]);
});

test("empty wells and edge mismatch", () => {
  const empty = judgeShot(plateWith(), "0,0", { position: "confirmed", focus: "empty", z: 10 }, CORNER_OK);
  assert.deepEqual([empty.unverified, empty.focusBasis, empty.analysisReady], [false, "no_content", false]);
  const edge = judgeShot(plateWith(), "0,0",
    { position: "edge_mismatch", position_note: "row index -1", focus: "refocused", z: 10 }, CORNER_OK);
  assert.deepEqual([edge.unverified, edge.remember], [true, false]);
});

test("6/12-well plates: in-frame checks are impossible, photos are not flagged", () => {
  const v = judgeShot(plateWith({ format: 6 }), "0,0", { position: "unchecked", focus: "unchecked", z: 10 }, null);
  assert.deepEqual([v.position, v.unverified, v.remember, v.analysisReady], ["unchecked", false, false, false]);
  assert.match(v.issues[0], /6-well/);
});

// ── 扫后对焦复查 ──

test("review 2 #2: a round with a failed corner check never removes existing focus memory", () => {
  // 板角失败:所有格 remember=false (没写记忆),即使各格找到了 8 / 11 / 11.1 的峰
  const p = plateWith({ z: { "0,0": 8 } });
  const res = [["0,0", 8], ["0,1", 11], ["0,2", 11.1]].map(([k, z]) => {
    const verdict = judgeShot(p, k, { position: "edge_mismatch", focus: "refocused", z }, CORNER_BAD);
    return { key: k, label: k, ok: true, info: { z }, verdict };
  });
  assert.ok(res.every((r) => r.verdict.remember === false));
  assert.deepEqual(focusReview(res), []);
});

test("post-scan review only judges blocks written this round and restores their previous values", () => {
  const res = [
    { ...shot("0,0", [0, 0], { info: { z: 13 } }), prevFocus: { z: 8.1, zSharp: 4 } },
    shot("0,1", [0, 0], { info: { z: 10 } }),
    shot("0,2", [0, 0], { info: { z: 10.2 } }),
    shot("1,2", [0, 0], { info: { z: 20 }, verdict: { remember: false } }), // 没写记忆 → 不投票、不撤销
  ].map((r) => (r.verdict.remember === undefined ? { ...r, verdict: { ...r.verdict, remember: true } } : r));
  const out = focusReview(res);
  assert.deepEqual(out.map((o) => o.key), ["0,0"]);
  assert.deepEqual(out[0].prev, { z: 8.1, zSharp: 4 });
  const v = markLateOffPlane({ issues: [], unverified: false, analysisReady: true }, out[0]);
  assert.deepEqual([v.focus, v.unverified, v.analysisReady], ["off_plane", true, false]); // CSV 写 unverified=1
});

// ── 地图修正 ──

test("review 1: 4 of 6 blocks failed, 2 report +2.3 mm → map NOT shifted", () => {
  const results = [
    shot("0,0", [2.3, 0]), shot("0,1", [2.3, 0]),
    ...["0,2", "1,2", "1,1", "1,0"].map((k) => ({ key: k, label: k, ok: false, error: "timeout" })),
  ];
  const s = planShift(plateWith(), results, { planned: 6, pitch: 9, corner: CORNER_OK });
  assert.equal(s.apply, false);
  assert.match(s.reason, /incomplete scan \(2\/6/);
});

test("a stopped scan (blocks never shot) does not shift the map", () => {
  const results = [shot("0,0", [2.3, 0]), { key: "0,1", label: "0,1", ok: false, error: "stopped before this block" }];
  assert.equal(planShift(plateWith(), results, { planned: 6, pitch: 9, corner: CORNER_OK }).apply, false);
});

test("complete scan, corner verified, consistent offset → map shifted by it", () => {
  const results = KEYS.map((k) => shot(k, [2.3, 0]));
  const s = planShift(plateWith(), results, { planned: 6, pitch: 9, corner: CORNER_OK });
  assert.equal(s.apply, true);
  for (const k of ["tl", "tr", "bl"]) {
    assert.ok(Math.abs(s.ref[k].x - (REF[k].x + 2.3)) < 0.02, k);
    assert.ok(Math.abs(s.ref[k].y - REF[k].y) < 0.02, k);
  }
  assert.deepEqual(s.base, REF);
  assert.ok(Math.abs(s.drift - 2.3) < 0.02);
});

test("no map change unless the corner check passed", () => {
  const results = KEYS.map((k) => shot(k, [2.3, 0]));
  for (const corner of [null, CORNER_BAD, CORNER_UNSURE]) {
    assert.equal(planShift(plateWith(), results, { planned: 6, pitch: 9, corner }).apply, false);
  }
});

test("no map change when any block was not aligned", () => {
  const results = KEYS.map((k) => shot(k, [2.3, 0]));
  results[3] = shot("1,2", null, { verdict: { position: "unaligned" } });
  const s = planShift(plateWith(), results, { planned: 6, pitch: 9, corner: CORNER_OK });
  assert.equal(s.apply, false);
  assert.match(s.reason, /not aligned/);
});

test("review 2 #1: affine extrapolation to the fourth corner (H12) is checked against the limits", () => {
  // A1=(0,0) A12=(99,0) H1=(0,63);X 偏差 = 0.045 (x + y) − 3,Y 偏差 0。
  // 六格中心和 A1 的最大修正只有 3.07 mm,但 H12 要挪 4.29 mm (> 0.35 × 9 = 3.15)
  const ref = { tl: { x: 0, y: 0 }, tr: { x: 99, y: 0 }, bl: { x: 0, y: 63 } };
  const e = ([x, y]) => [0.045 * (x + y) - 3, 0];
  const cs = [[13.5, 13.5], [49.5, 13.5], [85.5, 13.5], [85.5, 49.5], [49.5, 49.5], [13.5, 49.5]];
  const results = cs.map((p, i) => ({ key: String(i), label: String(i), ok: true,
    info: { x: p[0], y: p[1], align_error_mm: e(p) }, verdict: { position: "aligned" } }));
  const s = planShift({ format: 96, ref }, results,
    { planned: 6, pitch: 9, corner: { ...CORNER_OK, a1_error_mm: e([0, 0]) } });
  assert.equal(s.apply, false);
  assert.ok(Math.abs(s.max - 4.29) < 0.02, s.max);
  assert.match(s.reason, /too large/);
  assert.deepEqual(fourCorners(ref).br, { x: 99, y: 63 });
});

test("per-round and cumulative correction limits (four corners)", () => {
  const big = KEYS.map((k) => shot(k, [4.0, 0])); // > 0.35 × 9 mm
  const s1 = planShift(plateWith(), big, { planned: 6, pitch: 9, corner: { ...CORNER_OK, a1_error_mm: [4.0, 0] } });
  assert.equal(s1.apply, false);
  assert.match(s1.reason, /too large/);
  // 已经累计漂了 3 mm,这一轮再 +2 mm → 相对基准 5 mm > 0.45 × 9
  const base = { tl: { x: 210.5, y: 197.1 }, tr: { x: 210.5, y: 98.1 }, bl: { x: 147.5, y: 197.1 } };
  const s2 = planShift(plateWith({ refBase: base }), KEYS.map((k) => shot(k, [2.0, 0])),
    { planned: 6, pitch: 9, corner: { ...CORNER_OK, a1_error_mm: [2.0, 0] } });
  assert.equal(s2.apply, false);
  assert.match(s2.reason, /re-find the plate/);
});

test("tiny offsets leave the map alone", () => {
  const s = planShift(plateWith(), KEYS.map((k) => shot(k, [0.1, -0.1])),
    { planned: 6, pitch: 9, corner: { ...CORNER_OK, a1_error_mm: [0.1, -0.1] } });
  assert.equal(s.apply, false);
  assert.match(s.reason, /no change needed/);
});

test("markUnverified inserts the tag before the extension", () => {
  assert.equal(markUnverified("exp - Plate 1 - A1 - day 0 - 2026-11-23_14-05-09.jpg"),
    "exp - Plate 1 - A1 - day 0 - 2026-11-23_14-05-09 - UNVERIFIED.jpg");
});
