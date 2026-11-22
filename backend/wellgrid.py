"""局部孔阵识别:在一帧 (只拍到板子一部分) 里找出孔的规则网格。

相机一帧只覆盖板子的一部分 (96 孔板约 7×5 个孔),plate_detector 那种「整板
8×12 拟合」用不上。这里只回答自动对准需要的问题:
  - 网格的两个基向量 a、b (像素):孔距 + 网格方向;
  - 离画面中心最近的那个孔的中心 → 它偏离画面中心多少像素。

做法 (两步,都是「全体孔一起投票」,个别孔里有杂物/反光不影响):
  1. 孔距和方向:高通后的图像自相关。规则孔阵在自相关里给出 ±a、±b 的峰。
  2. 网格位置:孔壁上每个边缘点沿自己的梯度方向,在「孔半径」距离处给圆心投票
     (梯度 Hough)。真孔整圈孔壁的票都投到同一个圆心;四孔之间的空隙虽然看着
     也像个圆 (单看圆检测会把它当成圆),但围住它的弧线属于四个不同的孔,票投到
     各自的孔心去了。再把所有格点的票数按网格折叠求和,找出整张网格最吻合的位置。

孔是周期重复的,所以结果只确定「到最近一个孔」—— 认出是哪个孔要靠记住的
位置 (偏差必须小于半个孔距),这由调用方保证。本模块只放纯函数,方便单测。
"""

from __future__ import annotations

import math

import cv2
import numpy as np

# 工作分辨率宽度:预览帧 (1014 宽) 缩到这个宽度再算,Pi 3B 上也够快;
# 网格位置最后做亚像素细化,精度不受影响。
WORK_WIDTH = 640

# 投票半径 / 孔距。孔壁在画面里是半径约 0.36–0.46 倍孔距的同心圆
# (孔口和孔底因透视大小不同),投票半径一起覆盖。
RING_INNER = 0.32
RING_OUTER = 0.48
VOTE_RADII = 8          # 在 [RING_INNER, RING_OUTER] 里取几个半径投票
EDGE_PERCENTILE = 75    # 只让梯度最强的 25% 像素投票 (孔壁),压掉平坦区和噪声

# 「可靠」门槛:真孔位置要明显胜过半格错位 (空隙) 位置,且有足够多的孔参与投票。
# 真实板子 (开灯/关灯) 实测 contrast 5–8;随机纹理约 1–1.5。
MIN_CONTRAST = 2.0
MIN_WELLS = 6
MIN_PERIODICITY = 0.15

# 格点上「有孔」的门槛:该点票数 / 画面里典型孔的票数。板边外、板子外的格点
# 没有整圈孔壁,票数很低 (实测 ≤0.16);真孔因透视差异大 (实测 0.36–1.8)。
# 单点只供显示;判断板边要看整排/整列的中位数 (见 platefind)。
PRESENT_MIN = 0.3


