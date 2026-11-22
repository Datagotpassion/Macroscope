"""标定 + 自动对准测试 — 假平台 + 按平台位置渲染孔阵的假相机,不用真机跑完整流程。"""

import math
import sys
from pathlib import Path

import numpy as np
import pytest

# 让测试能 import backend 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import align  # noqa: E402
from test_wellgrid import H, W, render  # noqa: E402

align.SETTLE_S = 0.0  # 测试里不用等机械振动


class FakeStage:
    def __init__(self, x=120.0, y=90.0, frozen=False):
        self.p = np.array([x, y], float)
        self.frozen = frozen  # True = 电机不动 (模拟没上电 / 丢步)

    def status(self):
        return {"connected": True, "homed": "xyz",
                "position": {"x": self.p[0], "y": self.p[1], "z": 10.0}}

    def move(self, x=None, y=None, z=None, feed=0):
        if self.frozen:
            return
        if x is not None:
            self.p[0] = x
        if y is not None:
            self.p[1] = y

    def wait_moves(self):
        pass


def camera_matrix(px_per_mm=16.4, rot_deg=91.0, mirrored=True):
    """真值:相机装歪 91° 且镜像 (画面内容平移 = M · 平台移动)。"""
    t = math.radians(rot_deg)
    R = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]])
    F = np.diag([1.0, -1.0]) if mirrored else np.eye(2)
    return px_per_mm * R @ F


class FakeCamera:
    """孔 (0,0) 在平台坐标 well0 处;相机在平台位置 p 时,它出现在画面中心 + M·(p − well0)。"""

    def __init__(self, stage, M, well0, pitch_mm=9.0, plate_deg=0.8, wells=True):
        self.stage, self.M, self.well0 = stage, M, np.array(well0, float)
        t = math.radians(plate_deg)
        a_img = M @ (pitch_mm * np.array([math.cos(t), math.sin(t)]))
        ang = math.degrees(math.atan2(a_img[1], a_img[0]))
        self.angle = (ang + 45.0) % 90.0 - 45.0  # 方格阵:角度取到 (−45°, 45°]
        self.pitch_px = float(np.linalg.norm(a_img))
        self.wells = wells
        self.frame_no = 0

    def capture_array(self, preview=True):
        self.frame_no += 1  # 每帧传感器噪声不同
        if not self.wells:
            rng = np.random.default_rng(self.frame_no)
            return rng.integers(0, 255, (H, W, 3), dtype=np.uint8)
        o = np.array([W / 2.0, H / 2.0]) + self.M @ (self.stage.p - self.well0)
        img, *_ = render(self.pitch_px, self.angle, tuple(o), noise_seed=1000 + self.frame_no)
        return img


def make(tmp_path, start=(120.0, 90.0), well0=(118.4, 91.7), **kw):
    stage = FakeStage(*start, frozen=kw.pop("frozen", False))
    M = camera_matrix()
    cam = FakeCamera(stage, M, well0, **kw)
    return align.Aligner(cam, stage, cal_file=tmp_path / "cal.json"), stage, M


def test_calibration_recovers_camera_matrix(tmp_path):
    al, stage, M = make(tmp_path)
    cal = al.calibrate(step_mm=3.0)
    est = np.array(cal["M"])
    assert np.abs(est - M).max() / np.abs(M).max() < 0.015, (est, M)
    assert cal["mirrored"] is True
    assert cal["return_error_mm"] < 0.05
    assert np.allclose(stage.p, [120.0, 90.0])  # 标定完回到起点
    assert (tmp_path / "cal.json").exists()


def test_calibration_rejected_when_stage_does_not_move(tmp_path):
    al, *_ = make(tmp_path, frozen=True)
    with pytest.raises(align.AlignError, match="barely moved"):
        al.calibrate(step_mm=3.0)
    assert not (tmp_path / "cal.json").exists()


def test_center_on_well_converges_to_the_well(tmp_path):
    al, stage, _ = make(tmp_path, start=(120.0, 90.0), well0=(118.4, 91.7))
    al.calibrate(step_mm=3.0)
    res = al.center_on_well(pitch_mm=9.0, tol_mm=0.1)
    assert res["ok"]
    assert math.hypot(res["position"]["x"] - 118.4, res["position"]["y"] - 91.7) < 0.08, res
    assert res["moves"] <= 3


def test_center_refuses_without_wells(tmp_path):
    al, stage, _ = make(tmp_path)
    al.calibrate(step_mm=3.0)
    al.camera.wells = False
    with pytest.raises(align.AlignError, match="not recognised"):
        al.center_on_well()


def test_center_requires_calibration(tmp_path):
    al, *_ = make(tmp_path)
    with pytest.raises(align.AlignError, match="not calibrated"):
        al.center_on_well()
