import React from "react";

// 全板网格视图 (F3, F4, F8)。showMask 控制孔位遮罩 + 板边框的显示/隐藏。
// 标记用真实像素定位/尺寸,保证最小点击区域 (否则孔很小时按钮高度可能塌成 0)。
export default function PlateView({ wells, imageUrl, onSelect, selected, showMask }) {
  const imgRef = React.useRef(null);
  const [box, setBox] = React.useState({ w: 0, natW: 4056, natH: 3040 });

  const measure = React.useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const natW = el.naturalWidth || 4056;
    const natH = el.naturalHeight || 3040;
    // 值没变就返回旧对象,避免无意义的重渲染
    setBox((prev) =>
      prev.w === w && prev.natW === natW && prev.natH === natH
        ? prev
        : { w, natW, natH }
    );
  }, []);

  React.useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  const scale = box.w && box.natW ? box.w / box.natW : 0;

  // 板边框 (由所有孔的范围 + padding 推算)
  let boundary = null;
  if (showMask && scale > 0 && wells.length) {
    const xs = wells.map((w) => w.cx);
    const ys = wells.map((w) => w.cy);
    const pad = Math.max(...wells.map((w) => w.r)) * 1.5;
    const x1 = (Math.min(...xs) - pad) * scale;
    const y1 = (Math.min(...ys) - pad) * scale;
    const x2 = (Math.max(...xs) + pad) * scale;
    const y2 = (Math.max(...ys) + pad) * scale;
    boundary = { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
  }

  return (
    <div className="relative inline-block">
      <img
        ref={imgRef}
        src={imageUrl}
        alt="plate"
        onLoad={measure}
        className="block w-full max-w-4xl rounded-lg border border-slate-700"
      />
      {boundary && (
        <div
          className="pointer-events-none absolute rounded-md border-2 border-cyan-400/70 bg-cyan-400/5"
          style={boundary}
        />
      )}
      {showMask &&
        scale > 0 &&
        wells.map((w) => {
          const d = Math.max(16, w.r * 2 * scale); // 最小 16px 点击区域
          const isSel = selected === w.label;
          return (
            <button
              key={w.label}
              title={w.label}
              onClick={() => onSelect(w.label)}
              style={{
                left: `${w.cx * scale}px`,
                top: `${w.cy * scale}px`,
                width: `${d}px`,
                height: `${d}px`,
                transform: "translate(-50%, -50%)",
              }}
              className={`absolute rounded-full border-2 transition
                ${isSel ? "border-yellow-400 bg-yellow-400/30" : ""}
                ${w.detected ? "border-green-500/70" : "border-orange-400/60"}
                hover:bg-white/30`}
            />
          );
        })}
    </div>
  );
}
