"""相机控制 (F1, F2).

提供统一的 CameraController 接口。在树莓派上使用 picamera2 (libcamera);
在没有相机的开发机 (Windows/Mac) 上自动回退到 MockCamera,生成合成的
96 孔板图像,这样整个后端可以在 VS Code 本地完整跑通再 SSH 部署到 Pi。

后端代码只依赖 CameraController,不直接碰具体后端实现。
"""

from __future__ import annotations

import sys
import threading

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


class _Backend:
    """相机后端的抽象基类。"""

    def configure_still(self) -> None: ...
    def configure_preview(self) -> None: ...
    def capture_array(self) -> np.ndarray: ...
    def set_roi(self, cx: float, cy: float, r: float) -> None: ...
    def clear_roi(self) -> None: ...
    def close(self) -> None: ...


class PiCameraBackend(_Backend):
    """真·树莓派后端,基于 picamera2 / libcamera。"""

    def __init__(self) -> None:
        from picamera2 import Picamera2  # 延迟导入,开发机上没有也不报错

        self._cam = Picamera2()
        self._still_cfg = self._cam.create_still_configuration(
            main={"size": FULL_SIZE, "format": "RGB888"}
        )
        self._preview_cfg = self._cam.create_preview_configuration(
            main={"size": PREVIEW_SIZE, "format": "RGB888"}
        )
        self._mode: str | None = None
        self._started = False
        # 全传感器像素阵列尺寸 (ScalerCrop 的坐标系)
        self._full = tuple(
            self._cam.camera_properties.get("PixelArraySize", FULL_SIZE)
        )
        self.configure_still()  # 首次配置 + start

    def _switch(self, mode: str, cfg) -> None:
        """切换相机模式。picamera2 要求 reconfigure 前必须 stop,之后再 start。

        旧实现直接在运行中的相机上 configure() 会抛异常 —— 这正是实时预览
        切到低分辨率模式时静默挂掉的原因。
        """
        if self._mode == mode:
            return
        if self._started:
            self._cam.stop()
            self._started = False
        self._cam.configure(cfg)
        self._cam.start()
        self._started = True
        self._mode = mode

    def configure_still(self) -> None:
        self._switch("still", self._still_cfg)

    def configure_preview(self) -> None:
        self._switch("preview", self._preview_cfg)

    def capture_array(self) -> np.ndarray:
        # picamera2 返回 RGB,后续 OpenCV 处理统一用 BGR
        rgb = self._cam.capture_array()
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    def set_roi(self, cx: float, cy: float, r: float) -> None:
        """硬件数字变焦:让 ISP 只读出该孔区域并放大到输出尺寸。

        ScalerCrop 用全传感器像素坐标。裁剪框保持输出宽高比避免拉伸。
        """
        fw, fh = self._full
        aspect = PREVIEW_SIZE[1] / PREVIEW_SIZE[0]
        pad = 1.6
        w = int(min(fw, max(1, r * fw * pad * 2)))
        h = int(min(fh, max(1, w * aspect)))
        x = int(min(max(0, cx * fw - w / 2), fw - w))
        y = int(min(max(0, cy * fh - h / 2), fh - h))
        self._cam.set_controls({"ScalerCrop": (x, y, w, h)})

    def clear_roi(self) -> None:
        fw, fh = self._full
        self._cam.set_controls({"ScalerCrop": (0, 0, fw, fh)})

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
        self._size = FULL_SIZE
        self._base = self._render_plate(FULL_SIZE)
        self._roi: tuple[float, float, float] | None = None

    def configure_still(self) -> None:
        if self._size != FULL_SIZE:
            self._size = FULL_SIZE
            self._base = self._render_plate(FULL_SIZE)

    def configure_preview(self) -> None:
        if self._size != PREVIEW_SIZE:
            self._size = PREVIEW_SIZE
            self._base = self._render_plate(PREVIEW_SIZE)

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

    def capture_array(self) -> np.ndarray:
        # 加一点噪声,让每帧略有不同 (预览串流看起来是 "活" 的)
        noise = np.random.default_rng().integers(
            -6, 6, self._base.shape, dtype=np.int16
        )
        frame = np.clip(self._base.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        if self._roi:
            # 模拟硬件 ROI:裁出该区域并放大回输出尺寸
            h, w = frame.shape[:2]
            cx, cy, r = self._roi
            aspect = h / w
            half_w = max(1, int(r * w * 1.6))
            half_h = max(1, int(half_w * aspect))
            x = int(min(max(0, cx * w - half_w), w - 2 * half_w)) if w > 2 * half_w else 0
            y = int(min(max(0, cy * h - half_h), h - 2 * half_h)) if h > 2 * half_h else 0
            crop = frame[y : y + 2 * half_h, x : x + 2 * half_w]
            if crop.size:
                frame = cv2.resize(crop, (w, h), interpolation=cv2.INTER_LINEAR)
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

    def capture_array(self, preview: bool = False) -> np.ndarray:
        """拍一帧返回 BGR numpy array。preview=True 用低分辨率。"""
        with self._lock:
            if preview:
                self._backend.configure_preview()
            else:
                self._backend.configure_still()
            return self._backend.capture_array()

    def set_roi(self, cx: float, cy: float, r: float) -> None:
        """硬件数字变焦到某个孔 (供实时高清单孔检视)。"""
        with self._lock:
            self._backend.set_roi(cx, cy, r)
            self.roi_active = True

    def clear_roi(self) -> None:
        with self._lock:
            self._backend.clear_roi()
            self.roi_active = False

    def capture(self, path: str, preview: bool = False) -> str:
        """拍一帧并写到指定路径 (JPEG/TIFF 由扩展名决定)。"""
        frame = self.capture_array(preview=preview)
        if not cv2.imwrite(path, frame):
            raise IOError(f"无法写入图像: {path}")
        return path

    def close(self) -> None:
        with self._lock:
            self._backend.close()
