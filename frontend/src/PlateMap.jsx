import React from "react";
import { stageStatus, stageMove } from "./api";

// 板面地图 (Phase 1):把整盘拍摄区域画成 rows×cols 个方格 (每格 = 一块 16 孔小板,
// 相机一帧覆盖一格)。教 3 个角 (左上/右上/左下) 的 XY,用仿射插值算出全部方格坐标
// (可容许轻微旋转/倾斜);每格可单独教一个对焦 Z。点方格 → 平台移到该格。
// 全部存 localStorage,跨会话保留;真实坐标依赖「先 home 一次」建立坐标系。
//
// Phase 2 会用这张地图做「巡扫 timelapse」:每 30 分钟依次走 6 格拍照。

const PLATE_KEY = "platescope_platemap_v1";

const two = (n) => Math.round(n * 100) / 100;

function loadMap() {
  try {
    const m = JSON.parse(localStorage.getItem(PLATE_KEY));
    if (m && m.rows && m.cols) return m;
  } catch {
    /* ignore */
  }
  return { rows: 2, cols: 3, ref: {}, z: {} }; // ref: {tl,tr,bl}, z: {"c,r": number}
}

// 3 角仿射:grid (c,r) → (x,y)。tl=(0,0), tr=(cols-1,0), bl=(0,rows-1)。
function affine(ref, rows, cols) {
  const { tl, tr, bl } = ref;
  if (!tl || !tr || !bl) return null;
  const dcx = (tr.x - tl.x) / (cols - 1 || 1);
  const dcy = (tr.y - tl.y) / (cols - 1 || 1);
  const drx = (bl.x - tl.x) / (rows - 1 || 1);
  const dry = (bl.y - tl.y) / (rows - 1 || 1);
  return (c, r) => ({
    x: two(tl.x + c * dcx + r * drx),
    y: two(tl.y + c * dcy + r * dry),
  });
}

export default function PlateMap() {
  const [map, setMap] = React.useState(loadMap);
  const [st, setSt] = React.useState(null);
  const [sel, setSel] = React.useState(null); // "c,r" 当前选中格
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

  const grid = affine(map.ref, map.rows, map.cols);
  const key = (c, r) => `${c},${r}`;
  const squareXY = (c, r) => (grid ? grid(c, r) : null);
  const squareZ = (c, r) => map.z[key(c, r)];

  // 当前平台最接近哪一格 (高亮)。
  const nearest = React.useMemo(() => {
    if (!pos || !grid) return null;
    let best = null;
    let bestD = Infinity;
    for (let r = 0; r < map.rows; r++)
      for (let c = 0; c < map.cols; c++) {
        const p = grid(c, r);
        const d = (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = key(c, r);
        }
      }
    return bestD < 25 ? best : null; // 5mm 内才算「在这一格」
  }, [pos, grid, map.rows, map.cols]);

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

  // 教一个角:抓当前平台 XY 存进 ref。
  const teachCorner = (which) =>
    run(async () => {
      const s = await stageStatus();
      if (!s?.connected || !s.position) throw new Error("stage offline / no position");
      setMap((m) => ({
        ...m,
        ref: { ...m.ref, [which]: { x: two(s.position.x), y: two(s.position.y) } },
      }));
    });

  const goSquare = (c, r) =>
    run(async () => {
      const p = squareXY(c, r);
      if (!p) throw new Error("teach the 3 corners first");
      setSel(key(c, r));
      await stageMove({ x: p.x, y: p.y, feed: 3000 });
      const z = squareZ(c, r);
      if (z != null) await stageMove({ z, feed: 600 });
    });

  // 把当前 Z 存为选中格 (或最近格) 的对焦高度。
  const teachZ = () =>
    run(async () => {
      const target = sel || nearest;
      if (!target) throw new Error("select a square first");
      const s = await stageStatus();
      const z = s?.position?.z;
      if (z == null) throw new Error("no Z position");
      setMap((m) => ({ ...m, z: { ...m.z, [target]: two(z) } }));
    });

  const setDim = (field, v) => {
    const n = Math.max(1, Math.min(12, Number(v) || 1));
    setMap((m) => ({ ...m, [field]: n }));
  };

  const cornersSet = map.ref.tl && map.ref.tr && map.ref.bl;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Plate map</h3>
        <span className={`text-xs ${connected ? "text-emerald-400" : "text-slate-500"}`}>
          {connected ? (xyHomed ? "homed" : "not homed") : "offline"}
        </span>
      </div>

      {/* 尺寸 */}
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
        <label className="flex items-center gap-1">
          rows
          <input
            type="number"
            min="1"
            max="12"
            value={map.rows}
            onChange={(e) => setDim("rows", e.target.value)}
            className="w-12 rounded bg-slate-800 px-1 py-0.5"
          />
        </label>
        <label className="flex items-center gap-1">
          cols
          <input
            type="number"
            min="1"
            max="12"
            value={map.cols}
            onChange={(e) => setDim("cols", e.target.value)}
            className="w-12 rounded bg-slate-800 px-1 py-0.5"
          />
        </label>
        <span className="text-slate-500">= {map.rows * map.cols} squares</span>
      </div>

      {/* 教角 */}
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs">
        <span className="text-slate-400">Teach corner:</span>
        {[
          ["tl", "top-left"],
          ["tr", "top-right"],
          ["bl", "bottom-left"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => teachCorner(k)}
            disabled={busy || !connected}
            title={map.ref[k] ? `X${map.ref[k].x} Y${map.ref[k].y}` : "not set"}
            className={`rounded px-2 py-0.5 ${
              map.ref[k] ? "bg-emerald-800 text-emerald-100" : "bg-slate-700 text-slate-300"
            } hover:bg-slate-600 disabled:opacity-40`}
          >
            {label}
            {map.ref[k] ? " ✓" : ""}
          </button>
        ))}
      </div>

      {/* 方格网 */}
      <div
        className="mb-2 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${map.cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: map.rows }).map((_, r) =>
          Array.from({ length: map.cols }).map((__, c) => {
            const k = key(c, r);
            const p = squareXY(c, r);
            const z = squareZ(c, r);
            const isSel = sel === k;
            const isHere = nearest === k;
            const n = r * map.cols + c + 1;
            return (
              <button
                key={k}
                onClick={() => goSquare(c, r)}
                disabled={busy || !connected || !cornersSet}
                title={p ? `X${p.x} Y${p.y}${z != null ? ` Z${z}` : ""}` : "teach corners"}
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
                <span className="absolute left-1 top-0.5 text-[10px] text-slate-400">{n}</span>
                {/* 4x4 孔位示意 */}
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span className="grid grid-cols-4 gap-[2px] opacity-60">
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

      {/* Z 教学 + 状态 */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={teachZ}
          disabled={busy || !connected || !(sel || nearest)}
          className="rounded bg-cyan-800 px-2 py-1 hover:bg-cyan-700 disabled:opacity-40"
        >
          Save Z here → {sel || nearest || "?"}
        </button>
        {pos && (
          <span className="font-mono text-[10px] text-slate-400">
            X{pos.x?.toFixed(1)} Y{pos.y?.toFixed(1)} Z{pos.z?.toFixed(1)}
          </span>
        )}
      </div>

      {!cornersSet && (
        <p className="mt-2 text-[11px] text-amber-400/80">
          Jog to each corner square and click Teach — top-left, top-right, bottom-left — to fill the grid.
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
