import React from "react";
import PlateView from "./PlateView";
import PreviewMask from "./PreviewMask";
import WellDetail from "./WellDetail";
import TimelapseControl from "./TimelapseControl";
import LocalSave from "./LocalSave";
import Settings from "./Settings";
import { useI18n } from "./i18n.jsx";
import { capture, getStatus, openPreview, plateImageUrl } from "./api";

export default function App() {
  const { t, toggle } = useI18n();
  const [wells, setWells] = React.useState([]);
  const [selected, setSelected] = React.useState(null);
  const [plateUrl, setPlateUrl] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [previewUrl, setPreviewUrl] = React.useState(null);
  const [livePreview, setLivePreview] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const [experiment, setExperiment] = React.useState("exp1");
  const [showMask, setShowMask] = React.useState(true);
  const [autoSave, setAutoSave] = React.useState(false);

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

  // 拍照 + 检测孔位 (F1, F3)，可选自动保存到 PC (F6)
  const doCapture = async () => {
    setBusy(true);
    try {
      const data = await capture();
      setWells(data.wells);
      if (autoSave && saverRef.current) {
        await saverRef.current(); // 保存的是刚分析过的这一帧
      }
      setPlateUrl(plateImageUrl(true)); // 带标注的全板图
    } finally {
      setBusy(false);
    }
  };

  // 实时预览开关 (F2)
  React.useEffect(() => {
    if (!livePreview) return;
    const ws = openPreview((url) => {
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    });
    return () => ws.close();
  }, [livePreview]);

  return (
    <div className="mx-auto max-w-7xl p-4">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          🔬 PlateScope
          <span className="ml-2 text-sm font-normal text-slate-400">
            {t("subtitle")}
          </span>
        </h1>
        <div className="flex gap-2">
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
            onClick={toggle}
            title="Language / 语言"
            className="rounded border border-slate-600 px-3 py-2 text-sm font-medium hover:bg-slate-700"
          >
            {t("switchTo")}
          </button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 左:全板视图 / 实时预览 */}
        <div className="lg:col-span-2">
          {livePreview ? (
            <div className="space-y-2">
              <div className="text-sm text-slate-400">{t("previewHeader")}</div>
              {previewUrl ? (
                <div className="relative inline-block">
                  <img
                    src={previewUrl}
                    alt="live"
                    className="block w-full rounded-lg border border-slate-700"
                  />
                  <PreviewMask wells={wells} show={showMask} />
                </div>
              ) : (
                <div className="flex h-96 items-center justify-center rounded-lg border border-slate-700 text-slate-500">
                  {t("connecting")}
                </div>
              )}
            </div>
          ) : plateUrl ? (
            <PlateView
              wells={wells}
              imageUrl={plateUrl}
              selected={selected}
              onSelect={setSelected}
              showMask={showMask}
            />
          ) : (
            <div className="flex h-96 items-center justify-center rounded-lg border border-dashed border-slate-700 text-slate-500">
              {t("captureHint")}
            </div>
          )}
          {wells.length > 0 && !livePreview && (
            <div className="mt-2 text-sm text-slate-400">
              {t("wellsDetected", wells.length)} ·{" "}
              <span className="text-green-400">
                {t("wellsDirect", wells.filter((w) => w.detected).length)}
              </span>{" "}
              ·{" "}
              <span className="text-orange-400">
                {t("wellsFilled", wells.filter((w) => !w.detected).length)}
              </span>
            </div>
          )}
        </div>

        {/* 右:单孔放大 + 控制 */}
        <div className="space-y-4">
          <WellDetail label={selected} />
          <LocalSave
            experiment={experiment}
            autoSave={autoSave}
            setAutoSave={setAutoSave}
            registerSaver={registerSaver}
          />
          <TimelapseControl
            jobs={status?.jobs ?? []}
            onChange={refreshStatus}
            experiment={experiment}
            setExperiment={setExperiment}
          />
          <Settings status={status} />
        </div>
      </div>
    </div>
  );
}
