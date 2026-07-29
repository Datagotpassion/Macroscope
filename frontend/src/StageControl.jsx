import React from "react";
import { useI18n } from "./i18n.jsx";
import {
  stageStatus,
  stageJog,
  stageHome,
  stageStop,
  stageFirmwareRestart,
} from "./api";

const STEPS = [0.1, 1, 5, 10, 25];

// 运动平台手动控制:连接状态 + 坐标读数 + XY/Z 步进 + 回零 + 急停。
// CoreXY 移动相机,Z 移动板 (对焦)。未 home 时 Klipper 会拒绝步进,错误会显示出来。
export default function StageControl() {
  const { t } = useI18n();
  const [st, setSt] = React.useState(null);
  const [step, setStep] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const refresh = React.useCallback(async () => {
    try {
      setSt(await stageStatus());
    } catch {
      setSt({ connected: false });
    }
  }, []);

  React.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const jog = (axis, dir) => run(() => stageJog(axis, dir * step, axis === "Z" ? 300 : 600));

  const connected = st?.connected;
  const pos = st?.position;
  const homed = (st?.homed || "").toLowerCase();
  const isHomed = (a) => homed.includes(a);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{t("stageTitle")}</h3>
        <span
          className={`flex items-center gap-1 text-xs ${
            connected ? "text-emerald-400" : "text-slate-500"
          }`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected ? "bg-emerald-400" : "bg-slate-600"
            }`}
          />
          {connected ? st?.state || t("connected") : t("stageOffline")}
        </span>
      </div>

      {!connected ? (
        <p className="text-xs text-slate-500">{t("stageOfflineHint")}</p>
      ) : (
        <>
          {/* 坐标读数 */}
          <div className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
            {["x", "y", "z"].map((a) => (
              <div
                key={a}
                className={`rounded bg-slate-800 py-1 ${
                  isHomed(a) ? "" : "opacity-50"
                }`}
                title={isHomed(a) ? t("stageHomed") : t("stageNotHomed")}
              >
                <div className="text-[10px] uppercase text-slate-400">{a}</div>
                <div className="font-mono">
                  {pos ? pos[a].toFixed(2) : "—"}
                </div>
              </div>
            ))}
          </div>

          {/* 步进大小 */}
          <div className="mb-3 flex items-center gap-1 text-xs">
            <span className="text-slate-400">{t("stageStep")}</span>
            {STEPS.map((s) => (
              <button
                key={s}
                onClick={() => setStep(s)}
                className={`rounded px-2 py-0.5 ${
                  step === s ? "bg-cyan-700 text-white" : "bg-slate-800 text-slate-300"
                }`}
              >
                {s}
              </button>
            ))}
            <span className="text-slate-500">mm</span>
          </div>

          <div className="flex items-start gap-4">
            {/* XY 摇杆 */}
            <div>
              <div className="mb-1 text-center text-[10px] text-slate-500">XY</div>
              <div className="grid grid-cols-3 gap-1">
                <span />
                <JogBtn label="Y+" onClick={() => jog("Y", 1)} disabled={busy} />
                <span />
                <JogBtn label="X−" onClick={() => jog("X", -1)} disabled={busy} />
                <span />
                <JogBtn label="X+" onClick={() => jog("X", 1)} disabled={busy} />
                <span />
                <JogBtn label="Y−" onClick={() => jog("Y", -1)} disabled={busy} />
                <span />
              </div>
            </div>

            {/* Z (对焦) */}
            <div>
              <div className="mb-1 text-center text-[10px] text-slate-500">
                Z · {t("stageFocus")}
              </div>
              <div className="flex flex-col gap-1">
                <JogBtn label="Z+" onClick={() => jog("Z", 1)} disabled={busy} />
                <JogBtn label="Z−" onClick={() => jog("Z", -1)} disabled={busy} />
              </div>
            </div>
          </div>

          {/* 回零 */}
          <div className="mt-3 flex flex-wrap gap-1 text-xs">
            <button
              onClick={() => run(() => stageHome("XYZ"))}
              disabled={busy}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageHomeAll")}
            </button>
            <button
              onClick={() => run(() => stageHome("XY"))}
              disabled={busy}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageHomeXY")}
            </button>
            <button
              onClick={() => run(() => stageHome("Z"))}
              disabled={busy}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageHomeZ")}
            </button>
          </div>

          {/* 急停 / 复位 */}
          <div className="mt-2 flex gap-1 text-xs">
            <button
              onClick={() => run(stageStop)}
              className="flex-1 rounded bg-red-700 px-2 py-1 font-medium hover:bg-red-600"
            >
              {t("stageEstop")}
            </button>
            <button
              onClick={() => run(stageFirmwareRestart)}
              disabled={busy}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageRestart")}
            </button>
          </div>

          {!homed && (
            <p className="mt-2 text-[11px] text-amber-400/80">{t("stageHomeHint")}</p>
          )}
          {err && <p className="mt-2 text-[11px] text-red-400">{err}</p>}
        </>
      )}
    </div>
  );
}

function JogBtn({ label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded bg-slate-700 px-3 py-2 text-sm font-medium hover:bg-cyan-700 disabled:opacity-40"
    >
      {label}
    </button>
  );
}
