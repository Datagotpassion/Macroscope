import React from "react";
import { stageStatus, stageMove, stageWait, alignCalibration, alignCalibrate, plateFind } from "./api";
import { useI18n } from "./i18n.jsx";
import {
  scanPlate,
  isScanningPlate,
  fileStamp,
  safeName,
  STORE_EVENT,
  SCAN_LOG_SUFFIX,
  getFullRes,
  setFullRes,
} from "./scanRunner";
import { chooseFolder, currentFolderName } from "./save";
import {
  FORMAT_LIST,
  ROW_LETTERS,
  STORE_KEY,
  two,
  cornerWells,
  cornersSet as cornersSetFor,
  blockDims,
  listBlocks,
  blockCenter as blockCenterFor,
  keyLabel,
  loadStore,
  selectedPlate,
  newPlate,
  plateQuad,
  plateBBox,
} from "./plateModel";

// 载物台地图:整个可达区域里放多块板 (每块 6/12/24/48/96 孔任选)。
// 上方插画按真实坐标画出可达区 + 每块板的位置 + 当前平台位置,点板即选中。
// 下方对选中板:选板型、每帧几孔、教 3 个角孔、点方格前往、每格教对焦 Z。
// 坐标持久化 (localStorage);真实定位依赖「先 home 一次」建立坐标系。

const DEF_ENV = { minX: 0, minY: 0, maxX: 325, maxY: 230 }; // 兜底可达区

// 「拍全板」结果:板角核验、每格的最终高度、对焦/对正验收、成功与否、地图有没有修正
const FOCUS_TEXT = {
  refocused: "refocused",
  sharp_kept: "sharp, kept",
  empty: "empty wells",
  off: "autofocus off",
  no_peak: "no peak, kept Z",
  unknown: "not assessed",
  off_plane: "off the well-bottom plane",
  plane_kept: "no peak, kept plate plane",
  unchecked: "not checked (format)",
};
const POSITION_TEXT = {
  confirmed: "edge-verified",
  aligned: "aligned",
  edge_mismatch: "plate edge mismatch",
  unaligned: "not aligned",
  unchecked: "map only (format)",
};
const positionText = (r) => {
  const v = r.verdict;
  if (!v) return r.info ? "n/a" : "–";
  const res = r.info?.residual_mm;
  return `${POSITION_TEXT[v.position] || v.position}${res != null ? ` (${res} mm)` : ""}`;
};

