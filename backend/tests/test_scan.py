"""一键拍全板的单格流程测试 — 假平台 (带 Z 和回零) + 按 Z 离焦程度变模糊的假相机。"""

import math
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

# 让测试能 import backend 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import align  # noqa: E402
import scan  # noqa: E402
from test_align import FakeStage, camera_matrix  # noqa: E402
from test_wellgrid import H, W, render  # noqa: E402

align.SETTLE_S = 0.0
scan.Z_SETTLE_S = 0.0


class Stage3(FakeStage):
    """FakeStage + Z 轴、回零、行程上限。z_home_fails:Z 回零前几次报「没触发」(板子太高)。"""

    def __init__(self, x=120.0, y=90.0, z=0.0, homed="xyz", zmax=15.0, z_home_fails=0, **kw):
        super().__init__(x, y, **kw)
        self.z, self.homed, self.zmax, self.z_home_fails = z, homed, zmax, z_home_fails
        self.homes = []

    def status(self):
        st = super().status()
        st.update(homed=self.homed, state="ready", axis_maximum=[325.0, 230.0, self.zmax, 0.0])
        st["position"]["z"] = self.z
        return st

    def move(self, x=None, y=None, z=None, feed=0):
        super().move(x=x, y=y, feed=feed)
        if z is not None:
            assert -1e-9 <= z <= self.zmax + 1e-9, f"Z {z} out of range"
            self.z = z

    def home(self, axes):
        self.homes.append(axes)
        if "Z" in axes.upper() and self.z_home_fails > 0:
            self.z_home_fails -= 1
            raise RuntimeError("No trigger on stepper_z after full movement")
        for a in axes.lower():
            if a in "xyz" and a not in self.homed:
                self.homed += a


class FocusCamera:
    """孔 (0,0) 在平台坐标 well0;板子方向 = 平台方向。离焦 |z − z_focus| 越大越模糊。"""

    kind = "picamera2"

    def __init__(self, stage, M, well0, z_focus=10.2, content=True, dark=False):
        self.stage, self.M, self.well0 = stage, M, np.array(well0, float)
        a_img = M @ np.array([9.0, 0.0])
        ang = math.degrees(math.atan2(a_img[1], a_img[0]))
        self.angle = (ang + 45.0) % 90.0 - 45.0
        self.pitch_px = float(np.linalg.norm(a_img))
        self.z_focus, self.content, self.dark = z_focus, content, dark
        self.n = 0

    def clear_roi(self):
        pass

    def capture_array(self, preview=True):
        self.n += 1
        if self.dark:
            return np.full((H, W, 3), 5, np.uint8)
        o = np.array([W / 2.0, H / 2.0]) + self.M @ (self.stage.p - self.well0)
        img, *_ = render(self.pitch_px, self.angle, tuple(o), noise_seed=1000 + self.n, debris=self.content)
        sigma = 0.6 * abs(self.stage.z - self.z_focus)
        return cv2.GaussianBlur(img, (0, 0), sigma) if sigma > 0.05 else img


def make(tmp_path, start=(120.0, 90.0), well0=(118.4, 91.7), z_focus=10.2, **kw):
    stage = Stage3(*start, z=z_focus, **{k: v for k, v in kw.items() if k in ("homed", "z_home_fails")})
    M = camera_matrix(px_per_mm=16.4, rot_deg=0.0, mirrored=False)
    cam = FocusCamera(stage, M, well0, z_focus=z_focus,
                      **{k: v for k, v in kw.items() if k in ("content", "dark")})
    al = align.Aligner(cam, stage, cal_file=tmp_path / "cal.json")
    if kw.get("calibrate", True):
        al.calibrate(step_mm=2.0)
    return scan.Shooter(cam, stage, al), stage, cam, al


# ── 格子中心偏差 ──

def _lat(offset):
    return {"a": [150.0, 0.0], "b": [0.0, 150.0], "offset": list(offset)}


