"""相机 ↔ 平台标定 + 自动对准孔。

标定 (一次性):平台在 X、Y 各挪 step_mm,用相位相关测画面平移了多少像素,
得到 2×2 矩阵 M (像素/毫米):画面内容的平移 = M · 相机 (平台) 的移动。
它同时包含了比例、相机安装的旋转角和镜像,之后「孔偏了多少像素」就能换算成
「平台该挪多少毫米」:move = M⁻¹ · (−offset)。

对准:在当前画面里找孔阵 (wellgrid),把离画面中心最近的孔挪到中心,反复
几次直到误差 < tol。孔是周期重复的 —— 这里只负责「对准最近的那个孔」,
认出是哪个孔由调用方 (记住的位置,偏差 < 半个孔距) 保证。

camera 需要 capture_array(preview=True);stage 需要 status() / move() / wait_moves()。
测试里用假的平台 + 按平台位置渲染孔阵的假相机,整个流程不用真机就能跑。
"""

from __future__ import annotations

import json
import math
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

import autofocus
import wellgrid
from image_store import BASE_DIR

CAL_FILE = Path(BASE_DIR) / "camera_calibration.json"

SETTLE_S = 0.3        # 每次移动停稳后再等一会儿,让机械振动衰减
DISCARD_FRAMES = 2    # 丢掉相机队列里可能在移动中曝光的旧帧
FEED = 1200           # 对准/标定时的移动速度 (mm/min)

# 单向接近:每次都先退到目标的 (−X, −Y) 方向这么远,再走到目标。
# 实测 (2026-11-22) 平台有明显回程间隙/滞后:反向第一步丢 0.4–0.7 mm,同一坐标
# 从两边接近差 0.7–1.6 mm。只要永远从同一方向接近,到位时滞后量一样,位置就可重复。
# 这个距离要大于滞后带宽度,才能让「同向滞后」充分建立。
ANTI_BACKLASH_MM = 2.5

# 标定前先找焦面。2026-11-24 机器搬进培养箱时磕了一下,焦面从 Z 8–10 mm 跑到约 17 mm
# (超出 15 mm 行程);那次标定是在糊的画面上做的,孔距被认成 115 px (清楚时约 159 px),
# 却照样通过了。所以标定先把整个 Z 行程扫一遍,找到焦点再走 X/Y。
FOCUS_COARSE_MM = 0.5     # 全行程粗扫步长 (清晰度峰宽约 ±1 mm,见 scan.AF_STEP_MM)
FOCUS_FINE_MM = 0.1       # 粗扫峰附近细扫的步长
FOCUS_FINE_HALF_MM = 0.6  # 细扫范围:粗扫峰 ± 这么多
FOCUS_MIN_GAIN = 1.5      # 最清楚一帧 / 最糊一帧 的清晰度至少这么多,否则曲线是平的 = 没东西可对焦
FOCUS_SUGGEST_Z = 9.0     # 焦点跑出行程时,建议把 Z 放在这里再拧镜头 (以前的孔底平面 8–10 mm)
Z_APPROACH_MM = 0.3       # Z 总是从下方接近目标 (丝杆回程间隙),和 scan.py 一致
Z_FEED = 300              # mm/min
Z_SETTLE_S = 0.2

# 标定完用板子当尺子核对:画面里的孔距 ÷ 标定比例 应接近板子的标准孔距。
# 小步标定比例偏差约 4% (见 platefind.IMAGE_TOL);认错周期时差 25% 以上。
PITCH_CHECK_TOL = 0.10


class AlignError(RuntimeError):
    """标定/对准失败 (看不到孔、偏差过大、不收敛、标定结果不合理…)。"""


