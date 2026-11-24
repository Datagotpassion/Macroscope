"""标定前找焦点 + 标定后用板子孔距核对 —— 假平台带 Z,假相机按离焦程度模糊。"""

import math
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import align  # noqa: E402
from test_align import camera_matrix  # noqa: E402
from test_scan import FocusCamera, Stage3  # noqa: E402
from test_wellgrid import H, W, render  # noqa: E402

align.SETTLE_S = 0.0
align.Z_SETTLE_S = 0.0


class TrackedStage(Stage3):
    """记下每次 Z 移动,检查扫描是不是一直从下往上走。"""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.z_moves = []

    def move(self, x=None, y=None, z=None, feed=0):
        super().move(x=x, y=y, z=z, feed=feed)
        if z is not None:
            self.z_moves.append(z)


class LensCamera(FocusCamera):
    """清晰度曲线是圆滑的单峰 (像真镜头):焦点上也有一点模糊,离焦越远越糊。

    test_scan 的 FocusCamera 在焦点 ±0.4 mm 内几乎不模糊 (曲线平顶),够它用 0.5 mm 步长对焦,
    但细扫 0.1 mm 时峰的位置就成了随机的。
    """

    def capture_array(self, preview=True):
        self.n += 1
        if self.dark:
            return np.full((H, W, 3), 5, np.uint8)
        o = np.array([W / 2.0, H / 2.0]) + self.M @ (self.stage.p - self.well0)
        img, *_ = render(self.pitch_px, self.angle, tuple(o), noise_seed=1000 + self.n, debris=self.content)
        return cv2.GaussianBlur(img, (0, 0), math.hypot(0.8, 1.5 * (self.stage.z - self.z_focus)))


def make(tmp_path, z_focus, z_start=8.0, homed="xyz"):
    stage = TrackedStage(120.0, 90.0, z=z_start, homed=homed)
    M = camera_matrix(px_per_mm=16.4, rot_deg=0.0, mirrored=False)
    cam = LensCamera(stage, M, (118.4, 91.7), z_focus=z_focus, content=False)
    return align.Aligner(cam, stage, cal_file=tmp_path / "cal.json"), stage


# ── 纯函数 ──

def curve(zs, peak, width=1.0, floor=5.0):
    return [(z, floor + 50.0 / (1 + ((z - peak) / width) ** 2)) for z in zs]


ZS = [k * 0.5 for k in range(31)]  # 0 … 15 mm


def test_pick_focus_inside_travel():
    p = align.pick_focus(curve(ZS, 9.2))
    assert p["status"] == "ok" and p["z"] == 9.0 and p["gain"] > 5


@pytest.mark.parametrize("peak,status", [(17.0, "above"), (-2.0, "below")])
def test_pick_focus_still_rising_at_the_end_of_travel(peak, status):
    """2026-11-24 实测:焦点跑到约 17 mm,0–15 mm 一路变清楚,没有峰。"""
    assert align.pick_focus(curve(ZS, peak, width=3.7))["status"] == status


def test_pick_focus_flat_curve():
    flat = [(z, 10.0 + 0.1 * (k % 3)) for k, z in enumerate(ZS)]
    assert align.pick_focus(flat)["status"] == "flat"


def test_refine_peak_interpolates_between_steps():
    zs = [8.6 + 0.1 * k for k in range(13)]
    assert abs(align.refine_peak(curve(zs, 9.23, width=0.5)) - 9.23) < 0.02


# ── 带假平台 ──

@pytest.mark.parametrize("z_focus", [3.4, 9.27, 14.2])
def test_calibrate_finds_focus_first(tmp_path, z_focus):
    al, stage = make(tmp_path, z_focus)
    cal = al.calibrate(step_mm=2.0, focus=True, pitch_mm=9.0)
    assert abs(cal["focus"]["z"] - z_focus) < 0.1, cal["focus"]
    assert abs(stage.z - z_focus) < 0.1  # 标定完停在焦点上
    assert np.allclose(stage.cmd, [120.0, 90.0])  # X/Y 回到起点
    assert abs(cal["plate_pitch_mm"] - 9.0) < 0.3
    saved = (tmp_path / "cal.json").read_text(encoding="utf-8")
    assert '"focus"' in saved
    # 每段扫描都从下往上:除了「退到起点下方」那一下,Z 不往回走
    downs = [i for i in range(1, len(stage.z_moves)) if stage.z_moves[i] < stage.z_moves[i - 1] - 1e-9]
    assert len(downs) <= 3, stage.z_moves  # 粗扫开头、细扫开头、最后接近焦点


@pytest.mark.parametrize("z_focus,where", [(17.0, "above"), (-1.5, "below")])
def test_calibrate_refuses_when_focus_is_outside_travel(tmp_path, z_focus, where):
    al, stage = make(tmp_path, z_focus)
    with pytest.raises(align.AlignError, match=f"focus is {where} the Z travel"):
        al.calibrate(step_mm=2.0, focus=True)
    assert not (tmp_path / "cal.json").exists()
    assert np.allclose(stage.cmd, [120.0, 90.0])  # 没走 X/Y


def test_calibrate_refuses_without_anything_to_focus_on(tmp_path):
    al, stage = make(tmp_path, 9.0)
    al.camera.dark = True
    with pytest.raises(align.AlignError, match="no focus found"):
        al.calibrate(step_mm=2.0, focus=True)
    assert not (tmp_path / "cal.json").exists()


def test_calibrate_needs_z_homed_for_focus(tmp_path):
    al, _ = make(tmp_path, 9.0, homed="xy")
    with pytest.raises(align.AlignError, match="Z not homed"):
        al.calibrate(step_mm=2.0, focus=True)


def test_calibrate_rejects_pitch_that_does_not_match_the_plate(tmp_path):
    """画面里的孔距 ÷ 标定比例 和板子的标准孔距对不上 = 认错周期或板型不对,不保存。"""
    al, _ = make(tmp_path, 8.0)
    with pytest.raises(align.AlignError, match="wells measure"):
        al.calibrate(step_mm=2.0, pitch_mm=13.08)
    assert not (tmp_path / "cal.json").exists()
    cal = al.calibrate(step_mm=2.0, pitch_mm=9.0)  # 不找焦点时行为和以前一样
    assert cal["focus"] is None
