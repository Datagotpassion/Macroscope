import React from "react";
import { useI18n } from "./i18n.jsx";
import {
  chooseFolder,
  currentFolderName,
  initSaveTarget,
  saveMode,
  saveBytes,
} from "./save";
import { freshFrameBlob, stageMove, stageWait } from "./api";
import { loadPlateMap, listBlocks, blockCenter, cornersSet } from "./plateModel";

// 客户端定时拍摄 → 保存到本机文件夹 (Electron)。App 端跑计划,每次抓帧写盘。
// 单点模式:「实验条件 - day # - 时间戳」。
// 巡扫模式:每个周期走遍板面地图所有方格各拍一张,文件名加方格标签
//           「实验条件 - A1 - day # - 时间戳」。day# = 起始 day + 距开始的整天数。

const two = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_` +
  `${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;

// 组装文件名并去掉文件系统非法字符 (< > : " / \ | ? *)。block 可选 (巡扫时的方格标签)。
function buildName(condition, dayNum, block, d = new Date()) {
  const parts = [(condition || "capture").trim()];
  if (block) parts.push(block);
  parts.push(`day ${dayNum}`, stamp(d));
  return parts.join(" - ").replace(/[<>:"/\\|?*\n\r]/g, "").trim() + ".jpg";
}

// 运行状态持久化 key —— 意外关闭 (App 崩溃 / 手滑关掉 / PC 重启) 后自动从原起点续拍。
const TL_KEY = "platescope_tl_run";

// experiment / setExperiment 与全站共享(跳动检测、保存等都用它作实验名/命名前缀)。
export default function PcTimelapse({ experiment, setExperiment, onRunningChange }) {
  const { t } = useI18n();
  const [folder, setFolder] = React.useState(null);
  const [startDay, setStartDay] = React.useState(0);
  const [intervalMin, setIntervalMin] = React.useState(30);
  const [running, setRunning] = React.useState(false);
  const [count, setCount] = React.useState(0);
  const [lastFile, setLastFile] = React.useState("");
  const [err, setErr] = React.useState("");
  const [resumed, setResumed] = React.useState(false);
  const [scan, setScan] = React.useState(false); // 巡扫模式:每周期走遍所有方格
  const [scanInfo, setScanInfo] = React.useState(""); // 巡扫进度,如 "A5 (2/6)"

  // captureOnce 走 ref 取值,避免 setInterval 闭包读到过期 state(续拍恢复时尤其关键)。
  const startRef = React.useRef(0); // 本次运行开始时间戳 (ms)
  const startDayRef = React.useRef(0); // 起始 day#
  const expRef = React.useRef(""); // 实验名 (跟随 prop)
  const intervalRef = React.useRef(30); // 间隔 (分钟)
  const countRef = React.useRef(0); // 已拍张数
  const timerRef = React.useRef(null);
  const scanRef = React.useRef(false); // 巡扫开关 (给 setInterval 闭包用)
  const scanBusyRef = React.useRef(false); // 一圈巡扫进行中,防止周期叠加

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  React.useEffect(() => {
    expRef.current = experiment;
  }, [experiment]);
  React.useEffect(() => {
    intervalRef.current = Math.max(1, Number(intervalMin) || 1);
  }, [intervalMin]);
  React.useEffect(() => {
    scanRef.current = scan;
  }, [scan]);
  React.useEffect(() => {
    onRunningChange?.(running); // 让父层(分页标签)知道是否在跑
  }, [running, onRunningChange]);

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
          scan: scanRef.current,
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

  // 巡扫一圈:依次走每个成像方格 → 到该格对焦 Z → 拍一帧 → 存 (文件名带方格标签)。
  const scanOnce = async () => {
    if (scanBusyRef.current) return; // 上一圈还没扫完就跳过本次触发,避免运动叠加
    const map = loadPlateMap();
    if (!cornersSet(map.ref)) {
      setErr("plate map: teach corners A1 / A12 / H1 first");
      return;
    }
    scanBusyRef.current = true;
    const blocks = listBlocks();
    const dn = dayNumber();
    try {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const p = blockCenter(map.ref, b.br, b.bc);
        if (!p) continue;
        setScanInfo(`${b.label} (${i + 1}/${blocks.length})`);
        try {
          await stageMove({ x: p.x, y: p.y, feed: 3000 });
          const z = map.z[b.key];
          if (z != null) await stageMove({ z, feed: 600 });
          await stageWait(); // 等运动队列清空 (停稳)
          await sleep(400); // 再等机械振动衰减
          const name = buildName(expRef.current, dn, b.label);
          const blob = await freshFrameBlob();
          await saveBytes(name, await blob.arrayBuffer());
          countRef.current += 1;
          setCount(countRef.current);
          setLastFile(name);
          setErr("");
        } catch (e) {
          // 单个方格失败 (移动被拒 / 相机超时) 不停整圈:记一下,继续下一格
          setErr(`${b.label}: ${e.message || String(e)}`);
        }
      }
      persist();
    } finally {
      scanBusyRef.current = false;
      setScanInfo("");
    }
  };

  // 单点 or 巡扫,由 scanRef 决定 (setInterval 闭包里取 ref,续拍恢复也对)。
  const cycle = () => (scanRef.current ? scanOnce() : captureOnce());

  const beginLoop = (delayMs) => {
    setRunning(true);
    cycle(); // 立即拍一次 (整圈或单张)
    timerRef.current = setInterval(cycle, delayMs);
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
    scanRef.current = scan;
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
      scanRef.current = !!saved.scan;
      setScan(!!saved.scan);
      setResumed(true);
      beginLoop(intervalRef.current * 60000);
    });
    return () => {
      alive = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previewName = buildName(
    experiment || "condition",
    Number(startDay),
    scan ? "A1" : undefined
  );

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

      {/* 巡扫模式:每个周期走遍板面地图的所有方格,各拍一张 (需先在 Plate map 教好角) */}
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={scan}
          onChange={(e) => setScan(e.target.checked)}
          disabled={running}
        />
        Scan whole plate — visit every mapped block each interval
      </label>

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
        {running && scanInfo && (
          <span className="text-xs text-cyan-400">▸ scanning {scanInfo}</span>
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
