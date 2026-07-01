import React from "react";
import { gridWells, handleLabels } from "./grid";

const clamp = (v) => Math.min(1, Math.max(0, v));

// 可拖拽的手动孔网格 —— 纯叠加层 (不含图片),铺在父级 relative 容器里。
// edit=true:
//   - 粉色 A1/A12/H1 控制点:摆放整体均匀网格;拖网格内部空白 = 整体平移。
//   - 单个孔:直接拖 = 微调该孔位置 (覆盖);拖孔右边缘的小点 = 改该孔大小。
//     被微调过的孔显示为琥珀色。
// edit=false: 孔是可点击按钮 (点击放大/检视/跳动检测),用各自的位置和大小。
function GridMask({ grid, setGrid, edit, show, onSelectWell, selected }) {
  const ref = React.useRef(null);
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const dragRef = React.useRef(null);

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    setBox((p) => (p.w === w && p.h === h ? p : { w, h }));
  }, []);

  React.useEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const norm = (e) => {
    const r = ref.current.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / r.width),
      y: clamp((e.clientY - r.top) / r.height),
    };
  };

  const startDrag = (mode, extra) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      mode,
      extra,
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
      const g0 = d.grid0;
      if (d.mode === "all") {
        const dx = m.x - d.start.x;
        const dy = m.y - d.start.y;
        setGrid({
          ...g0,
          a1: { x: g0.a1.x + dx, y: g0.a1.y + dy },
          a12: { x: g0.a12.x + dx, y: g0.a12.y + dy },
          h1: { x: g0.h1.x + dx, y: g0.h1.y + dy },
        });
      } else if (d.mode.startsWith("well:")) {
        // 拖单个孔 → 覆盖该孔位置 (保留当前大小)
        const label = d.mode.slice(5);
        const cur = (g0.overrides && g0.overrides[label]) || {};
        const rr = cur.r != null ? cur.r : g0.r;
        setGrid({
          ...g0,
          overrides: { ...g0.overrides, [label]: { x: m.x, y: m.y, r: rr } },
        });
      } else if (d.mode.startsWith("size:")) {
        // 拖孔边缘 → 覆盖该孔半径 (中心到指针的距离,按宽度归一化)
        const label = d.mode.slice(5);
        const { wx, wy } = d.extra;
        const rect = ref.current.getBoundingClientRect();
        const dxpx = e.clientX - (wx * rect.width + rect.left);
        const dypx = e.clientY - (wy * rect.height + rect.top);
        const rNorm = Math.max(0.005, Math.hypot(dxpx, dypx) / rect.width);
        const cur = (g0.overrides && g0.overrides[label]) || {};
        setGrid({
          ...g0,
          overrides: {
            ...g0.overrides,
            [label]: {
              x: cur.x != null ? cur.x : wx,
              y: cur.y != null ? cur.y : wy,
              r: rNorm,
            },
          },
        });
      } else {
        // 仿射角控制点 a1/a12/h1
        setGrid({ ...g0, [d.mode]: { x: m.x, y: m.y } });
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
  }, [edit, setGrid, grid]);

  const wells = gridWells(grid);
  const hl = handleLabels(grid);
  const handles = [
    ["a1", hl.a1],
    ["a12", hl.a12],
    ["h1", hl.h1],
  ];

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 select-none">
      {show && edit && (
        <div
          className="pointer-events-auto absolute inset-0 cursor-move"
          onPointerDown={startDrag("all")}
        />
      )}

      {show &&
        box.w > 0 &&
        wells.map((w) => {
          const d = Math.max(10, w.r * box.w * 2);
          const style = {
            left: `${w.x * box.w}px`,
            top: `${w.y * box.h}px`,
            width: `${d}px`,
            height: `${d}px`,
            transform: "translate(-50%, -50%)",
          };
          if (edit) {
            return (
              <React.Fragment key={w.label}>
                <div
                  onPointerDown={startDrag("well:" + w.label)}
                  style={style}
                  title={w.label}
                  className={`pointer-events-auto absolute cursor-move rounded-full border-2 ${
                    w.overridden ? "border-amber-400" : "border-cyan-400/70"
                  }`}
                />
                {/* 右边缘的调大小小点 */}
                <div
                  onPointerDown={startDrag("size:" + w.label, { wx: w.x, wy: w.y })}
                  style={{
                    left: `${(w.x + w.r) * box.w}px`,
                    top: `${w.y * box.h}px`,
                    transform: "translate(-50%, -50%)",
                  }}
                  className="pointer-events-auto absolute h-2.5 w-2.5 cursor-ew-resize rounded-full border border-white bg-cyan-500"
                />
              </React.Fragment>
            );
          }
          const isSel = selected === w.label;
          return (
            <button
              key={w.label}
              title={w.label}
              style={style}
              onClick={() => onSelectWell(w)}
              className={`pointer-events-auto absolute rounded-full border-2 transition hover:bg-white/30 ${
                isSel ? "border-yellow-400 bg-yellow-400/30" : "border-cyan-400/70"
              }`}
            />
          );
        })}

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
            className="pointer-events-auto absolute h-5 w-5 cursor-grab rounded-full border-2 border-white bg-pink-500 shadow-lg"
          >
            <span className="absolute left-6 top-[-2px] whitespace-nowrap text-xs font-bold text-pink-300">
              {lab}
            </span>
          </div>
        ))}
    </div>
  );
}

export default React.memo(GridMask);
