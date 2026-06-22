import React from "react";

// 实时预览上的轻量孔位遮罩。wells 是归一化坐标 {x,y,r} (来自手动网格)。
// React.memo 保证预览高帧率刷新时遮罩本身不重渲染。
function PreviewMask({ wells, show }) {
  if (!show || !wells.length) return null;

  const xs = wells.map((w) => w.x);
  const ys = wells.map((w) => w.y);
  const pad = (wells[0].r || 0.02) * 1.5;
  const bx1 = (Math.min(...xs) - pad) * 100;
  const by1 = (Math.min(...ys) - pad) * 100;
  const bx2 = (Math.max(...xs) + pad) * 100;
  const by2 = (Math.max(...ys) + pad) * 100;

  return (
    <>
      <div
        className="pointer-events-none absolute rounded border-2 border-cyan-400/70"
        style={{
          left: `${bx1}%`,
          top: `${by1}%`,
          width: `${bx2 - bx1}%`,
          height: `${by2 - by1}%`,
        }}
      />
      {wells.map((w) => (
        <div
          key={w.label}
          className="pointer-events-none absolute rounded-full bg-cyan-400/80"
          style={{
            left: `${w.x * 100}%`,
            top: `${w.y * 100}%`,
            width: 6,
            height: 6,
            transform: "translate(-50%, -50%)",
          }}
        />
      ))}
    </>
  );
}

export default React.memo(PreviewMask);
