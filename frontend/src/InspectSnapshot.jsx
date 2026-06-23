import React from "react";
import { wellSnapshotUrl } from "./api";
import { useI18n } from "./i18n.jsx";

// 分支 B 的单孔检视:轮询全分辨率静帧裁剪图。
// 自链式刷新:加载完一张 → 等一小会 → 取下一张 (避免请求堆积)。
// 全分辨率拍摄约 1-2s/张,所以有效刷新约每 2-3 秒,但清晰度最高。
export default function InspectSnapshot({ well }) {
  const { t } = useI18n();
  const [url, setUrl] = React.useState(() =>
    wellSnapshotUrl(well.x, well.y, well.r)
  );
  const [loading, setLoading] = React.useState(true);
  const stopped = React.useRef(false);

  React.useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);

  const scheduleNext = () => {
    if (stopped.current) return;
    setTimeout(() => {
      if (stopped.current) return;
      setLoading(true);
      setUrl(wellSnapshotUrl(well.x, well.y, well.r));
    }, 900);
  };

  return (
    <div className="relative inline-block w-full">
      <img
        src={url}
        alt={well.label}
        onLoad={() => {
          setLoading(false);
          scheduleNext();
        }}
        onError={scheduleNext}
        className="block w-full rounded-lg border border-slate-700 bg-black"
      />
      {loading && (
        <span className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-slate-200">
          {t("refreshingSnap")}
        </span>
      )}
    </div>
  );
}
