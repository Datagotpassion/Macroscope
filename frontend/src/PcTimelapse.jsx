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

  const startRef = React.useRef(0);
  const timerRef = React.useRef(null);

  React.useEffect(() => {
    initSaveTarget().then((name) => name && setFolder(name));
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const pickFolder = async () => {
    const name = await chooseFolder();
    if (name) setFolder(name);
  };

  const dayNumber = () =>
    Number(startDay) + Math.floor((Date.now() - startRef.current) / 86400000);

  const captureOnce = async () => {
    try {
      const name = buildName(experiment, dayNumber());
      const blob = await freshFrameBlob();
      await saveBytes(name, await blob.arrayBuffer());
      setCount((c) => c + 1);
      setLastFile(name);
      setErr("");
    } catch (e) {
      // 单次失败 (相机离线等) 不停整个任务:记一下,下个周期继续。
      setErr(e.message || String(e));
    }
  };

  const start = async () => {
    if (!currentFolderName()) return setErr(t("pcTlNeedFolder"));
    if (!experiment.trim()) return setErr(t("pcTlNeedCondition"));
    setErr("");
    setCount(0);
    startRef.current = Date.now();
    setRunning(true);
    await captureOnce(); // 立即拍第一张
    timerRef.current = setInterval(
      captureOnce,
      Math.max(1, Number(intervalMin)) * 60000
    );
  };

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
  };

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
