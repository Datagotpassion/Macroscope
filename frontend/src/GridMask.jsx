import React from "react";
import { gridWells } from "./grid";

// 可拖拽的手动 96 孔网格,叠加在全板图上。
// edit=true: 显示三个粉色角控制点 (A1/A12/H1),可单独拖,也可拖整张网格平移。
// edit=false: 孔变成可点击按钮 (点击放大该孔)。
export default function GridMask({
  imageUrl,
  grid,
  setGrid,
  edit,
  show,
  onSelectWell,
  selected,
}) {
  const wrapRef = React.useRef(null);
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const dragRef = React.useRef(null);

  const measure = React.useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    setBox((p) => (p.w === w && p.h === h ? p : { w, h }));
  }, []);

  React.useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const norm = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const startDrag = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      mode,
      start: norm(e),
      grid0: JSON.parse(JSON.stringify(grid)),
    };
  };

  React.useEffect(() => {
    if (!edit) return;
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const m = norm(e);
      if (d.mode === "all") {
        const dx = m.x - d.start.x;
        const dy = m.y - d.start.y;
        setGrid({
          a1: { x: d.grid0.a1.x + dx, y: d.grid0.a1.y + dy },
          a12: { x: d.grid0.a12.x + dx, y: d.grid0.a12.y + dy },
          h1: { x: d.grid0.h1.x + dx, y: d.grid0.h1.y + dy },
          r: d.grid0.r,
        });
      } else {
        setGrid({ ...d.grid0, [d.mode]: { x: m.x, y: m.y } });
      }
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [edit, setGrid]);

  const wells = gridWells(grid);
  const rPx = grid.r * box.w;
  const handles = [
    ["a1", "A1"],
    ["a12", "A12"],
    ["h1", "H1"],
  ];

  return (
    <div ref={wrapRef} className="relative inline-block select-none">
      <img
        src={imageUrl}
        alt="plate"
        onLoad={measure}
        className="block w-full max-w-4xl rounded-lg border border-slate-700"
      />

      {/* edit 模式:整张网格可拖动 */}
      {show && edit && (
        <div
          className="absolute inset-0 cursor-move"
          onPointerDown={startDrag("all")}
        />
      )}

      {/* 孔位 */}
      {show &&
        box.w > 0 &&
        wells.map((w) => {
          const d = Math.max(10, rPx * 2);
          const style = {
            left: `${w.x * box.w}px`,
            top: `${w.y * box.h}px`,
            width: `${d}px`,
            height: `${d}px`,
            transform: "translate(-50%, -50%)",
          };
          if (edit) {
            return (
              <div
                key={w.label}
                style={style}
                className="pointer-events-none absolute rounded-full border border-cyan-400/70"
              />
            );
          }
          const isSel = selected === w.label;
          return (
            <button
              key={w.label}
              title={w.label}
              style={style}
              onClick={() => onSelectWell(w)}
              className={`absolute rounded-full border-2 transition hover:bg-white/30 ${
                isSel ? "border-yellow-400 bg-yellow-400/30" : "border-cyan-400/70"
              }`}
            />
          );
        })}

      {/* 三个角控制点 */}
      {show &&
        edit &&
        box.w > 0 &&
        handles.map(([k, lab]) => (
          <div
            key={k}
            onPointerDown={startDrag(k)}
            style={{
              left: `${grid[k].x * box.w}px`,
              top: `${grid[k].y * box.h}px`,
              transform: "translate(-50%, -50%)",
            }}
            className="absolute h-4 w-4 cursor-grab rounded-full border-2 border-white bg-pink-500 shadow"
          >
            <span className="absolute left-5 top-[-2px] whitespace-nowrap text-xs font-bold text-pink-300">
              {lab}
            </span>
          </div>
        ))}
    </div>
  );
}
