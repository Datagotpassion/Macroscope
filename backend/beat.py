"""跳动检测分析 (F16).

输入一段单孔的时序信号 (每帧平均亮度,随收缩起伏),输出主频 = 跳动频率。
流程:
  1. 均匀重采样;
  2. 高通去趋势 (减去滑动均值) —— 去掉慢漂移/残留曝光阶跃,只留下跳动那种快起伏;
  3. 加窗 FFT,在生理频段 (0.4-5 Hz) 找主峰;
  4. 用「主峰功率 / 频段噪声中位数」= 谱信噪比 (SNR) 判断是否真的在跳 ——
     平坦/噪声信号 SNR 接近 1,会被判为「没在跳」,而不是硬报一个假频率。

用平均亮度 (每周期一次) 而不是帧差 (每周期两次) 作频率信号,避免频率翻倍。
"""

from __future__ import annotations

import numpy as np

FMIN = 0.4  # Hz (24 bpm) —— 心肌类 organoid 跳动一般 >30 bpm
FMAX = 5.0  # Hz (300 bpm)
# 主峰 (±1 bin) 占整个频段能量的比例阈值。真正的周期跳动能量集中在一个峰上;
# 白噪声/平坦信号能量摊在几十个 bin 上,峰占比很低 —— 用占比而不是 SNR,
# 因为噪声的「峰/中位数」可以虚高。
PEAK_FRAC_BEATING = 0.35


def analyze(times, signal, motion=0.0) -> dict:
    n = len(signal)
    out = {
        "ok": False,
        "beating": False,
        "n": n,
        "times": [round(float(t), 3) for t in times],
        "signal": [round(float(s), 4) for s in signal],
        "motion": round(float(motion), 4),
        "bpm": 0.0,
        "hz": 0.0,
        "confidence": 0.0,
        "snr": 0.0,
        "peak_bpm": 0.0,
        "fps": 0.0,
    }
    if n < 32:
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

    # 均匀重采样
    uni_t = np.linspace(t[0], t[-1], n)
    su = np.interp(uni_t, t, s)

    # 去线性趋势 (去掉整体漂移)。曝光已在相机端锁定,不需要会塑形频谱的滑动均值高通。
    x = uni_t - uni_t.mean()
    A = np.vstack([x, np.ones(n)]).T
    coef, *_ = np.linalg.lstsq(A, su, rcond=None)
    hp = su - A @ coef
    if not np.any(np.abs(hp) > 1e-6):
        out["ok"] = True
        out["reason"] = "flat_signal"
        return out

    sw = hp * np.hanning(n)
    freqs = np.fft.rfftfreq(n, d=dur / (n - 1))
    power = np.abs(np.fft.rfft(sw)) ** 2
    band = (freqs >= FMIN) & (freqs <= FMAX)
    if not band.any() or power[band].max() <= 0:
        out["ok"] = True
        return out

    bp = power[band]
    bf = freqs[band]
    bidx = int(np.argmax(bp))
    pf = float(bf[bidx])
    total = float(bp.sum() + 1e-12)
    lo, hi = max(0, bidx - 1), min(len(bp), bidx + 2)
    peak_frac = float(bp[lo:hi].sum() / total)  # 主峰能量占比

    out.update(
        ok=True,
        beating=bool(peak_frac >= PEAK_FRAC_BEATING),
        hz=round(pf, 3),
        bpm=round(pf * 60, 1),
        snr=round(peak_frac, 3),  # 对外仍叫 snr 字段,值为峰能量占比
        confidence=round(min(1.0, peak_frac / 0.5), 3),
        peak_bpm=_peak_rate(hp, fps),
    )
    return out


def _peak_rate(sig, fps) -> float:
    """阈上行交叉计数 → 每分钟次数,作为 FFT 的旁证。"""
    if fps <= 0 or len(sig) < 4:
        return 0.0
    thr = sig.mean() + 0.5 * sig.std()
    above = sig > thr
    crossings = int(np.sum((~above[:-1]) & (above[1:])))
    dur = len(sig) / fps
    return round(crossings / dur * 60, 1) if dur > 0 else 0.0