def test_block_error_on_well_and_between_wells():
    M = 16.0 * np.eye(2)
    o = np.array([-30.0, 20.0])  # 最近的孔在画面中心左下
    # 奇数孔数:中心应在孔上 → 修正 = 把这个孔挪到中心
    err = scan.block_error(_lat(o), M, (1.0, 0.0), False, False)
    assert np.allclose(err, [30 / 16, -20 / 16])
    # 偶数孔数:中心应在四孔正中;修正后再算一次应该为零
    err = scan.block_error(_lat(o), M, (1.0, 0.0), True, True)
    o2 = o + M @ err  # 平台移动 err → 画面内容平移 M·err
    o2 = o2 - 150 * np.round(o2 / 150)  # 新的「最近的孔」
    assert np.allclose(scan.block_error(_lat(o2), M, (1.0, 0.0), True, True), 0, atol=1e-9)


def test_block_error_mixed_parity_follows_plate_rows_direction():
    M = 16.0 * np.eye(2)
    o = np.array([0.0, 0.0])  # 画面中心正对一个孔
    # 行方向沿画面 x (平台 −X → 画面 +x):行方向是偶数 → x 要偏半格,y 不动
    err = scan.block_error(_lat(o), M, (-1.0, 0.0), True, False)
    assert abs(abs(err[0]) - 75 / 16) < 1e-9 and abs(err[1]) < 1e-9
    # 行方向沿画面 y:同样的奇偶 → y 偏半格,x 不动
    err = scan.block_error(_lat(o), M, (0.0, 1.0), True, False)
    assert abs(err[0]) < 1e-9 and abs(abs(err[1]) - 75 / 16) < 1e-9


# ── 对焦 ──

