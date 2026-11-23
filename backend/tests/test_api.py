"""接口层的数据完整性:看门狗/定时探测不覆盖缓存帧、缓存帧带相机来源、假相机不做跳动检测。

开发机上没有 picamera2,main 导入时相机自动退回 MockCamera (kind == "mock",被动回退)。
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

pytest.importorskip("httpx")  # TestClient 需要
if os.environ.get("PLATESCOPE_FORCE_MOCK"):
    pytest.skip("these tests expect the passive MockCamera fallback", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def fresh_store():
    main.store.latest_frame = None
    main.store.latest_meta = {}
    main.store.latest_wells = None
    yield


def test_probe_with_buffer_false_does_not_replace_the_cached_frame():
    r = client.get("/api/capture")
    assert r.status_code == 200
    cached = main.store.latest_frame
    r = client.get("/api/plate/image?fresh=true&buffer=false")
    assert r.status_code == 200 and r.headers["X-Camera"] == main.camera.kind
    assert main.store.latest_frame is cached  # 用户拍的那一帧还在


def test_fresh_frame_without_buffer_flag_still_buffers_as_before():
    client.get("/api/plate/image?fresh=true")
    assert main.store.latest_frame is not None
    assert main.store.latest_meta.get("camera") == main.camera.kind


def test_latest_frame_reports_which_camera_took_it():
    client.get("/api/capture")
    r = client.get("/api/frame/latest")
    assert r.status_code == 200
    assert r.headers["X-Camera"] == main.camera.kind == "mock"


def test_beat_detection_refuses_the_fallback_mock_camera():
    r = client.post("/api/well/beat?cx=0.5&cy=0.5&r=0.05&duration=2")
    assert r.status_code == 400