def _gray(img: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return g.astype(np.float32)


def lattice_vectors(
    gray: np.ndarray, expected: float | None = None
) -> tuple[np.ndarray, np.ndarray, float] | None:
    """从高通图像的自相关里取网格基向量 a、b (像素) 和周期性强度 (0..1)。

    expected:预期孔距 (像素)。给了就只在 ±15% 里找,并选最接近它的周期 ——
    孔底的手写记号、板架边缘等竖条纹也会在自相关里出峰 (实测 71/109 px 对 150 px
    的真孔距),「选最短的强峰」会被它们骗。没给时在 0.06–0.6 倍图宽里选最短的强峰。
    a 取更「横」的那个且朝 +x,b 和 a 近似垂直且朝 +y。找不到返回 None。
    """
    pitch_range = (0.85 * expected, 1.15 * expected) if expected else None
    h, w = gray.shape
    hp = gray - cv2.GaussianBlur(gray, (0, 0), max(4.0, w / 40))  # 去照明梯度
    hp = cv2.GaussianBlur(hp, (0, 0), 1.0)
    hp -= hp.mean()
    f = np.fft.rfft2(hp)
    ac = np.fft.fftshift(np.fft.irfft2(f * np.conj(f), s=hp.shape)).astype(np.float32)
    ac /= max(float(ac.max()), 1e-9)
    cy, cx = h // 2, w // 2

    lo, hi = pitch_range if pitch_range else (0.06 * w, 0.6 * w)
    k = max(3, int(lo * 0.3) | 1)
    peaks = (ac == cv2.dilate(ac, np.ones((k, k), np.uint8))) & (ac > 0.05)
    cand = []
    for y, x in np.argwhere(peaks):
        dx, dy = float(x - cx), float(y - cy)
        d = math.hypot(dx, dy)
        if lo <= d <= hi:
            # 亚像素:3 点抛物线拟合
            def sub(v0, v1, v2):
                den = v0 - 2 * v1 + v2
                return 0.0 if abs(den) < 1e-9 else 0.5 * (v0 - v2) / den

            if 0 < x < w - 1 and 0 < y < h - 1:
                dx += sub(ac[y, x - 1], ac[y, x], ac[y, x + 1])
                dy += sub(ac[y - 1, x], ac[y, x], ac[y + 1, x])
            cand.append((float(ac[y, x]), np.array([dx, dy])))
    if not cand:
        return None
    cand.sort(key=lambda c: -c[0])
    top = cand[0][0]
    strong = [c for c in cand if c[0] >= 0.6 * top]
    if expected:
        # 第一个基向量:强峰里最接近预期孔距的
        a = min(strong, key=lambda c: abs(np.linalg.norm(c[1]) - expected))[1]
    else:
        # 第一个基向量:强峰里最短的 (避免把 2a 当成 a)
        a = min(strong, key=lambda c: np.linalg.norm(c[1]))[1]
    # 第二个:和 a 夹角 60°–120° 的最强峰
    b = None
    for s, v in cand:
        cosang = abs(float(np.dot(a, v))) / (np.linalg.norm(a) * np.linalg.norm(v))
        if cosang < 0.5:
            b = v
            break
    if b is None:
        return None
    # 规范方向:a 更横 (|ax| ≥ |bx|),a 朝 +x,b 朝 +y
    if abs(b[0]) > abs(a[0]):
        a, b = b, a
    if a[0] < 0:
        a = -a
    if b[1] < 0:
        b = -b
    return a, b, float(top)


def _center_votes(gray: np.ndarray, pitch: float) -> np.ndarray:
    """梯度 Hough:每个强边缘点沿 ±梯度方向、在孔半径距离处给圆心投票。"""
    h, w = gray.shape
    gb = cv2.GaussianBlur(gray, (0, 0), 1.2)
    gx = cv2.Sobel(gb, cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(gb, cv2.CV_32F, 0, 1)
    mag = cv2.magnitude(gx, gy)
    ys, xs = np.nonzero(mag > np.percentile(mag, EDGE_PERCENTILE))
    m = mag[ys, xs]
    ux, uy = gx[ys, xs] / m, gy[ys, xs] / m
    wgt = np.sqrt(m)  # 强边缘多投一点,但不让个别高反光点主导
    acc = np.zeros(h * w, np.float64)
    for r in np.linspace(RING_INNER * pitch, RING_OUTER * pitch, VOTE_RADII):
        for sgn in (1.0, -1.0):  # 孔壁可能比孔内亮也可能更暗,两个方向都投
            vx = np.rint(xs + sgn * r * ux).astype(np.int64)
            vy = np.rint(ys + sgn * r * uy).astype(np.int64)
            ok = (vx >= 0) & (vx < w) & (vy >= 0) & (vy < h)
            acc += np.bincount(vy[ok] * w + vx[ok], weights=wgt[ok], minlength=h * w)
    acc = acc.reshape(h, w).astype(np.float32)
    return cv2.GaussianBlur(acc, (0, 0), max(1.5, 0.03 * pitch))


def _lattice_points(origin, a, b, w, h, margin):
    """覆盖整幅 (w×h) 的所有格点 origin + i·a + j·b,只留离边缘 ≥ margin 的。"""
    B = np.column_stack([a, b])
    inv = np.linalg.inv(B)
    corners = np.array([[0, 0], [w, 0], [0, h], [w, h]], float) - origin
    ij = corners @ inv.T
    i0, j0 = np.floor(ij.min(0)).astype(int) - 1
    i1, j1 = np.ceil(ij.max(0)).astype(int) + 1
    ii, jj = np.mgrid[i0 : i1 + 1, j0 : j1 + 1]
    ij = np.column_stack([ii.ravel(), jj.ravel()]).astype(float)
    pts = origin + ij @ B.T
    keep = (
        (pts[:, 0] >= margin)
        & (pts[:, 0] <= w - 1 - margin)
        & (pts[:, 1] >= margin)
        & (pts[:, 1] <= h - 1 - margin)
    )
    return pts[keep], ij[keep]


def find_well_lattice(
    image: np.ndarray,
    expected_pitch_px: float | None = None,
    work_width: int = WORK_WIDTH,
) -> dict:
    """在一帧里找孔阵。坐标全部是输入图的像素坐标。

    expected_pitch_px:已知的孔距 (像素) → 只在 ±15% 里找最接近的周期,更不容易认错。
    最好用同一块板上刚测到的孔距,而不是「标准孔距 × 标定比例」(后者有几 % 误差)。
    返回 dict:ok / reason,a、b (基向量), pitch_px, angle_deg (a 相对图像 x 轴),
    nearest (离画面中心最近的孔中心), offset (nearest − 画面中心), n (参与投票的格点数),
    periodicity (自相关峰强 0..1), contrast (真孔位置 vs 半格错位位置的响应比, >1 越大越可靠),
    reliable (三项指标都过门槛;自动对准只应使用 reliable 的结果)。
    """
    H, W = image.shape[:2]
    s = min(1.0, work_width / W)
    small = cv2.resize(image, (int(round(W * s)), int(round(H * s))), interpolation=cv2.INTER_AREA) if s < 1 else image
    g = _gray(small)
    h, w = g.shape

    lv = lattice_vectors(g, expected_pitch_px * s if expected_pitch_px else None)
    if lv is None:
        return {"ok": False, "reason": "no periodic well pattern in view"}
    a, b, periodicity = lv
    pitch = float((np.linalg.norm(a) + np.linalg.norm(b)) / 2)

    votes = _center_votes(g, pitch)

    # 折叠:在一个网格单元里扫描相位 (u,v),对画面内所有格点的票数取平均。
    # 一次 remap 采完所有相位 × 所有格点 (Pi 3B 上也快)。
    B = np.column_stack([a, b])
    base = np.array([w / 2.0, h / 2.0])
    steps = max(16, int(pitch / 1.5))
    _, ij = _lattice_points(base, a, b, w, h, -2 * pitch)  # 覆盖全图 + 一个单元余量
    uu, vv = np.meshgrid(np.arange(steps) / steps, np.arange(steps) / steps, indexing="ij")
    phase = np.column_stack([uu.ravel(), vv.ravel()]) @ B.T      # (M,2)
    allp = (base + ij @ B.T)[None, :, :] + phase[:, None, :]      # (M,N,2)
    margin = 0.5 * pitch
    inside = (
        (allp[..., 0] >= margin) & (allp[..., 0] <= w - 1 - margin)
        & (allp[..., 1] >= margin) & (allp[..., 1] <= h - 1 - margin)
    )
    vals = cv2.remap(
        votes, allp[..., 0].astype(np.float32), allp[..., 1].astype(np.float32),
        cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0,
    )
    cnt = inside.sum(1)
    if cnt.max() == 0:
        return {"ok": False, "reason": "view too small for the lattice"}
    scores = (np.where(inside, vals, 0).sum(1) / np.maximum(cnt, 1)).reshape(steps, steps)

    # 亚像素细化:在折叠分数图上对峰值做抛物线拟合 (周期边界)
    u0, v0 = np.unravel_index(int(np.argmax(scores)), scores.shape)
    n = int(cnt[u0 * steps + v0])

    def par(m1, c0, p1):
        den = m1 - 2 * c0 + p1
        return 0.0 if abs(den) < 1e-12 else 0.5 * (m1 - p1) / den

    du = par(scores[(u0 - 1) % steps, v0], scores[u0, v0], scores[(u0 + 1) % steps, v0])
    dv = par(scores[u0, (v0 - 1) % steps], scores[u0, v0], scores[u0, (v0 + 1) % steps])
    origin = base + ((u0 + du) / steps) * a + ((v0 + dv) / steps) * b

    # 可靠性:真孔位置 vs 半格错位 (四孔之间的空隙) 的响应比
    half = scores[(u0 + steps // 2) % steps, (v0 + steps // 2) % steps]
    contrast = float(scores[u0, v0] / max(float(half), 1e-9))

    # 离画面中心最近的孔
    ij = np.round(np.linalg.solve(B, base - origin))
    nearest = origin + B @ ij

    inv = 1.0 / s

    # 每个格点上有没有孔 (找板边/板角用):该点附近的最高票数 ÷ 画面里典型孔的票数。
    # 只评估整个孔都在画面里的格点 —— 被画面边缘切掉一半的孔票数天然偏低。
    rmax = max(1, int(round(0.15 * pitch)))  # 离画面中心远的孔因透视,票数峰会偏开一点
    vmax = cv2.dilate(votes, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rmax + 1,) * 2))
    pts, pij = _lattice_points(nearest, a, b, w, h, 0.5 * pitch)
    wells = []
    if len(pts):
        pv = cv2.remap(vmax, pts[:, 0].astype(np.float32).reshape(1, -1),
                       pts[:, 1].astype(np.float32).reshape(1, -1), cv2.INTER_LINEAR)[0]
        ref = float(np.median(np.sort(pv)[-max(1, len(pv) // 3):])) or 1.0
        for (x, y), (i, j), v in zip(pts, pij, pv):
            sc = float(v) / ref
            wells.append({"ij": [int(i), int(j)], "xy": [float(x * inv), float(y * inv)],
                          "score": round(sc, 3), "present": sc >= PRESENT_MIN})
    a_o, b_o = a * inv, b * inv
    nearest_o = nearest * inv
    center_o = np.array([W / 2.0, H / 2.0])
    return {
        "ok": True,
        "a": [float(a_o[0]), float(a_o[1])],
        "b": [float(b_o[0]), float(b_o[1])],
        "pitch_px": pitch * inv,
        "angle_deg": math.degrees(math.atan2(a_o[1], a_o[0])),
        "nearest": [float(nearest_o[0]), float(nearest_o[1])],
        "offset": [float(nearest_o[0] - center_o[0]), float(nearest_o[1] - center_o[1])],
        "n": int(n),
        "periodicity": round(periodicity, 3),
        "contrast": round(contrast, 3),
        "reliable": bool(
            contrast >= MIN_CONTRAST and n >= MIN_WELLS and periodicity >= MIN_PERIODICITY
        ),
        # 格点 (ij 以离中心最近的孔为 [0,0],单位是基向量 a、b) 和它上面有没有孔
        "wells": wells,
    }


def draw_overlay(image: np.ndarray, res: dict) -> np.ndarray:
    """调试图:画出识别到的格点、最近的孔和画面中心。"""
    out = image.copy()
    H, W = out.shape[:2]
    cx, cy = W // 2, H // 2
    cv2.drawMarker(out, (cx, cy), (0, 255, 255), cv2.MARKER_CROSS, 40, 2)
    if not res.get("ok"):
        cv2.putText(out, res.get("reason", "fail"), (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
        return out
    a, b = np.array(res["a"]), np.array(res["b"])
    o = np.array(res["nearest"])
    r = int(0.42 * res["pitch_px"])
    pts, _ = _lattice_points(o, a, b, W, H, -r)
    for x, y in pts:
        cv2.circle(out, (int(round(x)), int(round(y))), r, (0, 200, 0), 2)
    cv2.circle(out, (int(round(o[0])), int(round(o[1]))), r, (0, 0, 255), 3)
    cv2.line(out, (cx, cy), (int(round(o[0])), int(round(o[1]))), (0, 0, 255), 2)
    txt = f"pitch {res['pitch_px']:.1f}px  angle {res['angle_deg']:.2f}deg  offset ({res['offset'][0]:.1f},{res['offset'][1]:.1f})px  contrast {res['contrast']:.2f}"
    cv2.putText(out, txt, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 4)
    cv2.putText(out, txt, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 1)
    return out
