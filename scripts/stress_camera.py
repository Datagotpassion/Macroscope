#!/usr/bin/env python3
"""Camera-pipeline stress test.

Compresses "hours of use + a flaky-link reconnect storm" into a few minutes,
to verify (before trusting a multi-day run):

  1. the single-streamer guard holds -- a reconnect storm must NOT stack
     multiple preview capture loops fighting over the one camera;
  2. timelapse-style fresh captures stay reliable (high success rate, no
     runaway latency, no stalls) even while the storm hammers preview;
  3. memory does not leak over time and the Pi does not brown-out / throttle.

Run ON the Pi:
    cd ~/Macroscope
    python3 scripts/stress_camera.py --duration 300

Options:
    --url        backend base URL (default http://localhost:8000)
    --duration   seconds to run (default 300)
    --storm      concurrent preview connections per wave (default 6)
"""
import argparse
import asyncio
import subprocess
import sys
import time
import urllib.request

try:
    import websockets
except ImportError:
    print(
        "Need the 'websockets' library (ships with uvicorn[standard]).\n"
        "Install with: pip install websockets",
        file=sys.stderr,
    )
    sys.exit(1)


def mem_available_mb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        pass
    return -1


def vcgen(cmd):
    try:
        return subprocess.check_output(["vcgencmd", cmd], text=True).strip()
    except Exception:
        return "n/a"


class Stats:
    def __init__(self):
        self.cap_ok = 0
        self.cap_fail = 0
        self.cap_lat_sum = 0.0
        self.cap_lat_max = 0.0
        self.ws_opened = 0


async def capture_worker(base, stats, stop):
    """Hammer fresh captures back-to-back; measure success rate + latency."""
    url = base + "/api/plate/image?annotate=false&fresh=true"

    def grab():
        return urllib.request.urlopen(url + f"&t={time.time()}", timeout=30).read()

    while not stop.is_set():
        t0 = time.time()
        try:
            await asyncio.to_thread(grab)
            dt = time.time() - t0
            stats.cap_ok += 1
            stats.cap_lat_sum += dt
            stats.cap_lat_max = max(stats.cap_lat_max, dt)
        except Exception:
            stats.cap_fail += 1
        await asyncio.sleep(0.05)


async def storm_worker(base, stats, stop, concurrency):
    """Simulate a flapping Ethernet link: repeatedly open a burst of preview
    WS connections, read a few frames, then abruptly drop them."""
    ws_url = base.replace("http", "ws", 1) + "/ws/preview"

    async def one():
        stats.ws_opened += 1
        try:
            ws = await asyncio.wait_for(
                websockets.connect(ws_url, max_size=None), timeout=10
            )
        except Exception:
            return
        try:
            for _ in range(3):
                await asyncio.wait_for(ws.recv(), timeout=8)
        except Exception:
            pass
        finally:
            try:
                await ws.close()
            except Exception:
                pass

    while not stop.is_set():
        await asyncio.gather(
            *[one() for _ in range(concurrency)], return_exceptions=True
        )
        await asyncio.sleep(0.1)


async def monitor(stats, stop, duration):
    t0 = time.time()
    while not stop.is_set():
        await asyncio.sleep(5)
        el = time.time() - t0
        avg = (stats.cap_lat_sum / stats.cap_ok) if stats.cap_ok else 0
        thr = vcgen("get_throttled").split("=")[-1]
        print(
            f"[{el:5.0f}s] caps ok={stats.cap_ok} fail={stats.cap_fail} "
            f"avg={avg * 1000:4.0f}ms max={stats.cap_lat_max * 1000:4.0f}ms "
            f"ws={stats.ws_opened} | memAvail={mem_available_mb()}MB "
            f"{vcgen('measure_temp')} throttled={thr}",
            flush=True,
        )
        if el >= duration:
            stop.set()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--duration", type=int, default=300)
    ap.add_argument("--storm", type=int, default=6, help="preview conns per wave")
    args = ap.parse_args()

    base = args.url.rstrip("/")
    stats = Stats()
    stop = asyncio.Event()
    start_mem = mem_available_mb()
    print(
        f"stress start: {base}  duration={args.duration}s  storm={args.storm}  "
        f"memAvail={start_mem}MB"
    )
    print(f"start throttled={vcgen('get_throttled')}  {vcgen('measure_temp')}")

    tasks = [
        asyncio.create_task(capture_worker(base, stats, stop)),
        asyncio.create_task(storm_worker(base, stats, stop, args.storm)),
        asyncio.create_task(monitor(stats, stop, args.duration)),
    ]
    try:
        await stop.wait()
    except KeyboardInterrupt:
        stop.set()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

    end_mem = mem_available_mb()
    tot = stats.cap_ok + stats.cap_fail
    rate = 100 * stats.cap_ok / tot if tot else 0
    leak = start_mem - end_mem
    print("\n==== result ====")
    print(f"captures : {stats.cap_ok} ok / {stats.cap_fail} fail   ({rate:.1f}% ok)")
    print(
        f"latency  : avg {1000 * stats.cap_lat_sum / max(1, stats.cap_ok):.0f}ms   "
        f"max {1000 * stats.cap_lat_max:.0f}ms"
    )
    print(f"preview  : {stats.ws_opened} connections opened (storm)")
    print(f"memory   : {start_mem}MB -> {end_mem}MB  (delta {leak}MB)")
    print(f"end throttled={vcgen('get_throttled')}  {vcgen('measure_temp')}")
    ok = rate > 95 and leak < 80 and stats.cap_lat_max < 15
    print(
        f"verdict  : {'PASS' if ok else 'CHECK'}  "
        f"(want >95% ok, mem drop <80MB, max latency <15s)"
    )


if __name__ == "__main__":
    asyncio.run(main())
