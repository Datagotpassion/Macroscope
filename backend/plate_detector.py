"""96 孔自动检测 + 标注 (F3, F8) + 单孔裁剪 (F4).

相比初版需求文档,这里修复了两个问题:

1. 原 `_find_breaks` 返回的是索引而不是圆坐标,`_assign_labels` 解包
   `(cx, cy, r)` 会直接崩溃。现在用基于已知行数的聚类正确分行/分列。

2. 纯 Hough 检测在边缘孔、空孔、反光时经常少检/误检,很难稳定得到 96 个。
   这里用 Hough 的结果去 *拟合* 标准板几何 (ANSI/SLAS 9mm pitch),
   再按规则网格回填所有 96 个孔。即使只检测到一部分孔,也能输出完整网格。
"""

from __future__ import annotations

import cv2
import numpy as np

ROW_LABELS = "ABCDEFGH"


class PlateDetector:
    """检测 96 孔板的所有孔位。"""

    # 标准 96 孔板几何 (ANSI/SLAS)
    ROWS = 8       # A-H
    COLS = 12      # 1-12
    PITCH = 9.0    # mm 孔间距
    WELL_D = 6.4   # mm 孔径

    # 检测用的工作分辨率宽度。HoughCircles 在 12MP 全图上要几十秒,
    # 而孔是大特征,缩小到约 1200px 检测再把坐标放大回去,快几十倍且精度足够。
    DETECT_WIDTH = 1200

    def detect_wells(self, image: np.ndarray) -> list[dict]:
        """输入全板 BGR 图像,输出 96 个孔 (坐标在原图分辨率下)。

        返回: [{"label": "A1", "cx", "cy", "r", "detected": bool}, ...]
        `detected=True` 表示该孔由 Hough 直接检测到,False 表示由网格几何推算补全。
        """
        H, W = image.shape[:2]

        # 下采样到工作分辨率再检测
        if W > self.DETECT_WIDTH:
            scale = self.DETECT_WIDTH / W
            small = cv2.resize(
                image,
                (self.DETECT_WIDTH, max(1, int(round(H * scale)))),
                interpolation=cv2.INTER_AREA,
            )
        else:
            scale = 1.0
            small = image

        sh, sw = small.shape[:2]
        circles = self._hough_circles(small)

        wells = None
        if len(circles) >= 4:
            wells = self._fit_grid(circles, image_shape=(sh, sw))
        if wells is None:
            # 兜底:完全基于图像尺寸的理想网格 (Hough 全失败时仍返回 96 孔)
            wells = self._ideal_grid(sw, sh)

        # 把检测坐标从工作分辨率映射回原图分辨率
        if scale != 1.0:
            inv = 1.0 / scale
            for wd in wells:
                wd["cx"] = int(round(wd["cx"] * inv))
                wd["cy"] = int(round(wd["cy"] * inv))
                wd["r"] = int(round(wd["r"] * inv))
        return wells

    # ── Hough 圆检测 ──

    def _hough_circles(self, image: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (7, 7), 1.5)
        h, w = gray.shape

        circles = cv2.HoughCircles(
            blur,
            cv2.HOUGH_GRADIENT,
            dp=1.2,
            minDist=int(min(w, h) / 16),
            param1=60,
            param2=28,
            minRadius=int(min(w, h) / 30),
            maxRadius=int(min(w, h) / 12),
        )
        if circles is None:
            return np.empty((0, 3), dtype=float)

        circles = circles[0]
        # 过滤半径异常的误检
        radii = circles[:, 2]
        med_r = np.median(radii)
        keep = np.abs(radii - med_r) < med_r * 0.35
        return circles[keep]

    # ── 网格拟合 (核心修复) ──

    def _fit_grid(
        self, circles: np.ndarray, image_shape: tuple[int, int]
    ) -> list[dict] | None:
        """把检测到的圆聚类到行/列,估出网格参数,再回填完整 8x12 网格。"""
        xs = circles[:, 0]
        ys = circles[:, 1]

        col_centers = self._cluster_1d(xs, self.COLS)
        row_centers = self._cluster_1d(ys, self.ROWS)
        if col_centers is None or row_centers is None:
            return None

        # 用线性回归把 "簇序号 -> 像素坐标" 拟合成等距网格,
        # 这样缺失的行/列也能用 pitch 外推出来。
        col_origin, col_pitch = self._fit_line(col_centers)
        row_origin, row_pitch = self._fit_line(row_centers)

        med_r = float(np.median(circles[:, 2]))

        # 建一个快速查找:把每个检测圆归到最近的 (row, col)
        detected: dict[tuple[int, int], tuple[float, float, float]] = {}
        for cx, cy, r in circles:
            col = int(round((cx - col_origin) / col_pitch))
            row = int(round((cy - row_origin) / row_pitch))
            if 0 <= row < self.ROWS and 0 <= col < self.COLS:
                detected[(row, col)] = (cx, cy, r)

        h, w = image_shape
        wells: list[dict] = []
        for row in range(self.ROWS):
            for col in range(self.COLS):
                if (row, col) in detected:
                    cx, cy, r = detected[(row, col)]
                    is_det = True
                else:
                    cx = col_origin + col * col_pitch
                    cy = row_origin + row * row_pitch
                    r = med_r
                    is_det = False
                # 钳制到图像范围内
                cx = float(np.clip(cx, 0, w - 1))
                cy = float(np.clip(cy, 0, h - 1))
                wells.append(
                    {
                        "label": f"{ROW_LABELS[row]}{col + 1}",
                        "cx": int(round(cx)),
                        "cy": int(round(cy)),
                        "r": int(round(r)),
                        "detected": is_det,
                    }
                )
        return wells

    @staticmethod
    def _cluster_1d(values: np.ndarray, n_groups: int) -> list[float] | None:
        """把一维坐标按最大间隙切成 n_groups 组,返回各组中心 (已排序)。

        如果检测到的不同坐标值少于 n_groups,允许返回少于 n_groups 个簇 —
        `_fit_line` 会用线性回归补全。
        """
        if len(values) == 0:
            return None
        sv = np.sort(values)
        if len(sv) == 1:
            return [float(sv[0])]

        gaps = np.diff(sv)
        # 期望的簇数最多 n_groups,因此最多 n_groups-1 个分界
        n_breaks = min(n_groups - 1, len(gaps))
        if n_breaks <= 0:
            return [float(np.mean(sv))]

        # 取最大的 n_breaks 个间隙作为分界点
        break_idx = np.sort(np.argsort(gaps)[-n_breaks:])
        centers: list[float] = []
        start = 0
        for bi in break_idx:
            centers.append(float(np.mean(sv[start : bi + 1])))
            start = bi + 1
        centers.append(float(np.mean(sv[start:])))
        return centers

    @staticmethod
    def _fit_line(centers: list[float]) -> tuple[float, float]:
        """把簇中心拟合成等距网格,返回 (origin, pitch)。

        簇中心已排序,索引 0..k-1。用最小二乘拟合 center = origin + idx*pitch。
        """
        k = len(centers)
        if k == 1:
            # 只有一簇,无法估 pitch,退化处理
            return centers[0], 1.0
        idx = np.arange(k, dtype=float)
        c = np.array(centers, dtype=float)
        pitch, origin = np.polyfit(idx, c, 1)  # 斜率=pitch, 截距=origin
        if pitch == 0:
            pitch = 1.0
        return float(origin), float(pitch)

    def _ideal_grid(self, w: int, h: int) -> list[dict]:
        """完全没有检测信号时,按图像尺寸均匀铺一个理想网格。"""
        margin_x = w * 0.06
        margin_y = h * 0.08
        pitch_x = (w - 2 * margin_x) / (self.COLS - 1)
        pitch_y = (h - 2 * margin_y) / (self.ROWS - 1)
        r = int(min(pitch_x, pitch_y) * 0.42)
        wells = []
        for row in range(self.ROWS):
            for col in range(self.COLS):
                wells.append(
                    {
                        "label": f"{ROW_LABELS[row]}{col + 1}",
                        "cx": int(margin_x + col * pitch_x),
                        "cy": int(margin_y + row * pitch_y),
                        "r": r,
                        "detected": False,
                    }
                )
        return wells

    # ── 单孔裁剪 (F4) ──

    def crop_well(
        self, image: np.ndarray, well: dict, padding: float = 1.2
    ) -> np.ndarray:
        """裁剪单孔图像,带一点 padding。"""
        cx, cy, r = well["cx"], well["cy"], well["r"]
        pr = max(1, int(r * padding))
        h, w = image.shape[:2]
        x1 = max(0, cx - pr)
        y1 = max(0, cy - pr)
        x2 = min(w, cx + pr)
        y2 = min(h, cy + pr)
        return image[y1:y2, x1:x2]

    # ── 标注叠加 (F8) ──

    def annotate(self, image: np.ndarray, wells: list[dict]) -> np.ndarray:
        """在全板图上画出孔圈和标签,返回带标注的副本。"""
        out = image.copy()
        for w in wells:
            color = (0, 200, 0) if w.get("detected", True) else (0, 165, 255)
            cv2.circle(out, (w["cx"], w["cy"]), w["r"], color, 2, cv2.LINE_AA)
            cv2.putText(
                out,
                w["label"],
                (w["cx"] - w["r"], w["cy"] - w["r"] - 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                color,
                1,
                cv2.LINE_AA,
            )
        return out
