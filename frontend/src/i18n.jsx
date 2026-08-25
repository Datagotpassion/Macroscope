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
    previewReconnecting: "预览重连中…",
    captureHint: "点击「拍摄全板」开始",
    wellsDetected: (n) => `检测到 ${n} 孔`,
    wellsDirect: (n) => `${n} 直接检测`,
    wellsFilled: (n) => `${n} 网格补全`,

    wellDetailHint: "点击左侧任意孔位查看放大图",
    wellTitle: (label) => `孔位 ${label}`,
    refresh: "刷新",
    zoomLive: "实时",
    zoomStatic: "静帧",
    inspectSharp: "高清检视",
    backToPlate: "← 返回全板",
    snapMode: "全分辨率静帧 · 每 ~2-3 秒刷新",
    refreshingSnap: "刷新中…",
    beatTitle: "跳动检测",
    beatRun: "检测跳动",
    beatMeasuring: "测量中…",
    beatMeasuringNote: (s) => `独占相机抓取约 ${s} 秒…实时预览会暂停`,
    beatFailed: (e) => `检测失败: ${e}`,
    beatConfidence: "置信度",
    beatCrosscheck: "峰值计数",
    beatNone: "未检测到明显跳动 (信号太弱或不规律)",
    beatWaveformHint: "波形 = 收缩信号随时间 (自动选最强的:PCA/运动/亮度);规律起伏即为跳动。",
    beatPatchHint: "实际测量的区域 — 确认 organoid 在框内",
    beatSave: "保存结果",
    beatSaved: "已保存到跳动日志 (platescope_beats.csv) + 波形 JSON",
    beatSaveFailed: (e) => `保存失败: ${e}`,

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

    pcTlTitle: "定时拍摄 → 本机文件夹",
    pcTlChoose: "选择文件夹",
    pcTlFolder: (name) => `文件夹: ${name}`,
    pcTlNoFolder: (mode) => `未选文件夹 (${mode})`,
    pcTlCondition: "实验条件",
    pcTlStartDay: "起始 Day#",
    pcTlPreview: (name) => `文件名: ${name}`,
    pcTlStart: "开始定时拍摄",
    pcTlStop: "停止",
    pcTlStatus: (n) => `已存 ${n} 张`,
    pcTlLast: (name) => `最新: ${name}`,
    pcTlNeedFolder: "请先选择文件夹",
    pcTlNeedCondition: "请填写实验条件",
    pcTlRunningNote: "保持本 App 与电脑开机;相机离线时自动跳过,恢复后继续。",

    systemStatus: "系统状态",
    connection: "连接",
    connected: "已连接",
    disconnected: "未连接",
    connect: "连接",
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
    resetGrid: "重置网格",
    resetWells: "重置微调",
    wellSize: "孔大小",
    gridRows: "行",
    gridCols: "列",
    gridHint: "先拖粉色 A1 / A12 / H1 摆好整体网格 (拖内部可整体平移);再拖单个孔微调位置、拖孔右边缘小点改大小。",

    stageTitle: "运动平台",
    stageOffline: "未连接",
    stageReconnecting: "重连中…",
    stageOfflineHint: "未连接到 Moonraker (检查 Klipper 是否运行、地址是否可达)。",
    stageStep: "步进",
    stageFocus: "对焦",
    stageHomed: "已回零",
    stageNotHomed: "未回零",
    stageHomeAll: "回零 全部",
    stageHomeXY: "回零 XY",
    stageHomeZ: "回零 Z",
    stageForce: "强制可动 (免回零)",
    stageForceHint:
      "不回零直接解锁移动:把当前位置当作量程中点并标记已回零,之后 jog/前往即可用 (CoreXY 走直线)。坐标是假定的,精确定位仍需回零。用于回零前/失败时手动挪台。",
    stageEstop: "急停",
    stageRestart: "复位固件",
    stageHomeHint: "尚未回零 —— 未回零时 Klipper 会拒绝坐标移动。先点回零 (或急停后复位固件)。",
    stageGoto: "前往坐标 (mm)",
    stageGo: "前往",
    stageSavedPos: "已存位置 (示教)",
    stageSaveCurrent: "存当前",
    stagePosName: "位置名",
    stageNoSaved: "暂无已存位置 —— 移到某处后「存当前」记录 XY",
    stageAutofocus: "自动对焦",
    stageAfRunning: "对焦中…",
    stageAfHint:
      "Z 小步 (0.1mm) 扫描找清晰度峰值。先在网格点选一个孔 → 只对该孔对焦;否则整幅(易被别处细节带偏)。需 Home Z + 相机在线。",
    stageAfTarget: (label) => `→ 孔 ${label}`,
    stageAfWhole: "→ 整幅(先点选孔)",
    stageAfResult: (z) => `焦点 Z=${z}`,
    stageSetZ: "手动对焦 Z (mm)",
    stageSetZHint: "先移到大致焦点,再自动对焦微调",

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
    previewReconnecting: "Reconnecting…",
    captureHint: 'Click "Capture Plate" to start',
    wellsDetected: (n) => `Detected ${n} wells`,
    wellsDirect: (n) => `${n} direct`,
    wellsFilled: (n) => `${n} grid-filled`,

    wellDetailHint: "Click any well on the left to view a zoomed image",
    wellTitle: (label) => `Well ${label}`,
    refresh: "Refresh",
    zoomLive: "Live",
    zoomStatic: "Still",
    inspectSharp: "Inspect (sharp)",
    backToPlate: "← Back to plate",
    snapMode: "Full-resolution snapshot · refreshes every ~2-3s",
    refreshingSnap: "Refreshing…",
    beatTitle: "Beat detection",
    beatRun: "Detect beating",
    beatMeasuring: "Measuring…",
    beatMeasuringNote: (s) => `Capturing ~${s}s with exclusive camera… live preview pauses`,
    beatFailed: (e) => `Detection failed: ${e}`,
    beatConfidence: "Confidence",
    beatCrosscheck: "Peak count",
    beatNone: "No clear beating detected (signal too weak or irregular)",
    beatWaveformHint: "Waveform = contraction signal over time (best of PCA / motion / brightness); regular oscillation = beating.",
    beatPatchHint: "The region actually measured — check the organoid is inside",
    beatSave: "Save result",
    beatSaved: "Saved to beat log (platescope_beats.csv) + waveform JSON",
    beatSaveFailed: (e) => `Save failed: ${e}`,

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

    pcTlTitle: "Timelapse → PC folder",
    pcTlChoose: "Choose folder",
    pcTlFolder: (name) => `Folder: ${name}`,
    pcTlNoFolder: (mode) => `No folder (${mode})`,
    pcTlCondition: "Experiment condition",
    pcTlStartDay: "Start day #",
    pcTlPreview: (name) => `Filename: ${name}`,
    pcTlStart: "Start timelapse",
    pcTlStop: "Stop",
    pcTlStatus: (n) => `${n} saved`,
    pcTlLast: (name) => `Last: ${name}`,
    pcTlNeedFolder: "Choose a folder first",
    pcTlNeedCondition: "Enter a condition",
    pcTlRunningNote:
      "Keep this app + PC running; offline captures are skipped and resume automatically.",

    systemStatus: "System Status",
    connection: "Connection",
    connected: "Connected",
    disconnected: "Disconnected",
    connect: "Connect",
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
    resetGrid: "Reset grid",
    resetWells: "Reset tweaks",
    wellSize: "Well size",
    gridRows: "Rows",
    gridCols: "Cols",
    gridHint:
      "First drag the pink A1 / A12 / H1 to place the whole grid (drag inside to move it all); then drag individual wells to reposition, and the dot on a well's right edge to resize.",

    stageTitle: "Motion Stage",
    stageOffline: "Offline",
    stageReconnecting: "Reconnecting…",
    stageOfflineHint:
      "Not connected to Moonraker (check Klipper is running and the host is reachable).",
    stageStep: "Step",
    stageFocus: "focus",
    stageHomed: "Homed",
    stageNotHomed: "Not homed",
    stageHomeAll: "Home All",
    stageHomeXY: "Home XY",
    stageHomeZ: "Home Z",
    stageForce: "Force move (no home)",
    stageForceHint:
      "Unlock motion without homing: treats the current spot as mid-range and marks the axes homed, so jog/go-to work (CoreXY stays straight). Coordinates are assumed — real homing is still needed for accurate positions. For nudging the stage before/without a home.",
    stageEstop: "E-STOP",
    stageRestart: "Restart FW",
    stageHomeHint:
      "Not homed yet — Klipper refuses coordinated moves until homed. Click Home first (or Restart FW after an E-stop).",
    stageGoto: "Go to (mm)",
    stageGo: "Go",
    stageSavedPos: "Saved positions (teach)",
    stageSaveCurrent: "Save current",
    stagePosName: "name",
    stageNoSaved: "No saved positions — move somewhere, then \"Save current\" to record its XY",
    stageAutofocus: "Autofocus",
    stageAfRunning: "Focusing…",
    stageAfHint:
      "Sweeps Z (0.1 mm steps) for peak sharpness. Select a well in the grid to focus on just that well; otherwise whole frame (easily pulled off by detail elsewhere). Needs Z homed + camera online.",
    stageAfTarget: (label) => `→ well ${label}`,
    stageAfWhole: "→ whole frame (select a well)",
    stageAfResult: (z) => `Focus Z=${z}`,
    stageSetZ: "Focus Z (mm)",
    stageSetZHint: "move near focus, then Autofocus fine-tunes",

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
