"""FastAPI 主入口 (F7).

Pi 是服务器,浏览器只是显示端。提供 REST API + WebSocket 预览,
并托管打包后的 React 前端静态文件。
"""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import time
from datetime import datetime
from pathlib import Path

import cv2
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import autofocus
import beat
import wellgrid
from align import AlignError, Aligner
from camera import CameraController, _log
from platefind import PlateFinder
from scan import ScanError, Shooter
from image_store import ImageStore
from plate_detector import PlateDetector
from scheduler import Scheduler
from stage import StageController, StageError

app = FastAPI(title="PlateScope")

# 开发期前端跑在 Vite (5173),允许跨域;生产时前端由本服务静态托管,同源无需 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Camera", "X-Shot"],  # 跨域 (Electron 渲染层) 读得到相机类型 / 拍摄信息
)

camera = CameraController()
detector = PlateDetector()
store = ImageStore()
scheduler = Scheduler(camera, store)
stage = StageController()
aligner = Aligner(camera, stage)
finder = PlateFinder(aligner)
shooter = Shooter(camera, stage, aligner)

# 实时预览参数。PREVIEW_FPS 设得很高 = 实际不限速,跑多快取决于相机/编码/网络。
PREVIEW_FPS = 120
PREVIEW_QUALITY = 65


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
    """手动触发拍照 — 只缓存到内存/tmp,不写正式目录。

    拍照和孔位检测都很重 (全分辨率 + HoughCircles),必须放到线程里跑,
    否则会阻塞事件循环,让整个服务器 (包括本请求的响应) 卡死。
    """
    t0 = time.perf_counter()
    image = await asyncio.to_thread(camera.capture_array)
    t1 = time.perf_counter()
    wells = await asyncio.to_thread(detector.detect_wells, image)
    t2 = time.perf_counter()
    store.buffer_frame(image, meta={"wells": len(wells)})
    store.latest_wells = wells  # 缓存检测结果,标注时直接复用,不重复检测
    _log(f"[capture] grab={t1 - t0:.2f}s detect={t2 - t1:.2f}s wells={len(wells)}")
    return {
        "wells": wells,
        "total": len(wells),
        "timestamp": datetime.now().isoformat(),
    }


@app.get("/api/wells")
async def get_wells():
    """获取当前帧的所有孔位 (基于一次新拍摄)。"""
    image = await asyncio.to_thread(camera.capture_array)
    store.buffer_frame(image, meta={})
    wells = await asyncio.to_thread(detector.detect_wells, image)
    return {"wells": wells, "total": len(wells)}


@app.get("/api/plate/image")
async def get_plate_image(annotate: bool = False, fresh: bool = False):
    """获取当前全板图像。

    默认复用最近一次 /api/capture 缓存的帧 (不重新拍摄),这样点一次「拍摄」
    只拍一张,而且显示的就是刚分析过的那一帧。fresh=True 时强制重新拍摄。
    """
    if fresh or store.latest_frame is None:
        image = await asyncio.to_thread(camera.capture_array)
        store.buffer_frame(image, meta={})
    else:
        image = store.latest_frame
    if annotate:
        # 复用 /api/capture 已检测好的孔位,避免对同一帧重复跑 HoughCircles
        wells = store.latest_wells
        if wells is None:
            wells = await asyncio.to_thread(detector.detect_wells, image)
        image = await asyncio.to_thread(detector.annotate, image, wells)
    jpeg = await asyncio.to_thread(_encode_jpeg, image)
    # X-Camera: 让 timelapse / 看门狗分辨这帧是不是真相机拍的 (mock = 假数据)
    return Response(content=jpeg, media_type="image/jpeg", headers={"X-Camera": camera.kind})


@app.get("/api/well/{label}/image")
async def get_well_image(label: str):
    """获取指定孔的裁剪放大图。优先用缓存帧,避免重复拍摄。"""
    image = store.latest_frame
    if image is None:
        image = await asyncio.to_thread(camera.capture_array)
        store.buffer_frame(image, meta={})
    wells = await asyncio.to_thread(detector.detect_wells, image)
    well = next((w for w in wells if w["label"] == label.upper()), None)
    if not well:
        raise HTTPException(404, f"Well {label} not found")
    crop = detector.crop_well(image, well)
    jpeg = await asyncio.to_thread(_encode_jpeg, crop)
    return Response(content=jpeg, media_type="image/jpeg")


