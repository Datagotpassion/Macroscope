// scanLogic 的测试:`npm test` (node --test,不需要额外依赖)。
// 包含独立审查 (2026-11-23) 的离线复现场景。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AF_RANGE_KNOWN,
  AF_RANGE_NEW,
  DEFAULT_FOCUS_Z,
  focusPlane,
  focusPlan,
  judgeShot,
  lateFocusOutliers,
  markUnverified,
  planShift,
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
const CORNER_OK = { ok: true, a1_error_mm: [2.3, 0], reason: "ok" };

// ── 对焦计划 ──

test("one block alone never defines the focus plane", () => {
  assert.equal(focusPlane([13]), null);
  assert.equal(focusPlane([10, 13]), null); // 两格不一致
  assert.equal(focusPlane([10, 10.4]), 10.2);
  assert.equal(focusPlane([10, 10.2, 13, 13.1]), null); // 两簇一样大,各说各的
  assert.equal(focusPlane([10, 10.2, 10.1, 13]), 10.1);
});

test("review repro: first block accepted at Z=13 must not narrow the next block's window", () => {
  const plan = focusPlan(plateWith({ z: { "0,0": 13 } }), "0,1");
  assert.equal(plan.z, DEFAULT_FOCUS_Z);
  assert.equal(plan.af_range, AF_RANGE_NEW);
  assert.equal(plan.af_extend, true);
  // 窗口 7–13 + 可外扩,真实孔底 10 在窗口内部
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

// ── 单张验收 ──

test("review repro: uniform gray frame is saved but UNVERIFIED and not remembered", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "unaligned", focus: "unknown", z: 10 }, CORNER_OK);
  assert.equal(v.unverified, true);
  assert.equal(v.remember, false);
  assert.ok(v.issues.some((s) => s.startsWith("position")));
  assert.ok(v.issues.some((s) => s.startsWith("focus")));
});

test("a failed corner check marks every photo, even an edge-confirmed one", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "confirmed", focus: "refocused", z: 10 },
    { ok: false, reason: "plate edge not where the map puts A1" });
  assert.equal(v.identity, "failed");
  assert.equal(v.unverified, true);
  assert.equal(v.remember, false);
});

test("aligned shot with a passed corner check is verified and remembered", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "aligned", focus: "refocused", z: 10 }, CORNER_OK);
  assert.deepEqual([v.identity, v.unverified, v.remember], ["verified", false, true]);
});

test("without a corner check (old Pi) identity is unknown but the photo is not flagged", () => {
  const v = judgeShot(plateWith(), "0,0", { position: "aligned", focus: "sharp_kept", z: 10 }, null);
  assert.deepEqual([v.identity, v.unverified, v.remember], ["unknown", false, false]);
});

test("refocusing onto another plane is flagged once the plane is known", () => {
  const p = plateWith({ z: { "0,1": 10, "0,2": 10.2 } });
  const v = judgeShot(p, "0,0", { position: "aligned", focus: "refocused", z: 13 }, CORNER_OK);
  assert.equal(v.focus, "off_plane");
  assert.equal(v.unverified, true);
  assert.equal(v.remember, false);
});

test("empty wells and edge mismatch", () => {
  const empty = judgeShot(plateWith(), "0,0", { position: "confirmed", focus: "empty", z: 10 }, CORNER_OK);
  assert.equal(empty.unverified, false);
  const edge = judgeShot(plateWith(), "0,0",
    { position: "edge_mismatch", position_note: "row index -1", focus: "refocused", z: 10 }, CORNER_OK);
  assert.equal(edge.unverified, true);
  assert.equal(edge.remember, false);
});

test("post-scan check flags an early block that focused on another plane", () => {
  const res = [shot("0,0", [0, 0], { info: { z: 13 } }), shot("0,1", [0, 0], { info: { z: 10 } }),
    shot("0,2", [0, 0], { info: { z: 10.2 } })];
  assert.deepEqual(lateFocusOutliers(res).map((o) => o.key), ["0,0"]);
});

// ── 地图修正 ──

test("review repro: 4 of 6 blocks failed, 2 report +2.3 mm → map NOT shifted", () => {
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
  assert.deepEqual(s.base, REF); // 第一次修正:基准 = 修正前的地图
});

test("no map change without a passed corner check", () => {
  const results = KEYS.map((k) => shot(k, [2.3, 0]));
  assert.equal(planShift(plateWith(), results, { planned: 6, pitch: 9, corner: null }).apply, false);
  assert.equal(planShift(plateWith(), results,
    { planned: 6, pitch: 9, corner: { ok: false, reason: "x" } }).apply, false);
});

test("no map change when any block was not aligned", () => {
  const results = KEYS.map((k) => shot(k, [2.3, 0]));
  results[3] = shot("1,2", null, { verdict: { position: "unaligned" } });
  const s = planShift(plateWith(), results, { planned: 6, pitch: 9, corner: CORNER_OK });
  assert.equal(s.apply, false);
  assert.match(s.reason, /not aligned/);
});

test("per-round and cumulative correction limits", () => {
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

test("6/12-well plates: in-frame checks are impossible, photos are not flagged", () => {
  const v = judgeShot(plateWith({ format: 6 }), "0,0", { position: "unaligned", focus: "unknown", z: 10 }, null);
  assert.deepEqual([v.position, v.unverified, v.remember], ["unchecked", false, false]);
  assert.match(v.issues[0], /6-well/);
});

test("real-machine case: no peak but the plane is known → kept on the plane, not flagged", () => {
  // 2026-11-23:A1 / A5 / E9 都对到 7.6–8.1 mm;A9 板面有马克笔字迹,曲线一路往低处升、找不到峰,
  // 沿用平面 8.025 mm —— 照片其实对在孔底,不该标 UNVERIFIED
  const p = plateWith({ z: { "0,0": 8.025, "0,1": 8.106, "1,2": 7.612 } });
  const v = judgeShot(p, "0,2", { position: "confirmed", focus: "no_peak", z: 8.025 }, CORNER_OK);
  assert.deepEqual([v.focus, v.unverified, v.remember], ["plane_kept", false, false]);
  assert.match(v.issues[0], /kept the plate's well-bottom plane/);
});

test("no peak while the plane is still unknown stays flagged", () => {
  const v = judgeShot(plateWith({ z: { "0,0": 8.0 } }), "0,1", { position: "aligned", focus: "no_peak", z: 10 }, CORNER_OK);
  assert.deepEqual([v.focus, v.unverified], ["no_peak", true]);
});
