import React from "react";
import { stageStatus, stageMove } from "./api";
import {
  FORMAT_LIST,
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

export default function PlateMap() {
  const [store, setStore] = React.useState(loadStore);
  const [st, setSt] = React.useState(null);
  const [sel, setSel] = React.useState(null); // 选中板内的方格 key
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");

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
  const blockZ = (k) => plate.z[k];

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
    try {
      await fn();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // ── 多板管理 ──
  const updatePlate = (fn) =>
    setStore((s) => ({
      ...s,
      plates: s.plates.map((p) => (p.id === s.selectedId ? fn(p) : p)),
    }));
  const selectPlate = (id) => {
    setSel(null);
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
  const setBlock = (field, v) =>
    updatePlate((p) => ({ ...p, [field]: Math.max(1, Number(v) || 1) }));

  const teachCorner = (which) =>
    run(async () => {
      const s = await stageStatus();
      if (!s?.connected || !s.position) throw new Error("stage offline / no position");
      updatePlate((p) => ({
        ...p,
        ref: { ...p.ref, [which]: { x: two(s.position.x), y: two(s.position.y) } },
      }));
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
      updatePlate((p) => ({ ...p, z: { ...p.z, [target]: two(z) } }));
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
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Stage map</h3>
        <span className={`text-xs ${connected ? "text-emerald-400" : "text-slate-500"}`}>
          {connected ? (xyHomed ? "homed" : "not homed") : "offline"}
        </span>
      </div>

      {/* 可达区插画:画出每块已放好的板 + 当前位置 */}
      <svg
        viewBox={`-4 -4 ${W + 8} ${H + 8}`}
        className="mb-2 w-full rounded border border-slate-700 bg-slate-950"
        style={{ maxHeight: 240 }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* 可达区边框 */}
        <rect
          x="0"
          y="0"
          width={W}
          height={H}
          fill="none"
          stroke="#334155"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        {store.plates.map((p) => {
          const q = plateQuad(p);
          const isSel = p.id === store.selectedId;
          if (!q) return null;
          const pts = q.map((pt) => `${sx(pt.x)},${sy(pt.y)}`).join(" ");
          const bb = plateBBox(p);
          return (
            <g key={p.id} onClick={() => selectPlate(p.id)} style={{ cursor: "pointer" }}>
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
        {/* 当前平台位置 */}
        {pos && xyHomed && (
          <circle
            cx={sx(pos.x)}
            cy={sy(pos.y)}
            r={Math.max(2, H / 60)}
            fill="#f59e0b"
            stroke="#fff"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* 板清单 */}
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
        {store.plates.map((p) => (
          <span
            key={p.id}
            className={`flex items-center gap-1 rounded px-2 py-0.5 ${
              p.id === store.selectedId
                ? "bg-cyan-800 text-cyan-100"
                : "bg-slate-800 text-slate-300"
            }`}
          >
            <button onClick={() => selectPlate(p.id)} title={cornersSetFor(p.ref) ? "placed" : "not placed yet"}>
              {p.name} · {p.format}
              {!cornersSetFor(p.ref) && " ·?"}
            </button>
            {store.plates.length > 1 && (
              <button
                onClick={() => removePlate(p.id)}
                className="text-slate-400 hover:text-red-300"
                title="remove"
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          onClick={addPlate}
          className="rounded bg-slate-700 px-2 py-0.5 hover:bg-slate-600"
        >
          + plate
        </button>
      </div>

      {/* 选中板:名字 + 板型 + 每帧几孔 */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <input
          value={plate.name}
          onChange={(e) => rename(e.target.value)}
          className="w-24 rounded bg-slate-800 px-2 py-0.5 text-slate-100"
        />
        <select
          value={plate.format}
          onChange={(e) => changeFormat(e.target.value)}
          className="rounded bg-slate-800 px-1 py-0.5 text-slate-100"
        >
          {FORMAT_LIST.map((f) => (
            <option key={f} value={f}>
              {f}-well
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1" title="相机一帧覆盖多少孔 (行×列)">
          wells/frame
          <input
            type="number"
            min="1"
            value={plate.blockR}
            onChange={(e) => setBlock("blockR", e.target.value)}
            className="w-10 rounded bg-slate-800 px-1 py-0.5"
          />
          ×
          <input
            type="number"
            min="1"
            value={plate.blockC}
            onChange={(e) => setBlock("blockC", e.target.value)}
            className="w-10 rounded bg-slate-800 px-1 py-0.5"
          />
        </label>
        <span className="text-slate-500">
          = {blocks.length} shot{blocks.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* 教角孔 */}
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
        <span className="text-slate-400">Teach corners:</span>
        {CORNERS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => teachCorner(k)}
            disabled={busy || !connected}
            title={plate.ref[k] ? `X${plate.ref[k].x} Y${plate.ref[k].y}` : "not set"}
            className={`rounded px-2 py-0.5 font-mono ${
              plate.ref[k] ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-300"
            } hover:bg-slate-600 disabled:opacity-40`}
          >
            {label}
            {plate.ref[k] ? " ✓" : ""}
          </button>
        ))}
      </div>

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
            const isSel = sel === b.key;
            const isHere = nearest === b.key;
            return (
              <button
                key={b.key}
                onClick={() => goBlock(b)}
                disabled={busy || !connected || !cornersSet}
                title={p ? `${b.label} · X${p.x} Y${p.y}${z != null ? ` Z${z}` : ""}` : "teach corners"}
                className={`relative aspect-square rounded border text-xs transition ${
                  isSel
                    ? "border-cyan-400 bg-cyan-900/60"
                    : isHere
                    ? "border-amber-400 bg-amber-900/40"
                    : cornersSet
                    ? "border-slate-600 bg-slate-800 hover:bg-cyan-800"
                    : "border-slate-700 bg-slate-800/40"
                } disabled:cursor-not-allowed`}
              >
                <span className="absolute left-1 top-0.5 font-mono text-[11px] text-slate-300">
                  {b.label}
                </span>
                {z != null && (
                  <span className="absolute bottom-0.5 right-1 text-[9px] text-emerald-400">
                    Z{z}
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
          disabled={busy || !connected || !(sel || nearest)}
          className="rounded bg-cyan-800 px-2 py-1 hover:bg-cyan-700 disabled:opacity-40"
        >
          Save focus Z → {keyLabel(plate, sel || nearest)}
        </button>
        {pos && (
          <span className="font-mono text-[10px] text-slate-400">
            X{pos.x?.toFixed(1)} Y{pos.y?.toFixed(1)} Z{pos.z?.toFixed(1)}
          </span>
        )}
      </div>

      {!cornersSet && (
        <p className="mt-2 text-[11px] text-amber-400/80">
          Teach {plate.name}'s corners — {corners.tl} / {corners.tr} / {corners.bl} — to place it on the map.
        </p>
      )}
      {cornersSet && !xyHomed && (
        <p className="mt-2 text-[11px] text-amber-400/80">
          Home once (or Force move) so click-to-go has a real coordinate frame.
        </p>
      )}
      {err && <p className="mt-2 text-[11px] text-red-400">{err}</p>}
    </div>
  );
}
