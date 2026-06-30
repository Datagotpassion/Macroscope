// 手动孔网格模型 (可配置行列数,默认整板 8x12,也可只对子区块如 4x4)。
// 网格由三个角点定义 (归一化 0..1 坐标,相对显示图):
//   a1  = 第一个孔 (A1)
//   a12 = 第一行最后一列方向的角点
//   h1  = 最后一行第一列方向的角点
// 三点确定一个仿射 (平移+缩放+旋转+错切),足以贴合固定支架里的板/区块。
// r = 孔半径 (相对宽度比例)。
//
// 本支架的板方向相对标准布局旋转了 180°:A1 在右上。默认角点按这个方向。

export const ROW_LABELS = "ABCDEFGH";
export const DEFAULT_ROWS = 8;
export const DEFAULT_COLS = 12;

// 全分辨率 (用于把检测到的像素坐标换算成归一化)
export const NAT_W = 4056;
export const NAT_H = 3040;

export const DEFAULT_GRID = {
  a1: { x: 0.87, y: 0.16 }, // 右上
  a12: { x: 0.13, y: 0.16 }, // 左上
  h1: { x: 0.87, y: 0.84 }, // 右下
  r: 0.022,
  rows: DEFAULT_ROWS,
  cols: DEFAULT_COLS,
};

export const gridRows = (g) => g.rows || DEFAULT_ROWS;
export const gridCols = (g) => g.cols || DEFAULT_COLS;

// 三个控制点当前对应的孔标签 (随 rows/cols 变化)
export function handleLabels(g) {
  return {
    a1: "A1",
    a12: "A" + gridCols(g), // 第一行最后一列
    h1: ROW_LABELS[Math.min(gridRows(g), ROW_LABELS.length) - 1] + "1", // 最后一行第一列
  };
}

// 由三角点生成所有孔 (归一化坐标)
export function gridWells(g) {
  const rows = gridRows(g);
  const cols = gridCols(g);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const fc = cols > 1 ? c / (cols - 1) : 0;
      const fr = rows > 1 ? r / (rows - 1) : 0;
      const x = g.a1.x + (g.a12.x - g.a1.x) * fc + (g.h1.x - g.a1.x) * fr;
      const y = g.a1.y + (g.a12.y - g.a1.y) * fc + (g.h1.y - g.a1.y) * fr;
      const label = (ROW_LABELS[r] || "?" + (r + 1)) + (c + 1);
      out.push({ label, x, y, r: g.r });
    }
  }
  return out;
}

function valid(g) {
  return g && g.a1 && g.a12 && g.h1 && typeof g.r === "number";
}

const STORAGE_KEY = "platescope_grid_v2";

export function loadGrid() {
  try {
    const g = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (valid(g)) return { rows: DEFAULT_ROWS, cols: DEFAULT_COLS, ...g };
  } catch {
    /* ignore */
  }
  return DEFAULT_GRID;
}

export function saveGrid(g) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(g));
  } catch {
    /* ignore */
  }
}

// 用自动检测结果初始化整板网格 (8x12,作为手动微调起点)。
// 检测器按标准布局打标签 (A1=左上),本板旋转了 180°,所以做对应映射。
// 注意:auto-fit 只对「整板」有意义;对光学放大后的子区块请手动拖。
export function gridFromWells(wells) {
  if (!wells || !wells.length) return null;
  const find = (lab) => wells.find((w) => w.label === lab);
  const a1 = find("A12");
  const a12 = find("A1");
  const h1 = find("H12");
  if (!a1 || !a12 || !h1) return null;
  const radii = wells.map((w) => w.r).sort((x, y) => x - y);
  const med = radii[Math.floor(radii.length / 2)];
  return {
    a1: { x: a1.cx / NAT_W, y: a1.cy / NAT_H },
    a12: { x: a12.cx / NAT_W, y: a12.cy / NAT_H },
    h1: { x: h1.cx / NAT_W, y: h1.cy / NAT_H },
    r: med / NAT_W,
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
  };
}
