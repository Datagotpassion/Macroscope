"""运动平台控制 (通过 Moonraker / Klipper).

PlateScope 通过 Moonraker 的 HTTP API 驱动 CoreXY + Z 平台:
相机装在 XY 上 (移动视野),载物台/板装在 Z 上 (对焦)。
本模块是一个很薄的客户端 —— 往 Moonraker POST G-code,读取 Klipper 的
toolhead 状态。

**优雅降级**:Moonraker 不可达时 (开发机、或 Klipper 没跑),所有调用返回
`connected: False` 而不是抛异常,这样 PlateScope 其余功能照常工作。

用 stdlib urllib (不引入 httpx/requests 依赖,Pi 端 requirements 保持精简)。
urllib 是阻塞的,调用方 (main.py 的 endpoint) 用 asyncio.to_thread 包一层。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

# Moonraker 默认和后端同机 (Pi 上),端口 7125。开发机可用环境变量指向 Pi。
MOONRAKER_URL = os.environ.get("PLATESCOPE_MOONRAKER", "http://localhost:7125")
_TIMEOUT = 10.0

# 允许的运动范围之外,先给一个保守的手动步进上限,防手滑一次冲太远
MAX_JOG_MM = 50.0


class StageError(RuntimeError):
    """G-code 被 Klipper 拒绝 (例如未 home、超行程) 或 Moonraker 通信失败。"""


class StageController:
    def __init__(self, base_url: str = MOONRAKER_URL):
        self.base = base_url.rstrip("/")

    # ── 底层 HTTP ──

    def _request(self, path: str, method: str):
        url = f"{self.base}{path}"
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return json.loads(r.read().decode())

    def _get(self, path: str):
        return self._request(path, "GET")

    def _post(self, path: str):
        return self._request(path, "POST")

    # ── 连接 / 状态 ──

    def available(self) -> bool:
        try:
            self._get("/server/info")
            return True
        except Exception:  # noqa: BLE001
            return False

    def status(self) -> dict:
        """Klippy 状态 + 当前坐标 + 已 home 的轴 + 行程上限。永不抛异常。"""
        try:
            info = self._get("/printer/info")
        except Exception as e:  # noqa: BLE001 — 网络/连接问题都视为未连接
            return {"connected": False, "error": str(e)}

        state = info.get("result", {}).get("state")
        result: dict = {"connected": True, "state": state}
        try:
            q = self._get(
                "/printer/objects/query?"
                "toolhead=position,homed_axes,axis_maximum,axis_minimum"
            )
            th = q["result"]["status"].get("toolhead", {})
            pos = th.get("position") or [0.0, 0.0, 0.0, 0.0]
            result.update(
                {
                    "homed": th.get("homed_axes", ""),
                    "position": {
                        "x": round(pos[0], 3),
                        "y": round(pos[1], 3),
                        "z": round(pos[2], 3),
                    },
                    "axis_maximum": th.get("axis_maximum"),
                    "axis_minimum": th.get("axis_minimum"),
                }
            )
        except Exception as e:  # noqa: BLE001 — 已连接但查询失败 (例如正在启动)
            result["state"] = result.get("state") or "startup"
            result["query_error"] = str(e)
        return result

    # ── G-code ──

    def send(self, script: str) -> None:
        """执行一段 G-code (可多行, 用 \\n 分隔)。被拒绝时抛 StageError。"""
        path = "/printer/gcode/script?script=" + urllib.parse.quote(script)
        try:
            self._post(path)
        except urllib.error.HTTPError as e:
            # Moonraker 把 Klipper 的报错放在 body 里 (例如 "Must home axis first")
            try:
                body = json.loads(e.read().decode(errors="replace"))
                msg = body.get("error", {}).get("message") or str(body)
            except Exception:  # noqa: BLE001
                msg = f"HTTP {e.code}"
            raise StageError(msg) from e
        except Exception as e:  # noqa: BLE001
            raise StageError(str(e)) from e

    def jog(self, axis: str, distance: float, feed: float = 600) -> None:
        """相对移动单轴。做完恢复绝对模式,避免影响后续绝对定位。"""
        axis = axis.upper()
        if axis not in ("X", "Y", "Z"):
            raise StageError(f"未知轴 {axis!r}")
        if abs(distance) > MAX_JOG_MM:
            raise StageError(f"单次步进 {distance}mm 超过上限 {MAX_JOG_MM}mm")
        self.send(f"G91\nG1 {axis}{distance} F{feed}\nG90")

    def move(self, x=None, y=None, z=None, feed: float = 1200) -> None:
        """绝对移动到给定坐标 (只给需要动的轴)。"""
        parts = []
        if x is not None:
            parts.append(f"X{x}")
        if y is not None:
            parts.append(f"Y{y}")
        if z is not None:
            parts.append(f"Z{z}")
        if not parts:
            return
        self.send("G90\nG1 " + " ".join(parts) + f" F{feed}")

    def force_position(self, x=None, y=None, z=None) -> None:
        """未 home 也能动:用 SET_KINEMATIC_POSITION 把当前物理位置「声明」为给定坐标
        并将这些轴标记为已 home,之后普通的协调移动 (G1) 就能用 —— CoreXY 也走直线,
        不是单电机的斜向。不给某轴时默认取该轴量程中点,让两个方向都留出余量。

        注意:这只是「假装已 home」,坐标是人为设定的,软限位据此判断;真正要精确
        坐标仍需 G28。用途:home 之前/失败时手动挪一挪、从卡死里把台子挪开。
        """
        st = self.status()
        lo = st.get("axis_minimum") or [0.0, 0.0, 0.0, 0.0]
        hi = st.get("axis_maximum") or [325.0, 230.0, 60.0, 0.0]

        def mid(i: int) -> float:
            try:
                return round((lo[i] + hi[i]) / 2.0, 3)
            except Exception:  # noqa: BLE001
                return 0.0

        x = mid(0) if x is None else x
        y = mid(1) if y is None else y
        z = mid(2) if z is None else z
        self.send(f"SET_KINEMATIC_POSITION X={x} Y={y} Z={z}")

    def home(self, axes: str = "XYZ") -> None:
        """回零 (sensorless XY homing 在 printer.cfg 里配)。axes 例如 'XY' / 'Z'。"""
        letters = " ".join(a for a in "XYZ" if a in axes.upper())
        self.send(("G28 " + letters).strip())

    def wait_moves(self) -> None:
        """阻塞直到队列里的移动都执行完 (扫描/自动对焦时按步等待)。"""
        self.send("M400")

    def stop(self) -> None:
        """急停。之后需要 firmware_restart 才能恢复。"""
        try:
            self._post("/printer/emergency_stop")
        except Exception as e:  # noqa: BLE001
            raise StageError(str(e)) from e

    def firmware_restart(self) -> None:
        """急停/报错后重启固件,恢复到 Ready。"""
        try:
            self._post("/printer/firmware_restart")
        except Exception as e:  # noqa: BLE001
            raise StageError(str(e)) from e
