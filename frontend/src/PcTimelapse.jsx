import React from "react";
import { useI18n } from "./i18n.jsx";
import {
  chooseFolder,
  currentFolderName,
  initSaveTarget,
  saveMode,
  saveBytes,
} from "./save";
import { freshFrameBlob } from "./api";

// 客户端定时拍摄 → 保存到本机文件夹 (Electron)。App 端跑计划,每次抓一帧写盘。
// 文件名:「实验条件 - day # - 时间戳」。day# = 起始 day + 距开始的整天数。

const two = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_` +
  `${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;

// 组装文件名并去掉文件系统非法字符 (< > : " / \ | ? *)。
function buildName(condition, dayNum, d = new Date()) {
  const raw = `${(condition || "capture").trim()} - day ${dayNum} - ${stamp(d)}`;
  return raw.replace(/[<>:"/\\|?*\n\r]/g, "").trim() + ".jpg";
}

// 运行状态持久化 key —— 意外关闭 (App 崩溃 / 手滑关掉 / PC 重启) 后自动从原起点续拍。
const TL_KEY = "platescope_tl_run";

// experiment / setExperiment 与全站共享(跳动检测、保存等都用它作实验名/命名前缀)。
export default function PcTimelapse({ experiment, setExperiment }) {
  const { t } = useI18n();
  const [folder, setFolder] = React.useState(null);
  const [startDay, setStartDay] = React.useState(0);
  const [intervalMin, setIntervalMin] = React.useState(30);
  const [running, setRunning] = React.useState(false);
  const [count, setCount] = React.useState(0);
  const [lastFile, setLastFile] = React.useState("");
  const [err, setErr] = React.useState("");
  const [resumed, setResumed] = React.useState(false);

  // captureOnce 走 ref 取值,避免 setInterval 闭包读到过期 state(续拍恢复时尤其关键)。
  const startRef = React.useRef(0); // 本次运行开始时间戳 (ms)
  const startDayRef = React.useRef(0); // 起始 day#
  const expRef = React.useRef(""); // 实验名 (跟随 prop)
  const intervalRef = React.useRef(30); // 间隔 (分钟)
  const countRef = React.useRef(0); // 已拍张数
  const timerRef = React.useRef(null);

  React.useEffect(() => {
    expRef.current = experiment;
  }, [experiment]);
  React.useEffect(() => {
    intervalRef.current = Math.max(1, Number(intervalMin) || 1);
  }, [intervalMin]);

  // 把运行状态写盘 (localStorage 在 Electron 里跨重启保留)。每次拍成功都刷新计数/时间戳。
  const persist = () => {
    try {
      localStorage.setItem(
        TL_KEY,
        JSON.stringify({
          experiment: expRef.current,
          startDay: startDayRef.current,
          intervalMin: intervalRef.current,
          startEpoch: startRef.current,
          count: countRef.current,
          running: true,
        })
      );
    } catch {
      /* ignore */
    }
  };
  const clearPersist = () => {
    try {
      localStorage.removeItem(TL_KEY);
    } catch {
      /* ignore */
    }
  };

  const pickFolder = async () => {
    const name = await chooseFolder();
    if (name) setFolder(name);
  };

  // day# = 起始 day + 距(原始)开始时间的整天数 —— 用 startEpoch 保证续拍后天数连续。
  const dayNumber = () =>
    Number(startDayRef.current) +
    Math.floor((Date.now() - startRef.current) / 86400000);

  const captureOnce = async () => {
    try {
      const name = buildName(expRef.current, dayNumber());
      const blob = await freshFrameBlob();
      await saveBytes(name, await blob.arrayBuffer());
      countRef.current += 1;
      setCount(countRef.current);
      setLastFile(name);
      setErr("");
      persist(); // 断点续拍:每张成功后更新计数与时间戳
    } catch (e) {
      // 单次失败 (相机离线、网络抖动等) 不停整个任务:记一下,下个周期继续。
      setErr(e.message || String(e));
    }
  };

  const beginLoop = (delayMs) => {
    setRunning(true);
    captureOnce(); // 立即拍第一张
    timerRef.current = setInterval(captureOnce, delayMs);
  };

  const start = async () => {
    if (!currentFolderName()) return setErr(t("pcTlNeedFolder"));
    if (!experiment.trim()) return setErr(t("pcTlNeedCondition"));
    setErr("");
    setResumed(false);
    countRef.current = 0;
    setCount(0);
    startRef.current = Date.now();
    startDayRef.current = Number(startDay);
    expRef.current = experiment;
    intervalRef.current = Math.max(1, Number(intervalMin));
    persist();
    beginLoop(intervalRef.current * 60000);
  };

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
    setResumed(false);
    clearPersist();
  };

  // 挂载:恢复保存目标;若上次运行被意外中断,自动从原起点续拍(day# 连续,计数接着走)。
  React.useEffect(() => {
    let alive = true;
    initSaveTarget().then((name) => {
      if (!alive) return;
      if (name) setFolder(name);
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(TL_KEY) || "null");
      } catch {
        saved = null;
      }
      if (!saved || !saved.running) return;
      if (!currentFolderName()) {
        // 保存文件夹没恢复出来,没法续拍:提示重选并清状态
        setErr(t("pcTlNeedFolder"));
        clearPersist();
        return;
      }
      // 用原始 startEpoch 恢复,天数从头算起保持连续
      expRef.current = saved.experiment || "";
      setExperiment(saved.experiment || "");
      startDayRef.current = Number(saved.startDay) || 0;
      setStartDay(Number(saved.startDay) || 0);
      intervalRef.current = Math.max(1, Number(saved.intervalMin) || 30);
      setIntervalMin(intervalRef.current);
      startRef.current = Number(saved.startEpoch) || Date.now();
      countRef.current = Number(saved.count) || 0;
      setCount(countRef.current);
      setResumed(true);
      beginLoop(intervalRef.current * 60000);
    });
    return () => {
      alive = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previewName = buildName(experiment || "condition", Number(startDay));

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 p-4 text-sm">
      <h3 className="text-lg font-semibold">{t("pcTlTitle")}</h3>

      {/* 目标文件夹 */}
      <div className="flex items-center gap-2">
        <button
          onClick={pickFolder}
          disabled={running}
          className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600 disabled:opacity-50"
        >
          {t("pcTlChoose")}
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
          {folder ? t("pcTlFolder", folder) : t("pcTlNoFolder", saveMode())}
        </span>
      </div>

      {/* 命名字段:条件 + 起始 day# + 间隔 */}
      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1 rounded bg-slate-800 px-2 py-1 text-xs"
          placeholder={t("pcTlCondition")}
          value={experiment}
          onChange={(e) => setExperiment(e.target.value)}
          disabled={running}
        />
        <label className="flex items-center gap-1 text-xs text-slate-400">
          {t("pcTlStartDay")}
          <input
            type="number"
            className="w-14 rounded bg-slate-800 px-2 py-1"
            value={startDay}
            onChange={(e) => setStartDay(e.target.value)}
            disabled={running}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-400">
          <input
            type="number"
            min="1"
            className="w-16 rounded bg-slate-800 px-2 py-1"
            value={intervalMin}
            onChange={(e) => setIntervalMin(e.target.value)}
            disabled={running}
          />
          {t("minutes")}
        </label>
      </div>

      {/* 文件名预览 */}
      <div className="truncate text-[11px] text-slate-500">
        {t("pcTlPreview", previewName)}
      </div>

      {/* 开始 / 停止 + 状态 */}
      <div className="flex items-center gap-2">
        {running ? (
          <button
            onClick={stop}
            className="rounded bg-red-600 px-3 py-1.5 hover:bg-red-500"
          >
            {t("pcTlStop")}
          </button>
        ) : (
          <button
            onClick={start}
            className="rounded bg-blue-600 px-3 py-1.5 hover:bg-blue-500"
          >
            {t("pcTlStart")}
          </button>
        )}
        {running && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            {t("pcTlStatus", count)}
            {resumed && (
              <span title="resumed after restart" className="text-sky-400">
                ↻
              </span>
            )}
          </span>
        )}
      </div>

      {lastFile && (
        <div className="truncate text-[11px] text-slate-400">
          {t("pcTlLast", lastFile)}
        </div>
      )}
      {err && <div className="text-[11px] text-amber-400">{err}</div>}
      {running && (
        <div className="text-[11px] text-slate-500">{t("pcTlRunningNote")}</div>
      )}
    </div>
  );
}
