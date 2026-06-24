"""跳动检测分析 (F16).

输入一段单孔的时序信号 (每帧的平均亮度,随收缩起伏),输出主频 = 跳动频率。
方法:去趋势 + 加窗 + FFT 找生理频段 (0.2-5 Hz) 内的主峰;再用过零计数交叉验证。

注意:用「平均亮度」而不是「帧差」作为频率信号 —— 帧差能量每个收缩周期会出现
两次 (收缩 + 舒张),频率会翻倍;亮度信号每周期一次,频率更准。帧差强度单独
作为「是否在动」的幅度指标。
"""

from __future__ import annotations

import numpy as np

FMIN = 0.2  # Hz (12 bpm)
FMAX = 5.0  # Hz (300 bpm)


def analyze(times, signal, motion=0.0) -> dict:
    n = len(signal)
    out = {
        "ok": False,
        "n": n,
        "times": [round(float(t), 3) for t in times],
        "signal": [round(float(s), 4) for s in signal],
        "motion": round(float(motion), 4),
        "bpm": 0.0,
        "hz": 0.0,
        "confidence": 0.0,
        "peak_bpm": 0.0,
        "fps": 0.0,
    }
    if n < 16:
        out["reason"] = "too_few_frames"
        return out

    t = np.asarray(times, dtype=float)
    s = np.asarray(signal, dtype=float)
    dur = float(t[-1] - t[0])
    if dur <= 0:
        out["reason"] = "no_timing"
        return out
    fps = (n - 1) / dur
    out["fps"] = round(fps, 1)
    out["duration"] = round(dur, 1)

    # 均匀重采样到 n 点,去趋势 + 汉宁窗
    uni_t = np.linspace(t[0], t[-1], n)
    su = np.interp(uni_t, t, s)
    su = su - su.mean()
    if np.allclose(su, 0):
        out["reason"] = "flat_signal"
        return out
    sw = su * np.hanning(n)

    freqs = np.fft.rfftfreq(n, d=dur / (n - 1))
    power = np.abs(np.fft.rfft(sw)) ** 2
    band = (freqs >= FMIN) & (freqs <= FMAX)
    if band.any() and power[band].max() > 0:
        bidx = int(np.argmax(power[band]))
        pf = float(freqs[band][bidx])
        conf = float(power[band][bidx] / (power[band].sum() + 1e-12))
        out.update(
            ok=True,
            hz=round(pf, 3),
            bpm=round(pf * 60, 1),
            confidence=round(conf, 3),
        )

    # 过零/峰值计数交叉验证
    out["peak_bpm"] = _peak_rate(su, fps)
    return out


def _peak_rate(sig, fps) -> float:
    """阈上行交叉计数 → 估计每分钟次数,作为 FFT 的旁证。"""
    if fps <= 0 or len(sig) < 4:
        return 0.0
    thr = sig.mean() + 0.5 * sig.std()
    above = sig > thr
    crossings = int(np.sum((~above[:-1]) & (above[1:])))
    dur = len(sig) / fps
    return round(crossings / dur * 60, 1) if dur > 0 else 0.0
