"""自动找板:从 A1 附近出发,找到板角,数孔判断行/列方向,精确定位 A1 / A12 / H1。

只需要用户把相机大致放到 A1 附近 (板角在画面里)。之后:
  1. 对准离画面中心最近的孔,在画面里找板边 —— 整排/整列格点都没有孔的地方;
     由此知道板角在哪、板子往哪两个方向延伸。
  2. 走到板角那个孔并精确对准 = A1。确认它外侧两边都是板边。
  3. 沿一个方向数孔:到第 rows 个孔 (96 孔板是 8) 就碰到板边 → 这是 A→H 方向;
     还有孔 → 这是 1→12 方向。每次最多跳 MAX_HOP 个孔并重新对准,误差不累积。
  4. 走到 H1、A12 精确对准,确认它们外侧是板边;检查三角的几何关系。
任何一步看不清/对不上就报错停下,不猜。

方向约定:image 里的格点 ij 以 wellgrid 的 a、b 为单位 (a 偏横向 +x,b 偏纵向 +y),
同一台相机拍的每一帧 a、b 方向一致,所以「沿 a 往前」在每一帧里含义相同。
"""

from __future__ import annotations

import math

import numpy as np

from align import AlignError, Aligner

# 板型:(行数, 列数, 标准孔距 mm)。只支持一帧里能看到足够多孔的板型。
FORMATS = {96: (8, 12, 9.0), 48: (6, 8, 13.08), 24: (4, 6, 19.3)}

LINE_OUT = 0.3   # 一整排/列格点的中位分数低于它 = 板外 (实测板外 ≤0.16,板内 ≥0.36)
MAX_HOP = 4      # 一次最多跳几个孔再重新对准
GEOM_TOL = 0.03  # A1→H1 和 A1→A12 两条边算出的孔距,彼此相差的上限
IMAGE_TOL = 0.08  # 和「画面孔距 ÷ 标定比例」相差的上限 —— 标定用 2 mm 小步,
                  # 皮带弹性让小步走得偏少,长距离实测孔距比它小约 4%
ANGLE_TOL = 3.0  # 行方向和列方向夹角偏离 90° 的上限 (度)


def line_scores(res: dict, axis: int) -> dict[int, float]:
    """画面里每一排 (axis=0:按 i 分组,即沿 b 的竖线;axis=1:按 j 分组) 的中位孔分数。"""
    groups: dict[int, list[float]] = {}
    for w in res.get("wells", []):
        groups.setdefault(w["ij"][axis], []).append(w["score"])
    return {k: float(np.median(v)) for k, v in groups.items() if len(v) >= 2}


def edge_side(scores: dict[int, float]) -> tuple[int, int]:
    """在一条轴上找板边。返回 (角孔所在的排号, 板子延伸方向 +1/−1)。

    要求:板外的排都在同一侧,且板内至少两排。看不到板边或两侧都是板外就报错。
    """
    if not scores:
        raise AlignError("no wells evaluated in view")
    ins = sorted(k for k, s in scores.items() if s >= LINE_OUT)
    outs = sorted(k for k, s in scores.items() if s < LINE_OUT)
    if len(ins) < 2:
        raise AlignError("too few wells in view to locate the plate edge")
    if not outs:
        raise AlignError("plate edge not in view — move the camera closer to the A1 corner")
    if outs[-1] < ins[0]:
        return ins[0], +1     # 板外在负方向 → 板子往正方向延伸
    if outs[0] > ins[-1]:
        return ins[-1], -1
    raise AlignError("wells missing on both sides — is this a different plate format?")


