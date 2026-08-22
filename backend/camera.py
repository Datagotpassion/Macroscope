"""相机控制 (F1, F2).

提供统一的 CameraController 接口。在树莓派上使用 picamera2 (libcamera);
在没有相机的开发机 (Windows/Mac) 上自动回退到 MockCamera,生成合成的
96 孔板图像,这样整个后端可以在 VS Code 本地完整跑通再 SSH 部署到 Pi。

后端代码只依赖 CameraController,不直接碰具体后端实现。
"""

from __future__ import annotations

import math
import os
import sys
import threading
import time

import numpy as np


def _log(msg: str) -> None:
    """编码安全的 stdout 输出。

    Windows 控制台默认 cp1252,直接 print 中文会抛 UnicodeEncodeError 把程序带崩。
    这里按 stdout 实际编码做有损回退,保证日志永远不会让相机初始化失败。
    """
    enc = (getattr(sys.stdout, "encoding", None) or "utf-8")
    try:
        sys.stdout.write(msg + "\n")
    except UnicodeEncodeError:
        sys.stdout.write(msg.encode(enc, errors="replace").decode(enc) + "\n")

try:
    import cv2
except ImportError:  # pragma: no cover - cv2 缺失时给出清晰报错
    raise ImportError(
        "opencv-python 未安装。请运行: pip install -r requirements.txt"
    )

# 全分辨率 (IMX477) 与预览分辨率
FULL_SIZE = (4056, 3040)
PREVIEW_SIZE = (1014, 760)  # 1/4 分辨率,降低串流带宽

# 静帧输出分辨率。默认 2028x1520 —— IMX477 的「全视场 binned」模式:数据率约为
# 全分辨率 4056x3040 (12MP) 的一半。在信号裕度不足的排线上,12MP 会 "Camera
# frontend has timed out",而 2028x1520 (3MP) 能稳定串流,且足够分辨 16 孔。
# 好硬件 (短排线 / Pi4+) 想要 12MP 时用环境变量覆盖:PLATESCOPE_STILL_W/H=4056/3040。
STILL_SIZE = (
    int(os.environ.get("PLATESCOPE_STILL_W", 2028)),
    int(os.environ.get("PLATESCOPE_STILL_H", 1520)),
)

# 单孔 ROI 相对孔大小的倍数。1.0 = ROI 恰好等于孔 (跳动检测测试用);
# 之前是 1.6 (带余量便于检视取景)。改这一个值即可还原。
ROI_PADDING = 1.0


class _Backend:
    """相机后端的抽象基类。"""

    def configure_still(self) -> None: ...
    def configure_preview(self) -> None: ...
    def capture_array(self, preview: bool = False) -> np.ndarray: ...
    def set_roi(self, cx: float, cy: float, r: float) -> None: ...
    def clear_roi(self) -> None: ...
    def lock_exposure(self) -> None: ...
    def unlock_exposure(self) -> None: ...
    def close(self) -> None: ...


