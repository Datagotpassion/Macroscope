import React from "react";

// 全板网格视图 (F3, F4, F8)。把后端返回的 96 个孔按相对坐标叠加成可点击网格。
export default function PlateView({ wells, imageUrl, onSelect, selected }) {
  // 用图像自然尺寸做坐标归一化。后端孔坐标是像素,这里按容器百分比定位。
  const [dims, setDims] = React.useState({ w: 4056, h: 3040 });

  return (
    <div className="relative inline-block w-full max-w-4xl">
      <img
        src={imageUrl}
        alt="plate"
        className="w-full rounded-lg border border-slate-700"
        onLoad={(e) =>
          setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight })
        }
      />
      {wells.map((w) => {
        const left = (w.cx / dims.w) * 100;
        const top = (w.cy / dims.h) * 100;
        const size = ((w.r * 2) / dims.w) * 100;
        const isSel = selected === w.label;
        return (
          <button
            key={w.label}
            title={w.label}
            onClick={() => onSelect(w.label)}
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${size}%`,
              aspectRatio: "1 / 1",
            }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition
              ${isSel ? "border-yellow-400 bg-yellow-400/20" : ""}
              ${w.detected ? "border-green-500/70" : "border-orange-400/60"}
              hover:bg-white/20`}
          />
        );
      })}
    </div>
  );
}