def test_autofocus_finds_the_peak(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    mask, n = scan.content_mask(cam.capture_array(), al.analyze(cam.capture_array(), 9.0))
    assert n > 0
    af = sh.autofocus(9.0, 3.0, mask)
    assert af["found"] and abs(af["z"] - 10.2) < 0.25, af


def test_autofocus_extends_the_window_when_the_peak_is_at_its_edge(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    mask, _ = scan.content_mask(cam.capture_array(), al.analyze(cam.capture_array(), 9.0))
    af = sh.autofocus(6.0, 3.0, mask)  # 窗口 3–9,真焦点 10.2 在窗口外
    assert af["found"] and abs(af["z"] - 10.2) < 0.25, af


def test_autofocus_without_extension_stays_inside_the_window(tmp_path):
    # 板子已有对焦记忆:窗口外的峰 (另一个平面) 不去追,保持预测高度
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    mask, _ = scan.content_mask(cam.capture_array(), al.analyze(cam.capture_array(), 9.0))
    af = sh.autofocus(6.0, 1.5, mask, extend=False)
    assert not af["found"] and af["z"] == 6.0, af
    assert all(4.5 - 1e-9 <= z <= 7.5 + 1e-9 for z, _ in af["curve"]), af["curve"]


def _curve(vals, z0=5.0):
    return {z0 + 0.5 * i: v for i, v in enumerate(vals)}


def test_interior_peak_ignores_slopes_and_noise():
    # 一路上升 (焦点在窗口外) → 没有峰
    assert scan._interior_peak(_curve([1.0, 1.2, 1.5, 2.0, 3.0])) is None
    # 坡上的小疙瘩 (噪声) → 不算峰
    assert scan._interior_peak(_curve([1.0, 1.3, 1.6, 1.65, 1.62, 2.0, 2.4])) is None
    # 下沿更高 (另一个平面的坡),中间有真正的孔底峰 → 取中间的峰
    assert scan._interior_peak(_curve([5.0, 3.0, 2.0, 2.6, 3.4, 2.7, 2.1])) == 4


# ── 单格 ──

def test_shoot_focuses_and_returns_info(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    gap = np.array([118.4 + 4.5, 91.7 + 4.5])  # 4×4 格子的中心在四孔正中
    img, info = sh.shoot(*gap, z_pred=8.5, rows_dir=(1.0, 0.0), row_half=True, col_half=True)
    assert img.shape == (H, W, 3)
    assert info["af"]["ran"] and info["af"]["found"]
    assert abs(info["z"] - 10.2) < 0.25 and abs(stage.z - info["z"]) < 1e-6


def test_shoot_full_res_uses_the_12mp_capture(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    full = np.full((3040, 4056, 3), 120, np.uint8)
    cam.capture_full = lambda: full
    gap = np.array([118.4 + 4.5, 91.7 + 4.5])
    img, info = sh.shoot(*gap, z_pred=10.2, full_res=True)
    assert img is full and info["size"] == [4056, 3040]
    img, info = sh.shoot(*gap, z_pred=10.2)  # 默认仍是常驻配置的静帧
    assert info["size"] == [W, H]


def test_shoot_skips_autofocus_when_sharp_enough(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    gap = np.array([118.4 + 4.5, 91.7 + 4.5])
    _, first = sh.shoot(*gap, z_pred=8.5)
    _, again = sh.shoot(*gap, z_pred=first["z"], ref_sharp=first["sharp"])
    assert again["af"]["ran"] is False and "sharp enough" in again["af"]["reason"]


def test_shoot_empty_wells_uses_the_predicted_height(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2, content=False)
    _, info = sh.shoot(118.4 + 4.5, 91.7 + 4.5, z_pred=9.0)
    assert info["content_wells"] == 0 and info["af"]["ran"] is False
    assert info["z"] == 9.0


def test_shoot_corrects_a_misplaced_block(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    gap = np.array([118.4 + 4.5, 91.7 + 4.5])
    _, info = sh.shoot(*(gap + [1.0, -0.8]), z_pred=10.2)  # 板子放偏了约 1.3 mm
    assert "aligned_to" in info
    assert math.hypot(*(stage.p - gap)) < 0.3, (stage.p, info)


# ── 自检 ──

def test_preflight_homes_and_retries_z(tmp_path):
    sh, stage, cam, al = make(tmp_path)
    stage.homed, stage.z_home_fails = "", 1  # 没回零,且板子高于一次回零行程
    res = sh.preflight()
    assert res["ok"] and res["homed_now"] == ["XY", "Z"]
    assert stage.homes == ["XY", "Z", "Z"]


@pytest.mark.parametrize("problem,match", [
    ("mock", "MockCamera"), ("uncalibrated", "not calibrated"), ("dark", "light on"),
])
def test_preflight_refuses(tmp_path, problem, match):
    sh, stage, cam, al = make(tmp_path, calibrate=(problem != "uncalibrated"))
    if problem == "mock":
        cam.kind = "mock"
    if problem == "dark":
        cam.dark = True
    with pytest.raises(scan.ScanError, match=match):
        sh.preflight()


# ── 验收:孔位 / 板边核验 / 板角核验 ──
# 用真机方向的整块板 (A→H 朝 −X,1→12 朝 −Y,板歪 0.8°),相机一帧约 7×5 孔,和真机一样。

from test_platefind import PlateCamera, unit  # noqa: E402

PITCH = 9.0
RD, CD = unit(180.8), unit(270.8)
A1 = np.array([213.5, 197.1])


class PlateCam3(PlateCamera):
    kind = "picamera2"

    def clear_roi(self):
        pass


def make_plate(tmp_path):
    M = camera_matrix(px_per_mm=15.9, rot_deg=0.0, mirrored=False)
    start = A1 + PITCH * (3 * RD + 5 * CD)  # 板中间,标定时满屏都是孔
    stage = Stage3(*start, z=10.0)
    cam = PlateCam3(stage, M, A1, RD, CD)
    al = align.Aligner(cam, stage, cal_file=tmp_path / "cal.json")
    al.calibrate(step_mm=2.0)
    return scan.Shooter(cam, stage, al), stage, cam


def shoot_block(sh, blk, shift=(0.0, 0.0), layout=True):
    r0, r1, c0, c1 = blk
    p = A1 + PITCH * ((r0 + r1) / 2 * RD + (c0 + c1) / 2 * CD) + np.asarray(shift)
    kw = dict(cols_dir=CD, block=blk, plate_dims=(8, 12)) if layout else {}
    _, info = sh.shoot(*p, z_pred=10.0, rows_dir=RD, autofocus=False,
                       row_half=(r1 - r0 + 1) % 2 == 0, col_half=(c1 - c0 + 1) % 2 == 0, **kw)
    return info


def test_corner_block_is_confirmed_by_the_plate_edge(tmp_path):
    sh, stage, cam = make_plate(tmp_path)
    info = shoot_block(sh, (0, 3, 0, 3), shift=(0.4, -0.3))  # 地图有一点小偏差 (正常)
    assert info["position"] == "confirmed", info
    assert info["edge_check"]["ok"] and info["edge_check"]["edges_seen"] > 0
    assert info["residual_mm"] is not None and info["residual_mm"] <= scan.ALIGN_TOL_MM


def test_map_off_by_a_whole_row_is_caught_by_the_block_edge_check(tmp_path):
    # 地图整体错开一行 (9 mm):对正照样「成功」(对到最近的孔),只有板边对不上
    sh, stage, cam = make_plate(tmp_path)
    info = shoot_block(sh, (0, 3, 0, 3), shift=PITCH * RD)
    assert info["residual_mm"] <= scan.ALIGN_TOL_MM  # 周期歧义:单看对正发现不了
    assert info["position"] == "edge_mismatch", info


def test_interior_block_without_edges_is_only_aligned(tmp_path):
    sh, stage, cam = make_plate(tmp_path)
    info = shoot_block(sh, (3, 4, 5, 6))
    assert info["position"] == "aligned", info


def test_without_plate_layout_the_edge_check_is_skipped(tmp_path):
    sh, stage, cam = make_plate(tmp_path)
    info = shoot_block(sh, (0, 3, 0, 3), layout=False)
    assert info["position"] == "aligned" and "edge_check" not in info


def test_uniform_gray_frame_is_unaligned_and_focus_unknown(tmp_path):
    # 审查复现:均匀灰图能过自检、返回照片 —— 现在照片仍返回,但验收标成未确认
    sh, stage, cam, al = make(tmp_path)
    gray = lambda preview=True: np.full((H, W, 3), 128, np.uint8)  # noqa: E731
    cam.capture_array = gray
    _, info = sh.shoot(120.0, 90.0, 10.0)
    assert info["position"] == "unaligned" and info["focus"] == "unknown", info


def test_focus_status_is_reported(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    gap = np.array([118.4 + 4.5, 91.7 + 4.5])
    _, first = sh.shoot(*gap, z_pred=8.5)
    assert first["focus"] == "refocused"
    _, again = sh.shoot(*gap, z_pred=first["z"], ref_sharp=first["sharp"])
    assert again["focus"] == "sharp_kept"
    _, off = sh.shoot(*gap, z_pred=10.2, autofocus=False)
    assert off["focus"] == "off"
    sh2, *_ = make(tmp_path / "empty", z_focus=10.2, content=False)
    _, empty = sh2.shoot(*gap, z_pred=10.2)
    assert empty["focus"] == "empty"


def test_corner_check_passes_on_the_real_a1(tmp_path):
    sh, stage, cam = make_plate(tmp_path)
    res = sh.verify_corner(*(A1 + [0.5, -0.4]), 10.0, rows_dir=RD, cols_dir=CD)
    assert res["ok"], res
    assert res["edge_check"]["edges_seen_rows"] and res["edge_check"]["edges_seen_cols"]
    assert math.hypot(*(np.array(res["a1_error_mm"]) - [-0.5, 0.4])) < 0.35, res


@pytest.mark.parametrize("shift", [PITCH * RD, -PITCH * RD, PITCH * CD, -PITCH * CD])
def test_corner_check_catches_a_map_off_by_a_whole_well(tmp_path, shift):
    # 整行 / 整列错开:块级核验在画面短边方向看不到板边,板角核验两个方向都看得到
    sh, stage, cam = make_plate(tmp_path)
    res = sh.verify_corner(*(A1 + shift), 10.0, rows_dir=RD, cols_dir=CD)
    assert not res["ok"], res


def test_corner_check_fails_when_no_wells_are_seen(tmp_path):
    sh, stage, cam = make_plate(tmp_path)
    res = sh.verify_corner(*(A1 - 40 * RD), 10.0, rows_dir=RD, cols_dir=CD)  # 板外很远
    assert not res["ok"] and "not recognised" in res["reason"]


def test_preflight_does_not_retry_z_on_other_errors(tmp_path):
    sh, stage, cam, al = make(tmp_path)
    stage.homed = "xy"

    def broken_home(axes):
        stage.homes.append(axes)
        raise RuntimeError("timed out")

    stage.home = broken_home
    with pytest.raises(scan.ScanError, match="Z homing failed"):
        sh.preflight()
    assert stage.homes == ["Z"]  # 不是「没触发」就不重试