class PlateFinder:
    def __init__(self, aligner: Aligner):
        self.al = aligner
        self.pitch_px: float | None = None  # 这块板在画面里的孔距,第一次对准时测得

    def _view(self, pitch_mm: float) -> dict:
        res = self.al.analyze(self.al.grab(), pitch_mm, self.pitch_px)
        if not res.get("reliable"):
            raise AlignError("wells not recognised in view — plate lit and roughly in focus? "
                             f"({res.get('reason', 'low contrast')})")
        return res

    def _stage_vectors(self, res: dict, frame_shape) -> tuple[np.ndarray, np.ndarray]:
        """画面里的基向量 a、b → 平台上「走到相邻孔」的位移 (mm)。"""
        M = self.al.matrix(frame_shape)
        a, b = np.array(res["a"]), np.array(res["b"])
        return -np.linalg.solve(M, a), -np.linalg.solve(M, b)

    def _center(self, xy, pitch_mm) -> np.ndarray:
        self.al.goto(xy)
        r = self.al.center_on_well(pitch_mm, expected_px=self.pitch_px)
        if self.pitch_px is None:
            self.pitch_px = r["pitch_px"]  # 之后每一帧都按这块板的实际孔距去认
        return np.array([r["position"]["x"], r["position"]["y"]])

    def _walk(self, start, step, n, pitch_mm, trace, label) -> np.ndarray:
        """从 start 沿 step (一个孔距的位移) 走 n 个孔,每跳 ≤MAX_HOP 个孔重新对准。

        每跳完一次,用刚对准的实际位置更新步长 —— 长距离移动的实际孔距和标定
        推算的差几 %,不更新的话误差会一跳跳累积。
        """
        p, done, step = np.array(start, float), 0, np.array(step, float)
        while done < n:
            hop = min(MAX_HOP, n - done)
            q = self._center(p + hop * step, pitch_mm)
            step = (q - p) / hop
            p, done = q, done + hop
            trace.append({"step": f"{label} +{done}", "x": round(p[0], 3), "y": round(p[1], 3)})
        return p

    def _beyond_is_edge(self, axis: int, direction: int, pitch_mm: float) -> bool:
        """当前对准的孔,沿 axis 往 direction 再过去一排是不是板外。"""
        sc = line_scores(self._view(pitch_mm), axis)
        here, beyond = sc.get(0), sc.get(direction)
        if here is None or beyond is None:
            raise AlignError("cannot see the next row of wells to check the plate edge")
        if here < LINE_OUT:
            raise AlignError("the well under the camera does not look like a well")
        return beyond < LINE_OUT

    def find(self, fmt: int = 96) -> dict:
        if fmt not in FORMATS:
            raise AlignError(f"auto-find supports {sorted(FORMATS)}-well plates; teach other formats manually")
        rows, cols, pitch_mm = FORMATS[fmt]
        trace: list[dict] = []
        self.pitch_px = None

        # 1. 对准最近的孔 (同时测出这块板在画面里的孔距),在画面里找板角
        w0 = self._center(self.al.position(), pitch_mm)
        frame = self.al.grab()
        res = self.al.analyze(frame, pitch_mm, self.pitch_px)
        if not res.get("reliable"):
            raise AlignError("wells not recognised in view — plate lit and roughly in focus?")
        sa, sb = self._stage_vectors(res, frame.shape)
        ka, da = edge_side(line_scores(res, 0))
        kb, db = edge_side(line_scores(res, 1))
        trace.append({"step": "start", "x": round(w0[0], 3), "y": round(w0[1], 3),
                      "corner_offset_wells": [ka, kb]})

        # 2. 板角孔 = A1,精确对准并确认两侧外面都是板边
        a1 = self._center(w0 + ka * sa + kb * sb, pitch_mm)
        if not (self._beyond_is_edge(0, -da, pitch_mm) and self._beyond_is_edge(1, -db, pitch_mm)):
            raise AlignError("the corner well does not have the plate edge on both outer sides")
        trace.append({"step": "A1", "x": round(a1[0], 3), "y": round(a1[1], 3)})

        # 3. 沿 a 方向数孔:走到第 rows 个孔,外面是板边 → a 是 A→H 方向
        ua, ub = da * sa, db * sb  # 往板内走一个孔的位移
        pa = self._walk(a1, ua, rows - 1, pitch_mm, trace, "along a")
        if self._beyond_is_edge(0, da, pitch_mm):
            h1 = pa
            a12 = self._walk(a1, ub, cols - 1, pitch_mm, trace, "along b")
            if not self._beyond_is_edge(1, db, pitch_mm):
                raise AlignError(f"expected the plate edge after {cols} wells along the other axis")
        else:
            a12 = self._walk(pa, ua, cols - rows, pitch_mm, trace, "along a")
            if not self._beyond_is_edge(0, da, pitch_mm):
                raise AlignError(f"no plate edge after {cols} wells — is this a {fmt}-well plate?")
            h1 = self._walk(a1, ub, rows - 1, pitch_mm, trace, "along b")
            if not self._beyond_is_edge(1, db, pitch_mm):
                raise AlignError(f"expected the plate edge after {rows} wells along the other axis")

        # 4. 几何检查:两条边算出的孔距彼此一致 (且和画面推算的大致相符),两边互相垂直
        row_vec, col_vec = h1 - a1, a12 - a1
        p_rows = np.linalg.norm(row_vec) / (rows - 1)
        p_cols = np.linalg.norm(col_vec) / (cols - 1)
        pitch_stage = (np.linalg.norm(sa) + np.linalg.norm(sb)) / 2
        ang = math.degrees(math.acos(abs(row_vec @ col_vec) / (np.linalg.norm(row_vec) * np.linalg.norm(col_vec))))
        problems = []
        if abs(p_rows / p_cols - 1) > GEOM_TOL:
            problems.append(f"A1→H1 pitch {p_rows:.3f} mm vs A1→A12 pitch {p_cols:.3f} mm")
        for name, p in (("A1→H1", p_rows), ("A1→A12", p_cols)):
            if abs(p - pitch_stage) / pitch_stage > IMAGE_TOL:
                problems.append(f"{name} pitch {p:.3f} mm vs {pitch_stage:.3f} mm from the image")
        if abs(ang - 90.0) > ANGLE_TOL:
            problems.append(f"rows and columns not perpendicular ({ang:.1f}°)")
        if problems:
            raise AlignError("plate geometry check failed: " + "; ".join(problems))

        self.al.goto(a1)  # 停在 A1,方便用户在预览里确认
        pt = lambda v: {"x": round(float(v[0]), 3), "y": round(float(v[1]), 3)}  # noqa: E731
        return {
            "ok": True,
            "format": fmt,
            "ref": {"tl": pt(a1), "tr": pt(a12), "bl": pt(h1)},  # A1 / A<cols> / <末行>1
            "pitch_mm": round(float((p_rows + p_cols) / 2), 4),
            "angle_deg": round(ang, 2),
            "trace": trace,
        }