def _prep(img: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    g = g.astype(np.float32)
    hp = g - cv2.GaussianBlur(g, (0, 0), max(4.0, g.shape[1] / 40))  # 去照明不均
    return cv2.GaussianBlur(hp, (0, 0), 1.5)  # 压掉像素级噪声 (含固定图案噪声)


def image_shift(f0: np.ndarray, f1: np.ndarray) -> tuple[float, float, float]:
    """f1 相对 f0 的画面平移 (dx, dy 像素) 和匹配强度 (0..1)。"""
    g0, g1 = _prep(f0), _prep(f1)
    win = cv2.createHanningWindow((g0.shape[1], g0.shape[0]), cv2.CV_32F)
    (dx, dy), resp = cv2.phaseCorrelate(g0, g1, win)
    return float(dx), float(dy), float(resp)


def reduce_to_cell(d, a, b) -> np.ndarray:
    """把平移 d 折回到「一个孔距以内」的那个等价平移。

    孔阵是周期的:平移 d 和 d ± a、d ± b 画面看起来完全一样,相位相关可能报出
    其中任何一个。只要真实平移小于半个孔距,折回后的就是真值。
    """
    B = np.column_stack([a, b])
    d = np.asarray(d, float)
    return d - B @ np.round(np.linalg.solve(B, d))


def check_matrix(M: np.ndarray) -> tuple[list[str], dict]:
    """标定矩阵的合理性:X/Y 比例应相同 (方像素),两轴在画面里应互相垂直。"""
    nx, ny = float(np.linalg.norm(M[:, 0])), float(np.linalg.norm(M[:, 1]))
    problems = []
    if min(nx, ny) < 2.0:
        return ["image barely moved — is the stage moving and the plate in view?"], {}
    cosang = abs(float(M[:, 0] @ M[:, 1])) / (nx * ny)
    ang = math.degrees(math.acos(min(1.0, cosang)))
    ratio = nx / ny
    if not 0.93 <= ratio <= 1.07:
        problems.append(f"X and Y scales differ ({ratio:.3f})")
    if abs(ang - 90.0) > 4.0:
        problems.append(f"stage axes not perpendicular in the image ({ang:.1f}°)")
    info = {
        "px_per_mm": round((nx + ny) / 2, 4),
        "scale_ratio": round(ratio, 4),
        "axis_angle_deg": round(ang, 2),
        # 平台 +X 在画面里让内容往哪个方向走 (度,图像坐标系,y 向下)
        "image_dir_of_stage_x_deg": round(math.degrees(math.atan2(M[1, 0], M[0, 0])), 2),
        "mirrored": bool(np.linalg.det(M) < 0),
    }
    return problems, info


def pick_focus(curve: list[tuple[float, float]]) -> dict:
    """全行程粗扫曲线 [(z, 清晰度)] (z 从小到大) → 焦点在哪,或为什么找不到。

    取全程最清楚的一点。它落在行程的第一个或最后一个点上 = 到头了还在变清楚,
    焦点在行程外 (status "below" / "above"),不猜;整条曲线差不多平 = 画面里
    没有能对焦的东西 ("flat")。
    """
    zs = [c[0] for c in curve]
    vals = [c[1] for c in curve]
    i = int(np.argmax(vals))
    gain = float(vals[i] / max(min(vals), 1e-9))
    out = {"z": float(zs[i]), "gain": round(gain, 2)}
    if gain < FOCUS_MIN_GAIN:
        return {**out, "status": "flat"}
    if i == len(vals) - 1:
        return {**out, "status": "above"}
    if i == 0:
        return {**out, "status": "below"}
    return {**out, "status": "ok"}


def refine_peak(curve: list[tuple[float, float]]) -> float:
    """细扫曲线的峰:最高点,两边都有点时用抛物线插值到亚步长。"""
    zs = [c[0] for c in curve]
    vals = [c[1] for c in curve]
    i = int(np.argmax(vals))
    z = float(zs[i])
    if 0 < i < len(vals) - 1:
        den = vals[i - 1] - 2 * vals[i] + vals[i + 1]
        if den < 0:
            z += 0.5 * (zs[i + 1] - zs[i]) * (vals[i - 1] - vals[i + 1]) / den
    return z


class Aligner:
    def __init__(self, camera, stage, cal_file: Path = CAL_FILE):
        self.camera = camera
        self.stage = stage
        self.cal_file = Path(cal_file)
        self.cal = self._load()

    # ── 标定持久化 ──

    def _load(self) -> dict | None:
        try:
            return json.loads(self.cal_file.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — 没有/坏了都当未标定
            return None

    def _save(self, cal: dict) -> None:
        self.cal_file.parent.mkdir(parents=True, exist_ok=True)
        self.cal_file.write_text(json.dumps(cal, indent=2), encoding="utf-8")
        self.cal = cal

    def matrix(self, frame_shape=None) -> np.ndarray:
        """标定矩阵 (像素/毫米),按需换算到给定帧尺寸。"""
        if not self.cal:
            raise AlignError("camera not calibrated yet — run calibration first")
        M = np.array(self.cal["M"], float)
        if frame_shape is not None:
            M = M * (frame_shape[1] / self.cal["frame"][0])
        return M

    def offset_to_move(self, offset_px, frame_shape=None) -> np.ndarray:
        """画面里偏了 offset_px → 平台要挪多少 mm 才能把它挪到画面中心。"""
        return np.linalg.solve(self.matrix(frame_shape), -np.asarray(offset_px, float))

    # ── 运动 / 取帧 ──

    def grab(self) -> np.ndarray:
        for _ in range(DISCARD_FRAMES):
            self.camera.capture_array(preview=True)
        return self.camera.capture_array(preview=True)

    def position(self) -> np.ndarray:
        st = self.stage.status()
        if not st.get("connected"):
            raise AlignError("stage offline")
        homed = (st.get("homed") or "").lower()
        if "x" not in homed or "y" not in homed:
            raise AlignError("X/Y not homed — home first")
        p = st["position"]
        return np.array([p["x"], p["y"]], float)

    def goto(self, xy) -> None:
        """单向接近:先到目标的 (−X,−Y) 侧 ANTI_BACKLASH_MM 处,再走到目标 (夹在行程下限内)。"""
        x, y = float(xy[0]), float(xy[1])
        lo = (self.stage.status().get("axis_minimum") or [0.0, 0.0])[:2]
        px, py = max(x - ANTI_BACKLASH_MM, lo[0]), max(y - ANTI_BACKLASH_MM, lo[1])
        self.stage.move(x=round(px, 3), y=round(py, 3), feed=FEED)
        self.stage.move(x=round(x, 3), y=round(y, 3), feed=FEED)
        self.stage.wait_moves()
        time.sleep(SETTLE_S)

    # ── 对焦 ──

    def _z_travel(self) -> tuple[float, float]:
        st = self.stage.status()
        if "z" not in (st.get("homed") or "").lower():
            raise AlignError("Z not homed — home first")
        lo = (st.get("axis_minimum") or [None] * 3)[2]
        hi = (st.get("axis_maximum") or [None] * 3)[2]
        if lo is None or hi is None or hi <= lo:
            raise AlignError("Z travel limits unknown — is Klipper reporting axis_minimum/axis_maximum?")
        return float(lo), float(hi)

    def _z_goto(self, z: float, lo: float) -> None:
        """从下方接近 z (消丝杆回程),停稳后返回。"""
        self.stage.move(z=round(max(lo, z - Z_APPROACH_MM), 3), feed=Z_FEED)
        self.stage.move(z=round(z, 3), feed=Z_FEED)
        self.stage.wait_moves()
        time.sleep(Z_SETTLE_S)

    def _z_sweep(self, zs: list[float], lo: float) -> list[tuple[float, float]]:
        """从下往上逐点测整帧清晰度 (先退到第一个点下方,之后一直往上走)。"""
        self.stage.move(z=round(max(lo, zs[0] - Z_APPROACH_MM), 3), feed=Z_FEED)
        curve = []
        for z in zs:
            self.stage.move(z=round(z, 3), feed=Z_FEED)
            self.stage.wait_moves()
            time.sleep(Z_SETTLE_S)
            curve.append((round(z, 3), autofocus.sharpness(autofocus.to_gray(self.grab()))))
        return curve

    def find_focus(self) -> dict:
        """在当前 X/Y 把整个 Z 行程粗扫一遍,再在峰附近细扫,停在焦点上。

        焦点在行程外 / 画面里没东西可对焦就报错,Z 留在最后扫到的地方。
        返回 {z, gain, coarse, fine} (曲线是 [z, 清晰度] 列表,存进标定文件备查)。
        """
        lo, hi = self._z_travel()
        n = int(math.floor((hi - lo) / FOCUS_COARSE_MM + 1e-9))
        coarse = self._z_sweep([lo + k * FOCUS_COARSE_MM for k in range(n + 1)], lo)
        pick = pick_focus(coarse)
        if pick["status"] == "flat":
            raise AlignError(
                f"no focus found between Z {lo:g} and {hi:g} mm (sharpness changes only "
                f"{pick['gain']:.2f}×) — is the plate in view and lit? If it is, the lens focus "
                f"may be far off: move Z to about {FOCUS_SUGGEST_Z:g} mm and turn the lens focus ring "
                "until the wells are sharp.")
        if pick["status"] in ("above", "below"):
            end = hi if pick["status"] == "above" else lo
            raise AlignError(
                f"focus is {pick['status']} the Z travel: the image is still getting sharper at "
                f"Z {end:g} mm (the {'top' if end == hi else 'bottom'} limit). The lens focus has "
                f"probably moved — move Z to about {FOCUS_SUGGEST_Z:g} mm, turn the lens focus ring "
                f"until the wells are sharp, then calibrate again.")
        zc = pick["z"]
        a, b = max(lo, zc - FOCUS_FINE_HALF_MM), min(hi, zc + FOCUS_FINE_HALF_MM)
        m = int(math.floor((b - a) / FOCUS_FINE_MM + 1e-9))
        fine = self._z_sweep([a + k * FOCUS_FINE_MM for k in range(m + 1)], lo)
        z = min(hi, max(lo, refine_peak(fine)))
        self._z_goto(z, lo)
        rnd = lambda c: [[z_, round(float(s), 2)] for z_, s in c]  # noqa: E731
        return {"z": round(z, 3), "gain": pick["gain"], "coarse": rnd(coarse), "fine": rnd(fine)}

    # ── 标定 ──

    def calibrate(self, step_mm: float = 2.0, steps: int = 3, *, focus: bool = False,
                  pitch_mm: float | None = None) -> dict:
        """沿 X、Y 各走 steps 步 (每步 step_mm,全部单向接近),测每步的画面平移,
        取平均得到标定矩阵并保存。结束时回到起点,并检查回到起点的重复精度。

        step_mm 要明显小于半个孔距 (96 孔板 4.5 mm),否则规则孔阵会让平移测量有歧义。
        focus=True:先在原地找焦点 (find_focus),找不到就不标定。API 默认开;
        这里默认关,是因为单测的假平台没有 Z。
        pitch_mm:板子的标准孔距。给了就核对画面里的孔距 —— 认错周期 (画面太糊时会)
        的标定会被拒绝。
        """
        p0 = self.position()
        foc = self.find_focus() if focus else None
        walks: dict[str, list[np.ndarray]] = {}
        try:
            for ax, unit in (("x", np.array([1.0, 0.0])), ("y", np.array([0.0, 1.0]))):
                frames = []
                for k in range(steps + 1):
                    self.goto(p0 + unit * step_mm * k)
                    frames.append(self.grab())
                walks[ax] = frames
            self.goto(p0)
            f_end = self.grab()
        finally:
            try:
                self.goto(p0)
            except Exception:  # noqa: BLE001 — 尽量回原位,失败也不掩盖原错误
                pass
        f0 = walks["x"][0]
        lat = wellgrid.find_well_lattice(f0)
        if not lat.get("reliable"):
            raise AlignError("calibration needs the plate in view (wells not recognised) — lit and roughly in focus?")
        a, b = np.array(lat["a"]), np.array(lat["b"])

        cols, step_norms, matches = [], {}, []
        for ax in ("x", "y"):
            fr = walks[ax]
            shifts = []
            for i in range(steps):
                dx, dy, resp = image_shift(fr[i], fr[i + 1])
                shifts.append(reduce_to_cell((dx, dy), a, b))
                matches.append(resp)
            cols.append(np.mean(shifts, axis=0) / step_mm)
            step_norms[ax] = [float(np.hypot(*s)) for s in shifts]
        M = np.column_stack(cols)
        problems, info = check_matrix(M)
        if min(matches) < 0.05:
            problems.append(f"weak image match ({min(matches):.2f}) — plate in view and lit?")
        for ax, norms in step_norms.items():
            spread = (max(norms) - min(norms)) / max(np.mean(norms), 1e-9)
            if spread > 0.25:
                problems.append(f"{ax.upper()} steps uneven ({spread:.0%}) — stage slipping or binding?")
        pitch_img_mm = float(lat["pitch_px"]) / info["px_per_mm"] if info else None
        if pitch_mm and pitch_img_mm and abs(pitch_img_mm / pitch_mm - 1) > PITCH_CHECK_TOL:
            problems.append(
                f"wells measure {pitch_img_mm:.2f} mm apart, expected {pitch_mm:g} mm — "
                "image too blurry to recognise the wells, or a different plate format?")
        if problems:
            raise AlignError("calibration rejected: " + "; ".join(problems))
        # 同一位置、同一接近方向:画面应几乎不动 (检查重复精度 / 丢步)
        rep = math.hypot(*reduce_to_cell(image_shift(f0, f_end)[:2], a, b)) / info["px_per_mm"]
        cal = {
            "M": M.tolist(),
            "frame": [int(f0.shape[1]), int(f0.shape[0])],
            "step_mm": step_mm,
            "steps": steps,
            "step_px": {k: [round(v, 2) for v in n] for k, n in step_norms.items()},
            "repeatability_mm": round(rep, 3),
            "anti_backlash_mm": ANTI_BACKLASH_MM,
            "match_min": round(min(matches), 3),
            # 用板子 (标准孔距) 当尺子:平台每「指令毫米」实际走多少真实毫米 (仅供诊断)
            "plate_pitch_px": round(float(lat["pitch_px"]), 2),
            "plate_pitch_mm": round(pitch_img_mm, 3),
            "focus": foc,  # None = 这次没找焦点 (沿用当时的 Z)
            "created": datetime.now().isoformat(timespec="seconds"),
            **info,
        }
        self._save(cal)
        return cal

    # ── 对准 ──

    def analyze(self, frame: np.ndarray, pitch_mm: float | None = None,
                expected_px: float | None = None) -> dict:
        """分析一帧:孔阵 + (已标定时) 换算成毫米的偏移和孔距。

        expected_px:同一块板上已经测到的孔距 (像素) —— 有就优先用它当预期值;
        否则用「标准孔距 × 标定比例」粗估 (有几 % 误差,只适合第一帧)。
        """
        exp = expected_px
        if exp is None and self.cal and pitch_mm:
            exp = pitch_mm * self.cal["px_per_mm"] * frame.shape[1] / self.cal["frame"][0]
        res = wellgrid.find_well_lattice(frame, expected_pitch_px=exp)
        if res.get("ok") and expected_px and abs(res["pitch_px"] / expected_px - 1) > 0.08:
            # 和这块板已知的孔距对不上 → 认错了周期,不能拿来对准
            res["reliable"] = False
            res["reason"] = f"pitch {res['pitch_px']:.1f}px vs expected {expected_px:.1f}px"
        if res.get("ok") and self.cal:
            mv = self.offset_to_move(res["offset"], frame.shape)
            res["move_mm"] = [round(float(mv[0]), 3), round(float(mv[1]), 3)]
            res["pitch_mm"] = round(
                res["pitch_px"] / (self.cal["px_per_mm"] * frame.shape[1] / self.cal["frame"][0]), 3
            )
        return res

    def center_on_well(self, pitch_mm: float = 9.0, tol_mm: float = 0.15, max_iter: int = 4,
                       expected_px: float | None = None) -> dict:
        """把离画面中心最近的孔对准到中心。返回最终平台坐标 (= 这个孔的位置) 和过程记录。

        expected_px:这块板已知的孔距 (像素),给了识别更稳 (见 analyze)。
        """
        self.matrix()  # 没标定就直接报错
        trace = []
        p = self.position()
        for it in range(max_iter + 1):
            res = self.analyze(self.grab(), pitch_mm, expected_px)
            if not res.get("reliable"):
                raise AlignError(
                    "wells not recognised in view "
                    f"(contrast {res.get('contrast')}, wells {res.get('n')}, "
                    f"reason {res.get('reason', '-')}) — plate in view, lit and roughly in focus?"
                )
            mv = np.array(res["move_mm"])
            dist = float(np.hypot(*mv))
            trace.append({"pos": [round(p[0], 3), round(p[1], 3)], "move_mm": res["move_mm"],
                          "contrast": res["contrast"], "pitch_mm": res.get("pitch_mm")})
            if dist <= tol_mm:
                w = p + mv  # 孔的位置 = 相机当前位置 + 剩下的一点残差
                return {"ok": True, "position": {"x": round(w[0], 3), "y": round(w[1], 3)},
                        "residual_mm": round(dist, 3), "moves": it, "trace": trace,
                        "pitch_px": round(float(res["pitch_px"]), 2)}
            if dist > 0.6 * pitch_mm:
                raise AlignError(f"computed correction {dist:.2f} mm is more than half a well pitch")
            if it == max_iter:
                break
            p = p + mv
            self.goto(p)
        raise AlignError(f"did not converge in {max_iter} moves (still {dist:.2f} mm off)")
