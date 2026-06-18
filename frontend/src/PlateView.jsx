import React from "react";

// 全板网格视图 (F3, F4, F8)。把后端返回的 96 个孔按相对坐标叠加成可点击网格。
// 标记用真实像素定位/尺寸 (而不是 % + aspect-ratio),并保证最小点击区域,
// 否则孔很小时按钮高度可能塌成 0,导致点不中。
export default function PlateView({ wells, imageUrl, onSelect, selected }) {
  const imgRef = React.useRef(null);
  // box: 图像在页面上的渲染尺寸 (px) + 自然分辨率 (px)
  const [box, setBox] = React.useState({ w: 0, natW: 4056, natH: 3040 });

  const measure = React.useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    setBox({
      w: el.clientWidth,
      natW: el.naturalWidth || 4056,
      natH: el.naturalHeight || 3040,
    });
  }, []);

  React.useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // 渲染像素 / 自然像素 的缩放比
  const scale = box.w && box.natW ? box.w / box.natW : 0;

  return (
    <div className="relative inline-block">
      <img
        ref={imgRef}
        src={imageUrl}
        alt="plate"
        onLoad={measure}
        className="block w-full max-w-4xl rounded-lg border border-slate-700"
      />
      {scale > 0 &&
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
