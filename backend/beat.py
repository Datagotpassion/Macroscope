"""跳动检测分析 (F16).

输入一段单孔的下采样灰度帧序列 (measure_motion 抓的),输出收缩频率。

思路:平均亮度对小 organoid 太弱 (被 ROI 里静止的培养基稀释),所以改用多个候选
信号,选周期性最强的那个:
  - PCA 前几个主成分:整段视频里「变化最大的空间模式」通常就是收缩本身,
    其时间投影是干净的 1×跳动信号 (对亮度不敏感,不被 ROI 大小稀释);
  - motion:相邻帧欧氏距离 (帧差能量) —— 一定能反映运动,但每个周期两次
    (收缩+舒张),频率会翻倍;
  - brightness:整帧平均亮度 (老方法,作兜底)。

对每个候选做去趋势 + 加窗 FFT,用「主峰能量占比」衡量周期性强弱,选最强的。
主峰占比 >= 阈值才判为「在跳」,避免把噪声硬报成频率。
"""

from __future__ import annotations

import numpy as np

FMIN = 0.4  # Hz (24 bpm)
FMAX = 5.0  # Hz (300 bpm)
PEAK_FRAC_BEATING = 0.30


def _spectral(times, sig):
    """对一维信号做去趋势 + FFT,返回主峰频率和能量占比。"""
    n = len(sig)
    if n < 32:
        return None
    t = np.asarray(times, dtype=float)
    s = np.asarray(sig, dtype=float)
    dur = float(t[-1] - t[0])
    if dur <= 0:
        return None
    # 线性去趋势
    x = t - t.mean()
    A = np.vstack([x, np.ones(n)]).T
    coef, *_ = np.linalg.lstsq(A, s, rcond=None)
    hp = s - A @ coef
    if not np.any(np.abs(hp) > 1e-9):
        return None
    sw = hp * np.hanning(n)
    freqs = np.fft.rfftfreq(n, d=dur / (n - 1))
    power = np.abs(np.fft.rfft(sw)) ** 2
    band = (freqs >= FMIN) & (freqs <= FMAX)
    if not band.any() or power[band].max() <= 0:
        return None
    bp = power[band]
    bf = freqs[band]
    bidx = int(np.argmax(bp))
    total = float(bp.sum() + 1e-12)
    lo, hi = max(0, bidx - 1), min(len(bp), bidx + 2)
    frac = float(bp[lo:hi].sum() / total)  # 主峰 ±1 bin 的能量占比
    return {"hz": float(bf[bidx]), "bpm": round(float(bf[bidx]) * 60, 1), "frac": frac, "hp": hp}


def analyze(times, frames) -> dict:
    n = len(times)
    out = {
        "ok": False,
        "beating": False,
        "n": n,
        "bpm": 0.0,
        "hz": 0.0,
        "confidence": 0.0,
        "snr": 0.0,
        "peak_bpm": 0.0,
        "fps": 0.0,
        "method": "",
        "times": [round(float(t), 3) for t in times],
        "signal": [],
    }
    frames = np.asarray(frames, dtype=np.float32)
    if n < 32 or frames.ndim != 3 or frames.shape[0] != n:
        out["reason"] = "too_few_frames"
        return out

    dur = float(times[-1] - times[0])
    fps = (n - 1) / dur if dur > 0 else 0.0
    out["fps"] = round(fps, 1)

    flat = frames.reshape(n, -1)
    centered = flat - flat.mean(axis=0, keepdims=True)  # 去每像素的时间均值

    candidates: dict[str, np.ndarray] = {}
    # PCA:Gram 矩阵 (n×n) 的前几个特征向量 = 时间主成分
    try:
        gram = centered @ centered.T
        evals, evecs = np.linalg.eigh(gram)
        for k in range(1, 4):
            if evecs.shape[1] - k >= 0 and evals[-k] > 0:
                candidates[f"pca{k}"] = evecs[:, -k]
    except Exception:  # noqa: BLE001
        pass
    # 帧差运动能量 (2× 频率,兜底)
    d = np.sqrt((np.diff(centered, axis=0) ** 2).sum(axis=1))
    candidates["motion"] = np.concatenate([[d[0] if len(d) else 0.0], d])
    # 平均亮度 (老方法,兜底)
    candidates["brightness"] = flat.mean(axis=1)

    # 选周期性最强 (主峰占比最高) 的候选
    best = None
    for name, sig in candidates.items():
        res = _spectral(times, sig)
        if res and (best is None or res["frac"] > best["frac"]):
            best = {**res, "name": name}

    if best is None:
        out["ok"] = True
        out["reason"] = "no_signal"
        return out

    hp = best["hp"]
    scale = np.percentile(np.abs(hp), 99) + 1e-9
    out.update(
        ok=True,
        beating=bool(best["frac"] >= PEAK_FRAC_BEATING),
        bpm=best["bpm"],
        hz=round(best["hz"], 3),
        confidence=round(min(1.0, best["frac"] / 0.5), 3),
        snr=round(best["frac"], 3),
        method=best["name"],
        peak_bpm=_peak_rate(hp, fps),
        signal=[round(float(v), 4) for v in (hp / scale)],
    )
    return out


def _peak_rate(sig, fps) -> float:
    """阈上行交叉计数 → 每分钟次数,作为 FFT 的旁证。"""
    sig = np.asarray(sig, dtype=float)
    if fps <= 0 or len(sig) < 4:
        return 0.0
    thr = sig.mean() + 0.5 * sig.std()
    above = sig > thr
    crossings = int(np.sum((~above[:-1]) & (above[1:])))
    dur = len(sig) / fps
    return round(crossings / dur * 60, 1) if dur > 0 else 0.0
