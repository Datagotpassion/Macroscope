"""一键拍全板:开拍前自检 + 每一格「移过去 → 对正 → 对焦 → 拍照」。

全板的顺序、保存、重试由桌面 App 编排 (照片存到 PC);这里只负责单格,
整个过程在 Pi 上一次完成,网络抖一下只影响这一格的重试,不会打乱流程。

对焦 (实测 2026-11-23):
  - 板子有两个清晰平面:孔底 (类器官) 和孔口,相距约 9–10 mm。Z 越大板子离相机越远,
    孔底那个平面在较高的 Z。只在预测高度 ±range 里找峰,避开孔口。
  - 只用「有内容的孔」里的清晰度 (空孔没东西可对焦;整幅画面的清晰度被孔壁主导)。
    整格都是空孔 → 没有对焦信号,直接用预测高度 (空孔也没有要拍的东西)。
  - 「模糊时才对焦」:给了上次这格的清晰度 ref_sharp,预测高度处 ≥ 80% 就不重新对焦。
对正:格子中心应落在孔上 (该方向孔数为奇数) 或两孔正中 (偶数)。画面里测出偏差,
超过 ALIGN_TOL 就修正一次 (平台到位有 ±0.2–0.3 mm 随机误差,要求不能更严)。
"""

from __future__ import annotations

import time

import cv2
import numpy as np

from align import Aligner

Z_SETTLE_S = 0.3        # Z 停稳后再等一会儿
Z_APPROACH_MM = 0.3     # Z 总是从下方接近目标 (丝杆回程间隙)
ALIGN_TOL_MM = 0.5      # 格子中心偏差超过它才修正
AF_STEP_MM = 0.5        # 对焦扫描步长 (清晰度峰宽 ~±1 mm)
AF_MIN_GAIN = 1.3       # 峰值 / 窗口内最低值,低于它 = 没有对焦信号
AF_MIN_PROM = 1.15      # 峰值 / 左右两侧各自最低值中较高的那个,低于它 = 坡上的噪声,不算峰
SKIP_AF_RATIO = 0.8     # 预测高度处清晰度 ≥ 上次的 80% 就不重新对焦
MIN_BRIGHTNESS = 25     # 画面平均亮度低于它 = 几乎全黑 (灯没开 / 相机异常)
CONTENT_FACTOR = 4.0    # 孔内清晰度 > 孔间空白处 (噪声水平) × 它 = 「有内容的孔」


class ScanError(RuntimeError):
    """自检或拍摄失败,带给用户看的原因。"""


def _lap(img: np.ndarray) -> np.ndarray:
    """先轻微平滑再取 Laplacian:清晰度看几个像素尺度的结构,不被逐像素噪声主导。"""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return cv2.Laplacian(cv2.GaussianBlur(g.astype(np.float32), (0, 0), 1.2), cv2.CV_32F)


def content_mask(frame: np.ndarray, lattice: dict) -> tuple[np.ndarray | None, int]:
    """画面里「有内容的孔」的孔中间区域 (避开孔壁)。返回 (mask, 孔数);没有就 (None, 0)。

    基准是四孔之间的空白塑料 (平的,清晰度 = 噪声水平),不是各孔的中位数 ——
    大多数孔都有东西时,中位数本身就高,会一个都选不出来。
    """
    if not lattice.get("reliable"):
        return None, 0
    pitch = lattice["pitch_px"]
    rad = int(0.28 * pitch)
    half = (np.array(lattice["a"]) + np.array(lattice["b"])) / 2
    lap = _lap(frame)
    h, w_ = frame.shape[:2]
    gaps = np.zeros((h, w_), np.uint8)
    scored = []
    for w in lattice["wells"]:
        if not w["present"]:
            continue
        x, y = w["xy"]
        m = np.zeros((h, w_), np.uint8)
        cv2.circle(m, (int(x), int(y)), rad, 255, -1)
        if m.any():
            scored.append((float(lap[m > 0].var()), m))
        cv2.circle(gaps, (int(x + half[0]), int(y + half[1])), max(2, int(0.1 * pitch)), 255, -1)
    if not scored or not gaps.any():
        return None, 0
    noise = float(lap[gaps > 0].var())
    rich = [m for s, m in scored if s > CONTENT_FACTOR * noise]
    if not rich:
        return None, 0
    mask = np.zeros(frame.shape[:2], np.uint8)
    for m in rich:
        mask |= m
    return mask, len(rich)


def sharpness(frame: np.ndarray, mask: np.ndarray) -> float:
    return float(_lap(frame)[mask > 0].var())


