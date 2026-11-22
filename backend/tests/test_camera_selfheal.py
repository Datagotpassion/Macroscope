"""相机自愈测试 — 运行中重建相机绝不能退回 MockCamera。

否则之后每帧都「成功」返回合成图,timelapse 会把假图当真实数据存下来。
"""

import sys
from pathlib import Path

import numpy as np
import pytest

# 让测试能 import backend 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import camera  # noqa: E402
from camera import CameraController, MockCamera  # noqa: E402


class _BrokenBackend:
    """模拟卡死的真相机:每次抓帧都报错。"""

    closed = False

    def capture_array(self, preview=False):
        raise RuntimeError("Camera frontend has timed out!")

    def close(self):
        self.closed = True


class _GoodBackend:
    def capture_array(self, preview=False):
        return np.zeros((4, 4, 3), np.uint8)

    def close(self):
        pass


def _no_camera():
    raise RuntimeError("no cameras available")


def _fail(ctrl, n):
    for _ in range(n):
        with pytest.raises(RuntimeError):
            ctrl.capture_array()


def test_rebuild_failure_never_falls_back_to_mock(monkeypatch):
    monkeypatch.setattr(camera, "PiCameraBackend", _no_camera)
    ctrl = CameraController(_BrokenBackend())
    assert ctrl.kind == "picamera2"

    _fail(ctrl, 3)  # 第 3 次触发重建,重建失败
    assert not ctrl.is_mock
    assert not isinstance(ctrl._backend, MockCamera)
    assert ctrl.kind == "picamera2"
    _fail(ctrl, 3)  # 之后照样报错,而不是悄悄返回合成图


def test_rebuild_success_swaps_in_new_real_camera(monkeypatch):
    monkeypatch.setattr(camera, "PiCameraBackend", _GoodBackend)
    broken = _BrokenBackend()
    ctrl = CameraController(broken)

    _fail(ctrl, 3)
    assert broken.closed
    assert ctrl.capture_array().shape == (4, 4, 3)
    assert not ctrl.is_mock


def test_kind_distinguishes_fallback_from_forced_mock(monkeypatch):
    monkeypatch.setattr(camera, "PiCameraBackend", _no_camera)
    monkeypatch.delenv("PLATESCOPE_FORCE_MOCK", raising=False)
    assert CameraController().kind == "mock"  # 真相机起不来被动回退 → 帧不可信

    monkeypatch.setenv("PLATESCOPE_FORCE_MOCK", "1")
    assert CameraController().kind == "mock-forced"  # 有意空跑
