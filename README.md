# PlateScope

树莓派 96 孔板成像系统 — Phase 1 实现 (F1–F7)。

Pi 是服务器,浏览器是显示端。Python (FastAPI) 后端 + React 前端,
局域网内任意设备打开浏览器即可使用。

## 已实现 (Phase 1)

| ID | 功能 | 位置 |
|----|------|------|
| F1 | 单帧全板拍摄 | `backend/camera.py` |
| F2 | 实时预览串流 (WebSocket MJPEG) | `backend/main.py` `/ws/preview` |
| F3 | 96 孔自动检测 (Hough + 网格拟合) | `backend/plate_detector.py` |
| F4 | 数字裁剪放大 | `/api/well/{label}/image` |
| F5 | 定时拍摄 | `backend/scheduler.py` |
| F6 | 手动确认存储 | `backend/image_store.py` |
| F7 | Web UI 远程访问 | `frontend/` |
| F8 | 孔位标注 A1–H12 | `PlateDetector.annotate` |

## 相对需求文档修复的问题

1. **`PlateDetector` 标签分配会崩溃** — 旧 `_find_breaks` 返回的是索引而非
   圆坐标,`_assign_labels` 解包 `(cx, cy, r)` 直接报错。现改为按已知行/列数
   做一维聚类 + 线性拟合，正确分配 A1–H12。
2. **纯 Hough 检测不稳定** — 边缘孔/空孔/反光时经常凑不齐 96 个。现用检测到的
   圆去**拟合标准板几何 (ANSI/SLAS 9mm pitch)**，缺失的孔用网格外推补全，
   保证始终输出 96 孔 (`detected` 字段标明是检测到的还是补全的)。
3. **预览串流不可用** — 旧 `stream_preview` 建了 `preview_config` 却没应用、
   没 import `cv2`、且会阻塞事件循环。现正确切换预览模式、用 `asyncio.to_thread`
   避免阻塞、断连优雅退出。
4. **开发机无相机也能跑** — `camera.py` 在 picamera2 不可用时自动回退到
   `MockCamera`，渲染合成 96 孔板，可在 Windows/Mac 上完整联调后再部署到 Pi。
5. **路径安全** — `image_store.py` 对实验名/帧名做净化，防止路径穿越。

## 本地开发 (无树莓派)

后端 (会自动用 MockCamera):
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

前端:
```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 (代理 /api 到 :8000)
```

测试:
```bash
cd backend
pytest
cd ../frontend
npm test             # 扫描判断逻辑 (scanLogic.js),node --test,不需要额外依赖
```

## 整板扫描的照片验收

每张照片都带这些判断 (见 `backend/scan.py` 开头、`frontend/src/scanLogic.js`),写进扫描记录
`… scan log v3.csv` (每圈一个 `scan_id`;另有板角核验、扫后对焦复查、地图决策三种事件行):

| 列 | 含义 |
|---|---|
| `position` | 孔位:confirmed (对正 + 本格板边一致) / aligned / edge_mismatch / unaligned / unchecked |
| `identity` | 孔身份:verified (A1 板角核验通过) / partial / conflict / failed / unknown |
| `focus_basis` | 焦面依据:peak (本格找到峰) / reference (和本格历史峰值比够清晰) / prediction (沿用预测高度) / … |
| `unverified` | 有证据表明不对 → 文件名加 ` - UNVERIFIED` (照片照样保存) |
| `analysis_ready` | 孔位对正 + 身份已核验 + 焦面有本格证据,可直接用于依赖孔内细节的分析 |

- 板角核验:每圈开拍前走到地图上的 A1,看外侧两个方向是不是板外。「对不上」→ 整圈照片标 UNVERIFIED;
  「看不清」→ 身份未核验,但不算地图错了。
- 对焦记忆:≥2 格一致才算知道孔底平面;手教的 Z (Plate 页「Teach Z」) 单独存,只用于那一格。
- 地图修正:只有「整圈完整 + 板角核验通过 + 每格都对正」时才自动修正,四角单轮 / 累计都有上限,
  扫描汇总里可撤销。
- 6 / 12 孔板一帧只有 1–2 个孔,画面核验做不了:Pi 只按地图位置和计划高度拍,不标 UNVERIFIED。

## 部署到树莓派

> ⚠️ **换相机前务必先关机断电!** 带电插拔 CSI 排线会掉电,曾经因此写坏 SD 卡导致
> 无法开机。步骤:`sudo shutdown -h now` → 等绿灯停 → 拔电源 → 再动排线。排线本身
> 也会用旧老化 (出现 "no cameras available" 时先换排线)。

新版 Raspberry Pi OS 的 Python,piwheels 没有 numpy/scipy 的预编译 wheel,`pip`
会从源码编译 (极慢甚至卡死)。所以**重的科学库走 apt,只有 web 层走 pip**:

```bash
# 系统级:相机 + numpy/scipy/opencv/pillow (预编译,和相机栈匹配)
sudo apt install -y python3-picamera2 python3-numpy python3-scipy \
                    python3-opencv python3-pil python3-full git

# 克隆 + venv (--system-site-packages 让 venv 看得到上面的系统库)
git clone https://github.com/Datagotpassion/Macroscope.git ~/Macroscope
cd ~/Macroscope/backend
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r requirements-pi.txt          # 只装 fastapi/uvicorn 等纯 web 包

# 开机自启 (systemd)
sudo cp ~/Macroscope/deploy/platescope.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now platescope
```

用桌面 App (`desktop/`) 的话,Pi 不用构建前端 —— App 自带 UI,Pi 只跑后端。
浏览器访问才需要 `cd frontend && npm install && npm run build`。

**更新已部署的 Pi:** `cd ~/Macroscope && git pull && sudo systemctl restart platescope`。
装了相机看门狗的话也重启它 (它直接运行仓库里的脚本):`sudo systemctl restart platescope-watchdog`。
从 PC 验证:`curl http://raspberrypi.local:8000/api/status` 应返回 `"camera":"picamera2"`。

## 数据目录

默认 `~/platescope_data/<实验名>/<时间戳>.jpg`,可用环境变量
`PLATESCOPE_DATA` 覆盖。拍照默认只缓存到临时目录,点「保存」或确认定时任务后才写盘。