function ScanSummary({ res, canUndo, onUndo }) {
  const c = res.corner;
  return (
    <div className="mb-2 rounded border border-slate-700 p-2 text-[11px]">
      <div className={res.failed || res.unverified ? "text-amber-400" : "text-emerald-400"}>
        {res.plate}: {res.ok}/{res.results.length} blocks saved
        {(() => {
          const sz = res.results.find((r) => r.info?.size)?.info.size;
          return sz ? ` (${sz[0]}×${sz[1]})` : "";
        })()}{" "}
        in {Math.round(res.ms / 1000)} s
        {res.failed ? ` — ${res.failed} failed` : ""}
        {res.unverified ? ` — ${res.unverified} saved as UNVERIFIED` : ""}
        {` · ${res.analysisReady ?? 0}/${res.ok} analysis-ready`}
      </div>
      {res.logFailures > 0 && (
        <div className="text-red-400">
          Scan log: {res.logFailures} row(s) could not be written — check the save folder
        </div>
      )}
      <div className={c?.ok ? "text-emerald-400" : "text-amber-400"}>
        {c == null
          ? "A1 corner check: not run (not possible for this plate format, or not supported by this Pi version)"
          : c.ok
          ? `A1 corner check passed (A1 off the map by ${c.a1_error_mm?.map((v) => v.toFixed(2)).join(", ")} mm)`
          : c.status === "inconclusive"
          ? `A1 corner check inconclusive: ${c.reason} — well identity not verified this round; map not changed`
          : `A1 corner check FAILED: ${c.reason} — photos marked UNVERIFIED; re-find the plate`}
      </div>
      {res.shift?.apply ? (
        <div className="text-cyan-300">
          Plate map corrected: blocks were off by ~({res.shift.mean[0]}, {res.shift.mean[1]}) mm
          (up to {res.shift.max} mm at a corner
          {res.shift.kind === "affine" ? ", incl. a slight rotation/scale" : ""}; {res.shift.drift} mm
          from the last found position) — next scan
          should land on target.{" "}
          {canUndo && (
            <button onClick={onUndo} className="underline hover:text-cyan-100">
              undo
            </button>
          )}
        </div>
      ) : (
        res.shift?.reason && <div className="text-slate-400">Plate map: {res.shift.reason}</div>
      )}
      <table className="mt-1 w-full text-left text-slate-300">
        <thead className="text-slate-500">
          <tr>
            <th className="font-normal">block</th>
            <th className="font-normal">Z mm</th>
            <th className="font-normal">focus</th>
            <th className="font-normal">position</th>
            <th className="font-normal" />
          </tr>
        </thead>
        <tbody>
          {res.results.map((r) => (
            <tr key={r.label} title={(r.verdict?.issues || []).join(" | ")}>
              <td className="font-mono">{r.label}</td>
              <td>{r.info?.z ?? "–"}</td>
              <td>{r.verdict ? FOCUS_TEXT[r.verdict.focus] || r.verdict.focus : "–"}</td>
              <td>{positionText(r)}</td>
              <td
                className={
                  !r.ok
                    ? "text-red-400"
                    : r.verdict?.unverified
                    ? "text-amber-400"
                    : r.verdict?.analysisReady
                    ? "text-emerald-400"
                    : "text-sky-300"
                }
              >
                {!r.ok
                  ? `✗ ${r.error}`
                  : r.verdict?.unverified
                  ? "⚠ UNVERIFIED"
                  : r.verdict?.analysisReady
                  ? "✓"
                  : "✓ review"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const AUTO_FORMATS = [24, 48, 96]; // 自动找板支持的板型 (一帧里要看得到足够多的孔)

export default function PlateMap({ experiment = "" }) {
  const { t } = useI18n();
  const [store, setStore] = React.useState(loadStore);
  const [scanRes, setScanRes] = React.useState(null); // 上一次「拍全板」的汇总
  const stopRef = React.useRef(false);

  // 扫描 (这里或延时巡扫) 写回了对焦记忆 → 重新读,免得用旧状态覆盖
  React.useEffect(() => {
    const reload = () => setStore(loadStore());
    window.addEventListener(STORE_EVENT, reload);
    return () => window.removeEventListener(STORE_EVENT, reload);
  }, []);
  const [st, setSt] = React.useState(null);
  const [sel, setSel] = React.useState(null); // 选中板内的方格 key
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [cal, setCal] = React.useState(null); // 相机↔平台标定 (null = 未标定)
  const [job, setJob] = React.useState(""); // 正在跑的长任务说明
  const [info, setInfo] = React.useState(""); // 上一个任务的结果
  const [scanning, setScanning] = React.useState(false); // 「拍全板」进行中 (显示 Stop)
  const [fullRes, setFullResState] = React.useState(getFullRes); // 最终照片 12MP / 3MP

  React.useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }, [store]);

  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await stageStatus();
        if (alive) setSt(s);
      } catch {
        if (alive) setSt({ connected: false });
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const plate = selectedPlate(store);
  const connected = st?.connected;

  React.useEffect(() => {
    if (!connected) return;
    alignCalibration()
      .then((c) => setCal(c && c.M ? c : null))
      .catch(() => {});
  }, [connected]);
  const calOk = !!cal;
  const pos = st?.position;
  const homed = (st?.homed || "").toLowerCase();
  const xyHomed = homed.includes("x") && homed.includes("y");

  // 可达区 (Klipper 报的行程上下限;没有就兜底)。
  const env = React.useMemo(() => {
    const lo = st?.axis_minimum;
    const hi = st?.axis_maximum;
    if (Array.isArray(lo) && Array.isArray(hi))
      return { minX: lo[0], minY: lo[1], maxX: hi[0], maxY: hi[1] };
    return DEF_ENV;
  }, [st]);

  const corners = cornerWells(plate);
  const blocks = listBlocks(plate);
  const { nC } = blockDims(plate);
  const cornersSet = cornersSetFor(plate.ref);
  const a1 = plate.ref?.tl;
  const hasA1 = Number.isFinite(a1?.x) && Number.isFinite(a1?.y);
  const a1InRange = hasA1 && a1.x >= env.minX && a1.x <= env.maxX && a1.y >= env.minY && a1.y <= env.maxY;
  const motionBusy = busy || isScanningPlate();
  const stageReady = connected && st.state === "ready" && xyHomed;
  let navigationHint = "";
  if (!hasA1) navigationHint = t("mapNeedA1");
  else if (!a1InRange) navigationHint = t("mapOutOfRange");
  else if (!connected) navigationHint = t("mapConnectHint");
  else if (!stageReady) navigationHint = t("mapHomeHint");
  else if (isScanningPlate()) navigationHint = t("mapScanBusy");
  // 前往方格时的高度:手教的优先,其次自动对焦记忆
  const blockZ = (k) => plate.zTaught?.[k] ?? plate.z?.[k];

  const nearest = React.useMemo(() => {
    if (!pos || !cornersSet) return null;
    let best = null;
    let bestD = Infinity;
    for (const b of blocks) {
      const p = blockCenterFor(plate, b);
      if (!p) continue;
      const d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b.key;
      }
    }
    return bestD < 100 ? best : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, plate]);

  const run = async (fn) => {
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      await fn();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
      setJob("");
    }
  };

  // ── 自动找板 ──
  const goToA1 = () =>
    run(async () => {
      if (isScanningPlate()) throw new Error(t("mapScanBusy"));
      if (!stageReady || !a1InRange) return;
      setJob(t("mapGoing", plate.name));
      setSel(null);
      await stageMove({ x: a1.x, y: a1.y, feed: 3000 });
      await stageWait();
      setInfo(t("mapArrived", plate.name));
    });

  const calibrate = () =>
    run(async () => {
      setJob(t("mapCalibrating"));
      const c = await alignCalibrate(AUTO_FORMATS.includes(plate.format) ? plate.format : null);
      setCal(c);
      setInfo(t("mapCalResult", c.px_per_mm?.toFixed(2), c.repeatability_mm, c.focus?.z));
    });

  const findPlate = () =>
    run(async () => {
      const id = plate.id; // 任务要跑 1–2 分钟,中途切换了选中板也写回这块板
      const name = plate.name;
      setJob(t("mapFinding", name));
      const r = await plateFind(plate.format);
      setStore((s) => ({
        ...s,
        plates: s.plates.map((p) =>
          p.id === id ? { ...p, ref: r.ref, refBase: r.ref, refPrev: undefined } : p
        ),
      }));
      setInfo(t("mapFound", name, r.pitch_mm, r.angle_deg));
    });

  // 一键拍全板:自检 → 每格对正 + 按需对焦 + 拍照 → 存到 PC 文件夹 → 失败补拍 → 汇总
  const scanNow = async () => {
    if (!currentFolderName()) {
      const f = await chooseFolder();
      if (!f) return setErr("choose a folder to save the images first");
    }
    const id = plate.id;
    const name = plate.name;
    stopRef.current = false;
    setScanRes(null);
    setScanning(true);
    await run(async () => {
      setJob(`Scanning ${name}…`);
      const res = await scanPlate(id, {
        nameFor: (b, camera) =>
          safeName([camera === "mock-forced" && "MOCK", experiment || "scan", name, b.label, fileStamp()]),
        logName: safeName([experiment || "scan", name, SCAN_LOG_SUFFIX], ".csv"),
        onProgress: (t) => setJob(`Scanning ${name} — ${t}`),
        shouldStop: () => stopRef.current,
      });
      setScanRes(res);
    });
    setScanning(false);
  };

  // ── 多板管理 ──
  const updatePlate = (fn) =>
    setStore((s) => ({
      ...s,
      plates: s.plates.map((p) => (p.id === s.selectedId ? fn(p) : p)),
    }));
  const selectPlate = (id) => {
    setSel(null);
    setInfo("");
    setErr("");
    setStore((s) => ({ ...s, selectedId: id }));
  };
  const addPlate = () =>
    setStore((s) => {
      const p = newPlate(96, `Plate ${s.plates.length + 1}`);
      return { plates: [...s.plates, p], selectedId: p.id };
    });
  const removePlate = (id) =>
    setStore((s) => {
      const plates = s.plates.filter((p) => p.id !== id);
      if (!plates.length) plates.push(newPlate(96, "Plate 1"));
      const selectedId = plates.some((p) => p.id === s.selectedId)
        ? s.selectedId
        : plates[0].id;
      return { plates, selectedId };
    });

  // ── 选中板编辑 ──
  const rename = (name) => updatePlate((p) => ({ ...p, name }));
  const changeFormat = (fmt) => {
    setSel(null);
    updatePlate((p) => ({ ...newPlate(Number(fmt), p.name), id: p.id }));
  };
  // 改分格:对焦记忆按格子编号 (行,列) 存,分格一变同一个编号就是另一片区域 → 清掉
  const setBlock = (field, v) =>
    updatePlate((p) => {
      const n = Math.max(1, Number(v) || 1);
      return n === p[field] ? p : { ...p, [field]: n, z: {}, zSharp: {}, zTaught: {} };
    });
  // 撤销上一次扫描对地图的自动修正
  const undoShift = () =>
    updatePlate((p) => (p.refPrev ? { ...p, ref: p.refPrev, refPrev: undefined } : p));

  const teachCorner = (which) =>
    run(async () => {
      const s = await stageStatus();
      if (!s?.connected || s.state !== "ready" || !s.homed?.includes("x") || !s.homed?.includes("y") ||
          !Number.isFinite(s.position?.x) || !Number.isFinite(s.position?.y)) {
        throw new Error(t("mapHomeHint"));
      }
      updatePlate((p) => {
        const ref = { ...p.ref, [which]: { x: two(s.position.x), y: two(s.position.y) } };
        return { ...p, ref, refBase: ref, refPrev: undefined };
      });
      setInfo(t("mapRecorded", plate.name, corners[which]));
    });

  const goBlock = (b) =>
    run(async () => {
      const p = blockCenterFor(plate, b);
      if (!p) throw new Error("teach the 3 corners first");
      setSel(b.key);
      await stageMove({ x: p.x, y: p.y, feed: 3000 });
      const z = blockZ(b.key);
      if (z != null) await stageMove({ z, feed: 600 });
    });

  const teachZ = () =>
    run(async () => {
      const target = sel || nearest;
      if (!target) throw new Error("select a square first");
      const s = await stageStatus();
      const z = s?.position?.z;
      if (z == null) throw new Error("no Z position");
      // 手教高度单独存:只用于这一格,不参与「孔底平面」投票,也不会被自动对焦改写
      updatePlate((p) => ({ ...p, zTaught: { ...(p.zTaught || {}), [target]: two(z) } }));
    });

  // 载物台坐标 → SVG (Y 翻转朝上)
  const W = Math.max(1, env.maxX - env.minX);
  const H = Math.max(1, env.maxY - env.minY);
  const sx = (x) => x - env.minX;
  const sy = (y) => env.maxY - y;

  const CORNERS = [
    ["tl", corners.tl],
    ["tr", corners.tr],
    ["bl", corners.bl],
  ];

  return (
    <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-3.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold tracking-tight">{t("mapTitle")}</h3>
        <span className={`flex items-center gap-1.5 text-xs ${stageReady ? "text-emerald-300" : "text-amber-300"}`}>
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
          {connected ? (st.state !== "ready" ? st.state || t("mapOffline") : xyHomed ? t("mapHomed") : t("mapUnhomed")) : t("mapOffline")}
        </span>
      </div>

      {/* 可达区插画:画出每块已放好的板 + 当前位置 */}
      <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
        <svg
          aria-label={t("mapTitle")}
          viewBox={`-12 -10 ${W + 24} ${H + 26}`}
          className="block max-h-60 w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            <pattern id="stage-map-grid" width="25" height="25" patternUnits="userSpaceOnUse" y={H}>
              <path d="M 25 0 H 0 V 25" fill="none" stroke="#263748" strokeWidth="1" />
            </pattern>
          </defs>
          <rect
            x="0"
            y="0"
            width={W}
            height={H}
            fill="url(#stage-map-grid)"
            stroke="#334155"
            vectorEffect="non-scaling-stroke"
          />
          <g fontSize="11" fill="#94a3b8" fontFamily="monospace">
            <text x="0" y={H + 13}>{env.minX}</text>
            <text x={W} y={H + 13} textAnchor="end">X {env.maxX} mm</text>
            <text x="3" y="12">Y {env.maxY}</text>
          </g>
          {store.plates.map((p) => {
            const q = plateQuad(p);
            const isSel = p.id === store.selectedId;
            if (!q) return null;
            const pts = q.map((pt) => `${sx(pt.x)},${sy(pt.y)}`).join(" ");
            const bb = plateBBox(p);
            return (
              <g key={p.id} onClick={() => !busy && selectPlate(p.id)} className={busy ? "" : "cursor-pointer"}>
                <polygon
                  points={pts}
                  fill={isSel ? "rgba(6,182,212,0.30)" : "rgba(100,116,139,0.20)"}
                  stroke={isSel ? "#22d3ee" : "#64748b"}
                  strokeWidth={isSel ? 1.5 : 1}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={sx(bb.cx)}
                  y={sy(bb.cy)}
                  fill={isSel ? "#a5f3fc" : "#cbd5e1"}
                  fontSize={Math.max(6, H / 22)}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {p.name} · {p.format}
                </text>
              </g>
            );
          })}
          {hasA1 && a1InRange && (
            <g transform={`translate(${sx(a1.x)} ${sy(a1.y)})`} fill="#67e8f9">
              <title>{t("mapSavedA1")}</title>
              <path d="M 0 -5 L 5 0 L 0 5 L -5 0 Z" />
              <text x={sx(a1.x) > W - 24 ? -8 : 8} y="4" textAnchor={sx(a1.x) > W - 24 ? "end" : "start"}
                fontSize="12" fontFamily="monospace" paintOrder="stroke" stroke="#020617" strokeWidth="2">A1</text>
            </g>
          )}
          {pos && xyHomed && (
            <g transform={`translate(${sx(pos.x)} ${sy(pos.y)})`} stroke="#fbbf24" fill="none">
              <title>{t("mapPosition")}</title>
              <circle r="7" strokeWidth="1.5" />
              <path d="M-11 0h6 M5 0h6 M0 -11v6 M0 5v6" strokeWidth="2" />
            </g>
          )}
        </svg>
        <div className="flex flex-wrap items-center justify-between gap-x-2 border-t border-slate-800 px-3 py-2 text-xs">
          <span className="flex items-center gap-2 text-slate-300">
            <span aria-hidden="true" className="h-2 w-2 rounded-full border border-amber-400" />{t("mapPosition")}
          </span>
          <span className="font-mono tabular-nums text-slate-300">
            {pos && xyHomed ? `X ${pos.x?.toFixed(1)} · Y ${pos.y?.toFixed(1)} mm` : "—"}
          </span>
        </div>
      </div>

      {/* 板清单 */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {store.plates.map((p) => (
          <span
            key={p.id}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 ${
              p.id === store.selectedId
                ? "border-cyan-600/60 bg-cyan-950 text-cyan-200"
                : "border-slate-700 bg-slate-800 text-slate-300"
            }`}
          >
            <button onClick={() => selectPlate(p.id)} disabled={busy} aria-pressed={p.id === plate.id}>
              {p.name} · {t("mapFormat", p.format)}
            </button>
            {store.plates.length > 1 && (
              <button
                onClick={() => removePlate(p.id)}
                disabled={busy}
                className="text-slate-400 hover:text-red-300"
                aria-label={t("mapRemove", p.name)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          onClick={addPlate}
          disabled={busy}
          className="rounded-md border border-dashed border-slate-600 px-2 py-1 text-slate-300 hover:border-slate-400"
        >
          + {t("mapAdd")}
        </button>
      </div>

      <div className="rounded-lg border border-cyan-900 bg-cyan-950/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h4 className="font-semibold text-slate-100">{t("mapSavedA1")}</h4>
          <span className="font-mono text-xs tabular-nums text-cyan-200">
            {hasA1 ? `X ${a1.x.toFixed(2)} · Y ${a1.y.toFixed(2)} mm` : t("mapUnset")}
          </span>
        </div>
        <button onClick={goToA1} disabled={busy || !!navigationHint}
          className="mt-2.5 w-full rounded-md bg-cyan-300 px-3 py-2 font-semibold text-slate-950 hover:bg-cyan-200 disabled:bg-slate-700 disabled:text-slate-400">
          {t("mapGoA1")}
        </button>
        {navigationHint && <p className="mt-2 text-xs text-slate-300">{navigationHint}</p>}
      </div>
      {job && <p role="status" className="text-xs text-cyan-200">{job}</p>}
      {info && <p role="status" className="text-xs text-emerald-300">{info}</p>}
      {err && <p role="alert" className="rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-200">{err}</p>}

      <details key={plate.id} open={!cornersSet} className="rounded-lg border border-slate-700">
        <summary className="cursor-pointer px-3 py-2.5 font-medium text-slate-200">{t("mapSetup")}</summary>
        <fieldset disabled={busy} className="space-y-3 border-t border-slate-700 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
            <input
              aria-label={t("mapPlateName")}
              value={plate.name}
              onChange={(e) => rename(e.target.value)}
              className="w-24 rounded bg-slate-800 px-2 py-0.5 text-slate-100"
            />
            <select
              aria-label={t("mapPlateFormat")}
              value={plate.format}
              onChange={(e) => changeFormat(e.target.value)}
              className="rounded bg-slate-800 px-1 py-0.5 text-slate-100"
            >
              {FORMAT_LIST.map((f) => (
                <option key={f} value={f}>
                  {t("mapFormat", f)}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              {t("mapBlockSize")}
              <input
                aria-label={t("mapRows")}
                type="number"
                min="1"
                value={plate.blockR}
                onChange={(e) => setBlock("blockR", e.target.value)}
                className="w-10 rounded bg-slate-800 px-1 py-0.5"
              />
              ×
              <input
                aria-label={t("mapCols")}
                type="number"
                min="1"
                value={plate.blockC}
                onChange={(e) => setBlock("blockC", e.target.value)}
                className="w-10 rounded bg-slate-800 px-1 py-0.5"
              />
            </div>
          </div>

          {/* 教角孔 */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-300">{t("mapRecordPosition")}</span>
            {CORNERS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => teachCorner(k)}
                disabled={motionBusy || !stageReady}
                title={plate.ref[k] ? `X ${plate.ref[k].x} · Y ${plate.ref[k].y} mm` : t("mapUnset")}
                aria-label={t("mapRecordCorner", label)}
                className={`rounded px-2 py-0.5 font-mono ${
                  plate.ref[k] ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-300"
                } hover:bg-slate-600 disabled:opacity-40`}
              >
                {label}
                {plate.ref[k] ? " ✓" : ""}
              </button>
            ))}
          </div>

          {/* 自动:相机标定 (一次性) + 从 A1 附近自动定位三个角 */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={calibrate}
              disabled={motionBusy || !stageReady}
              title={t("mapCalHint")}
              className={`rounded px-2 py-0.5 ${
                calOk ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-300"
              } hover:bg-slate-600 disabled:opacity-40`}
            >
              {calOk ? t("mapRecalibrate") : t("mapCalibrate")}
            </button>
            <button
              onClick={findPlate}
              disabled={
                motionBusy || !stageReady || !calOk || !AUTO_FORMATS.includes(plate.format)
              }
              aria-describedby="map-find-hint"
              className="rounded border border-slate-600 px-2 py-1 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              {t("mapFind")}
            </button>
          </div>
          <p id="map-find-hint" className="text-xs leading-relaxed text-slate-400">
            {AUTO_FORMATS.includes(plate.format) ? t("mapFindHint") : t("mapManualHint")}
          </p>
        </fieldset>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-700 pt-3">
        <h4 className="font-medium">{t("mapBlocks", blocks.length)}</h4>
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={scanNow}
            disabled={motionBusy || !connected || !calOk || !cornersSet}
            className="rounded bg-emerald-700 px-2 py-0.5 hover:bg-emerald-600 disabled:opacity-40"
          >
            {t("mapScan")}
          </button>
          {scanning && (
            <button
              onClick={() => (stopRef.current = true)}
              className="rounded bg-red-700 px-2 py-0.5 hover:bg-red-600"
              title={t("mapStopHint")}
            >
              {t("stop")}
            </button>
          )}
          <label
            className="flex items-center gap-1 text-slate-300"
            title={t("mapResolutionHint")}
          >
            <input
              type="checkbox"
              checked={fullRes}
              disabled={busy}
              onChange={(e) => {
                setFullRes(e.target.checked);
                setFullResState(e.target.checked);
              }}
            />
            12MP
          </label>
        </div>
      </div>
      {scanRes && (
        <ScanSummary
          res={scanRes}
          canUndo={!!plate.refPrev && scanRes.plate === plate.name}
          onUndo={undoShift}
        />
      )}

      {/* 选中板的成像方格网 */}
      <div
        className="mb-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${nC}, minmax(0, 1fr))` }}
      >
        {blocks
          .slice()
          .sort((a, b) => a.ri - b.ri || a.ci - b.ci)
          .map((b) => {
            const p = blockCenterFor(plate, b);
            const z = blockZ(b.key);
            const taught = plate.zTaught?.[b.key] != null;
            const isSel = sel === b.key;
            const isHere = nearest === b.key;
            const lastWell = `${ROW_LETTERS[b.rLast]}${b.cLast + 1}`;
            const range = lastWell === b.label ? b.label : `${b.label}–${lastWell}`;
            return (
              <button
                key={b.key}
                onClick={() => goBlock(b)}
                disabled={motionBusy || !stageReady || !cornersSet}
                aria-label={t("mapGoBlock", range)}
                title={
                  p
                    ? `${t("mapGoBlock", range)} · X ${p.x} Y ${p.y}${z != null ? ` Z ${z}` : ""}`
                    : t("mapNeedCorners")
                }
                className={`relative flex min-h-9 min-w-0 flex-col items-center justify-center rounded border py-1 text-xs transition ${
                  isSel
                    ? "border-cyan-400 bg-cyan-900/60"
                    : isHere
                    ? "border-amber-400 bg-amber-900/40"
                    : cornersSet
                    ? "border-slate-600 bg-slate-800 hover:bg-cyan-800"
                    : "border-slate-700 bg-slate-800/40"
                } disabled:cursor-not-allowed`}
              >
                <span className="max-w-full truncate font-mono text-[11px] text-slate-200">
                  {range}
                </span>
                {z != null && (
                  <span
                    className={`text-[10px] ${
                      taught ? "text-amber-300" : "text-emerald-400"
                    }`}
                  >
                    Z{z}
                    {taught ? "✎" : ""}
                  </span>
                )}
                {isHere && (
                  <span className="absolute bottom-0.5 left-1 text-[9px] text-amber-300">•</span>
                )}
              </button>
            );
          })}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={teachZ}
          disabled={motionBusy || !connected || !(sel || nearest)}
          className="rounded bg-cyan-800 px-2 py-1 hover:bg-cyan-700 disabled:opacity-40"
        >
          {t("mapSaveZ", sel || nearest ? keyLabel(plate, sel || nearest) : null)}
        </button>
        {pos && (
          <span className="font-mono text-[10px] text-slate-400">
            Z {pos.z?.toFixed(2)} mm
          </span>
        )}
      </div>

    </div>
  );
}
