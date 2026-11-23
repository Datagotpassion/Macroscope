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


class _FakePicam:
    """记录调用顺序的假 Picamera2。fail_capture:12MP 那一帧抓取报错。"""

    def __init__(self, fail_capture=False):
        self.log, self.fail_capture, self.cfg = [], fail_capture, None

    def create_still_configuration(self, **kw):
        return {"still": kw["main"]["size"]}

    def stop(self):
        self.log.append("stop")

    def configure(self, cfg):
        self.cfg = cfg
        self.log.append(("configure", cfg))

    def start(self):
        self.log.append(("start", self.cfg))

    def capture_metadata(self):
        self.log.append("skip")
        return {}

    def capture_array(self, name="main"):
        if self.fail_capture:
            raise RuntimeError("Camera frontend has timed out!")
        size = self.cfg["still"]
        return np.zeros((size[1], size[0], 3), np.uint8)


def _pi_backend(fake):
    be = object.__new__(camera.PiCameraBackend)  # 不跑 __init__ (开发机上没有 picamera2)
    be._cam, be._cfg, be._full_cfg = fake, {"video": True}, None
    return be


@pytest.mark.parametrize("fail", [False, True])
def test_capture_full_always_switches_back(fail):
    fake = _FakePicam(fail_capture=fail)
    be = _pi_backend(fake)
    if fail:
        with pytest.raises(RuntimeError):
            be.capture_full()
    else:
        assert be.capture_full().shape == (3040, 4056, 3)
    assert fake.log[-3:] == ["stop", ("configure", {"video": True}), ("start", {"video": True})]
    assert fake.log.count("skip") == camera.FULL_SKIP_FRAMES  # 新模式下先丢几帧让曝光稳定


def test_capture_full_failure_rebuilds_real_camera_at_once(monkeypatch):
    monkeypatch.setattr(camera, "PiCameraBackend", _GoodBackend)

    class _FullBroken(_GoodBackend):
        closed = False

        def capture_full(self):
            raise RuntimeError("Camera frontend has timed out!")

        def close(self):
            self.closed = True

    broken = _FullBroken()
    ctrl = CameraController(broken)
    ctrl.roi_active = True
    with pytest.raises(RuntimeError):
        ctrl.capture_full()
    assert broken.closed and isinstance(ctrl._backend, _GoodBackend)  # 一次就重建,不等 3 次
    assert not ctrl.is_mock and ctrl.roi_active is False


def test_kind_distinguishes_fallback_from_forced_mock(monkeypatch):
    monkeypatch.setattr(camera, "PiCameraBackend", _no_camera)
    monkeypatch.delenv("PLATESCOPE_FORCE_MOCK", raising=False)
    assert CameraController().kind == "mock"  # 真相机起不来被动回退 → 帧不可信

    monkeypatch.setenv("PLATESCOPE_FORCE_MOCK", "1")
    assert CameraController().kind == "mock-forced"  # 有意空跑