def _interior_peak(curve: dict[float, float]) -> int | None:
    """清晰度曲线 (按 Z 排序) 里最高的「内部明显峰」的下标;没有就 None。

    明显 = 比整条曲线最低值高 AF_MIN_GAIN 倍,且比左右两侧各自的最低值都高 AF_MIN_PROM 倍
    (一路上升的坡上的噪声小疙瘩不算)。
    """
    vals = [curve[z] for z in sorted(curve)]
    lo = max(min(vals), 1e-9)
    best = None
    for i in range(1, len(vals) - 1):
        v = vals[i]
        if v < vals[i - 1] or v < vals[i + 1] or v < AF_MIN_GAIN * lo:
            continue
        if v < AF_MIN_PROM * max(min(vals[:i]), min(vals[i + 1:])):
            continue
        if best is None or v > vals[best]:
            best = i
    return best


def block_error(lattice: dict, M: np.ndarray, rows_dir_stage, row_half: bool, col_half: bool) -> np.ndarray:
    """格子中心偏了多少 (平台 mm,= 要修正的移动)。

    rows_dir_stage:板上「往下一行 (A→B)」在平台坐标里的方向;row_half / col_half:
    这格在行 / 列方向上的孔数是偶数 (中心在两孔正中) 还是奇数 (中心在孔上)。
    """
    a, b = np.array(lattice["a"]), np.array(lattice["b"])
    B = np.column_stack([a, b])
    # 板上「往下一行」在画面里的方向 (平台位移 s 的点出现在画面 −M·s 处)
    rows_img = -M @ np.asarray(rows_dir_stage, float)
    along_a = abs(rows_img @ a) / (np.linalg.norm(a) + 1e-9) >= abs(rows_img @ b) / (np.linalg.norm(b) + 1e-9)
    delta = np.array([0.5 if (row_half if along_a else col_half) else 0.0,
                      0.5 if (col_half if along_a else row_half) else 0.0])
    q = np.linalg.solve(B, -np.array(lattice["offset"]))  # 画面中心相对最近孔 (格点单位)
    e = (q - delta) - np.round(q - delta)                  # 离理想格子中心差多少格
    return np.linalg.solve(M, B @ e)                       # 修正移动 (mm)


