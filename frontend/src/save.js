// 统一的「保存到本机」封装,供保存帧、保存跳动结果等共用一个目标文件夹。
// 优先级:Electron 原生 (window.desktop) > File System Access API > 浏览器下载。
import { idbGet, idbSet } from "./idb";

const desktop = typeof window !== "undefined" ? window.desktop : null;
const supportsFS =
  typeof window !== "undefined" && "showDirectoryPicker" in window;

let fsHandle = null; // File System Access 目录句柄
let dirPath = null; // Electron 目录路径

export function saveMode() {
  return desktop ? "desktop" : supportsFS ? "fs" : "download";
}

// 启动时恢复上次选的文件夹,返回显示名 (或 null)
export async function initSaveTarget() {
  if (desktop) {
    const p = localStorage.getItem("platescope_save_dir");
    if (p) dirPath = p;
    return dirPath;
  }
  if (supportsFS) {
    try {
      const h = await idbGet("saveDir");
      if (h) {
        fsHandle = h;
        return h.name;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function chooseFolder() {
  if (desktop) {
    const p = await desktop.chooseFolder();
    if (p) {
      dirPath = p;
      localStorage.setItem("platescope_save_dir", p);
      return p;
    }
    return null;
  }
  if (supportsFS) {
    try {
      const h = await window.showDirectoryPicker({ mode: "readwrite" });
      fsHandle = h;
      await idbSet("saveDir", h);
      return h.name;
    } catch {
      return null;
    }
  }
  return null;
}

export function currentFolderName() {
  if (desktop) return dirPath;
  if (fsHandle) return fsHandle.name;
  return null;
}

async function ensureFsPerm(h) {
  const o = { mode: "readwrite" };
  if ((await h.queryPermission(o)) === "granted") return true;
  return (await h.requestPermission(o)) === "granted";
}

// 把字节写入文件 (Uint8Array/ArrayBuffer)。返回保存位置描述。
export async function saveBytes(name, bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (desktop && dirPath) {
    return desktop.saveImage(dirPath, name, arr);
  }
  if (supportsFS && fsHandle) {
    if (!(await ensureFsPerm(fsHandle))) throw new Error("permission denied");
    const fh = await fsHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(arr);
    await w.close();
    return `${fsHandle.name}/${name}`;
  }
  // 下载回退
  const url = URL.createObjectURL(new Blob([arr]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return `Downloads/${name}`;
}

export const saveText = (name, text) =>
  saveBytes(name, new TextEncoder().encode(text));

// 追加一行到 CSV (Electron 下真追加,文件不存在先写表头)。
export async function appendCsvRow(name, header, row) {
  if (desktop && dirPath) {
    return desktop.appendCsv(dirPath, name, header, row);
  }
  // 非 Electron 没有真正的追加能力:退化为下载单行文件 (带时间戳)。
  const fallback = name.replace(/\.csv$/, "") + `_${Date.now()}.csv`;
  return saveText(fallback, header + "\n" + row + "\n");
}
