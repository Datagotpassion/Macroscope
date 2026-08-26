// 板面地图共享模型:96 孔板 (A–H × 1–12) 按 4×4 分成 6 个成像方格 (2 行 × 3 列)。
// 教 3 个角孔 A1 / A12 / H1 的 XY → 仿射插值算出每个孔 → 再算 6 个方格中心。
// PlateMap.jsx (手动教学/点击前往) 和 PcTimelapse.jsx (巡扫 timelapse) 共用这份逻辑。
//
// 若你的板不是 96 孔 / 4×4 分块,改这三个常量即可。
export const WELL_ROWS = 8; // A–H
export const WELL_COLS = 12; // 1–12
export const BLOCK = 4; // 每个成像方格 = 4×4 孔

export const ROW_LETTERS = "ABCDEFGH";
export const BLOCK_ROWS = WELL_ROWS / BLOCK; // 2
export const BLOCK_COLS = WELL_COLS / BLOCK; // 3
export const PLATE_KEY = "platescope_platemap_v2";

export const two = (n) => Math.round(n * 100) / 100;
export const bkey = (br, bc) => `${br},${bc}`;
// 每个方格用它左上角孔命名 (A1 / A5 / A9 / E1 / E5 / E9)。
export const blockLabel = (br, bc) => `${ROW_LETTERS[br * BLOCK]}${bc * BLOCK + 1}`;
export const keyLabel = (k) => {
  if (!k) return "?";
  const [br, bc] = k.split(",").map(Number);
  return blockLabel(br, bc);
};

export function loadPlateMap() {
  try {
    const m = JSON.parse(localStorage.getItem(PLATE_KEY));
    if (m && m.ref) return m;
  } catch {
    /* ignore */
  }
  return { ref: {}, z: {} }; // ref: {a1,a12,h1}; z: {"br,bc": number}
}

export function savePlateMap(m) {
  localStorage.setItem(PLATE_KEY, JSON.stringify(m));
}

export const cornersSet = (ref) => !!(ref && ref.a1 && ref.a12 && ref.h1);

// 孔仿射:well(r,c) → (x,y)。A1=(0,0), A12=(0,11), H1=(7,0)。
export function wellAffine(ref) {
  if (!cornersSet(ref)) return null;
  const { a1, a12, h1 } = ref;
  const cvx = (a12.x - a1.x) / (WELL_COLS - 1);
  const cvy = (a12.y - a1.y) / (WELL_COLS - 1);
  const rvx = (h1.x - a1.x) / (WELL_ROWS - 1);
  const rvy = (h1.y - a1.y) / (WELL_ROWS - 1);
  return (r, c) => ({
    x: two(a1.x + c * cvx + r * rvx),
    y: two(a1.y + c * cvy + r * rvy),
  });
}

// 方格中心 = 该 4×4 块的几何中心孔位。
export function blockCenter(ref, br, bc) {
  const w = wellAffine(ref);
  return w ? w(br * BLOCK + (BLOCK - 1) / 2, bc * BLOCK + (BLOCK - 1) / 2) : null;
}

// 巡扫顺序:蛇形 (serpentine),尽量少走回头路 → 少动 → 少扯排线。
export function listBlocks() {
  const out = [];
  for (let br = 0; br < BLOCK_ROWS; br++) {
    const cols = [];
    for (let bc = 0; bc < BLOCK_COLS; bc++) cols.push(bc);
    if (br % 2 === 1) cols.reverse();
    for (const bc of cols) out.push({ br, bc, key: bkey(br, bc), label: blockLabel(br, bc) });
  }
  return out;
}