class PiCameraBackend(_Backend):
    """真·树莓派后端,基于 picamera2 / libcamera。"""

    def __init__(self) -> None:
        from picamera2 import Picamera2  # 延迟导入,开发机上没有也不报错

        self._cam = Picamera2()
        # 关键:相机只配置一次、永不再 reconfigure。
        # 旧实现让静帧/预览用不同配置,每次拍照都 stop()->configure()->start() 切模式;
        # 在临界 CSI 上只要有一次切换 hang 住(且持锁),整台相机就永久卡死 —— 这正是
        # "跑几小时后相机彻底不出图" 的根因。改成单一配置 + 双流,之后再也不切模式:
        #   main  = 静帧分辨率 (2028x1520 RGB),定时拍摄/快照/自动对焦取这个;
        #   lores = 预览分辨率 (1014x760 YUV420),实时预览取这个,ISP 直接产出、省 CPU。
        # 两条流共用同一 binned 传感器模式 (raw 2028x1520),视场一致,网格/ROI 坐标不变。
        self._lores = True
        try:
            self._cfg = self._cam.create_video_configuration(
                main={"size": STILL_SIZE, "format": "RGB888"},
                lores={"size": PREVIEW_SIZE, "format": "YUV420"},
                raw={"size": (2028, 1520)},
            )
        except Exception as e:  # noqa: BLE001 —— 个别 picamera2 版本无 lores,退回单主流
            _log(f"[camera] lores 配置不可用 ({e!r}),回退单主流 + 软件缩放预览")
            self._lores = False
            self._cfg = self._cam.create_video_configuration(
                main={"size": STILL_SIZE, "format": "RGB888"},
                raw={"size": (2028, 1520)},
            )
        # 全传感器像素阵列尺寸 (ScalerCrop 的坐标系)
        self._full = tuple(
            self._cam.camera_properties.get("PixelArraySize", FULL_SIZE)
        )
        self._cam.configure(self._cfg)
        self._cam.start()  # 全程只 start 一次

    # 单一配置:configure_* 仅保留以兼容旧接口,不再做任何模式切换 (故意留空)。
    def configure_still(self) -> None:
        pass

    def configure_preview(self) -> None:
        pass

    def capture_array(self, preview: bool = False) -> np.ndarray:
        # 预览抓 lores (YUV420 -> BGR);静帧抓 main (RGB -> BGR)。全程不 reconfigure。
        if preview and self._lores:
            try:
                yuv = self._cam.capture_array("lores")
                bgr = cv2.cvtColor(yuv, cv2.COLOR_YUV420p2BGR)
                # lores 宽度可能被硬件对齐补齐 (stride padding):归一化回预览尺寸
                if (bgr.shape[1], bgr.shape[0]) != PREVIEW_SIZE:
                    bgr = cv2.resize(
                        bgr[:, : PREVIEW_SIZE[0]], PREVIEW_SIZE,
                        interpolation=cv2.INTER_AREA,
                    )
                return bgr
            except Exception as e:  # noqa: BLE001 —— lores 有问题就永久退回主流缩放,不影响定时拍摄
                _log(f"[camera] lores 预览失败 ({e!r}),永久改用主流缩放预览")
                self._lores = False
        rgb = self._cam.capture_array("main")
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        if preview:  # 无 lores 时的回退:抓主流再缩小到预览尺寸
            bgr = cv2.resize(bgr, PREVIEW_SIZE, interpolation=cv2.INTER_AREA)
        return bgr

    def _max_crop(self) -> tuple[int, int, int, int]:
        """有效裁剪范围 (x_off, y_off, w, h);用 ScalerCropMaximum,回退到全阵列。"""
        mc = self._cam.camera_properties.get("ScalerCropMaximum")
        if mc and len(mc) == 4 and mc[2] > 0 and mc[3] > 0:
            return tuple(int(v) for v in mc)
        return (0, 0, int(self._full[0]), int(self._full[1]))

    def set_roi(self, cx: float, cy: float, r: float) -> None:
        """硬件数字变焦:让 ISP 只读出该孔区域并放大到输出尺寸。

        ScalerCrop 用传感器像素坐标 (相对 ScalerCropMaximum,含偏移)。
        裁剪框保持输出宽高比避免拉伸,并夹在有效范围内。出错不能弄崩预览流。
        """
        try:
            mx, my, mw, mh = self._max_crop()
            aspect = PREVIEW_SIZE[1] / PREVIEW_SIZE[0]
            # ROI 高度 = 孔直径 × ROI_PADDING (恰好覆盖整个孔),宽度按输出宽高比补足
            diam = 2 * r * mw * ROI_PADDING
            h = int(max(48, min(mh, diam)))
            w = int(max(64, min(mw, h / aspect)))
            x = int(mx + min(max(0, cx * mw - w / 2), mw - w))
            y = int(my + min(max(0, cy * mh - h / 2), mh - h))
            _log(f"[roi] set ScalerCrop=({x},{y},{w},{h}) within max=({mx},{my},{mw},{mh})")
            self._cam.set_controls({"ScalerCrop": (x, y, w, h)})
        except Exception as e:  # noqa: BLE001
            _log(f"[roi] set failed: {e!r}")

    def clear_roi(self) -> None:
        try:
            self._cam.set_controls({"ScalerCrop": self._max_crop()})
        except Exception as e:  # noqa: BLE001
            _log(f"[roi] clear failed: {e!r}")

    def lock_exposure(self) -> None:
        """锁定当前 (全画面测光的) 曝光/白平衡。

        跳动检测裁到小孔区域时,自动曝光会重新测光,产生一个亮度阶跃 (被误判成
        慢频跳动),还会让之后的全幅快照发暗。锁死曝光后基线才平,只剩真实跳动。
        """
        try:
            md = self._cam.capture_metadata()
            ctrls = {"AeEnable": False, "AwbEnable": False}
            if "ExposureTime" in md:
                ctrls["ExposureTime"] = int(md["ExposureTime"])
            if "AnalogueGain" in md:
                ctrls["AnalogueGain"] = float(md["AnalogueGain"])
            self._cam.set_controls(ctrls)
        except Exception as e:  # noqa: BLE001
            _log(f"[beat] lock_exposure failed: {e!r}")

    def unlock_exposure(self) -> None:
        try:
            self._cam.set_controls({"AeEnable": True, "AwbEnable": True})
        except Exception as e:  # noqa: BLE001
            _log(f"[beat] unlock_exposure failed: {e!r}")

    def close(self) -> None:
        try:
            self._cam.stop()
            self._cam.close()
        except Exception:
            pass


