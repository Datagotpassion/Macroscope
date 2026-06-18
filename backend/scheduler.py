"""定时拍摄 (F5).

用 APScheduler 周期性触发拍照,确认过的定时任务直接写盘到实验目录。
"""

from __future__ import annotations

from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from camera import CameraController
from image_store import ImageStore


class Scheduler:
    def __init__(self, camera: CameraController, store: ImageStore) -> None:
        self.scheduler = AsyncIOScheduler()
        self.camera = camera
        self.store = store
        self._started = False

    def _ensure_started(self) -> None:
        if not self._started:
            self.scheduler.start()
            self._started = True

    @staticmethod
    def _job_id(experiment: str) -> str:
        return f"timelapse_{experiment}"

    def start_timelapse(self, experiment: str, interval_minutes: int) -> None:
        """开始定时拍摄。重复调用同一实验会替换旧任务。"""
        if interval_minutes <= 0:
            raise ValueError("interval_minutes 必须 > 0")

        def capture_job() -> None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            image = self.camera.capture_array()
            self.store.save_capture(
                experiment,
                image,
                timestamp=timestamp,
                meta={"source": "timelapse", "captured_at": timestamp},
            )

        self._ensure_started()
        self.scheduler.add_job(
            capture_job,
            "interval",
            minutes=interval_minutes,
            id=self._job_id(experiment),
            replace_existing=True,
            next_run_time=datetime.now(),  # 立即拍第一张
        )

    def stop_timelapse(self, experiment: str) -> bool:
        job_id = self._job_id(experiment)
        if self.scheduler.get_job(job_id):
            self.scheduler.remove_job(job_id)
            return True
        return False

    def list_jobs(self) -> list[dict]:
        jobs = []
        for job in self.scheduler.get_jobs():
            jobs.append(
                {
                    "id": job.id,
                    "experiment": job.id.replace("timelapse_", ""),
                    "next_run": job.next_run_time.isoformat()
                    if job.next_run_time
                    else None,
                }
            )
        return jobs

    def shutdown(self) -> None:
        if self._started:
            self.scheduler.shutdown(wait=False)
            self._started = False
