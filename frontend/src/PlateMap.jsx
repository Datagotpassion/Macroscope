import React from "react";
import { stageStatus, stageMove } from "./api";
import {
  FORMAT_LIST,
  PLATE_KEY,
  two,
  cornerWells,
  cornersSet as cornersSetFor,
  blockDims,
  listBlocks,
  blockCenter as blockCenterFor,
  keyLabel,
  loadPlateMap,
  defaultMap,
} from "./plateModel";

// 板面地图:选板型 (6/12/24/48/96) → 教 3 个角孔 → 仿射算出每个孔 → 分成成像方格。
// 点方格 → 平台移到该格中心;每格可单独教一个对焦 Z。全部存 localStorage。
// 真实坐标依赖「先 home 一次」建立坐标系 (或用 Force move 临时建一个)。

export default function PlateMap() {
  const [map, setMap] = React.useState(loadPlateMap);
  const [st, setSt] = React.useState(null);
  const [sel, setSel] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");

  React.useEffect(() => {
    localStorage.setItem(PLATE_KEY, JSON.stringify(map));
  }, [map]);

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

  const connected = st?.connected;
  const pos = st?.position;
  const homed = (st?.homed || "").toLowerCase();
  const xyHomed = homed.includes("x") && homed.includes("y");

  const corners = cornerWells(map); // {tl,tr,bl} 显示名,随板型变化
  const blocks = listBlocks(map);
  const { nR, nC } = blockDims(map);
  const cornersSet = cornersSetFor(map.ref);
  const blockZ = (k) => map.z[k];

  const nearest = React.useMemo(() => {
    if (!pos || !cornersSet) return null;
    let best = null;
    let bestD = Infinity;
    for (const b of blocks) {
      const p = blockCenterFor(map, b);
      if (!p) continue;
      const d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b.key;
      }
    }
    return bestD < 100 ? best : null; // 10mm 内算「在这一格」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, map]);

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

  // 换板型:角坐标与板型绑定 (不同板 A1 位置不同),重置地图,重新教。
  const changeFormat = (fmt) => {
    setSel(null);
    setMap(defaultMap(Number(fmt)));
  };

  const setBlock = (field, v) => {
    const n = Math.max(1, Number(v) || 1);
    setMap((m) => ({ ...m, [field]: n }));
  };

  const teachCorner = (which) =>
    run(async () => {
      const s = await stageStatus();
      if (!s?.connected || !s.position) throw new Error("stage offline / no position");
      setMap((m) => ({
        ...m,
        ref: { ...m.ref, [which]: { x: two(s.position.x), y: two(s.position.y) } },
      }));
    });

  const goBlock = (b) =>
    run(async () => {
      const p = blockCenterFor(map, b);
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
      setMap((m) => ({ ...m, z: { ...m.z, [target]: two(z) } }));
    });

  const CORNERS = [
    ["tl", corners.tl],
    ["tr", corners.tr],
    ["bl", corners.bl],
  ];

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Plate map</h3>
        <span className={`text-xs ${connected ? "text-emerald-400" : "text-slate-500"}`}>
          {connected ? (xyHomed ? "homed" : "not homed") : "offline"}
        </span>
      </div>

      {/* 板型 + 每帧几孔 */}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <label className="flex items-center gap-1">
          Plate
          <select
            value={map.format}
            onChange={(e) => changeFormat(e.target.value)}
            className="rounded bg-slate-800 px-1 py-0.5 text-slate-100"
          >
            {FORMAT_LIST.map((f) => (
              <option key={f} value={f}>
                {f}-well
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1" title="相机一帧覆盖多少孔 (行×列)">
          wells/frame
          <input
            type="number"
            min="1"
            value={map.blockR}
            onChange={(e) => setBlock("blockR", e.target.value)}
            className="w-10 rounded bg-slate-800 px-1 py-0.5"
          />
          ×
          <input
            type="number"
            min="1"
            value={map.blockC}
            onChange={(e) => setBlock("blockC", e.target.value)}
            className="w-10 rounded bg-slate-800 px-1 py-0.5"
          />
        </label>
        <span className="text-slate-500">
          = {blocks.length} shot{blocks.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* 教角孔 */}
      <div className="mb-1 text-[11px] text-slate-400">
        Center the camera on each corner well, then teach it:
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
        {CORNERS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => teachCorner(k)}
            disabled={busy || !connected}
            title={map.ref[k] ? `X${map.ref[k].x} Y${map.ref[k].y}` : "not set"}
            className={`rounded px-2 py-0.5 font-mono ${
              map.ref[k] ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-300"
            } hover:bg-slate-600 disabled:opacity-40`}
          >
            Teach {label}
            {map.ref[k] ? " ✓" : ""}
          </button>
        ))}
      </div>

      {/* 成像方格网 */}
      <div
        className="mb-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${nC}, minmax(0, 1fr))` }}
      >
        {blocks
          .slice()
          .sort((a, b) => a.ri - b.ri || a.ci - b.ci) // 显示按行列,不按蛇形
          .map((b) => {
            const p = blockCenterFor(map, b);
            const z = blockZ(b.key);
            const isSel = sel === b.key;
            const isHere = nearest === b.key;
            return (
              <button
                key={b.key}
                onClick={() => goBlock(b)}
                disabled={busy || !connected || !cornersSet}
                title={p ? `${b.label} · X${p.x} Y${p.y}${z != null ? ` Z${z}` : ""}` : "teach corners"}
                className={`relative aspect-square rounded border transition ${
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
                  <span className="absolute bottom-0.5 left-1 text-[9px] text-amber-300">•here</span>
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
          Save focus Z → {keyLabel(map, sel || nearest)}
        </button>
        {pos && (
          <span className="font-mono text-[10px] text-slate-400">
            X{pos.x?.toFixed(1)} Y{pos.y?.toFixed(1)} Z{pos.z?.toFixed(1)}
          </span>
        )}
      </div>

      {!cornersSet && (
        <p className="mt-2 text-[11px] text-amber-400/80">
          Teach the three corner wells — {corners.tl} / {corners.tr} / {corners.bl} — to map the plate.
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