class MockCamera(_Backend):
    """开发机后端:合成一张逼真的 96 孔板图像。

    用已知的 ANSI/SLAS 几何渲染 8x12 网格,孔内随机点缀一些 "organoid",
    让孔位检测和前端 UI 可以在没有硬件时联调。
    """

    ROWS, COLS = 8, 12

    def __init__(self) -> None:
        self._bases: dict[tuple[int, int], np.ndarray] = {}
        self._roi: tuple[float, float, float] | None = None

    def _base_for(self, size: tuple[int, int]) -> np.ndarray:
        if size not in self._bases:
            self._bases[size] = self._render_plate(size)
        return self._bases[size]

    # 单一配置语义:configure_* 留空,尺寸由 capture_array(preview) 决定。
    def configure_still(self) -> None:
        pass

    def configure_preview(self) -> None:
        pass

    def _render_plate(self, size: tuple[int, int]) -> np.ndarray:
        w, h = size
        img = np.full((h, w, 3), 40, dtype=np.uint8)  # 深色灯箱背景

        margin_x = w * 0.06
        margin_y = h * 0.08
        pitch_x = (w - 2 * margin_x) / (self.COLS - 1)
        pitch_y = (h - 2 * margin_y) / (self.ROWS - 1)
        r = int(min(pitch_x, pitch_y) * 0.42)

        rng = np.random.default_rng(42)
        for row in range(self.ROWS):
            for col in range(self.COLS):
                cx = int(margin_x + col * pitch_x)
                cy = int(margin_y + row * pitch_y)
                # 培养基:亮圆
                cv2.circle(img, (cx, cy), r, (200, 205, 210), -1, cv2.LINE_AA)
                cv2.circle(img, (cx, cy), r, (120, 125, 130), 2, cv2.LINE_AA)
                # 随机 organoid:暗团
                n = int(rng.integers(0, 4))
                for _ in range(n):
                    ox = cx + int(rng.integers(-r // 2, r // 2))
                    oy = cy + int(rng.integers(-r // 2, r // 2))
                    orad = int(rng.integers(r // 8, r // 3))
                    cv2.circle(img, (ox, oy), orad, (90, 95, 100), -1, cv2.LINE_AA)
        return img

    def set_roi(self, cx: float, cy: float, r: float) -> None:
        self._roi = (cx, cy, r)

    def clear_roi(self) -> None:
        self._roi = None

    def capture_array(self, preview: bool = False) -> np.ndarray:
        base = self._base_for(PREVIEW_SIZE if preview else FULL_SIZE)
        # 加一点噪声,让每帧略有不同 (预览串流看起来是 "活" 的)
        noise = np.random.default_rng().integers(-6, 6, base.shape, dtype=np.int16)
        frame = np.clip(base.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        if self._roi:
            # 模拟硬件 ROI:裁出该区域并放大回输出尺寸。
            # 半高 = 孔半径 × ROI_PADDING (恰好覆盖孔),半宽按输出宽高比补足。
            h, w = frame.shape[:2]
            cx, cy, r = self._roi
            half_h = max(1, int(r * w * ROI_PADDING))
            half_w = max(1, int(half_h * w / h))
            x = int(min(max(0, cx * w - half_w), w - 2 * half_w)) if w > 2 * half_w else 0
            y = int(min(max(0, cy * h - half_h), h - 2 * half_h)) if h > 2 * half_h else 0
            crop = frame[y : y + 2 * half_h, x : x + 2 * half_w]
            if crop.size:
                frame = cv2.resize(crop, (w, h), interpolation=cv2.INTER_LINEAR)
            # 模拟跳动:ROI 下整体亮度按 ~1.5Hz (90 bpm) 起伏,供跳动检测联调
            mod = 1.0 + 0.08 * math.sin(2 * math.pi * 1.5 * time.time())
            frame = np.clip(frame.astype(np.float32) * mod, 0, 255).astype(np.uint8)
        return frame

    def close(self) -> None:  # pragma: no cover - 无资源可释放
        pass


def _make_backend() -> _Backend:
    """优先真相机,失败则回退到 MockCamera。"""
    try:
        return PiCameraBackend()
    except Exception as exc:  # picamera2 缺失 / 无相机硬件
        _log(f"[camera] picamera2 不可用 ({exc.__class__.__name__}), 使用 MockCamera")
        return MockCamera()


class CameraController:
    """线程安全的相机封装。

    捕获和模式切换都加锁:预览串流和 REST 拍照可能并发访问同一个相机,
    libcamera 不允许并发 reconfigure。
    """

    def __init__(self, backend: _Backend | None = None) -> None:
        self._backend = backend if backend is not None else _make_backend()
        self._lock = threading.Lock()
        self.is_mock = isinstance(self._backend, MockCamera)
        self.roi_active = False
        self._fails = 0  # 连续抓取失败计数,用于软性自愈

    def capture_array(self, preview: bool = False) -> np.ndarray:
        """拍一帧返回 BGR numpy array。preview=True 用低分辨率 (lores)。

        单一相机配置,不再切模式。若连续多次抓取失败 (相机返回错误的软卡死),
        自动重建相机后端自愈;真正的 C 层 hang 由 systemd 的 Restart 兜底。
        """
        with self._lock:
            try:
                frame = self._backend.capture_array(preview)
                self._fails = 0
                return frame
            except Exception:
                self._fails += 1
                if not self.is_mock and self._fails >= 3:
                    _log(f"[camera] 连续 {self._fails} 次抓取失败,重建相机后端自愈…")
                    try:
                        self._backend.close()
                    except Exception:
                        pass
                    self._backend = _make_backend()
                    self.is_mock = isinstance(self._backend, MockCamera)
                    self._fails = 0
                raise

    def set_roi(self, cx: float, cy: float, r: float) -> None:
        """硬件数字变焦到某个孔 (供实时高清单孔检视)。"""
        with self._lock:
            self._backend.set_roi(cx, cy, r)
            self.roi_active = True

    def clear_roi(self) -> None:
        with self._lock:
            self._backend.clear_roi()
            self.roi_active = False

    def measure_motion(
        self, cx: float, cy: float, r: float, duration: float = 8.0
    ) -> tuple[list[float], "np.ndarray", "np.ndarray | None"]:
        """对某个孔抓一段高帧率序列,返回 (times, 下采样灰度帧堆叠, 代表帧).

        全程持锁独占相机 (预览会暂停几秒),保证帧率均匀。先切到预览(ROI)模式、
        锁死曝光、丢掉过渡帧,再尽快连续抓帧。返回每帧的小灰度图 (~100x75) 供
        beat.analyze 做 PCA/运动分析;代表帧供前端显示「实际测量的区域」。
        """
        times: list[float] = []
        frames: list[np.ndarray] = []
        patch: np.ndarray | None = None
        with self._lock:
            self._backend.configure_preview()
            # 全画面先曝光稳定几帧,再锁死曝光 (避免裁孔后自动测光的亮度阶跃)
            for _ in range(4):
                self._backend.capture_array(True)
            self._backend.lock_exposure()
            self._backend.set_roi(cx, cy, r)
            self.roi_active = True
            try:
                # 丢掉 ROI 刚生效后的过渡帧 (~0.6s)
                t_settle = time.perf_counter()
                while time.perf_counter() - t_settle < 0.6:
                    self._backend.capture_array(True)
                t0 = time.perf_counter()
                while time.perf_counter() - t0 < duration:
                    frame = self._backend.capture_array(True)
                    if patch is None:
                        patch = frame.copy()  # 代表帧:实际测量的孔区域
                    small = cv2.resize(frame, (100, 75))
                    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                    times.append(time.perf_counter() - t0)
                    frames.append(gray)
            finally:
                self._backend.clear_roi()
                self._backend.unlock_exposure()
                self.roi_active = False
        return times, np.array(frames, dtype=np.float32), patch

    def capture(self, path: str, preview: bool = False) -> str:
        """拍一帧并写到指定路径 (JPEG/TIFF 由扩展名决定)。"""
        frame = self.capture_array(preview=preview)
        if not cv2.imwrite(path, frame):
            raise IOError(f"无法写入图像: {path}")
        return path

    def close(self) -> None:
        with self._lock:
            self._backend.close()
