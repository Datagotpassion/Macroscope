import React from "react";
import { startTimelapse, stopTimelapse, saveFrame } from "./api";
import { useI18n } from "./i18n.jsx";

// 定时拍摄控制面板 (F5) + 手动保存 (F6)。
export default function TimelapseControl({ jobs, onChange }) {
  const { t } = useI18n();
  const [experiment, setExperiment] = React.useState("exp1");
  const [interval, setIntervalMin] = React.useState(30);
  const [msg, setMsg] = React.useState("");

  const flash = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 3000);
  };

  const onSave = async () => {
    try {
      const r = await saveFrame(experiment);
      flash(t("msgSaved", r.saved));
      onChange();
    } catch (e) {
      flash(t("msgSaveFailed", e.message));
    }
  };

  const onStart = async () => {
    await startTimelapse(experiment, Number(interval));
    flash(t("msgStarted", experiment, interval));
    onChange();
  };

  const onStop = async (exp) => {
    await stopTimelapse(exp);
    flash(t("msgStopped", exp));
    onChange();
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 p-4">
      <h3 className="text-lg font-semibold">{t("timelapseTitle")}</h3>
      <div className="flex flex-wrap gap-2">
        <input
          className="flex-1 rounded bg-slate-800 px-3 py-1.5"
          value={experiment}
          onChange={(e) => setExperiment(e.target.value)}
          placeholder={t("experimentPlaceholder")}
        />
        <input
          type="number"
          min="1"
          className="w-24 rounded bg-slate-800 px-3 py-1.5"
          value={interval}
          onChange={(e) => setIntervalMin(e.target.value)}
        />
        <span className="self-center text-sm text-slate-400">{t("minutes")}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onSave}
          className="rounded bg-emerald-600 px-3 py-1.5 hover:bg-emerald-500"
        >
          {t("saveFrame")}
        </button>
        <button
          onClick={onStart}
          className="rounded bg-blue-600 px-3 py-1.5 hover:bg-blue-500"
        >
          {t("startTimelapse")}
        </button>
      </div>

      {jobs.length > 0 && (
        <div className="space-y-1 text-sm">
          <div className="text-slate-400">{t("runningJobs")}</div>
          {jobs.map((j) => (
            <div
              key={j.id}
              className="flex items-center justify-between rounded bg-slate-800 px-3 py-1.5"
            >
              <span>
                {j.experiment}
                <span className="ml-2 text-slate-500">
                  {t("nextRun")}
                  {j.next_run ? new Date(j.next_run).toLocaleTimeString() : "—"}
                </span>
              </span>
              <button
                onClick={() => onStop(j.experiment)}
                className="rounded bg-red-600 px-2 py-0.5 text-xs hover:bg-red-500"
              >
                {t("stop")}
              </button>
            </div>
          ))}
        </div>
      )}

      {msg && <div className="text-sm text-yellow-300">{msg}</div>}
    </div>
  );
}