@app.get("/api/frame/latest")
async def get_latest_frame():
    """返回最近一次拍摄缓存的原始帧 (全质量, 不重新拍摄)。

    供前端保存到用户的 PC —— 保存的正是刚分析过的那一帧。
    """
    if store.latest_frame is None:
        raise HTTPException(404, "没有缓存帧,请先 /api/capture")
    return Response(content=_encode_jpeg(store.latest_frame, 95), media_type="image/jpeg")


@app.get("/api/crop")
async def crop_region(cx: float, cy: float, r: float):
    """按归一化坐标裁剪缓存帧 (供手动网格的单孔放大)。

    cx, cy 是相对整图宽/高的比例 (0..1);r 是相对宽度的比例。
    """
    image = store.latest_frame
    if image is None:
        raise HTTPException(404, "没有缓存帧,请先拍摄")
    h, w = image.shape[:2]
    px, py = int(cx * w), int(cy * h)
    pr = max(1, int(r * w))
    x1, y1 = max(0, px - pr), max(0, py - pr)
    x2, y2 = min(w, px + pr), min(h, py + pr)
    if x2 <= x1 or y2 <= y1:
        raise HTTPException(400, "裁剪区域为空")
    crop = image[y1:y2, x1:x2]
    jpeg = await asyncio.to_thread(_encode_jpeg, crop)
    return Response(content=jpeg, media_type="image/jpeg")


@app.get("/api/well/snapshot")
async def well_snapshot(cx: float, cy: float, r: float):
    """拍一张全分辨率静帧并裁剪该孔 (分支 B:最高清晰度,较慢 ~1-2s/张)。"""
    image = await asyncio.to_thread(camera.capture_array)  # 全分辨率静帧
    h, w = image.shape[:2]
    px, py = int(cx * w), int(cy * h)
    pr = max(1, int(r * 1.3 * w))
    x1, y1 = max(0, px - pr), max(0, py - pr)
    x2, y2 = min(w, px + pr), min(h, py + pr)
    if x2 <= x1 or y2 <= y1:
        raise HTTPException(400, "裁剪区域为空")
    crop = image[y1:y2, x1:x2]
    jpeg = await asyncio.to_thread(_encode_jpeg, crop, 92)
    return Response(content=jpeg, media_type="image/jpeg")


