"""FastAPI 主入口 (F7).

Pi 是服务器,浏览器只是显示端。提供 REST API + WebSocket 预览,
并托管打包后的 React 前端静态文件。
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

import cv2
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from camera import CameraController, _log
from image_store import ImageStore
from plate_detector import PlateDetector
from scheduler import Scheduler

app = FastAPI(title="PlateScope")

# 开发期前端跑在 Vite (5173),允许跨域;生产时前端由本服务静态托管,同源无需 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

camera = CameraController()
detector = PlateDetector()
store = ImageStore()
scheduler = Scheduler(camera, store)


def _encode_jpeg(image, quality: int = 90) -> bytes:
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise HTTPException(500, "JPEG 编码失败")
    return buf.tobytes()


# ── REST API ──


@app.get("/api/status")
async def status():
    """系统状态:相机类型 + 运行中的定时任务。"""
    return {
        "camera": "mock" if camera.is_mock else "picamera2",
        "jobs": scheduler.list_jobs(),
        "time": datetime.now().isoformat(),
    }


@app.get("/api/capture")
async def capture_now():
    """手动触发拍照 — 只缓存到内存/tmp,不写正式目录。"""
    image = camera.capture_array()
    wells = detector.detect_wells(image)
    store.buffer_frame(image, meta={"wells": len(wells)})
    return {
        "wells": wells,
        "total": len(wells),
        "timestamp": datetime.now().isoformat(),
    }


@app.get("/api/wells")
async def get_wells():
    """获取当前帧的所有孔位 (基于一次新拍摄)。"""
    image = camera.capture_array()
    store.buffer_frame(image, meta={})
    wells = detector.detect_wells(image)
    return {"wells": wells, "total": len(wells)}


@app.get("/api/plate/image")
async def get_plate_image(annotate: bool = False):
    """获取当前全板图像 (不写正式目录)。annotate=True 叠加孔位标注。"""
    image = camera.capture_array()
    store.buffer_frame(image, meta={})
    if annotate:
        wells = detector.detect_wells(image)
        image = detector.annotate(image, wells)
    return Response(content=_encode_jpeg(image), media_type="image/jpeg")


@app.get("/api/well/{label}/image")
async def get_well_image(label: str):
    """获取指定孔的裁剪放大图。优先用缓存帧,避免重复拍摄。"""
    image = store.latest_frame
    if image is None:
        image = camera.capture_array()
        store.buffer_frame(image, meta={})
    wells = detector.detect_wells(image)
    well = next((w for w in wells if w["label"] == label.upper()), None)
    if not well:
        raise HTTPException(404, f"Well {label} not found")
    crop = detector.crop_well(image, well)
    return Response(content=_encode_jpeg(crop), media_type="image/jpeg")


@app.post("/api/save")
async def save_frame(experiment: str):
    """用户确认保存当前缓存帧到磁盘。"""
    path = store.save_frame(experiment)
    if not path:
        raise HTTPException(400, "没有可保存的帧,请先 /api/capture")
    return {"saved": path}


@app.post("/api/timelapse/start")
async def start_timelapse(experiment: str, interval: int = 30):
    """开始定时拍摄 (确认后自动写盘)。"""
    try:
        scheduler.start_timelapse(experiment, interval)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"status": "started", "experiment": experiment, "interval": interval}


@app.post("/api/timelapse/stop")
async def stop_timelapse(experiment: str):
    """停止定时拍摄。"""
    stopped = scheduler.stop_timelapse(experiment)
    return {"status": "stopped" if stopped else "not_found", "experiment": experiment}


@app.get("/api/experiments")
async def list_experiments():
    return {"experiments": store.list_experiments()}


@app.get("/api/experiments/{name}/frames")
async def list_frames(name: str):
    return {"frames": store.list_frames(name)}


@app.get("/api/experiments/{name}/frames/{frame}")
async def get_frame(name: str, frame: str):
    path = store.frame_path(name, frame)
    if not path:
        raise HTTPException(404, "帧不存在")
    return FileResponse(str(path), media_type="image/jpeg")


# ── WebSocket 实时预览 (F2) ──


@app.websocket("/ws/preview")
async def preview(ws: WebSocket):
    """低分辨率连续帧推送到浏览器 (~10 fps)。"""
    await ws.accept()
    try:
        while True:
            # 在线程里拍照,避免阻塞事件循环;preview=True 用低分辨率模式
            frame = await asyncio.to_thread(camera.capture_array, True)
            jpeg = await asyncio.to_thread(_encode_jpeg, frame, 70)
            await ws.send_bytes(jpeg)
            await asyncio.sleep(0.1)  # ~10 fps
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:  # 串流出错时优雅关闭
        _log(f"[preview] 串流结束: {exc!r}")


# ── 前端静态文件 ──
# 打包后的前端放在 frontend/dist;不存在 (还没 build) 时跳过,API 仍可用。

_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend")
else:
    @app.get("/")
    async def _no_frontend():
        return {
            "message": "PlateScope API 运行中。前端尚未构建 (frontend/dist 不存在)。",
            "docs": "/docs",
        }


@app.on_event("shutdown")
def _shutdown():
    scheduler.shutdown()
    camera.close()