class Shooter:
    def __init__(self, camera, stage, aligner: Aligner):
        self.camera, self.stage, self.al = camera, stage, aligner

    # ── 自检 ──

    def preflight(self, home: bool = True) -> dict:
        """开拍前检查;没回零就回零。任何一项不行抛 ScanError。"""
        if getattr(self.camera, "kind", "picamera2") == "mock":
            raise ScanError("camera not available (fell back to MockCamera) — restart the service / check the camera")
        st = self.stage.status()
        if not st.get("connected"):
            raise ScanError("stage offline (Moonraker/Klipper not reachable)")
        if st.get("state") not in (None, "ready"):
            raise ScanError(f"Klipper not ready ({st.get('state')}) — firmware restart needed?")
        if not self.al.cal:
            raise ScanError("camera not calibrated — run Calibrate camera in the Plate map first")
        homed = (st.get("homed") or "").lower()
        did = []
        if home and not ("x" in homed and "y" in homed):
            self.stage.home("XY")
            did.append("XY")
        if home and "z" not in homed:
            try:
                self.stage.home("Z")
            except Exception:  # noqa: BLE001 — 板子高于一次回零行程时,第二次接着往下走
                self.stage.home("Z")
            did.append("Z")
        st = self.stage.status()
        homed = (st.get("homed") or "").lower()
        if not all(ax in homed for ax in "xyz"):
            raise ScanError(f"homing incomplete (homed: '{homed}')")
        self.camera.clear_roi()
        bright = float(cv2.cvtColor(self.al.grab(), cv2.COLOR_BGR2GRAY).mean())
        if bright < MIN_BRIGHTNESS:
            raise ScanError(f"image almost black (brightness {bright:.0f}) — is the light on?")
        return {"ok": True, "homed_now": did, "brightness": round(bright, 1),
                "z_max": (st.get("axis_maximum") or [None] * 3)[2]}

    # ── 运动 ──

    def z_goto(self, z: float) -> None:
        zmax = (self.stage.status().get("axis_maximum") or [0, 0, 1e9])[2]
        z = min(max(0.0, z), zmax)
        self.stage.move(z=round(max(0.0, z - Z_APPROACH_MM), 3), feed=300)
        self.stage.move(z=round(z, 3), feed=300)
        self.stage.wait_moves()
        time.sleep(Z_SETTLE_S)

    # ── 对焦 ──

    def autofocus(self, z_pred: float, half_range: float, mask: np.ndarray,
                  extend: bool = True) -> dict:
        """在 z_pred ± half_range 里从下往上扫,取「有内容的孔」清晰度的峰。

        只认窗口「内部」、比两侧都明显高的局部峰,有几个取最高的 —— 窗口边上的高值多半是
        另一个平面的坡 (实测 2026-11-23:孔口上的马克笔字迹在低 5 mm 处,A9 被它拉走)。
        窗口里没有这样的峰、且 extend 时,往高的那边再扩一个窗口 (一次)。板子已有对焦记忆时
        App 关掉扩展、缩小窗口,只在孔底平面附近找。找不到就用 z_pred。
        """
        zmax = (self.stage.status().get("axis_maximum") or [0, 0, 1e9])[2]
        lo, hi = max(0.0, z_pred - half_range), min(zmax, z_pred + half_range)
        curve: dict[float, float] = {}

        def run(a: float, b: float) -> None:
            zs = [round(z, 3) for z in np.arange(a, b + 1e-6, AF_STEP_MM) if round(z, 3) not in curve]
            if not zs:
                return
            self.z_goto(zs[0])  # 第一点从下方接近,之后一路往上
            for z in zs:
                self.stage.move(z=z, feed=300)
                self.stage.wait_moves()
                time.sleep(0.15)
                curve[z] = sharpness(self.al.grab(), mask)

        run(lo, hi)
        if extend and _interior_peak(curve) is None:
            vals = [curve[z] for z in sorted(curve)]
            i = int(np.argmax(vals))
            if i == len(vals) - 1 and hi < zmax:     # 一路往上升 → 往上再扫
                run(hi + AF_STEP_MM, min(zmax, hi + half_range))
            elif i == 0 and lo > 0:                  # 一路往下升 → 往下再扫
                run(max(0.0, lo - half_range), lo - AF_STEP_MM)
        zs = sorted(curve)
        vals = [curve[z] for z in zs]
        out = {"ran": True, "gain": round(max(vals) / max(min(vals), 1e-9), 2),
               "curve": [[z, round(curve[z], 2)] for z in zs]}
        i = _interior_peak(curve)
        if i is None:
            return {**out, "found": False, "z": z_pred,
                    "reason": "no clear focus peak" if out["gain"] < AF_MIN_GAIN
                    else "no peak inside the Z window"}
        z = zs[i]
        den = vals[i - 1] - 2 * vals[i] + vals[i + 1]
        if den < 0:
            z += 0.5 * AF_STEP_MM * (vals[i - 1] - vals[i + 1]) / den
        return {**out, "found": True, "z": round(float(z), 3),
                "gain": round(vals[i] / max(min(vals), 1e-9), 2)}

    # ── 单格 ──

    def shoot(self, x: float, y: float, z_pred: float, *, rows_dir=(1.0, 0.0),
              row_half: bool = True, col_half: bool = True, pitch_mm: float = 9.0,
              autofocus: bool = True, af_range: float = 3.0, af_extend: bool = True,
              ref_sharp: float | None = None, full_res: bool = False) -> tuple[np.ndarray, dict]:
        """拍一格。返回 (BGR 照片, 过程信息)。full_res=True 拍 12MP (临时切相机模式),否则 3MP。"""
        info: dict = {"x": x, "y": y, "z_pred": z_pred}
        self.al.goto([x, y])
        self.z_goto(z_pred)

        # 对正:格子中心偏了就修正一次
        frame = self.al.grab()
        lat = self.al.analyze(frame, pitch_mm)
        pos = np.array([x, y], float)
        if lat.get("reliable"):
            err = block_error(lat, self.al.matrix(frame.shape), rows_dir, row_half, col_half)
            info["align_error_mm"] = [round(float(err[0]), 3), round(float(err[1]), 3)]
            if float(np.hypot(*err)) > ALIGN_TOL_MM:
                pos = pos + err
                self.al.goto(pos)
                frame = self.al.grab()
                lat = self.al.analyze(frame, pitch_mm)
                info["aligned_to"] = [round(float(pos[0]), 3), round(float(pos[1]), 3)]
        else:
            info["align_error_mm"] = None
            info["align_note"] = "wells not recognised — alignment skipped"

        # 对焦
        mask, n_content = content_mask(frame, lat)
        info["content_wells"] = n_content
        z = z_pred
        if mask is None:
            info["af"] = {"ran": False, "reason": "no wells with content in view"}
        else:
            s_pred = sharpness(frame, mask)
            info["sharp_at_pred"] = round(s_pred, 2)
            if ref_sharp and s_pred >= SKIP_AF_RATIO * ref_sharp:
                info["af"] = {"ran": False, "reason": f"sharp enough ({s_pred:.0f} vs ref {ref_sharp:.0f})"}
            elif autofocus:
                af = self.autofocus(z_pred, af_range, mask, extend=af_extend)
                info["af"] = af
                z = af["z"]
            else:
                info["af"] = {"ran": False, "reason": "autofocus off"}
        self.z_goto(z)
        info["z"] = round(float(z), 3)
        if mask is not None:
            info["sharp"] = round(sharpness(self.al.grab(), mask), 2)

        # 拍照 + 检查
        t0 = time.monotonic()
        img = self.camera.capture_full() if full_res else self.camera.capture_array(preview=False)
        info["size"] = [int(img.shape[1]), int(img.shape[0])]
        info["capture_s"] = round(time.monotonic() - t0, 2)
        bright = float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean())
        info["brightness"] = round(bright, 1)
        if bright < MIN_BRIGHTNESS:
            raise ScanError(f"captured image almost black (brightness {bright:.0f})")
        return img, info
