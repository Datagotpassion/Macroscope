import React from "react";

// 实时预览上的轻量孔位遮罩:用归一化百分比定位 (不随每帧测量),
// React.memo 保证预览高帧率刷新时遮罩本身不重渲染。
const NAT_W = 4056;
const NAT_H = 3040;

function PreviewMask({ wells, show }) {
  if (!show || !wells.length) return null;

  const xs = wells.map((w) => w.cx);
  const ys = wells.map((w) => w.cy);
  const pad = Math.max(...wells.map((w) => w.r)) * 1.5;
  const bx1 = ((Math.min(...xs) - pad) / NAT_W) * 100;
  const by1 = ((Math.min(...ys) - pad) / NAT_H) * 100;
  const bx2 = ((Math.max(...xs) + pad) / NAT_W) * 100;
  const by2 = ((Math.max(...ys) + pad) / NAT_H) * 100;

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
            left: `${(w.cx / NAT_W) * 100}%`,
            top: `${(w.cy / NAT_H) * 100}%`,
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
