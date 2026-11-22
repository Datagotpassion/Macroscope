"""局部孔阵识别测试 — 用已知真值的合成孔阵检查偏移/孔距/角度,以及「别把空隙当孔」。"""

import math
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

# 让测试能 import backend 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wellgrid  # noqa: E402

W, H = 1014, 760  # 预览 (lores) 帧尺寸


def render(pitch=148.0, angle_deg=1.0, origin=(507.0, 380.0), bright=True, seed=0, keep=None,
           noise_seed=None):
    """合成一帧局部孔阵 (孔口/孔底两圈孔壁 + 孔里随机杂物 + 照明梯度 + 噪声)。

    seed 决定孔里的杂物 (跟着板子走);noise_seed 决定传感器噪声 (每帧不同,默认同 seed)。
    keep(i, j) 返回 False 的孔不画 (模拟板边)。返回 (BGR 图, 真值基向量 a, b, 原点)。
    """
    th = math.radians(angle_deg)
    a = pitch * np.array([math.cos(th), math.sin(th)])
    b = pitch * np.array([-math.sin(th), math.cos(th)])
    o = np.array(origin, float)
    centers, seeds = [], []
    for i in range(-8, 9):
        for j in range(-8, 9):
            if keep is not None and not keep(i, j):
                continue
            centers.append(o + i * a + j * b)
            seeds.append(seed * 1000 + (i + 8) * 17 + (j + 8))
    img = draw_wells(centers, pitch, bright, seeds, seed if noise_seed is None else noise_seed)
    return img, a, b, o


def draw_wells(centers, pitch, bright=True, seeds=None, noise_seed=0):
    """在 W×H 画面里按给定圆心画孔 (两圈孔壁 + 孔里杂物),加照明梯度和传感器噪声。

    seeds[k] 决定第 k 个孔里的杂物 (同一个孔每帧长得一样);noise_seed 决定这一帧的噪声。
    """
    bg, rim, inside = (200, 110, 235) if bright else (95, 190, 40)
    img = np.full((H, W), bg, np.uint8)
    F = 16  # cv2 的亚像素绘制 (shift=4)
    for k, c in enumerate(centers):
        if not (-pitch < c[0] < W + pitch and -pitch < c[1] < H + pitch):
            continue
        rng = np.random.default_rng(seeds[k] if seeds is not None else k)
        ctr = (int(round(c[0] * F)), int(round(c[1] * F)))
        cv2.circle(img, ctr, int(0.43 * pitch * F), rim, -1, cv2.LINE_AA, 4)
        cv2.circle(img, ctr, int(0.40 * pitch * F), inside, -1, cv2.LINE_AA, 4)
        cv2.circle(img, ctr, int(0.37 * pitch * F), rim, 3, cv2.LINE_AA, 4)
        for _ in range(rng.integers(0, 4)):  # 杂物 / 类器官
            p = c + rng.uniform(-0.25, 0.25, 2) * pitch
            ax = (int(rng.uniform(4, 0.12 * pitch)), int(rng.uniform(4, 0.08 * pitch)))
            cv2.ellipse(img, (int(p[0]), int(p[1])), ax, rng.uniform(0, 180), 0, 360,
                        int(rng.uniform(30, 160)), -1)
    img = img.astype(np.float32) + np.linspace(-25, 25, W)[None, :]  # 照明梯度
    noise = np.random.default_rng(noise_seed).normal(0, 4, img.shape)
    img = cv2.GaussianBlur(img, (0, 0), 1.0) + noise
    img = np.clip(img, 0, 255).astype(np.uint8)
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def truth_offset(a, b, o):
    """真值:离画面中心最近的格点相对画面中心的偏移。"""
    B = np.column_stack([a, b])
    c = np.array([W / 2.0, H / 2.0])
    ij = np.round(np.linalg.solve(B, c - o))
    return o + B @ ij - c


@pytest.mark.parametrize(
    "pitch,angle,origin,bright",
    [
        (148.0, 1.0, (507.0, 380.0), True),     # 正好对准
        (148.0, 1.0, (531.3, 341.7), True),     # 偏 (24, -38) px
        (150.5, -2.5, (462.8, 418.2), False),   # 关灯 (孔内暗) + 反向倾斜
        (120.0, 4.0, (570.4, 330.9), True),     # 孔距更小 + 倾斜 4°
    ],
)
def test_recovers_offset_pitch_and_angle(pitch, angle, origin, bright):
    img, a, b, o = render(pitch, angle, origin, bright)
    res = wellgrid.find_well_lattice(img)
    assert res["ok"] and res["reliable"], res
    err = np.array(res["offset"]) - truth_offset(a, b, o)
    assert np.hypot(*err) < 1.5, (res["offset"], truth_offset(a, b, o))
    assert abs(res["pitch_px"] - pitch) / pitch < 0.01
    assert abs(res["angle_deg"] - angle) < 0.3


def test_not_fooled_by_gaps_between_wells():
    """真孔位置必须明显胜过「四孔之间的空隙」(半格错位) 位置。"""
    img, a, b, o = render(148.0, 1.0, (531.3, 341.7))
    res = wellgrid.find_well_lattice(img)
    assert res["contrast"] > 3.0, res


def test_plate_edge_in_view():
    """画面里只有一半有孔 (到板边了):仍能找准网格。"""
    img, a, b, o = render(148.0, 1.0, (531.3, 341.7), keep=lambda i, j: i <= 0)
    res = wellgrid.find_well_lattice(img)
    assert res["ok"] and res["reliable"], res
    err = np.array(res["offset"]) - truth_offset(a, b, o)
    assert np.hypot(*err) < 1.5


def test_expected_pitch_from_calibration():
    img, a, b, o = render(148.0, 1.0, (531.3, 341.7))
    res = wellgrid.find_well_lattice(img, expected_pitch_px=148.0 * 1.08)
    assert res["reliable"]
    assert abs(res["pitch_px"] - 148.0) / 148.0 < 0.01


def test_texture_without_wells_is_not_reliable():
    rng = np.random.default_rng(1)
    img = np.full((H, W), 150, np.uint8)
    for _ in range(300):
        cv2.ellipse(img, (int(rng.uniform(0, W)), int(rng.uniform(0, H))),
                    (int(rng.uniform(5, 60)), int(rng.uniform(5, 40))), rng.uniform(0, 180),
                    0, 360, int(rng.uniform(0, 255)), -1)
    img = cv2.GaussianBlur(img, (0, 0), 1.5)
    res = wellgrid.find_well_lattice(cv2.cvtColor(img, cv2.COLOR_GRAY2BGR))
    assert not res.get("reliable"), res
