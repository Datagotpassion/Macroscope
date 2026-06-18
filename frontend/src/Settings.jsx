import React from "react";

// 系统设置 / 状态面板。LED 控制 (F14) 等 Phase 2 功能先占位。
export default function Settings({ status }) {
  return (
    <div className="space-y-2 rounded-lg border border-slate-700 p-4 text-sm">
      <h3 className="text-lg font-semibold">系统状态</h3>
      <div className="flex justify-between">
        <span className="text-slate-400">相机</span>
        <span className={status?.camera === "mock" ? "text-orange-400" : "text-green-400"}>
          {status?.camera === "mock" ? "MockCamera (开发模式)" : "picamera2 (硬件)"}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-slate-400">服务器时间</span>
        <span>{status?.time ? new Date(status.time).toLocaleTimeString() : "—"}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-slate-400">运行任务数</span>
        <span>{status?.jobs?.length ?? 0}</span>
      </div>
      <div className="pt-2 text-xs text-slate-500">
        LED 亮度控制 (F14)、温湿度监控 (F18) 将在 Phase 2 接入。
      </div>
    </div>
  );
}
