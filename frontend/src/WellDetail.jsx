import React from "react";
import { cropUrl } from "./api";
import { useI18n } from "./i18n.jsx";

// 单孔放大 (F4)。well = {label, x, y, r} 来自手动网格 (归一化坐标)。
// - 实时预览中:从每帧预览图里裁出该孔区域,放大画到 canvas → 实时缩放预览。
// - 看静帧时:用 /api/crop 取全分辨率清晰裁剪图。
export default function WellDetail({
  well,
  livePreview,
  previewUrl,
  inspecting,
  onInspect,
}) {
  const { t } = useI18n();
  const canvasRef = React.useRef(null);
  const imgRef = React.useRef(null);
  const [staticUrl, setStaticUrl] = React.useState(null);

  // 检视模式下,预览流本身已是该孔 (主视图显示),这里不再客户端裁剪
  const live = !!(livePreview && previewUrl && !inspecting);

  // 静态高清裁剪
  const refresh = React.useCallback(() => {
    if (well && !live) setStaticUrl(cropUrl(well.x, well.y, well.r));
  }, [well, live]);
  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // 实时缩放:把当前预览帧里该孔的区域放大画到 canvas
  React.useEffect(() => {
    if (!well || !live) return;
    let cancelled = false;
    if (!imgRef.current) imgRef.current = new Image();
    const img = imgRef.current;
    img.onload = () => {
      if (cancelled) return;
      const c = canvasRef.current;
      if (!c) return;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw) return;
      const pad = 1.4;
      const rad = well.r * nw * pad; // 以图宽为基准的半径(像素)
      const s = rad * 2;
      const sx = well.x * nw - rad;
      const sy = well.y * nh - rad;
      const size = 320;
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
    };
    img.src = previewUrl;
    return () => {
      cancelled = true;
    };
  }, [well, live, previewUrl]);

  if (!well) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-700 text-slate-500">
        {t("wellDetailHint")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {t("wellTitle", well.label)}
          <span
            className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
              live ? "bg-red-600/80" : "bg-slate-600"
            }`}
          >
            {live ? t("zoomLive") : t("zoomStatic")}
          </span>
        </h3>
        <div className="flex gap-2">
          {!inspecting && (
            <button
              onClick={() => onInspect(well)}
              className="rounded bg-cyan-700 px-3 py-1 text-sm hover:bg-cyan-600"
            >
              {t("inspectSharp")}
            </button>
          )}
          {!live && (
            <button
              onClick={refresh}
              className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
            >
              {t("refresh")}
            </button>
          )}
        </div>
      </div>
      {live ? (
        <canvas
          ref={canvasRef}
          className="aspect-square w-full rounded-lg border border-slate-700 bg-black"
        />
      ) : (
        staticUrl && (
          <img
            src={staticUrl}
            alt={well.label}
            className="w-full rounded-lg border border-slate-700 bg-black"
          />
        )
      )}
    </div>
  );
}
