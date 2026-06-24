import React from "react";
import { wellSnapshotUrl } from "./api";
import { useI18n } from "./i18n.jsx";

// 分支 B 的单孔检视:轮询全分辨率静帧裁剪图。
// 用固定定时器刷新 (不依赖上一张的 onLoad),这样即使某次全分辨率拍摄卡住,
// 下一次仍会照常发起,循环不会死掉。全分辨率拍摄约 1-2s,所以间隔取 3s。
// 计数 #N 让你一眼看出确实在刷新 (即使 organoid 静止画面看起来没变)。
const INTERVAL_MS = 3000;

export default function InspectSnapshot({ well }) {
  const { t } = useI18n();
  const [url, setUrl] = React.useState(() =>
    wellSnapshotUrl(well.x, well.y, well.r)
  );
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    let timer;
    const fire = () => {
      if (!active) return;
      setLoading(true);
      setUrl(wellSnapshotUrl(well.x, well.y, well.r));
      setTick((n) => n + 1);
      timer = setTimeout(fire, INTERVAL_MS);
    };
    fire();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [well]);

  return (
    <div className="relative inline-block w-full">
      <img
        src={url}
        alt={well.label}
        onLoad={() => setLoading(false)}
        className="block w-full rounded-lg border border-slate-700 bg-black"
      />
      <span className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-slate-200">
        {loading ? t("refreshingSnap") : `#${tick}`}
      </span>
    </div>
  );
}
