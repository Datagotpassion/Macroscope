"""孔位检测测试 — 重点验证修复的两个问题:

1. 网格能正确分配 A1-H12 标签 (旧 _find_breaks/_assign_labels 会崩)。
2. 即使部分孔缺失/Hough 失败,也能稳定输出 96 个孔。
"""

import sys
from pathlib import Path

import numpy as np
import pytest

# 让测试能 import backend 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from camera import MockCamera  # noqa: E402
from plate_detector import PlateDetector  # noqa: E402


@pytest.fixture
def detector():
    return PlateDetector()


@pytest.fixture
def plate_image():
    # 用 MockCamera 渲染一张合成 96 孔板 (中等分辨率,跑得快)
    cam = MockCamera()
    cam._size = (1014, 760)
    cam._base = cam._render_plate((1014, 760))
    return cam.capture_array()


def test_detects_all_96_wells(detector, plate_image):
    wells = detector.detect_wells(plate_image)
    assert len(wells) == 96


def test_labels_are_complete_and_unique(detector, plate_image):
    wells = detector.detect_wells(plate_image)
    labels = {w["label"] for w in wells}
    expected = {f"{r}{c}" for r in "ABCDEFGH" for c in range(1, 13)}
    assert labels == expected


def test_grid_is_ordered(detector, plate_image):
    """A1 应在左上,H12 在右下 — 验证行列排序正确。"""
    wells = {w["label"]: w for w in detector.detect_wells(plate_image)}
    assert wells["A1"]["cx"] < wells["A12"]["cx"]   # 同行,列递增 -> x 增
    assert wells["A1"]["cy"] < wells["H1"]["cy"]    # 同列,行递增 -> y 增
    assert wells["A1"]["cx"] < wells["H12"]["cx"]
    assert wells["A1"]["cy"] < wells["H12"]["cy"]


def test_handles_blank_image(detector):
    """全黑图 (无圆) 也要返回完整 96 孔网格,不能崩。"""
    blank = np.zeros((760, 1014, 3), dtype=np.uint8)
    wells = detector.detect_wells(blank)
    assert len(wells) == 96
    assert all(not w["detected"] for w in wells)


def test_crop_well_within_bounds(detector, plate_image):
    wells = detector.detect_wells(plate_image)
    crop = detector.crop_well(plate_image, wells[0])
    assert crop.size > 0
    assert crop.shape[0] > 0 and crop.shape[1] > 0


def test_cluster_1d_fewer_points_than_groups(detector):
    """检测到的行少于 8 时不应崩溃 (旧实现的隐患)。"""
    vals = np.array([10.0, 200.0, 400.0])  # 只有 3 个不同位置
    centers = detector._cluster_1d(vals, 8)
    assert centers is not None
    assert len(centers) <= 8


def test_fit_line_extrapolates(detector):
    """线性拟合能从部分簇外推出等距网格的 origin/pitch。"""
    origin, pitch = detector._fit_line([100.0, 200.0, 300.0])
    assert pytest.approx(origin, abs=1.0) == 100.0
    assert pytest.approx(pitch, abs=1.0) == 100.0
