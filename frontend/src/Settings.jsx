import React from "react";
import { useI18n } from "./i18n.jsx";
import { apiBase, setApiBase, isDesktop } from "./api";

// 系统设置 / 状态面板。LED 控制 (F14) 等 Phase 2 功能先占位。
export default function Settings({ status, onReconnect }) {
  const { t } = useI18n();
  const [addr, setAddr] = React.useState(apiBase());
  const connected = !!status;

  const connect = () => {
    setApiBase(addr);
    onReconnect && onReconnect();
  };

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 p-4 text-sm">
      <h3 className="text-lg font-semibold">{t("systemStatus")}</h3>

      <div className="flex justify-between">
        <span className="text-slate-400">{t("connection")}</span>
        <span className={connected ? "text-green-400" : "text-red-400"}>
          {connected ? t("connected") : t("disconnected")}
        </span>
      </div>

      {/* 桌面 App 才需要手动指定 Pi 地址;浏览器同源不需要 */}
      {isDesktop() && (
        <div className="flex gap-2">
          <input
            className="flex-1 rounded bg-slate-800 px-2 py-1 text-xs"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="http://raspberrypi.local:8000"
          />
          <button
            onClick={connect}
            className="rounded bg-blue-600 px-2 py-1 text-xs hover:bg-blue-500"
          >
            {t("connect")}
          </button>
        </div>
      )}

      <div className="flex justify-between">
        <span className="text-slate-400">{t("camera")}</span>
        <span className={status?.camera === "mock" ? "text-orange-400" : "text-green-400"}>
          {status?.camera === "mock" ? t("cameraMock") : t("cameraReal")}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-slate-400">{t("serverTime")}</span>
        <span>{status?.time ? new Date(status.time).toLocaleTimeString() : "—"}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-slate-400">{t("runningJobsCount")}</span>
        <span>{status?.jobs?.length ?? 0}</span>
      </div>
      <div className="pt-2 text-xs text-slate-500">{t("phase2Note")}</div>
    </div>
  );
}
