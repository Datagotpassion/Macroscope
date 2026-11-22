"""颜色顺序测试 — 真相机的静帧和预览都必须输出正确的 BGR。

2026-11 之前两条路径都把红蓝弄反了 (见 PiCameraBackend.capture_array 的注释)。
这里用一个假的 picamera2,按它真实的内存格式喂一张纯红图,检查输出仍是红色。
"""

import sys
import types
from pathlib import Path

import cv2
import numpy as np

# 让测试能 import backend 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import camera  # noqa: E402


def _red(size):
    w, h = size
    img = np.zeros((h, w, 3), np.uint8)
    img[:, :, 2] = 255  # OpenCV BGR: 第 3 通道是红
    return img


class _FakePicamera2:
    camera_properties = {"PixelArraySize": camera.FULL_SIZE}

    def create_video_configuration(self, **kw):
        return kw

    def configure(self, cfg):
        pass

    def start(self):
        pass

    def capture_array(self, name="main"):
        if name == "lores":
            # picamera2 的 YUV420 = I420 平面布局
            return cv2.cvtColor(_red(camera.PREVIEW_SIZE), cv2.COLOR_BGR2YUV_I420)
        # picamera2 的 "RGB888" 每像素内存顺序是 [B, G, R]
        return _red(camera.STILL_SIZE)


def _assert_red(img):
    b, g, r = img.reshape(-1, 3).mean(0)
    assert r > 200 and b < 50 and g < 50, f"expected red, got B={b:.0f} G={g:.0f} R={r:.0f}"


def test_still_and_preview_keep_true_colours(monkeypatch):
    monkeypatch.setitem(sys.modules, "picamera2", types.SimpleNamespace(Picamera2=_FakePicamera2))
    be = camera.PiCameraBackend()

    still = be.capture_array(preview=False)
    assert (still.shape[1], still.shape[0]) == camera.STILL_SIZE
    _assert_red(still)

    prev = be.capture_array(preview=True)
    assert (prev.shape[1], prev.shape[0]) == camera.PREVIEW_SIZE
    _assert_red(prev)
