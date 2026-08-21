import React from "react";
import { useI18n } from "./i18n.jsx";
import {
  stageStatus,
  stageJog,
  stageMove,
  stageHome,
  stageStop,
  stageFirmwareRestart,
  stageAutofocus,
} from "./api";

const STEPS = [0.1, 1, 5, 10, 25];
const POS_KEY = "platescope_stage_positions_v1";
// 当 Klipper 掉线(shutdown/error)时,自动重连的最小间隔 (ms),避免频繁重启。
const RECONNECT_COOLDOWN = 6000;

function loadPositions() {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY)) || [];
  } catch {
    return [];
  }
}

// 运动平台手动控制:连接/坐标 + XY/Z 步进 + 绝对前往 + 已存位置(示教) + 回零 + 急停。
// CoreXY 移动相机,Z 移动板(对焦)。未 home 时 Klipper 会拒绝坐标移动,错误会显示出来。
// 已存位置只记录 XY(相机在板上的位置),是后续「逐孔扫描」的孔位表基础。
export default function StageControl({ roi }) {
  const { t } = useI18n();
  const [st, setSt] = React.useState(null);
  const [step, setStep] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const [err, setErr] = React.useState(null);
  const [reconnecting, setReconnecting] = React.useState(false);
  const lastReconnectRef = React.useRef(0);
  // 用户主动急停后暂停自动重连,避免把 E-STOP 又自动恢复掉;点「复位固件」重新启用。
  const [autoPaused, setAutoPaused] = React.useState(false);
  const autoPausedRef = React.useRef(false);
  const pauseAuto = (v) => {
    autoPausedRef.current = v;
    setAutoPaused(v);
  };

  const [gotoX, setGotoX] = React.useState("");
  const [gotoY, setGotoY] = React.useState("");
  const [gotoZ, setGotoZ] = React.useState("");
  const [afRange, setAfRange] = React.useState(1.0);
  const [positions, setPositions] = React.useState(loadPositions);
  const [newName, setNewName] = React.useState("");

  React.useEffect(() => {
    localStorage.setItem(POS_KEY, JSON.stringify(positions));
  }, [positions]);

  const refresh = React.useCallback(async () => {
    let status;
    try {
      status = await stageStatus();
    } catch {
      status = { connected: false };
    }
    setSt(status);

    // 自动重连 Klipper:Moonraker 在线但 Klipper 处于 shutdown/error
    //(例如 Pico 短暂掉电/断开又回来),自动发一次 firmware_restart 把它拉回来。
    // 限速,避免不停重启;Moonraker 都不可达时无能为力,继续轮询即可。
    const klipperDown =
      status?.connected &&
      (status.state === "shutdown" || status.state === "error");
    if (klipperDown && !busyRef.current && !autoPausedRef.current) {
      const now = Date.now();
      if (now - lastReconnectRef.current > RECONNECT_COOLDOWN) {
        lastReconnectRef.current = now;
        setReconnecting(true);
        try {
          await stageFirmwareRestart();
        } catch {
          /* 还没好,下个周期再试 */
        } finally {
          setTimeout(() => setReconnecting(false), 2500);
        }
      }
    }
  }, []);

  React.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (fn) => {
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // XY jog ~40 mm/s (snappy); Z gentler (~10 mm/s) since it's plate/focus.
  const jog = (axis, dir) =>
    run(() => stageJog(axis, dir * step, axis === "Z" ? 600 : 2400));

  const connected = st?.connected;
  const pos = st?.position;
  const homed = (st?.homed || "").toLowerCase();
  const isHomed = (a) => homed.includes(a);
  const xyHomed = isHomed("x") && isHomed("y");
  // Klipper 掉线中(正在自动重连);Moonraker 在线但 Klipper shutdown/error
  const showReconnecting =
    !autoPaused &&
    (reconnecting || (connected && (st?.state === "shutdown" || st?.state === "error")));

  const goTo = () => {
    const x = gotoX === "" ? undefined : Number(gotoX);
    const y = gotoY === "" ? undefined : Number(gotoY);
    if (x === undefined && y === undefined) return;
    return run(() => stageMove({ x, y, feed: 3000 }));
  };

  // 手动对焦:直接把 Z 移到指定高度(慢速,安全)。先移到大致焦点,再自动对焦微调。
  const goToZ = () => {
    if (gotoZ === "") return;
    return run(() => stageMove({ z: Number(gotoZ), feed: 600 }));
  };

  const savePosition = () => {
    if (!pos) return;
    const name = newName.trim() || `P${positions.length + 1}`;
    setPositions((ps) => [
      ...ps.filter((p) => p.name !== name),
      { name, x: pos.x, y: pos.y },
    ]);
    setNewName("");
  };

  const recall = (p) => run(() => stageMove({ x: p.x, y: p.y, feed: 3000 }));
  const remove = (name) =>
    setPositions((ps) => ps.filter((p) => p.name !== name));

  // 自动对焦:Z 小步扫描找清晰度峰值(需 Z 已 home + 相机在线)。
  const [afResult, setAfResult] = React.useState(null);
  const [afRunning, setAfRunning] = React.useState(false);
  const runAutofocus = () => {
    setAfResult(null);
    setAfRunning(true);
    return run(async () => {
      try {
        // 选中了某个孔就只对该孔区域对焦(否则整幅 —— 容易被别处细节带偏)。
        const params = { z_range: afRange, step: 0.1 };
        if (roi) {
          params.cx = roi.x;
          params.cy = roi.y;
          params.r = roi.r;
        }
        setAfResult(await stageAutofocus(params));
      } finally {
        setAfRunning(false);
      }
    });
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{t("stageTitle")}</h3>
        <span
          className={`flex items-center gap-1 text-xs ${
            showReconnecting
              ? "text-amber-400"
              : connected
              ? "text-emerald-400"
              : "text-slate-500"
          }`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              showReconnecting
                ? "animate-pulse bg-amber-400"
                : connected
                ? "bg-emerald-400"
                : "bg-slate-600"
            }`}
          />
          {showReconnecting
            ? t("stageReconnecting")
            : connected
            ? st?.state || t("connected")
            : t("stageOffline")}
        </span>
      </div>

      {!connected && (
        <p className="mb-2 text-[11px] text-amber-400/80">{t("stageOfflineHint")}</p>
      )}
      {/* 面板常驻:离线时不隐藏,只是禁用控件,布局稳定 */}
      <div>
          {/* 坐标读数 */}
          <div className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
            {["x", "y", "z"].map((a) => (
              <div
                key={a}
                className={`rounded bg-slate-800 py-1 ${isHomed(a) ? "" : "opacity-50"}`}
                title={isHomed(a) ? t("stageHomed") : t("stageNotHomed")}
              >
                <div className="text-[10px] uppercase text-slate-400">{a}</div>
                <div className="font-mono">{pos ? pos[a].toFixed(2) : "—"}</div>
              </div>
            ))}
          </div>

          {/* 步进大小 */}
          <div className="mb-3 flex items-center gap-1 text-xs">
            <span className="text-slate-400">{t("stageStep")}</span>
            {STEPS.map((s) => (
              <button
                key={s}
                onClick={() => setStep(s)}
                className={`rounded px-2 py-0.5 ${
                  step === s ? "bg-cyan-700 text-white" : "bg-slate-800 text-slate-300"
                }`}
              >
                {s}
              </button>
            ))}
            <span className="text-slate-500">mm</span>
          </div>

          <div className="flex items-start gap-4">
            {/* XY 摇杆 */}
            <div>
              <div className="mb-1 text-center text-[10px] text-slate-500">XY</div>
              <div className="grid grid-cols-3 gap-1">
                <span />
                <JogBtn label="Y+" onClick={() => jog("Y", 1)} disabled={busy || !connected} />
                <span />
                <JogBtn label="X−" onClick={() => jog("X", -1)} disabled={busy || !connected} />
                <span />
                <JogBtn label="X+" onClick={() => jog("X", 1)} disabled={busy || !connected} />
                <span />
                <JogBtn label="Y−" onClick={() => jog("Y", -1)} disabled={busy || !connected} />
                <span />
              </div>
            </div>

            {/* Z (对焦) */}
            <div>
              <div className="mb-1 text-center text-[10px] text-slate-500">
                Z · {t("stageFocus")}
              </div>
              <div className="flex flex-col gap-1">
                <JogBtn label="Z+" onClick={() => jog("Z", 1)} disabled={busy || !connected} />
                <JogBtn label="Z−" onClick={() => jog("Z", -1)} disabled={busy || !connected} />
              </div>
            </div>
          </div>

          {/* 手动对焦:直接移到某个 Z。先手动大致对上焦,再自动对焦微调。 */}
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase text-slate-500">
              {t("stageSetZ")}
            </div>
            <div className="flex items-center gap-1 text-xs">
              <input
                type="number"
                step="0.1"
                placeholder="Z"
                value={gotoZ}
                onChange={(e) => setGotoZ(e.target.value)}
                className="w-16 rounded bg-slate-800 px-2 py-1"
              />
              <button
                onClick={goToZ}
                disabled={busy || !connected || !isHomed("z")}
                className="rounded bg-cyan-700 px-3 py-1 font-medium hover:bg-cyan-600 disabled:opacity-40"
              >
                {t("stageGo")}
              </button>
              <span className="text-[10px] text-slate-500">{t("stageSetZHint")}</span>
            </div>
          </div>

          {/* 自动对焦:以当前 Z 为中心 ±range 小步 (0.1mm) 扫描找清晰度峰值 */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={runAutofocus}
              disabled={busy || !connected || !isHomed("z")}
              title={t("stageAfHint")}
              className="rounded bg-cyan-800 px-3 py-1 font-medium hover:bg-cyan-700 disabled:opacity-40"
            >
              {afRunning ? t("stageAfRunning") : t("stageAutofocus")}
            </button>
            <label className="flex items-center gap-1 text-[10px] text-slate-400">
              ±
              <input
                type="number"
                step="0.5"
                min="0.1"
                value={afRange}
                onChange={(e) => setAfRange(Math.max(0.1, Number(e.target.value) || 1))}
                className="w-12 rounded bg-slate-800 px-1 py-0.5"
              />
              mm
            </label>
            <span className="text-[10px] text-slate-400">
              {roi ? t("stageAfTarget", roi.label || "?") : t("stageAfWhole")}
            </span>
            {afResult && afResult.best_z != null && (
              <span className="text-emerald-400">
                {t("stageAfResult", afResult.best_z)}
              </span>
            )}
          </div>

          {/* 绝对前往 (需先 home) */}
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase text-slate-500">
              {t("stageGoto")}
            </div>
            <div className="flex items-center gap-1 text-xs">
              <input
                type="number"
                placeholder="X"
                value={gotoX}
                onChange={(e) => setGotoX(e.target.value)}
                className="w-16 rounded bg-slate-800 px-2 py-1"
              />
              <input
                type="number"
                placeholder="Y"
                value={gotoY}
                onChange={(e) => setGotoY(e.target.value)}
                className="w-16 rounded bg-slate-800 px-2 py-1"
              />
              <button
                onClick={goTo}
                disabled={busy || !xyHomed}
                className="rounded bg-cyan-700 px-3 py-1 font-medium hover:bg-cyan-600 disabled:opacity-40"
              >
                {t("stageGo")}
              </button>
            </div>
          </div>

          {/* 已存位置 (示教 → 孔位表基础) */}
          <div className="mt-3">
            <div className="mb-1 text-[10px] uppercase text-slate-500">
              {t("stageSavedPos")}
            </div>
            <div className="mb-1 flex items-center gap-1 text-xs">
              <input
                type="text"
                placeholder={t("stagePosName")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="min-w-0 flex-1 rounded bg-slate-800 px-2 py-1"
              />
              <button
                onClick={savePosition}
                disabled={busy || !pos}
                className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-40"
              >
                {t("stageSaveCurrent")}
              </button>
            </div>
            {positions.length === 0 ? (
              <p className="text-[11px] text-slate-600">{t("stageNoSaved")}</p>
            ) : (
              <div className="max-h-32 space-y-0.5 overflow-y-auto">
                {positions.map((p) => (
                  <div key={p.name} className="flex items-center gap-1 text-xs">
                    <button
                      onClick={() => recall(p)}
                      disabled={busy || !xyHomed}
                      title={`X${p.x.toFixed(1)} Y${p.y.toFixed(1)}`}
                      className="flex-1 truncate rounded bg-slate-800 px-2 py-1 text-left hover:bg-cyan-800 disabled:opacity-40"
                    >
                      {p.name}
                      <span className="ml-1 font-mono text-[10px] text-slate-400">
                        {p.x.toFixed(0)},{p.y.toFixed(0)}
                      </span>
                    </button>
                    <button
                      onClick={() => remove(p.name)}
                      className="rounded bg-slate-700 px-1.5 py-1 text-slate-400 hover:bg-red-800 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 回零 */}
          <div className="mt-3 flex flex-wrap gap-1 text-xs">
            <button
              onClick={() => run(() => stageHome("XYZ"))}
              disabled={busy || !connected}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageHomeAll")}
            </button>
            <button
              onClick={() => run(() => stageHome("XY"))}
              disabled={busy || !connected}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageHomeXY")}
            </button>
            <button
              onClick={() => run(() => stageHome("Z"))}
              disabled={busy || !connected}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageHomeZ")}
            </button>
          </div>

          {/* 急停 / 复位 */}
          <div className="mt-2 flex gap-1 text-xs">
            <button
              onClick={() => {
                pauseAuto(true); // 主动急停:别再自动重连
                run(stageStop);
              }}
              disabled={!connected}
              className="flex-1 rounded bg-red-700 px-2 py-1 font-medium hover:bg-red-600 disabled:opacity-50"
            >
              {t("stageEstop")}
            </button>
            <button
              onClick={() => {
                pauseAuto(false); // 手动复位:重新启用自动重连
                run(stageFirmwareRestart);
              }}
              disabled={busy || !connected}
              className="rounded bg-slate-700 px-2 py-1 hover:bg-slate-600 disabled:opacity-50"
            >
              {t("stageRestart")}
            </button>
          </div>

          {!xyHomed && (
            <p className="mt-2 text-[11px] text-amber-400/80">{t("stageHomeHint")}</p>
          )}
          {err && <p className="mt-2 text-[11px] text-red-400">{err}</p>}
      </div>
    </div>
  );
}

function JogBtn({ label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded bg-slate-700 px-3 py-2 text-sm font-medium hover:bg-cyan-700 disabled:opacity-40"
    >
      {label}
    </button>
  );
}
