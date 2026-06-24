import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { detectBeat } from "./api";
import { useI18n } from "./i18n.jsx";

const DURATION = 8; // 秒

// 跳动检测 (F16):抓一段高帧率序列,分析单孔收缩频率,画出波形。
export default function BeatDetect({ well }) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState("idle"); // idle|measuring|done|error
  const [result, setResult] = React.useState(null);
  const [err, setErr] = React.useState("");

  const run = async () => {
    setStatus("measuring");
    setResult(null);
    setErr("");
    try {
      const r = await detectBeat(well.x, well.y, well.r, DURATION);
      setResult(r);
      setStatus("done");
    } catch (e) {
      setErr(e.message || String(e));
      setStatus("error");
    }
  };

  const data = result
    ? result.times.map((tt, i) => ({ t: +tt.toFixed(2), v: result.signal[i] }))
    : [];
  // 判定「在跳」:有足够运动 + FFT 主峰够突出
  const beating =
    result && result.ok && result.confidence >= 0.15 && result.motion >= 0.3;

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 p-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">
          {t("beatTitle")} · {well.label}
        </h3>
        <button
          onClick={run}
          disabled={status === "measuring"}
          className="rounded bg-purple-600 px-3 py-1 text-sm hover:bg-purple-500 disabled:opacity-50"
        >
          {status === "measuring" ? t("beatMeasuring") : t("beatRun")}
        </button>
      </div>

      {status === "measuring" && (
        <div className="text-sm text-slate-400">{t("beatMeasuringNote", DURATION)}</div>
      )}
      {status === "error" && (
        <div className="text-sm text-red-400">{t("beatFailed", err)}</div>
      )}

      {result && status === "done" && (
        <>
          <div className="flex flex-wrap items-baseline gap-4">
            {beating ? (
              <>
                <span className="text-2xl font-bold text-purple-300">
                  {result.bpm}
                  <span className="ml-1 text-sm font-normal text-slate-400">BPM</span>
                </span>
                <span className="text-sm text-slate-400">
                  {t("beatConfidence")}: {(result.confidence * 100).toFixed(0)}%
                </span>
                <span className="text-sm text-slate-400">
                  {t("beatCrosscheck")}: {result.peak_bpm}
                </span>
              </>
            ) : (
              <span className="text-sm text-orange-300">{t("beatNone")}</span>
            )}
            <span className="text-xs text-slate-500">
              {result.n} frames @ {result.fps} fps
            </span>
          </div>
          <div className="h-32 w-full">
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: -25 }}>
                <XAxis
                  dataKey="t"
                  tick={{ fontSize: 10, fill: "#94a3b8" }}
                  unit="s"
                  minTickGap={30}
                />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #334155" }}
                  labelStyle={{ color: "#94a3b8" }}
                />
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke="#c084fc"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs text-slate-500">{t("beatWaveformHint")}</div>
        </>
      )}
    </div>
  );
}
