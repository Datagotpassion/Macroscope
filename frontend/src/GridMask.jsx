import React from "react";
import { gridWells, handleLabels } from "./grid";

const clamp = (v) => Math.min(1, Math.max(0, v));

// 可拖拽的手动 96 孔网格 —— 纯叠加层 (不含图片),铺在父级 relative 容器里。
// 这样同一个组件能叠在「实时预览」和「拍摄静帧」上,父级换图不影响本层。
// edit=true: 显示粉色 A1/A12/H1 控制点 (可单独拖,或拖网格内部整体平移)。
// edit=false: 孔是可点击按钮 (点击放大)。
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

  // ResizeObserver 比 img.onLoad 更可靠:图片加载让容器变大时也会触发测量
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
  const hl = handleLabels(grid);
  const handles = [
    ["a1", hl.a1],
    ["a12", hl.a12],
    ["h1", hl.h1],
  ];

  // 容器本身不拦截事件,只有交互元素 (拖拽层/孔按钮/控制点) 才接收
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
                className="absolute rounded-full border border-cyan-400/70"
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