@app.post("/api/well/beat")
async def detect_beat(cx: float, cy: float, r: float, duration: float = 8.0):
    """跳动检测 (F16):对该孔抓一段高帧率序列,分析收缩频率。

    抓帧期间相机被独占,实时预览会暂停几秒。
    """
    duration = max(2.0, min(60.0, duration))
    times, frames, patch = await asyncio.to_thread(
        camera.measure_motion, cx, cy, r, duration
    )
    result = await asyncio.to_thread(beat.analyze, times, frames)
    # 把「实际测量的孔区域」缩略图一并返回 (去黑盒:用户能看清测的是不是 organoid)
    if patch is not None:
        ok, buf = cv2.imencode(".jpg", patch, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if ok:
            result["patch"] = "data:image/jpeg;base64," + base64.b64encode(
                buf.tobytes()
            ).decode("ascii")
    _log(
        f"[beat] n={result.get('n')} fps={result.get('fps')} "
        f"bpm={result.get('bpm')} conf={result.get('confidence')} method={result.get('method')}"
    )
    return result


@app.post("/api/preview/roi")
async def set_preview_roi(cx: float, cy: float, r: float):
    """硬件数字变焦:让实时预览只读出该孔区域并放大 (单孔高清检视)。"""
    camera.set_roi(cx, cy, r)
    return {"roi": True}


@app.post("/api/preview/roi/clear")
async def clear_preview_roi():
    camera.clear_roi()
    return {"roi": False}


@app.post("/api/save")
async def save_frame(experiment: str):
    """用户确认保存当前缓存帧到磁盘 (Pi 端)。"""
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


# ── 运动平台 (CoreXY + Z, 通过 Moonraker/Klipper) ──


@app.get("/api/stage/status")
async def stage_status():
    """平台连接状态 + 当前坐标 + 已 home 轴。Moonraker 不可达时 connected=False。"""
    return await asyncio.to_thread(stage.status)


@app.post("/api/stage/jog")
async def stage_jog(axis: str, distance: float, feed: float = 600):
    """手动步进单轴 (相对移动)。未 home 时 Klipper 会拒绝并返回提示。"""
    try:
        await asyncio.to_thread(stage.jog, axis, distance, feed)
    except StageError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/stage/move")
async def stage_move(
    x: float | None = None,
    y: float | None = None,
    z: float | None = None,
    feed: float = 1200,
):
    """绝对移动到坐标 (只给要动的轴)。"""
    try:
        await asyncio.to_thread(stage.move, x, y, z, feed)
    except StageError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/stage/force_position")
async def stage_force_position(
    x: float | None = None,
    y: float | None = None,
    z: float | None = None,
):
    """不 home 也能动:SET_KINEMATIC_POSITION 假定当前位置为给定坐标 (默认量程中点)
    并标记为已 home,之后普通 jog/前往即可用 (CoreXY 正确)。仅用于手动挪台/救援。"""
    try:
        await asyncio.to_thread(stage.force_position, x, y, z)
    except StageError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/stage/home")
async def stage_home(axes: str = "XYZ"):
    """回零。sensorless XY homing 由 printer.cfg 配置。"""
    try:
        await asyncio.to_thread(stage.home, axes)
    except StageError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/stage/wait")
async def stage_wait():
    """阻塞直到运动队列清空 (M400)。巡扫时每步移动后等停稳再拍。"""
    try:
        await asyncio.to_thread(stage.wait_moves)
    except StageError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/stage/stop")
async def stage_stop():
    """急停 (需之后 firmware_restart 恢复)。"""
    try:
        await asyncio.to_thread(stage.stop)
    except StageError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/stage/firmware_restart")
async def stage_firmware_restart():
    """急停/报错后重启 Klipper 固件,恢复 Ready。"""
    try:
        await asyncio.to_thread(stage.firmware_restart)
    except StageError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.post("/api/autofocus")
async def run_autofocus(
    z_range: float = 1.0,
    step: float = 0.1,
    feed: float = 120,
    settle: float = 0.2,
    cx: float | None = None,
    cy: float | None = None,
    r: float | None = None,
):
    """自动对焦:以当前 Z 为中心 ±z_range 小步扫描,取清晰度峰值并移到该 Z。

    需要平台在线且 Z 已 home (用 G1 绝对移动,越界会被 Klipper 拒绝 —— 板不会
    撞镜头)。给 cx,cy,r 则只对该孔区域对焦。相机为 mock 时仍会跑完流程,只是
    找不到真实焦点。
    """
    st = await asyncio.to_thread(stage.status)
    if not st.get("connected"):
        raise HTTPException(400, "运动平台离线")
    if "z" not in (st.get("homed") or "").lower():
        raise HTTPException(400, "Z 轴未回零,请先 Home Z")
    z0 = float((st.get("position") or {}).get("z", 0.0))
    amin = (st.get("axis_minimum") or [None, None, None])[2]
    amax = (st.get("axis_maximum") or [None, None, None])[2]
    zs = autofocus.sweep_positions(z0, z_range, step, amin, amax)

    def _measure(z: float) -> float:
        stage.move(z=z, feed=feed)
        stage.wait_moves()
        if settle > 0:
            time.sleep(settle)
        frame = camera.capture_array(preview=True)
        return autofocus.sharpness(autofocus.to_gray(frame, cx, cy, r))

    curve: list[dict] = []
    for z in zs:
        try:
            s = await asyncio.to_thread(_measure, z)
        except StageError as e:
            raise HTTPException(400, f"Z 移动失败: {e}")
        curve.append({"z": z, "sharp": round(s, 2)})

    best = autofocus.best_z(curve)
    if best is not None:
        try:
            await asyncio.to_thread(stage.move, None, None, best["z"], feed)
            await asyncio.to_thread(stage.wait_moves)
        except StageError as e:
            raise HTTPException(400, f"移回焦点失败: {e}")
    _log(
        f"[autofocus] n={len(curve)} best_z={best and best['z']} "
        f"z0={z0:.2f} step={step} mock={camera.is_mock}"
    )
    return {"best_z": best and best["z"], "curve": curve, "z0": z0}


# ── 自动对准 (相机↔平台标定 + 局部孔阵识别) ──


def _require_real_camera() -> None:
    if camera.kind == "mock":
        raise HTTPException(400, "相机不可用 (退回了 MockCamera),无法对准")


# 标定/对准/找板都会连续移动平台,同一时间只允许一个在跑
_motion_job = asyncio.Lock()


async def _motion(fn, *args):
    if _motion_job.locked():
        raise HTTPException(409, "another alignment job is running")
    async with _motion_job:
        try:
            return await asyncio.to_thread(fn, *args)
        except (AlignError, StageError, ScanError) as e:
            raise HTTPException(400, str(e))


@app.post("/api/align/calibrate")
async def align_calibrate(step_mm: float = 2.0):
    """一次性标定:平台沿 X/Y 各走几小步,测画面平移,保存像素↔毫米矩阵。需板子在画面里。"""
    _require_real_camera()
    step_mm = max(0.5, min(4.0, step_mm))  # 必须小于半个孔距 (96 孔板 4.5 mm)
    return await _motion(aligner.calibrate, step_mm)


@app.get("/api/align/calibration")
async def align_calibration():
    return aligner.cal or {}


@app.get("/api/align/view")
async def align_view(pitch_mm: float = 9.0, overlay: bool = False):
    """只分析当前画面 (不动平台):孔阵、离中心最近的孔偏了多少。overlay=true 返回标注图。"""
    _require_real_camera()
    frame = await asyncio.to_thread(aligner.grab)
    res = await asyncio.to_thread(aligner.analyze, frame, pitch_mm)
    if overlay:
        jpeg = await asyncio.to_thread(_encode_jpeg, wellgrid.draw_overlay(frame, res), 85)
        return Response(content=jpeg, media_type="image/jpeg")
    return res


@app.post("/api/align/center")
async def align_center(pitch_mm: float = 9.0, tol_mm: float = 0.15, max_iter: int = 4):
    """把离画面中心最近的孔对准到中心 (平台小步移动,最多 max_iter 次)。"""
    _require_real_camera()
    res = await _motion(aligner.center_on_well, pitch_mm, tol_mm, max_iter)
    _log(f"[align] centered at {res['position']} residual={res['residual_mm']}mm moves={res['moves']}")
    return res


@app.post("/api/plate/find")
async def plate_find(fmt: int = 96):
    """自动找板:相机从 A1 附近出发 (A1 要在画面里),定位 A1/A12/H1,返回板面地图的三个角。

    约 1–2 分钟。结束时停在 A1,方便在预览里确认。只支持 24/48/96 孔板。
    """
    _require_real_camera()
    res = await _motion(finder.find, fmt)
    _log(f"[plate] found {fmt}-well: ref={res['ref']} pitch={res['pitch_mm']} angle={res['angle_deg']}")
    return res


# ── 一键拍全板 (App 编排全板顺序/保存/重试;这里是自检 + 单格) ──


@app.post("/api/scan/preflight")
async def scan_preflight(home: bool = True):
    """开拍前自检:相机是真相机、Klipper 就绪、已标定、画面不黑;没回零就回零 (Z 会重试一次)。"""
    return await _motion(shooter.preflight, home)


@app.post("/api/scan/shot")
async def scan_shot(
    x: float,
    y: float,
    z: float,
    rows_dx: float = 1.0,
    rows_dy: float = 0.0,
    row_half: bool = True,
    col_half: bool = True,
    pitch_mm: float = 9.0,
    af: bool = True,
    af_range: float = 3.0,
    ref_sharp: float | None = None,
):
    """拍一格:移过去 → 对正 → 按需对焦 → 全分辨率照片。

    照片在 body (JPEG);对正/对焦/最终高度等过程信息在 X-Shot 头 (JSON)。
    (x,y) 是格子中心,z 是预测的对焦高度;rows_dx/dy 是板上「往下一行」的平台方向,
    row_half/col_half 表示这格在行/列方向的孔数是偶数 (中心在两孔正中)。
    """
    _require_real_camera()
    img, info = await _motion(functools.partial(
        shooter.shoot, x, y, z, rows_dir=(rows_dx, rows_dy), row_half=row_half,
        col_half=col_half, pitch_mm=pitch_mm, autofocus=af, af_range=af_range,
        ref_sharp=ref_sharp,
    ))
    jpeg = await asyncio.to_thread(_encode_jpeg, img, 92)
    info["camera"] = camera.kind
    _log(f"[scan] shot ({x:.1f},{y:.1f}) z={info.get('z')} af={info.get('af', {}).get('ran')} "
         f"align={info.get('align_error_mm')} content={info.get('content_wells')}")
    return Response(content=jpeg, media_type="image/jpeg", headers={
        "X-Camera": camera.kind,
        "X-Shot": json.dumps(info, separators=(",", ":")),
    })


# ── WebSocket 实时预览 (F2) ──

# 只允许一条活跃预览流:新连接进来,旧循环下一轮检测到代次变化就退出并释放相机。
# 防止网络抖动(如以太网抖动)引发的重连风暴把多条 capture_array 循环叠在一起,
# 争抢同一个相机、慢慢拖垮 Pi 的相机管线。
_preview_gen = 0


@app.websocket("/ws/preview")
async def preview(ws: WebSocket):
    """低分辨率连续帧推送到浏览器。

    帧率提升:
    - 自适应节流——只补足目标帧间隔剩下的时间,而不是固定 sleep(0.1) 死锁在 10fps;
    - 流水线——在发送上一帧的同时,后台线程已经在抓下一帧 (抓帧和编码/网络发送重叠);
    - 预览质量 65,体积更小、编码更快。
    """
    global _preview_gen
    await ws.accept()
    _preview_gen += 1
    my_gen = _preview_gen
    loop = asyncio.get_event_loop()
    interval = 1.0 / PREVIEW_FPS
    next_frame: asyncio.Task | None = None
    fps_t0 = loop.time()
    fps_n = 0
    try:
        # 先抓第一帧,之后边发边抓下一帧
        next_frame = asyncio.create_task(asyncio.to_thread(camera.capture_array, True))
        while True:
            # 有更新的预览连接接管了 -> 退出,把相机让给它 (杜绝重连叠加)
            if my_gen != _preview_gen:
                break
            t0 = loop.time()
            frame = await next_frame
            if my_gen != _preview_gen:
                break
            # 立刻安排下一帧的抓取,与本帧的编码/发送并行
            next_frame = asyncio.create_task(
                asyncio.to_thread(camera.capture_array, True)
            )
            # 单帧抓取/编码失败 (例如刚切 ROI 的瞬间) 不应弄断整条流:跳过这帧
            if frame is None or getattr(frame, "size", 0) == 0:
                await asyncio.sleep(0.05)
                continue
            try:
                jpeg = await asyncio.to_thread(_encode_jpeg, frame, PREVIEW_QUALITY)
            except Exception as exc:  # noqa: BLE001
                _log(f"[preview] 跳过一帧: {exc!r}")
                await asyncio.sleep(0.05)
                continue
            await ws.send_bytes(jpeg)
            # 每 ~5 秒打印一次实际预览帧率,便于调优
            fps_n += 1
            if loop.time() - fps_t0 >= 5.0:
                _log(f"[preview] {fps_n / (loop.time() - fps_t0):.1f} fps")
                fps_t0 = loop.time()
                fps_n = 0
            # 只睡剩余时间;若处理已超过一帧预算就不睡
            await asyncio.sleep(max(0.0, interval - (loop.time() - t0)))
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:  # 串流出错时优雅关闭
        _log(f"[preview] 串流结束: {exc!r}")
    finally:
        # 取消可能仍在跑的预抓取任务,避免悬挂
        if next_frame is not None and not next_frame.done():
            next_frame.cancel()
        # 预览结束时清掉 ROI,避免之后的全板拍摄被意外裁剪
        if camera.roi_active:
            camera.clear_roi()


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
