// 安全地把原生能力暴露给渲染层 (contextIsolation 下唯一的桥)。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  // 默认 Pi 地址 (前端 api.js 在没有用户设置时用它)
  defaultApiBase: ipcRenderer.sendSync("get-default-api"),
  // 弹出系统文件夹选择框,返回绝对路径 (取消则 null)
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  // 把字节写入 dir/name,返回完整路径
  saveImage: (dir, name, bytes) =>
    ipcRenderer.invoke("save-image", { dir, name, bytes }),
  // 追加一行到 CSV (文件不存在时先写表头)
  appendCsv: (dir, name, header, row) =>
    ipcRenderer.invoke("append-csv", { dir, name, header, row }),
});
