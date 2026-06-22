import React from "react";

// 轻量 i18n:字典 + Context + localStorage 持久化,不引入额外依赖。
// 参数化文案用函数表示;静态文案用字符串。

const translations = {
  zh: {
    subtitle: "96 孔板成像",
    capture: "拍摄全板",
    capturing: "拍摄中…",
    livePreview: "实时预览",
    stopPreview: "关闭预览",
    previewHeader: "实时预览",
    connecting: "连接中…",
    captureHint: "点击「拍摄全板」开始",
    wellsDetected: (n) => `检测到 ${n} 孔`,
    wellsDirect: (n) => `${n} 直接检测`,
    wellsFilled: (n) => `${n} 网格补全`,

    wellDetailHint: "点击左侧任意孔位查看放大图",
    wellTitle: (label) => `孔位 ${label}`,
    refresh: "刷新",

    timelapseTitle: "实验 & 定时拍摄",
    experimentPlaceholder: "实验名",
    minutes: "分钟",
    saveFrame: "保存当前帧",
    startTimelapse: "开始定时拍摄",
    runningJobs: "运行中的任务:",
    nextRun: "下次: ",
    stop: "停止",
    msgSaved: (path) => `已保存: ${path}`,
    msgSaveFailed: (err) => `保存失败: ${err}`,
    msgStarted: (exp, interval) => `已开始定时拍摄: ${exp} 每 ${interval} 分钟`,
    msgStopped: (exp) => `已停止: ${exp}`,

    systemStatus: "系统状态",
    camera: "相机",
    cameraMock: "MockCamera (开发模式)",
    cameraReal: "picamera2 (硬件)",
    serverTime: "服务器时间",
    runningJobsCount: "运行任务数",
    phase2Note: "LED 亮度控制 (F14)、温湿度监控 (F18) 将在 Phase 2 接入。",

    mask: "孔位遮罩",
    localSaveTitle: "保存到本机 (PC)",
    chooseFolder: "选择文件夹",
    noFolderChosen: "未选择文件夹 (将用下载)",
    folderLabel: (name) => `文件夹: ${name}`,
    downloadModeNote: "当前以下载方式保存到本机「下载」目录 (浏览器不支持选目录)。",
    saveToPC: "保存当前帧到本机",
    autoSavePC: "拍摄后自动保存到本机",
    saveNoFrame: "没有可保存的帧,请先拍摄",
    savePermDenied: "未获得文件夹写入权限",
    savedTo: (p) => `已保存到: ${p}`,
    savedDownload: (n) => `已下载: ${n}`,
    saveFailed: (e) => `保存失败: ${e}`,

    alignGrid: "对齐网格",
    doneAlign: "完成对齐",
    autoFit: "从检测套用",
    wellSize: "孔大小",
    gridHint: "拖动粉色 A1 / A12 / H1 控制点到板上对应的孔;拖网格内部可整体平移。",

    switchTo: "English",
  },
  en: {
    subtitle: "96-well plate imaging",
    capture: "Capture Plate",
    capturing: "Capturing…",
    livePreview: "Live Preview",
    stopPreview: "Stop Preview",
    previewHeader: "Live preview",
    connecting: "Connecting…",
    captureHint: 'Click "Capture Plate" to start',
    wellsDetected: (n) => `Detected ${n} wells`,
    wellsDirect: (n) => `${n} direct`,
    wellsFilled: (n) => `${n} grid-filled`,

    wellDetailHint: "Click any well on the left to view a zoomed image",
    wellTitle: (label) => `Well ${label}`,
    refresh: "Refresh",

    timelapseTitle: "Experiment & Timelapse",
    experimentPlaceholder: "Experiment name",
    minutes: "min",
    saveFrame: "Save Current Frame",
    startTimelapse: "Start Timelapse",
    runningJobs: "Running jobs:",
    nextRun: "Next: ",
    stop: "Stop",
    msgSaved: (path) => `Saved: ${path}`,
    msgSaveFailed: (err) => `Save failed: ${err}`,
    msgStarted: (exp, interval) =>
      `Timelapse started: ${exp} every ${interval} min`,
    msgStopped: (exp) => `Stopped: ${exp}`,

    systemStatus: "System Status",
    camera: "Camera",
    cameraMock: "MockCamera (dev mode)",
    cameraReal: "picamera2 (hardware)",
    serverTime: "Server time",
    runningJobsCount: "Running jobs",
    phase2Note:
      "LED brightness (F14) and temp/humidity monitoring (F18) coming in Phase 2.",

    mask: "Plate Mask",
    localSaveTitle: "Save to This PC",
    chooseFolder: "Choose Folder",
    noFolderChosen: "No folder chosen (will download)",
    folderLabel: (name) => `Folder: ${name}`,
    downloadModeNote:
      "Saving via browser download to your Downloads folder (this browser can't pick a folder over http).",
    saveToPC: "Save Frame to PC",
    autoSavePC: "Auto-save captures to PC",
    saveNoFrame: "No frame to save — capture first",
    savePermDenied: "Folder write permission denied",
    savedTo: (p) => `Saved to: ${p}`,
    savedDownload: (n) => `Downloaded: ${n}`,
    saveFailed: (e) => `Save failed: ${e}`,

    alignGrid: "Align Grid",
    doneAlign: "Done",
    autoFit: "Auto-fit",
    wellSize: "Well size",
    gridHint:
      "Drag the pink A1 / A12 / H1 handles onto those wells; drag inside the grid to move it all.",

    switchTo: "中文",
  },
};

function pickDefault() {
  const saved = localStorage.getItem("platescope_lang");
  if (saved === "zh" || saved === "en") return saved;
  // 没存过就按浏览器语言猜
  return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
}

const I18nContext = React.createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLang] = React.useState(pickDefault);

  React.useEffect(() => {
    localStorage.setItem("platescope_lang", lang);
    document.documentElement.lang = lang;
  }, [lang]);

  const t = React.useCallback(
    (key, ...args) => {
      const entry = translations[lang][key] ?? translations.en[key] ?? key;
      return typeof entry === "function" ? entry(...args) : entry;
    },
    [lang]
  );

  const toggle = React.useCallback(
    () => setLang((l) => (l === "zh" ? "en" : "zh")),
    []
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, toggle, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
