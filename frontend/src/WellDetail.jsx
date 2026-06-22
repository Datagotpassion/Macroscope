import React from "react";
import { cropUrl } from "./api";
import { useI18n } from "./i18n.jsx";

// 单孔放大视图 (F4)。well = {label, x, y, r} (归一化坐标),按坐标裁剪。
export default function WellDetail({ well }) {
  const { t } = useI18n();
  const [url, setUrl] = React.useState(null);

  const refresh = React.useCallback(() => {
    if (well) setUrl(cropUrl(well.x, well.y, well.r));
  }, [well]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

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
        <h3 className="text-lg font-semibold">{t("wellTitle", well.label)}</h3>
        <button
          onClick={refresh}
          className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
        >
          {t("refresh")}
        </button>
      </div>
      {url && (
        <img
          src={url}
          alt={well.label}
          className="w-full rounded-lg border border-slate-700 bg-black"
        />
      )}
    </div>
  );
}
