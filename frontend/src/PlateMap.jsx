import React from "react";
import { stageStatus, stageMove } from "./api";
import {
  BLOCK_ROWS,
  BLOCK_COLS,
  PLATE_KEY,
  two,
  bkey,
  blockLabel,
  keyLabel,
  loadPlateMap,
  blockCenter as blockCenterFor,
  cornersSet as cornersSetFor,
} from "./plateModel";

// 板面地图 (Phase 1):点方格 → 平台移到该格中心;每格可单独教一个对焦 Z。
// 模型/几何在 platemap.js (与巡扫 timelapse 共用)。全部存 localStorage。
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

  const blockCenter = (br, bc) => blockCenterFor(map.ref, br, bc);
  const blockZ = (br, bc) => map.z[bkey(br, bc)];
  const cornersSet = cornersSetFor(map.ref);

  const nearest = React.useMemo(() => {
    if (!pos || !cornersSet) return null;
    let best = null;
    let bestD = Infinity;
    for (let br = 0; br < BLOCK_ROWS; br++)
      for (let bc = 0; bc < BLOCK_COLS; bc++) {
        const p = blockCenter(br, bc);
        const d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = bkey(br, bc);
        }
      }
    return bestD < 100 ? best : null; // 10mm 内算「在这一格」
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, map.ref]);

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

  const teachCorner = (which) =>
    run(async () => {
      const s = await stageStatus();
      if (!s?.connected || !s.position) throw new Error("stage offline / no position");
      setMap((m) => ({
        ...m,
        ref: { ...m.ref, [which]: { x: two(s.position.x), y: two(s.position.y) } },
      }));
    });

  const goBlock = (br, bc) =>
    run(async () => {
      const p = blockCenter(br, bc);
      if (!p) throw new Error("teach A1, A12, H1 first");
      setSel(bkey(br, bc));
      await stageMove({ x: p.x, y: p.y, feed: 3000 });
      const z = blockZ(br, bc);
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
    ["a1", "A1"],
    ["a12", "A12"],
    ["h1", "H1"],
  ];

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Plate map</h3>
        <span className={`text-xs ${connected ? "text-emerald-400" : "text-slate-500"}`}>
          {connected ? (xyHomed ? "homed" : "not homed") : "offline"}
        </span>
      </div>

      {/* 教角孔:把相机对准该角孔中心,再点按钮 */}
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

      {/* 6 个成像方格 (2×3) */}
      <div
        className="mb-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${BLOCK_COLS}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: BLOCK_ROWS }).map((_, br) =>
          Array.from({ length: BLOCK_COLS }).map((__, bc) => {
            const k = bkey(br, bc);
            const p = blockCenter(br, bc);
            const z = blockZ(br, bc);
            const isSel = sel === k;
            const isHere = nearest === k;
            return (
              <button
                key={k}
                onClick={() => goBlock(br, bc)}
                disabled={busy || !connected || !cornersSet}
                title={p ? `${blockLabel(br, bc)} · X${p.x} Y${p.y}${z != null ? ` Z${z}` : ""}` : "teach corners"}
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
                  {blockLabel(br, bc)}
                </span>
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span className="grid grid-cols-4 gap-[2px] opacity-50">
                    {Array.from({ length: 16 }).map((_, i) => (
                      <span key={i} className="h-[3px] w-[3px] rounded-full bg-slate-500" />
                    ))}
                  </span>
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
          })
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={teachZ}
          disabled={busy || !connected || !(sel || nearest)}
          className="rounded bg-cyan-800 px-2 py-1 hover:bg-cyan-700 disabled:opacity-40"
        >
          Save focus Z → {keyLabel(sel || nearest)}
        </button>
        {pos && (
          <span className="font-mono text-[10px] text-slate-400">
            X{pos.x?.toFixed(1)} Y{pos.y?.toFixed(1)} Z{pos.z?.toFixed(1)}
          </span>
        )}
      </div>

      {!cornersSet && (
        <p className="mt-2 text-[11px] text-amber-400/80">
          Teach the three corner wells — A1, A12, H1 — to map the whole plate.
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
