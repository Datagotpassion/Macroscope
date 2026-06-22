import React from "react";
import { useI18n } from "./i18n.jsx";
import { fetchLatestFrameBlob } from "./api";
import { idbGet, idbSet } from "./idb";

// File System Access API 只在安全上下文 (https / localhost) 可用。
// 走 http://树莓派IP 时不可用,自动回退到浏览器下载 (存到「下载」目录)。
const supportsFS =
  typeof window !== "undefined" && "showDirectoryPicker" in window;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// 保存到 PC (F6 的 PC 侧)。把句柄上报给父组件以支持「拍摄后自动保存」。
export default function LocalSave({ experiment, autoSave, setAutoSave, registerSaver }) {
  const { t } = useI18n();
  const [dirName, setDirName] = React.useState(null);
  const dirHandleRef = React.useRef(null);
  const [msg, setMsg] = React.useState("");

  const flash = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 4000);
  };

  // 刷新后恢复上次选的文件夹
  React.useEffect(() => {
    (async () => {
      if (!supportsFS) return;
      try {
        const h = await idbGet("saveDir");
        if (h) {
          dirHandleRef.current = h;
          setDirName(h.name);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  const pickFolder = async () => {
    try {
      const h = await window.showDirectoryPicker({ mode: "readwrite" });
      dirHandleRef.current = h;
      setDirName(h.name);
      await idbSet("saveDir", h);
    } catch {
      /* 用户取消 */
    }
  };

  const ensurePerm = async (h) => {
    const opts = { mode: "readwrite" };
    if ((await h.queryPermission(opts)) === "granted") return true;
    return (await h.requestPermission(opts)) === "granted";
  };

  const saveNow = React.useCallback(async () => {
    let blob;
    try {
      blob = await fetchLatestFrameBlob();
    } catch {
      flash(t("saveNoFrame"));
      return;
    }
    const name = `${experiment || "exp"}_${stamp()}.jpg`;
    const h = dirHandleRef.current;
    if (supportsFS && h) {
      try {
        if (!(await ensurePerm(h))) {
          flash(t("savePermDenied"));
          return;
        }
        const fh = await h.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        flash(t("savedTo", `${h.name}/${name}`));
        return;
      } catch (e) {
        flash(t("saveFailed", e.message));
        return;
      }
    }
    // 下载回退
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    flash(t("savedDownload", name));
  }, [experiment, t]);

  // 把 saver 交给父组件,拍摄后可自动调用
  React.useEffect(() => {
    registerSaver(saveNow);
  }, [saveNow, registerSaver]);

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 p-4">
      <h3 className="text-lg font-semibold">{t("localSaveTitle")}</h3>

      {supportsFS ? (
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={pickFolder}
            className="rounded bg-slate-700 px-3 py-1.5 hover:bg-slate-600"
          >
            {t("chooseFolder")}
          </button>
          <span className="text-slate-400">
            {dirName ? t("folderLabel", dirName) : t("noFolderChosen")}
          </span>
        </div>
      ) : (
        <div className="text-xs text-slate-500">{t("downloadModeNote")}</div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={saveNow}
          className="rounded bg-emerald-600 px-3 py-1.5 hover:bg-emerald-500"
        >
          {t("saveToPC")}
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(e) => setAutoSave(e.target.checked)}
          />
          {t("autoSavePC")}
        </label>
      </div>

      {msg && <div className="break-all text-sm text-yellow-300">{msg}</div>}
    </div>
  );
}
