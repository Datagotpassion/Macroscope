"""数据存储管理 (F6) — 手动确认模式.

关键设计:拍照默认只缓存到内存 + /tmp,不写入正式实验目录。
只有用户点 "保存" 或确认定时任务后,才真正写盘到 BASE_DIR。
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

# 在 Pi 上是 /home/pi/platescope_data;开发机用环境变量覆盖或回退到 ./data
BASE_DIR = Path(os.environ.get("PLATESCOPE_DATA", Path.home() / "platescope_data"))
_TMP_LATEST = Path(tempfile.gettempdir()) / "platescope_latest.jpg"


class ImageStore:
    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = Path(base_dir) if base_dir else BASE_DIR
        self.latest_frame: np.ndarray | None = None
        self.latest_meta: dict = {}
        self.latest_wells: list[dict] | None = None  # 与 latest_frame 对应的检测结果
        self.latest_path = str(_TMP_LATEST)

    # ── 缓冲 (不写正式目录) ──

    def buffer_frame(self, image: np.ndarray, meta: dict | None = None) -> None:
        """每次拍照只缓存到内存 + /tmp,等用户确认。"""
        self.latest_frame = image
        self.latest_meta = meta or {}
        self.latest_wells = None  # 新帧:旧的检测结果失效
        cv2.imwrite(self.latest_path, image)

    # ── 确认保存 (写盘) ──

    def save_frame(
        self, experiment: str, timestamp: str | None = None
    ) -> str | None:
        """用户点 "保存" 后才真正写盘。返回保存路径,无缓存帧时返回 None。"""
        if self.latest_frame is None:
            return None
        return self._write(experiment, self.latest_frame, timestamp, self.latest_meta)

    def save_capture(
        self,
        experiment: str,
        image: np.ndarray,
        timestamp: str | None = None,
        meta: dict | None = None,
    ) -> str:
        """定时任务用:确认过的拍摄直接写盘。"""
        return self._write(experiment, image, timestamp, meta or {})

    def _write(
        self,
        experiment: str,
        image: np.ndarray,
        timestamp: str | None,
        meta: dict,
    ) -> str:
        experiment = _safe_name(experiment)
        if timestamp is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        dir_path = self.base_dir / experiment
        dir_path.mkdir(parents=True, exist_ok=True)
        path = dir_path / f"{timestamp}.jpg"
        if not cv2.imwrite(str(path), image):
            raise IOError(f"无法写入: {path}")
        # 追加/更新元数据
        if meta:
            self._append_meta(experiment, timestamp, meta)
        return str(path)

    # ── 查询 ──

    def list_experiments(self) -> list[str]:
        if not self.base_dir.exists():
            return []
        return sorted(d.name for d in self.base_dir.iterdir() if d.is_dir())

    def list_frames(self, experiment: str) -> list[str]:
        exp_dir = self.base_dir / _safe_name(experiment)
        if not exp_dir.exists():
            return []
        return sorted(f.name for f in exp_dir.glob("*.jpg"))

    def frame_path(self, experiment: str, frame: str) -> Path | None:
        path = self.base_dir / _safe_name(experiment) / _safe_name(frame)
        return path if path.exists() else None

    # ── 元数据 ──

    def _append_meta(self, experiment: str, timestamp: str, meta: dict) -> None:
        path = self.base_dir / experiment / "metadata.json"
        data: dict = {}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                data = {}
        data[timestamp] = meta
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def read_metadata(self, experiment: str) -> dict:
        path = self.base_dir / _safe_name(experiment) / "metadata.json"
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}


def _safe_name(name: str) -> str:
    """防止路径穿越:只保留文件名部分,去掉危险字符。"""
    name = os.path.basename(name)
    return "".join(c for c in name if c.isalnum() or c in "._- ").strip() or "unnamed"
