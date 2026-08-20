"""自动对焦 (被动对焦:Z 小步扫描 + 清晰度峰值).

原理:焦点处图像高频细节最多,清晰度最高。沿 Z 小步 (~0.1mm) 扫描,每步拍
一帧算「清晰度」(Laplacian 方差),曲线峰值对应的 Z 即为焦点。

安全:相机在下、板在 Z 上;扫描用 G1 绝对移动,受 printer.cfg 的
position_min/max 限制,不会把板撞进镜头。编排 (移动/拍照) 在 main.py 的
endpoint 里,本模块只放纯函数,方便单测。
"""

from __future__ import annotations

import cv2
import numpy as np


def sharpness(gray: np.ndarray) -> float:
    """清晰度指标:Laplacian 方差。越大 = 高频细节越多 = 越清晰。"""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def to_gray(
    bgr: np.ndarray,
    cx: float | None = None,
    cy: float | None = None,
    r: float | None = None,
) -> np.ndarray:
    """转灰度;给了归一化 ROI (cx,cy,r) 就只裁该方块区域评估 (只对某个孔对焦)。"""
    img = bgr
    if cx is not None and cy is not None and r is not None:
        h, w = bgr.shape[:2]
        pr = max(8, int(r * w))
        px, py = int(cx * w), int(cy * h)
        x1, y1 = max(0, px - pr), max(0, py - pr)
        x2, y2 = min(w, px + pr), min(h, py + pr)
        if x2 > x1 and y2 > y1:
            img = bgr[y1:y2, x1:x2]
    if img.ndim == 3:
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img


def sweep_positions(z0: float, z_range: float, step: float,
                    lo_limit: float | None, hi_limit: float | None) -> list[float]:
    """以 z0 为中心生成 ±z_range 的 Z 扫描点 (步长 step),夹到轴限位内。"""
    step = max(0.01, abs(step))
    lo = z0 - abs(z_range)
    hi = z0 + abs(z_range)
    if lo_limit is not None:
        lo = max(lo, float(lo_limit))
    if hi_limit is not None:
        hi = min(hi, float(hi_limit))
    n = int(round((hi - lo) / step)) + 1
    zs = [round(lo + i * step, 4) for i in range(max(1, n))]
    return [z for z in zs if z <= hi + 1e-6]


def best_z(curve: list[dict]) -> dict | None:
    """从 [{z, sharp}] 里取清晰度最高的点。"""
    if not curve:
        return None
    return max(curve, key=lambda c: c["sharp"])
