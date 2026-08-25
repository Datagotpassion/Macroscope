import React from "react";
import { stageStatus, stageMove } from "./api";

// 板面地图 (Phase 1):96 孔板 (A–H × 1–12) 按 4×4 分成 6 个成像方格 (2 行 × 3 列)。
// 教 3 个角孔 A1 / A12 / H1 的 XY,用仿射插值算出每个孔 → 再算出 6 个方格中心。
// 点方格 → 平台移到该格中心;每格可单独教一个对焦 Z。全部存 localStorage。
// 真实坐标依赖「先 home 一次」建立坐标系 (或用 Force move 临时建一个)。
//
// 若你的板不是 96 孔 / 4×4 分块,改下面三个常量即可。

const WELL_ROWS = 8; // A–H
const WELL_COLS = 12; // 1–12
const BLOCK = 4; // 每个成像方格 = 4×4 孔
const ROW_LETTERS = "ABCDEFGH";
const BLOCK_ROWS = WELL_ROWS / BLOCK; // 2
const BLOCK_COLS = WELL_COLS / BLOCK; // 3

const PLATE_KEY = "platescope_platemap_v2";
const two = (n) => Math.round(n * 100) / 100;

// 每个成像方格用它左上角孔命名 (A1 / A5 / A9 / E1 / E5 / E9)。
const blockLabel = (br, bc) => `${ROW_LETTERS[br * BLOCK]}${bc * BLOCK + 1}`;
const bkey = (br, bc) => `${br},${bc}`;
const keyLabel = (k) => {
  if (!k) return "?";
  const [br, bc] = k.split(",").map(Number);
  return blockLabel(br, bc);
};

function loadMap() {
  try {
    const m = JSON.parse(localStorage.getItem(PLATE_KEY));
    if (m && m.ref) return m;
  } catch {
    /* ignore */
  }
  return { ref: {}, z: {} }; // ref: {a1,a12,h1}; z: {"br,bc": number}
}

// 孔仿射:well(r,c) → (x,y)。A1=(0,0), A12=(0,11), H1=(7,0)。
function wellAffine(ref) {
  const { a1, a12, h1 } = ref;
  if (!a1 || !a12 || !h1) return null;
  const cvx = (a12.x - a1.x) / (WELL_COLS - 1);
  const cvy = (a12.y - a1.y) / (WELL_COLS - 1);
  const rvx = (h1.x - a1.x) / (WELL_ROWS - 1);
  const rvy = (h1.y - a1.y) / (WELL_ROWS - 1);
  return (r, c) => ({
    x: two(a1.x + c * cvx + r * rvx),
    y: two(a1.y + c * cvy + r * rvy),
  });
}

export default function PlateMap() {
  const [map, setMap] = React.useState(loadMap);
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

  const well = wellAffine(map.ref);
  // 方格中心 = 该 4×4 块的几何中心孔位。
  const blockCenter = (br, bc) =>
    well ? well(br * BLOCK + (BLOCK - 1) / 2, bc * BLOCK + (BLOCK - 1) / 2) : null;
  const blockZ = (br, bc) => map.z[bkey(br, bc)];
  const cornersSet = map.ref.a1 && map.ref.a12 && map.ref.h1;

  const nearest = React.useMemo(() => {
    if (!pos || !well) return null;
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
