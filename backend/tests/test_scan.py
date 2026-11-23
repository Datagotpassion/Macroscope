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


# ── 单格 ──

def test_shoot_focuses_and_returns_info(tmp_path):
    sh, stage, cam, al = make(tmp_path, z_focus=10.2)
    gap = np.array([118.4 + 4.5, 91.7 + 4.5])  # 4×4 格子的中心在四孔正中
    img, info = sh.shoot(*gap, z_pred=8.5, rows_dir=(1.0, 0.0), row_half=True, col_half=True)
    assert img.shape == (H, W, 3)
    assert info["af"]["ran"] and info["af"]["found"]
    assert abs(info["z"] - 10.2) < 0.25 and abs(stage.z - info["z"]) < 1e-6


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
