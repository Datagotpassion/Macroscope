"""运动平台客户端:按命令类型的等待时间、行程未知时拒绝「声明坐标」。不连真的 Moonraker。"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import stage as stage_mod  # noqa: E402
from stage import StageController, StageError  # noqa: E402


class Recorder(StageController):
    """记下每个请求 (路径, 方法, 超时),状态查询返回给定的 toolhead。"""

    def __init__(self, toolhead=None, connected=True):
        super().__init__("http://test")
        self.calls = []
        self.toolhead = toolhead if toolhead is not None else {
            "position": [1, 2, 3, 0], "homed_axes": "xyz",
            "axis_minimum": [0, 0, 0, 0], "axis_maximum": [325, 230, 15, 0],
        }
        self.connected = connected

    def _request(self, path, method, timeout=stage_mod._TIMEOUT):
        self.calls.append((path, method, timeout))
        if not self.connected:
            raise OSError("connection refused")
        if path.startswith("/printer/info"):
            return {"result": {"state": "ready"}}
        if path.startswith("/printer/objects/query"):
            return {"result": {"status": {"toolhead": self.toolhead}}}
        return {"result": "ok"}

    def gcode_timeouts(self):
        return [t for p, _, t in self.calls if p.startswith("/printer/gcode/script")]


def test_homing_and_wait_moves_get_the_long_timeout():
    # 回零 / M400 要等动作真的做完:X 325 mm、回零 20 mm/s 就要十几秒,旧的 10 s 会误报超时
    st = Recorder()
    st.home("XY")
    st.wait_moves()
    assert st.gcode_timeouts() == [stage_mod.MOTION_TIMEOUT] * 2
    assert stage_mod.MOTION_TIMEOUT >= 60


def test_ordinary_gcode_and_status_keep_short_timeouts():
    st = Recorder()
    st.move(x=10, y=20)
    st.jog("X", 1.0)
    st.status()
    assert st.gcode_timeouts() == [stage_mod.GCODE_TIMEOUT] * 2
    assert all(t == stage_mod._TIMEOUT for p, _, t in st.calls if not p.startswith("/printer/gcode"))


def test_force_position_uses_the_middle_of_the_real_travel():
    st = Recorder()
    st.force_position()
    script = [p for p, _, _ in st.calls if "SET_KINEMATIC_POSITION" in p][0]
    assert "Z%3D7.5" in script  # 15 / 2,不是旧兜底值的 30


@pytest.mark.parametrize("toolhead", [
    {"position": [0, 0, 0, 0], "homed_axes": ""},                       # 查不到行程
    {"position": [0, 0, 0, 0], "homed_axes": "", "axis_maximum": None, "axis_minimum": None},
])
def test_force_position_refuses_when_travel_limits_are_unknown(toolhead):
    st = Recorder(toolhead=toolhead)
    with pytest.raises(StageError, match="axis limits unknown"):
        st.force_position()
    assert not [p for p, _, _ in st.calls if "SET_KINEMATIC_POSITION" in p]


def test_force_position_refuses_when_offline():
    st = Recorder(connected=False)
    with pytest.raises(StageError, match="offline"):
        st.force_position()
