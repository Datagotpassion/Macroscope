import React from "react";
import { wellImageUrl } from "./api";
import { useI18n } from "./i18n.jsx";

// 单孔放大视图 (F4)。选中孔后拉取裁剪图,支持手动刷新。
export default function WellDetail({ label }) {
  const { t } = useI18n();
  const [url, setUrl] = React.useState(null);

  const refresh = React.useCallback(() => {
    if (label) setUrl(wellImageUrl(label));
  }, [label]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  if (!label) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-700 text-slate-500">
        {t("wellDetailHint")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{t("wellTitle", label)}</h3>
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
          alt={label}
          className="w-full rounded-lg border border-slate-700 bg-black"
        />
      )}
    </div>
  );
}
