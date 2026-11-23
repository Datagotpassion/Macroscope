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

验收 (每张照片都带,写进 X-Shot,App 据此标 UNVERIFIED / 决定能不能学进地图和对焦记忆):
  position  confirmed     对正残差合格,且画面里看得到的板边和板面地图预测的一致 (孔身份已核验)
            aligned       对正残差合格,但这格画面里看不到板边 (孔身份靠地图,本格无法核验)
            edge_mismatch 看得到的板边和预测的对不上 —— 多半整体错开了整行/整列
            unaligned     认不出孔阵,或修正后残差仍超标
  focus     refocused / sharp_kept / empty (认出了孔、孔里没东西) / no_peak / unknown (认不出孔) / off
孔阵是周期的,画面只能确定「到最近一个孔」;错开整行整列只能靠板边发现 (edge_check)。
"""

from __future__ import annotations

import time

import cv2
import numpy as np

from align import Aligner
from platefind import LINE_OUT

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


def _plate_axis(lattice: dict, M: np.ndarray, dir_stage) -> tuple[int, float]:
    """板上某个方向 (平台坐标的单位向量) 对应画面的哪个基向量 (0=a, 1=b),以及正负号。

    平台位移 d 的点出现在画面 −M·d 处,所以板上「往 +方向」在画面里是 −M·dir。
    """
    a, b = np.array(lattice["a"]), np.array(lattice["b"])
    d_img = -M @ np.asarray(dir_stage, float)
    ca = (d_img @ a) / (np.linalg.norm(a) + 1e-9)
    cb = (d_img @ b) / (np.linalg.norm(b) + 1e-9)
    return (0, float(np.sign(ca))) if abs(ca) >= abs(cb) else (1, float(np.sign(cb)))


def edge_check(lattice: dict, M: np.ndarray, rows_dir, cols_dir, block, plate_dims) -> dict:
    """画面里看得到的每一排/列孔,按板面地图应该在板内还是板外;和实际 (有没有孔) 比。

    block = (r0, r1, c0, c1) 这格覆盖的孔 (行/列号从 0 起,含两端);plate_dims = (rows, cols)。
    调用前画面中心应已对正到格子中心。画面中心在格点坐标里是 q (相对最近的孔),
    沿行方向的第 t 排格点对应板上第 round(Rc + s·(t − q)) 行 (Rc = 格子中心行号)。
    整体错开一整行/列时,本该在板外的那排会看到孔 (或反之) → 不一致。
    按二维判断:每个格点先换算成板上的 (行, 列);评估某一行时只用「列号在板内」的格点,评估某一列
    时只用「行号在板内」的格点 —— 板角外侧、对角方向本来就在板外的格点不能当成反对这一行/列的证据
    (旧版按整排取中位数,相机转 26° 时正确的 A1 被误拒,2026-11-23 复核)。少于 2 个有效格点的
    行/列不评估。
    注意:一帧约 7×5 孔,只评估整个孔都在画面里的格点;4×4 格子在画面短边方向的板边
    刚好在画面外,所以单格只能核验一个方向 —— 两个方向都要核验用 Shooter.verify_corner。
    返回 {ran, ok, edges_seen (看到了几排「应在板外」的格点), edges_seen_rows / _cols, mismatch}。
    """
    if not lattice.get("reliable"):
        return {"ran": False, "reason": "wells not recognised"}
    kr, sr = _plate_axis(lattice, M, rows_dir)
    kc, sc = _plate_axis(lattice, M, cols_dir)
    if kr == kc or sr == 0 or sc == 0:
        return {"ran": False, "reason": "plate row/column directions do not match the image grid"}
    a, b = np.array(lattice["a"]), np.array(lattice["b"])
    q = np.linalg.solve(np.column_stack([a, b]), -np.array(lattice["offset"]))
    r0, r1, c0, c1 = block
    rows, cols = plate_dims
    rc, cc = (r0 + r1) / 2, (c0 + c1) / 2
    pts = []  # (板上行号, 板上列号, 孔分数)
    for w in lattice.get("wells", []):
        ri = int(round(rc + sr * (w["ij"][kr] - q[kr])))
        ci = int(round(cc + sc * (w["ij"][kc] - q[kc])))
        pts.append((ri, ci, float(w["score"])))
    seen = {"row": 0, "column": 0}
    mismatch = []
    for name, key, n, other, other_n in (("row", 0, rows, 1, cols), ("column", 1, cols, 0, rows)):
        groups: dict[int, list[float]] = {}
        for p in pts:
            if 0 <= p[other] < other_n:
                groups.setdefault(p[key], []).append(p[2])
        for idx, scores in sorted(groups.items()):
            if len(scores) < 2:
                continue
            score = float(np.median(scores))
            expect_in = 0 <= idx < n
            seen_in = score >= LINE_OUT
            if not expect_in:
                seen[name] += 1
            if expect_in != seen_in:
                mismatch.append(f"{name} index {idx} (0-based): expected {'wells' if expect_in else 'off-plate'}, "
                                f"saw {'wells' if seen_in else 'none'} (score {score:.2f}, n={len(scores)})")
    return {"ran": True, "ok": not mismatch, "edges_seen": seen["row"] + seen["column"],
            "edges_seen_rows": seen["row"], "edges_seen_cols": seen["column"], "mismatch": mismatch}


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
            except Exception as e:  # noqa: BLE001
                # 只有「走完全程没触发」(板子高于一次回零行程) 才接着再回零一次;
                # 通信超时等其他错误不能当成机械没触发,直接报出来。
                if "no trigger" not in str(e).lower():
                    raise ScanError(f"Z homing failed: {e}") from e
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

    # ── 板角核验 (每圈开拍前) ──

    def verify_corner(self, x: float, y: float, z: float, *, rows_dir, cols_dir,
                      plate_dims=(8, 12), pitch_mm: float = 9.0) -> dict:
        """走到地图上的 A1,确认 A1 外侧两个方向都是板外 —— 地图没有整体错开整行/整列。

        孔阵是周期的,单格对正只能保证「对到了最近的孔」;单格的板边核验在 4×4 格子里只看得到
        一个方向。这里在角孔上两个方向都看得到板边。相机先挪近最近的孔 (偏差 > 1/4 孔距时),
        避免半格处的取整歧义 (0.25 孔距只是「先挪近」的触发条件,不是验收值)。
        返回 {ok, status, reason, a1_error_mm (A1 实际位置 − 地图位置), edge_check}。status:
          passed        两个方向都看到了板外,且没有任何不一致
          mismatch      看到的板边和地图对不上 (有证据表明地图错了) → App 把这一圈的照片标 UNVERIFIED
          inconclusive  看不清 (认不出孔阵 / 一侧板边不在画面里) → 孔身份未核验,但不算地图错了
        """
        def result(status: str, reason: str, **kw) -> dict:
            return {**kw, "ok": status == "passed", "status": status, "reason": reason}

        self.al.goto([x, y])
        self.z_goto(z)
        pos = np.array([x, y], float)
        frame = self.al.grab()
        lat = self.al.analyze(frame, pitch_mm)
        if lat.get("reliable") and float(np.hypot(*lat["move_mm"])) > 0.25 * pitch_mm:
            pos = pos + np.array(lat["move_mm"])
            self.al.goto(pos)
            frame = self.al.grab()
            lat = self.al.analyze(frame, pitch_mm)
        if not lat.get("reliable"):
            return result("inconclusive", "wells not recognised at the mapped A1 corner")
        a1 = pos + np.array(lat["move_mm"])
        out = {"a1_error_mm": [round(float(a1[0] - x), 3), round(float(a1[1] - y), 3)]}
        ec = edge_check(lat, self.al.matrix(frame.shape), rows_dir, cols_dir, (0, 0, 0, 0), plate_dims)
        out["edge_check"] = ec
        if not ec.get("ran"):
            return result("inconclusive", ec.get("reason", "edge check did not run"), **out)
        if not ec["ok"]:
            return result("mismatch", "plate edge not where the map puts A1: " + "; ".join(ec["mismatch"]), **out)
        if not (ec["edges_seen_rows"] and ec["edges_seen_cols"]):
            return result("inconclusive", "could not see the plate edge on both sides of A1", **out)
        return result("passed", "A1 has the plate edge on both outer sides", **out)

    # ── 单格 ──

    def shoot(self, x: float, y: float, z_pred: float, *, rows_dir=(1.0, 0.0),
              row_half: bool = True, col_half: bool = True, pitch_mm: float = 9.0,
              autofocus: bool = True, af_range: float = 3.0, af_extend: bool = True,
              ref_sharp: float | None = None, full_res: bool = False,
              cols_dir=None, block=None, plate_dims=None,
              align: bool = True) -> tuple[np.ndarray, dict]:
        """拍一格。返回 (BGR 照片, 过程信息 + 验收结果)。full_res=True 拍 12MP (临时切相机模式),否则 3MP。

        cols_dir (板上「往下一列 1→2」的平台方向)、block (r0, r1, c0, c1)、plate_dims (rows, cols)
        都给了才做板边核验 (edge_check);不给时 position 最多是 aligned。
        align=False:只按地图拍 —— 不对正、不对焦、不做画面核验,直接在 (x, y, z_pred) 拍
        (6/12 孔板一帧只有 1–2 个孔,孔阵识别做不了;position / focus 记为 unchecked)。
        """
        info: dict = {"x": x, "y": y, "z_pred": z_pred}
        self.al.goto([x, y])
        self.z_goto(z_pred)
        if not align:
            info.update(align_error_mm=None, residual_mm=None, position="unchecked",
                        position_note="map-only mode (in-frame checks off)", content_wells=0,
                        af={"ran": False, "reason": "map-only mode"}, focus="unchecked",
                        z=round(float(z_pred), 3))
            return self._final_shot(info, full_res)

        # 对正:格子中心偏了就修正一次
        frame = self.al.grab()
        lat = self.al.analyze(frame, pitch_mm)
        pos = np.array([x, y], float)
        residual = None
        if lat.get("reliable"):
            err = block_error(lat, self.al.matrix(frame.shape), rows_dir, row_half, col_half)
            info["align_error_mm"] = [round(float(err[0]), 3), round(float(err[1]), 3)]
            residual = float(np.hypot(*err))
            if residual > ALIGN_TOL_MM:
                pos = pos + err
                self.al.goto(pos)
                frame = self.al.grab()
                lat = self.al.analyze(frame, pitch_mm)
                info["aligned_to"] = [round(float(pos[0]), 3), round(float(pos[1]), 3)]
                residual = None  # 修正后重新测
                if lat.get("reliable"):
                    err2 = block_error(lat, self.al.matrix(frame.shape), rows_dir, row_half, col_half)
                    residual = float(np.hypot(*err2))
        else:
            info["align_error_mm"] = None
            info["align_note"] = "wells not recognised — alignment skipped"
        info["residual_mm"] = None if residual is None else round(residual, 3)

        # 孔位验收:残差 + 板边核验 (看得到板边时)
        if residual is None:
            position, note = "unaligned", "wells not recognised in view"
        elif residual > ALIGN_TOL_MM:
            position, note = "unaligned", f"still {residual:.2f} mm off after correction"
        else:
            position, note = "aligned", "no plate edge in view to verify well identity"
            if cols_dir is not None and block is not None and plate_dims is not None:
                ec = edge_check(lat, self.al.matrix(frame.shape), rows_dir, cols_dir, block, plate_dims)
                info["edge_check"] = ec
                if ec.get("ran") and not ec["ok"]:
                    position, note = "edge_mismatch", "; ".join(ec["mismatch"])
                elif ec.get("ran") and ec["edges_seen"] > 0:
                    position, note = "confirmed", f"{ec['edges_seen']} off-plate line(s) where expected"
                elif not ec.get("ran"):
                    note = ec.get("reason", note)
            else:
                note = "plate layout not given — edge check skipped"
        info["position"], info["position_note"] = position, note

        # 对焦
        mask, n_content = content_mask(frame, lat)
        info["content_wells"] = n_content
        z = z_pred
        if mask is None:
            if lat.get("reliable"):
                info["af"] = {"ran": False, "reason": "no wells with content in view"}
                info["focus"] = "empty"
            else:
                info["af"] = {"ran": False, "reason": "wells not recognised — focus not assessed"}
                info["focus"] = "unknown"
        else:
            s_pred = sharpness(frame, mask)
            info["sharp_at_pred"] = round(s_pred, 2)
            if ref_sharp and s_pred >= SKIP_AF_RATIO * ref_sharp:
                info["af"] = {"ran": False, "reason": f"sharp enough ({s_pred:.0f} vs ref {ref_sharp:.0f})"}
                info["focus"] = "sharp_kept"
            elif autofocus:
                af = self.autofocus(z_pred, af_range, mask, extend=af_extend)
                info["af"] = af
                info["focus"] = "refocused" if af["found"] else "no_peak"
                z = af["z"]
            else:
                info["af"] = {"ran": False, "reason": "autofocus off"}
                info["focus"] = "off"
        self.z_goto(z)
        info["z"] = round(float(z), 3)
        if mask is not None:
            info["sharp"] = round(sharpness(self.al.grab(), mask), 2)

        return self._final_shot(info, full_res)

    def _final_shot(self, info: dict, full_res: bool) -> tuple[np.ndarray, dict]:
        """最终照片 + 亮度检查。"""
        t0 = time.monotonic()
        img = self.camera.capture_full() if full_res else self.camera.capture_array(preview=False)
        info["size"] = [int(img.shape[1]), int(img.shape[0])]
        info["capture_s"] = round(time.monotonic() - t0, 2)
        bright = float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean())
        info["brightness"] = round(bright, 1)
        if bright < MIN_BRIGHTNESS:
            raise ScanError(f"captured image almost black (brightness {bright:.0f})")
        return img, info
