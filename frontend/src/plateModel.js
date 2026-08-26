// 板面地图共享模型:支持 6 / 12 / 24 / 48 / 96 孔标准板 (SBS 网格)。
// 教 3 个角孔 (左上 A1 / 右上 A<cols> / 左下 <末行>1) → 仿射插值算出每个孔;
// 成像时按「每帧几孔」(blockR × blockC) 把板分成若干成像方格,逐格拍。
// PlateMap.jsx (手动教学/点击前往) 和 PcTimelapse.jsx (巡扫) 共用这份逻辑。

export const PLATE_FORMATS = {
  6: { rows: 2, cols: 3 },
  12: { rows: 3, cols: 4 },
  24: { rows: 4, cols: 6 },
  48: { rows: 6, cols: 8 },
  96: { rows: 8, cols: 12 },
};
// 每种板默认「每帧几孔」(相机视场约能覆盖的孔数)。可在界面里改。
export const DEFAULT_BLOCK = {
  6: [1, 1],
  12: [1, 1],
  24: [1, 1],
  48: [2, 2],
  96: [4, 4],
};
export const FORMAT_LIST = [6, 12, 24, 48, 96];
export const ROW_LETTERS = "ABCDEFGH";
export const PLATE_KEY = "platescope_platemap_v3";
export const two = (n) => Math.round(n * 100) / 100;

export function defaultMap(format = 96) {
  const [br, bc] = DEFAULT_BLOCK[format] || [1, 1];
  return { format, blockR: br, blockC: bc, ref: {}, z: {} }; // ref: {tl,tr,bl}
}

export function loadPlateMap() {
  try {
    const m = JSON.parse(localStorage.getItem(PLATE_KEY));
    if (m && PLATE_FORMATS[m.format]) return { ...defaultMap(m.format), ...m };
  } catch {
    /* ignore */
  }
  return defaultMap(96);
}
export function savePlateMap(m) {
  localStorage.setItem(PLATE_KEY, JSON.stringify(m));
}

export const dims = (map) => PLATE_FORMATS[map.format] || PLATE_FORMATS[96];

// 三个角孔的显示名 (随板型变化):左上 A1 / 右上 A<cols> / 左下 <末行>1。
export function cornerWells(map) {
  const { rows, cols } = dims(map);
  return { tl: "A1", tr: `A${cols}`, bl: `${ROW_LETTERS[rows - 1]}1` };
}

export const cornersSet = (ref) => !!(ref && ref.tl && ref.tr && ref.bl);

// 孔仿射:well(r,c) → (x,y)。tl=(0,0), tr=(0,cols-1), bl=(rows-1,0)。
export function wellAffine(map) {
  if (!cornersSet(map.ref)) return null;
  const { rows, cols } = dims(map);
  const { tl, tr, bl } = map.ref;
  const cvx = (tr.x - tl.x) / (cols - 1 || 1);
  const cvy = (tr.y - tl.y) / (cols - 1 || 1);
  const rvx = (bl.x - tl.x) / (rows - 1 || 1);
  const rvy = (bl.y - tl.y) / (rows - 1 || 1);
  return (r, c) => ({
    x: two(tl.x + c * cvx + r * rvx),
    y: two(tl.y + c * cvy + r * rvy),
  });
}

export function blockDims(map) {
  const { rows, cols } = dims(map);
  const br = Math.max(1, Math.min(rows, map.blockR || 1));
  const bc = Math.max(1, Math.min(cols, map.blockC || 1));
  return { rows, cols, br, bc, nR: Math.ceil(rows / br), nC: Math.ceil(cols / bc) };
}

// 成像方格列表 (蛇形顺序,少走回头路)。每格含覆盖孔范围 + 左上角孔标签。
export function listBlocks(map) {
  const { rows, cols, br, bc, nR, nC } = blockDims(map);
  const out = [];
  for (let ri = 0; ri < nR; ri++) {
    const order = [];
    for (let ci = 0; ci < nC; ci++) order.push(ci);
    if (ri % 2 === 1) order.reverse();
    for (const ci of order) {
      const r0 = ri * br;
      const c0 = ci * bc;
      out.push({
        ri,
        ci,
        r0,
        c0,
        rLast: Math.min(rows - 1, r0 + br - 1),
        cLast: Math.min(cols - 1, c0 + bc - 1),
        key: `${ri},${ci}`,
        label: `${ROW_LETTERS[r0]}${c0 + 1}`,
      });
    }
  }
  return out;
}

// 方格中心 = 它覆盖的那片孔的几何中心 (边缘不满一整块也居中正确)。
export function blockCenter(map, blk) {
  const w = wellAffine(map);
  if (!w) return null;
  return w((blk.r0 + blk.rLast) / 2, (blk.c0 + blk.cLast) / 2);
}

export function keyLabel(map, k) {
  if (!k) return "?";
  const b = listBlocks(map).find((x) => x.key === k);
  return b ? b.label : "?";
}

// ── 多板层:整个可达区域里放多块板,每块板 = 上面的单板对象 + id/name ──

export const STORE_KEY = "platescope_stagemap_v1";

export function newPlate(format = 96, name = "Plate") {
  const [br, bc] = DEFAULT_BLOCK[format] || [1, 1];
  return {
    id: `p${Date.now()}${Math.floor(Math.random() * 1000)}`,
    name,
    format,
    blockR: br,
    blockC: bc,
    ref: {},
    z: {},
  };
}

export function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.plates) && s.plates.length) return s;
  } catch {
    /* ignore */
  }
  const p = newPlate(96, "Plate 1");
  return { plates: [p], selectedId: p.id };
}
export function saveStore(s) {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}
export function selectedPlate(store) {
  return store.plates.find((p) => p.id === store.selectedId) || store.plates[0];
}
export function loadSelectedPlate() {
  return selectedPlate(loadStore());
}

// 板在载物台坐标系里的四角 [tl, tr, br, bl] (br 由平行四边形补出,容许旋转)。
export function plateQuad(plate) {
  const { tl, tr, bl } = plate.ref || {};
  if (!tl || !tr || !bl) return null;
  const br = { x: tr.x + (bl.x - tl.x), y: tr.y + (bl.y - tl.y) };
  return [tl, tr, br, bl];
}
export function plateBBox(plate) {
  const q = plateQuad(plate);
  if (!q) return null;
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}
