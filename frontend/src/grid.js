// 手动 96 孔网格模型。
// 网格由三个角点定义 (归一化 0..1 坐标,相对显示图):
//   a1  = A1 孔中心 (左上)
//   a12 = A12 孔中心 (右上,A1 右边 11 列)
//   h1  = H1 孔中心 (左下,A1 下方 7 行)
// 三点确定一个仿射 (平移+缩放+旋转+错切),足以贴合固定支架里的板。
// r = 孔半径 (相对宽度比例)。

export const ROWS = 8;
export const COLS = 12;
export const ROW_LABELS = "ABCDEFGH";

// 全分辨率 (用于把检测到的像素坐标换算成归一化)
export const NAT_W = 4056;
export const NAT_H = 3040;

export const DEFAULT_GRID = {
  a1: { x: 0.13, y: 0.16 },
  a12: { x: 0.87, y: 0.16 },
  h1: { x: 0.13, y: 0.84 },
  r: 0.022,
};

// 由三角点生成 96 个孔 (归一化坐标)
export function gridWells(g) {
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const fc = c / (COLS - 1);
      const fr = r / (ROWS - 1);
      const x = g.a1.x + (g.a12.x - g.a1.x) * fc + (g.h1.x - g.a1.x) * fr;
      const y = g.a1.y + (g.a12.y - g.a1.y) * fc + (g.h1.y - g.a1.y) * fr;
      out.push({ label: ROW_LABELS[r] + (c + 1), x, y, r: g.r });
    }
  }
  return out;
}

function valid(g) {
  return g && g.a1 && g.a12 && g.h1 && typeof g.r === "number";
}

export function loadGrid() {
  try {
    const g = JSON.parse(localStorage.getItem("platescope_grid"));
    if (valid(g)) return g;
  } catch {
    /* ignore */
  }
  return DEFAULT_GRID;
}

export function saveGrid(g) {
  try {
    localStorage.setItem("platescope_grid", JSON.stringify(g));
  } catch {
    /* ignore */
  }
}

// 用自动检测结果初始化网格 (作为手动微调的起点)
export function gridFromWells(wells) {
  if (!wells || !wells.length) return null;
  const find = (lab) => wells.find((w) => w.label === lab);
  const a1 = find("A1");
  const a12 = find("A12");
  const h1 = find("H1");
  if (!a1 || !a12 || !h1) return null;
  const radii = wells.map((w) => w.r).sort((x, y) => x - y);
  const med = radii[Math.floor(radii.length / 2)];
  return {
    a1: { x: a1.cx / NAT_W, y: a1.cy / NAT_H },
    a12: { x: a12.cx / NAT_W, y: a12.cy / NAT_H },
    h1: { x: h1.cx / NAT_W, y: h1.cy / NAT_H },
    r: med / NAT_W,
  };
}
