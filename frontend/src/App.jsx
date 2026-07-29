import React from "react";
import GridMask from "./GridMask";
import WellDetail from "./WellDetail";
import InspectSnapshot from "./InspectSnapshot";
import BeatDetect from "./BeatDetect";
import TimelapseControl from "./TimelapseControl";
import LocalSave from "./LocalSave";
import StageControl from "./StageControl";
import Settings from "./Settings";
import { useI18n } from "./i18n.jsx";
import { capture, getStatus, openPreview, plateImageUrl } from "./api";
import { loadGrid, saveGrid, gridFromWells, DEFAULT_GRID } from "./grid";

export default function App() {
  const { t, toggle } = useI18n();
  const [wells, setWells] = React.useState([]); // 自动检测结果 (仅作 auto-fit 起点)
  const [selectedWell, setSelectedWell] = React.useState(null); // {label,x,y,r}
  const [plateUrl, setPlateUrl] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [previewUrl, setPreviewUrl] = React.useState(null);
  const [livePreview, setLivePreview] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const [experiment, setExperiment] = React.useState("exp1");
  const [showMask, setShowMask] = React.useState(true);
  const [editGrid, setEditGrid] = React.useState(false);
  const [autoSave, setAutoSave] = React.useState(false);
  const [inspectWell, setInspectWell] = React.useState(null); // 硬件变焦检视中的孔

  // 分支 B:检视用全分辨率静帧轮询。进入时停掉实时预览,把相机让给静帧拍摄。
  const startInspect = React.useCallback((well) => {
    setInspectWell(well);
    setLivePreview(false);
  }, []);

  const stopInspect = React.useCallback(() => {
    setInspectWell(null);
  }, []);

  // 手动网格 (持久化到 localStorage,固定支架只需对齐一次)
  const [grid, setGrid] = React.useState(loadGrid);
  React.useEffect(() => {
    saveGrid(grid);
  }, [grid]);

  // LocalSave 把它的 saveNow 交给这里,拍摄后可自动保存
  const saverRef = React.useRef(null);
  const registerSaver = React.useCallback((fn) => {
    saverRef.current = fn;
  }, []);

  const refreshStatus = React.useCallback(async () => {
    try {
      setStatus(await getStatus());
    } catch {
      /* 后端未就绪时忽略 */
    }
  }, []);

  React.useEffect(() => {
    refreshStatus();
    const timer = setInterval(refreshStatus, 5000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  // 拍照 (F1, F3)。busy 一定会复位,自动保存放在 busy 之外,不会卡住按钮。
  const doCapture = async () => {
    if (busy) return;
    if (inspectWell) stopInspect(); // 全板拍摄前先退出单孔检视
    setBusy(true);
    try {
      const data = await capture();
      setWells(data.wells);
      setPlateUrl(plateImageUrl(true));
    } catch (e) {
      console.error("[capture] failed", e);
    } finally {
      setBusy(false);
    }
    if (autoSave && saverRef.current) {
      try {
        await saverRef.current();
      } catch (e) {
        console.error("[autosave] failed", e);
      }
    }
  };

  const autoFit = () => {
    const g = gridFromWells(wells);
    if (g) setGrid(g);
  };

  // 实时预览开关 (F2) + 客户端实测帧率
  const [previewFps, setPreviewFps] = React.useState(0);
  const fpsCountRef = React.useRef(0);
  React.useEffect(() => {
    if (!livePreview) {
      setPreviewFps(0);
      return;
    }
    fpsCountRef.current = 0;
    const ws = openPreview((url) => {
      fpsCountRef.current += 1;
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    });
    const timer = setInterval(() => {
      setPreviewFps(Math.round(fpsCountRef.current / 2));
      fpsCountRef.current = 0;
    }, 2000);
    return () => {
      ws.close();
      clearInterval(timer);
    };
  }, [livePreview]);

  return (
    <div className="mx-auto max-w-7xl p-4">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">
          🔬 PlateScope
          <span className="ml-2 text-sm font-normal text-slate-400">
            {t("subtitle")}
          </span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={doCapture}
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 font-medium hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? t("capturing") : t("capture")}
          </button>
          <button
            onClick={() => setLivePreview((v) => !v)}
            className={`rounded px-4 py-2 font-medium ${
              livePreview ? "bg-red-600 hover:bg-red-500" : "bg-slate-700 hover:bg-slate-600"
            }`}
          >
            {livePreview ? t("stopPreview") : t("livePreview")}
          </button>
          <button
            onClick={() => setShowMask((v) => !v)}
            className={`rounded px-4 py-2 font-medium ${
              showMask ? "bg-cyan-700 hover:bg-cyan-600" : "bg-slate-700 hover:bg-slate-600"
            }`}
          >
            {t("mask")}
          </button>
          <button
            onClick={() => {
              setShowMask(true);
              setEditGrid((v) => !v);
            }}
            className={`rounded px-4 py-2 font-medium ${
              editGrid ? "bg-pink-600 hover:bg-pink-500" : "bg-slate-700 hover:bg-slate-600"
            }`}
          >
            {editGrid ? t("doneAlign") : t("alignGrid")}
          </button>
          <button
            onClick={toggle}
            title="Language / 语言"
            className="rounded border border-slate-600 px-3 py-2 text-sm font-medium hover:bg-slate-700"
          >
            {t("switchTo")}
          </button>
        </div>
      </header>

      {/* 对齐网格时的辅助控制 */}
      {editGrid && (
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg border border-pink-700/50 bg-pink-950/20 p-3 text-sm">
          <span className="text-pink-200">{t("gridHint")}</span>
          <label className="flex items-center gap-1">
            {t("gridRows")}
            <input
              type="number"
              min="1"
              max="8"
              className="w-14 rounded bg-slate-800 px-2 py-1"
              value={grid.rows ?? 8}
              onChange={(e) =>
                setGrid({ ...grid, rows: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })
              }
            />
          </label>
          <label className="flex items-center gap-1">
            {t("gridCols")}
            <input
              type="number"
              min="1"
              max="12"
              className="w-14 rounded bg-slate-800 px-2 py-1"
              value={grid.cols ?? 12}
              onChange={(e) =>
                setGrid({ ...grid, cols: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })
              }
            />
          </label>
          <button
            onClick={autoFit}
            className="rounded bg-slate-700 px-3 py-1 hover:bg-slate-600"
          >
            {t("autoFit")}
          </button>
          <button
            onClick={() => setGrid({ ...grid, overrides: {} })}
            className="rounded bg-slate-700 px-3 py-1 hover:bg-slate-600"
          >
            {t("resetWells")}
          </button>
          <button
            onClick={() => setGrid(DEFAULT_GRID)}
            className="rounded bg-slate-700 px-3 py-1 hover:bg-slate-600"
          >
            {t("resetGrid")}
          </button>
          <label className="flex items-center gap-2">
            {t("wellSize")}
            <input
              type="range"
              min="0.01"
              max="0.075"
              step="0.001"
              value={grid.r}
              onChange={(e) => setGrid({ ...grid, r: Number(e.target.value) })}
            />
          </label>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 左:全板视图 / 实时预览 */}
        <div className="lg:col-span-2">
          {inspectWell ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-sm text-slate-400">
                <button
                  onClick={stopInspect}
                  className="rounded bg-slate-700 px-2 py-0.5 hover:bg-slate-600"
                >
                  {t("backToPlate")}
                </button>
                <span className="font-semibold text-cyan-300">
                  {t("wellTitle", inspectWell.label)}
                </span>
                <span className="text-xs">{t("snapMode")}</span>
              </div>
              <InspectSnapshot key={inspectWell.label} well={inspectWell} />
              <BeatDetect
                key={`beat-${inspectWell.label}`}
                well={inspectWell}
                experiment={experiment}
              />
            </div>
          ) : livePreview ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <span>{t("previewHeader")}</span>
                {previewFps > 0 && (
                  <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                    {previewFps} fps
                  </span>
                )}
              </div>
              {previewUrl ? (
                <div className="relative">
                  <img
                    src={previewUrl}
                    alt="live"
                    className="block w-full rounded-lg border border-slate-700"
                  />
                  <GridMask
                    grid={grid}
                    setGrid={setGrid}
                    edit={editGrid}
                    show={showMask}
                    onSelectWell={setSelectedWell}
                    selected={selectedWell?.label}
                  />
                </div>
              ) : (
                <div className="flex h-96 items-center justify-center rounded-lg border border-slate-700 text-slate-500">
                  {t("connecting")}
                </div>
              )}
            </div>
          ) : plateUrl ? (
            <div className="relative">
              <img
                src={plateUrl}
                alt="plate"
                className="block w-full rounded-lg border border-slate-700"
              />
              <GridMask
                grid={grid}
                setGrid={setGrid}
                edit={editGrid}
                show={showMask}
                onSelectWell={setSelectedWell}
                selected={selectedWell?.label}
              />
            </div>
          ) : (
            <div className="flex h-96 items-center justify-center rounded-lg border border-dashed border-slate-700 text-slate-500">
              {t("captureHint")}
            </div>
          )}
        </div>

        {/* 右:单孔放大 + 控制 */}
        <div className="space-y-4">
          <WellDetail
            well={selectedWell}
            livePreview={livePreview}
            previewUrl={previewUrl}
            inspecting={!!inspectWell}
            onInspect={startInspect}
          />
          <LocalSave
            experiment={experiment}
            autoSave={autoSave}
            setAutoSave={setAutoSave}
            registerSaver={registerSaver}
          />
          <StageControl />
          <TimelapseControl
            jobs={status?.jobs ?? []}
            onChange={refreshStatus}
            experiment={experiment}
            setExperiment={setExperiment}
          />
          <Settings status={status} onReconnect={refreshStatus} />
        </div>
      </div>
    </div>
  );
}
