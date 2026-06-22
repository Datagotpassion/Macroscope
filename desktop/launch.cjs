// 启动 Electron 前先清掉 ELECTRON_RUN_AS_NODE。
// VS Code / Electron 宿主会把这个变量设为 1,导致 electron.exe 当成普通 Node 跑,
// 于是 require("electron") 返回的是路径字符串而不是 API,主进程直接崩 (ipcMain undefined)。
delete process.env.ELECTRON_RUN_AS_NODE;

const { spawn } = require("child_process");
const electron = require("electron"); // 在普通 Node 里 require 返回 electron.exe 路径

const child = spawn(electron, ["."], { stdio: "inherit", env: process.env });
child.on("close", (code) => process.exit(code ?? 0));
