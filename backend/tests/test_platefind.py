"""自动找板测试 — 假平台 + 只拍到整块板一部分的假相机 (板外是空白)。"""

import math
import sys
from pathlib import Path

import numpy as np
import pytest

# 让测试能 import backend 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import align  # noqa: E402
import platefind  # noqa: E402
from test_align import REAL_PLAY, FakeStage, camera_matrix  # noqa: E402
from test_wellgrid import H, W, draw_wells  # noqa: E402

align.SETTLE_S = 0.0


def unit(deg):
    t = math.radians(deg)
    return np.array([math.cos(t), math.sin(t)])


class PlateCamera:
    """整块板固定在平台坐标系里:A1 在 a1,A→H 沿 row_dir,1→12 沿 col_dir。"""

    def __init__(self, stage, M, a1, row_dir, col_dir, rows=8, cols=12, pitch=9.0):
        self.stage, self.M = stage, M
        self.wells = [(r, c, np.array(a1) + r * pitch * row_dir + c * pitch * col_dir)
                      for r in range(rows) for c in range(cols)]
        self.pitch_px = pitch * float(np.linalg.norm(M[:, 0]))
        self.frame_no = 0

    def well(self, label):
        r, c = "ABCDEFGH".index(label[0]), int(label[1:]) - 1
        return next(w for rr, cc, w in self.wells if rr == r and cc == c)

    def capture_array(self, preview=True):
        self.frame_no += 1
        ctr = np.array([W / 2.0, H / 2.0])
        centers, seeds = [], []
        for r, c, w in self.wells:
            centers.append(ctr + self.M @ (self.stage.p - w))  # 托架实际位置成像
            seeds.append(r * 100 + c)
        return draw_wells(centers, self.pitch_px, seeds=seeds, noise_seed=self.frame_no)


def setup(tmp_path, M, a1, row_dir, col_dir, start_offset_wells, play=(0.0, 0.0),
          start_err=(0.6, -0.4), stage_jitter=0.0):
    a1 = np.array(a1, float)
    start = a1 + 9.0 * (start_offset_wells[0] * row_dir + start_offset_wells[1] * col_dir) + start_err
    stage = FakeStage(*start, play=play)
    cam = PlateCamera(stage, M, a1, row_dir, col_dir)
    al = align.Aligner(cam, stage, cal_file=tmp_path / "cal.json")
    al.calibrate(step_mm=2.0)
    stage.jitter = stage_jitter  # 标定之后才加随机到位误差 (真机标定时的重复精度是 0.075 mm)
    return platefind.PlateFinder(al), al, stage, cam


def assert_corners(res, cam, stage, al, tol=0.12):
    """找到的三角 (指令坐标) 再按同样方式走过去,相机必须真的对准对应的孔。"""
    for key, label in (("tl", "A1"), ("tr", "A12"), ("bl", "H1")):
        p = res["ref"][key]
        al.goto([p["x"], p["y"]])
        err = math.hypot(*(stage.p - cam.well(label)))
        assert err < tol, (label, err, res)


def test_random_positioning_error_does_not_stall_centering(tmp_path):
    """真机:每次到位随机偏 ±0.2–0.3 mm。对准要求太严 (0.15 mm) 时会原地来回修正、
    收敛不了;找板按 CENTER_TOL (0.3 mm) 对准,能走完全程且三角仍然找对。"""
    M = camera_matrix(px_per_mm=15.9, rot_deg=0.0, mirrored=False)
    rd, cd = unit(180.8), unit(270.8)
    finder, al, stage, cam = setup(tmp_path, M, (213.5, 197.1), rd, cd, (1, 1),
                                   play=REAL_PLAY, stage_jitter=0.25)
    res = finder.find(96)
    # 每次走回去本身就有 ±0.25 mm 随机误差,再加对准时的误差
    assert_corners(res, cam, stage, al, tol=0.8)


def test_real_machine_orientation_with_backlash(tmp_path):
    # 和真机一样:相机内容随平台同向移动 (M ≈ +15.9·I),A→H 朝 −X,1→12 朝 −Y,板歪 0.8°
    M = camera_matrix(px_per_mm=15.9, rot_deg=0.0, mirrored=False)
    rd, cd = unit(180.8), unit(270.8)
    finder, al, stage, cam = setup(tmp_path, M, (213.5, 197.1), rd, cd, (1, 1), play=REAL_PLAY)
    res = finder.find(96)
    assert res["ok"]
    assert abs(res["angle_deg"] - 90.0) < 0.5
    assert abs(res["pitch_mm"] - 9.0) < 0.05
    assert_corners(res, cam, stage, al)


def test_long_moves_travel_more_than_small_step_calibration_says(tmp_path):
    """真机:2 mm 小步标定出的比例,长距离实际孔距比它推算的小约 4.5%
    (8.99/9.11 vs 9.43 mm)。跳孔要按实测更新步长,几何检查也不能因此误报。"""
    M = camera_matrix(px_per_mm=15.9, rot_deg=0.0, mirrored=False)
    rd, cd = unit(180.8), unit(270.8)
    finder, al, stage, cam = setup(tmp_path, M, (213.5, 197.1), rd, cd, (1, 1), play=REAL_PLAY)
    al.cal["M"] = (np.array(al.cal["M"]) / 1.045).tolist()  # 标定比例偏小 4.5%
    al.cal["px_per_mm"] /= 1.045
    res = finder.find(96)
    assert_corners(res, cam, stage, al)


def test_rotated_plate_and_mirrored_camera(tmp_path):
    # 板转 90° (A→H 朝 +Y,1→12 朝 −X),相机装歪 91° 且镜像
    M = camera_matrix(px_per_mm=16.4, rot_deg=91.0, mirrored=True)
    rd, cd = unit(89.0), unit(179.0)
    finder, al, stage, cam = setup(tmp_path, M, (180.0, 60.0), rd, cd, (1, 1))
    res = finder.find(96)
    assert_corners(res, cam, stage, al)


@pytest.mark.parametrize("start", [(4, 5), (2, 4)])
def test_refuses_when_corner_not_in_view(tmp_path, start):
    """A1 不在画面里就拒绝 —— 不去「探」板边:起点离别的角更近时会把那个角错当成 A1。"""
    M = camera_matrix(px_per_mm=15.9, rot_deg=0.0, mirrored=False)
    rd, cd = unit(180.0), unit(270.0)
    finder, *_ = setup(tmp_path, M, (213.5, 197.1), rd, cd, start)  # E6 / C5 附近
    with pytest.raises(align.AlignError, match="edge not in view"):
        finder.find(96)


def test_unsupported_format(tmp_path):
    M = camera_matrix(px_per_mm=15.9, rot_deg=0.0, mirrored=False)
    finder, *_ = setup(tmp_path, M, (213.5, 197.1), unit(180.0), unit(270.0), (1, 1))
    with pytest.raises(align.AlignError, match="teach other formats manually"):
        finder.find(6)
