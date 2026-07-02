import React from "react";
import { useI18n } from "./i18n.jsx";
import { fetchLatestFrameBlob } from "./api";
import {
  saveMode,
  initSaveTarget,
  chooseFolder,
  currentFolderName,
  saveBytes,
} from "./save";

const canPickFolder = saveMode() !== "download";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// 保存到 PC (F6 的 PC 侧)。用共享的 save 模块 (与跳动结果保存同一个文件夹)。
export default function LocalSave({ experiment, autoSave, setAutoSave, registerSaver }) {
  const { t } = useI18n();
  const [dirName, setDirName] = React.useState(null);
  const [msg, setMsg] = React.useState("");

  const flash = (m) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 4000);
  };

  React.useEffect(() => {
    initSaveTarget().then((name) => name && setDirName(name));
  }, []);

  const pickFolder = async () => {
    const name = await chooseFolder();
    if (name) setDirName(name);
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
    try {
      const buf = await blob.arrayBuffer();
      const where = await saveBytes(name, new Uint8Array(buf));
      flash(t("savedTo", where));
    } catch (e) {
      flash(t("saveFailed", e.message || String(e)));
    }
  }, [experiment, t]);

  React.useEffect(() => {
    registerSaver(saveNow);
  }, [saveNow, registerSaver]);

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 p-4">
      <h3 className="text-lg font-semibold">{t("localSaveTitle")}</h3>

      {canPickFolder ? (
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={pickFolder}
            className="rounded bg-slate-700 px-3 py-1.5 hover:bg-slate-600"
          >
            {t("chooseFolder")}
          </button>
          <span className="break-all text-slate-400">
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
