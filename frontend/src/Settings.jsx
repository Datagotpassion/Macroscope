import React from "react";
import { useI18n } from "./i18n.jsx";

// 系统设置 / 状态面板。LED 控制 (F14) 等 Phase 2 功能先占位。
export default function Settings({ status }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 rounded-lg border border-slate-700 p-4 text-sm">
      <h3 className="text-lg font-semibold">{t("systemStatus")}</h3>
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
