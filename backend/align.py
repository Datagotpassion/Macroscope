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

    # ── 标定 ──

    def calibrate(self, step_mm: float = 2.0, steps: int = 3) -> dict:
        """沿 X、Y 各走 steps 步 (每步 step_mm,全部单向接近),测每步的画面平移,
        取平均得到标定矩阵并保存。结束时回到起点,并检查回到起点的重复精度。

        step_mm 要明显小于半个孔距 (96 孔板 4.5 mm),否则规则孔阵会让平移测量有歧义。
        """
        p0 = self.position()
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
            "created": datetime.now().isoformat(timespec="seconds"),
            **info,
        }
        self._save(cal)
        return cal

    # ── 对准 ──

    def analyze(self, frame: np.ndarray, pitch_mm: float | None = None) -> dict:
        """分析一帧:孔阵 + (已标定时) 换算成毫米的偏移和孔距。"""
        exp = None
        if self.cal and pitch_mm:
            exp = pitch_mm * self.cal["px_per_mm"] * frame.shape[1] / self.cal["frame"][0]
        res = wellgrid.find_well_lattice(frame, expected_pitch_px=exp)
        if res.get("ok") and self.cal:
            mv = self.offset_to_move(res["offset"], frame.shape)
            res["move_mm"] = [round(float(mv[0]), 3), round(float(mv[1]), 3)]
            res["pitch_mm"] = round(
                res["pitch_px"] / (self.cal["px_per_mm"] * frame.shape[1] / self.cal["frame"][0]), 3
            )
        return res

    def center_on_well(self, pitch_mm: float = 9.0, tol_mm: float = 0.15, max_iter: int = 4) -> dict:
        """把离画面中心最近的孔对准到中心。返回最终平台坐标 (= 这个孔的位置) 和过程记录。"""
        self.matrix()  # 没标定就直接报错
        trace = []
        p = self.position()
        for it in range(max_iter + 1):
            res = self.analyze(self.grab(), pitch_mm)
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
                        "residual_mm": round(dist, 3), "moves": it, "trace": trace}
            if dist > 0.6 * pitch_mm:
                raise AlignError(f"computed correction {dist:.2f} mm is more than half a well pitch")
            if it == max_iter:
                break
            p = p + mv
            self.goto(p)
        raise AlignError(f"did not converge in {max_iter} moves (still {dist:.2f} mm off)")
