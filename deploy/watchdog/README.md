# PlateScope camera watchdog

An external safety net for the marginal CSI camera. When picamera2/libcamera
wedges (a silent hang holding the camera lock, so preview + timelapse both
block and nothing inside the app can recover), this probes a real capture and
`systemctl restart`s the service when it stops responding. Combined with the
client-side timelapse's skip-and-resume, a wedge becomes a few-minute gap
instead of a dead run.

This is a **bridge**, not a cure — the real fix is a USB camera (no CSI ribbon,
no bandwidth ceiling). Use this to survive multi-day runs in the meantime.

## Install (on the Pi)

```bash
cd ~/Macroscope
chmod +x deploy/watchdog/platescope-watchdog.sh
sudo cp deploy/watchdog/platescope-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now platescope-watchdog
```

Check it:
```bash
systemctl status platescope-watchdog
journalctl -u platescope-watchdog -f
```

## Tuning (optional)

Override defaults with a drop-in, e.g. probe more often:
```bash
sudo systemctl edit platescope-watchdog
# add:
#   [Service]
#   Environment=WATCHDOG_INTERVAL=120
#   Environment=WATCHDOG_THRESHOLD=2
```

Defaults: probe every 180 s, 40 s capture timeout, restart after 2 consecutive
failures, 45 s cooldown after a restart. Worst-case detection ≈ 2 × 180 s ≈ 6 min.

## Notes
- The `ExecStart` path assumes the repo is at `/home/kdcberry/Macroscope`. Edit
  the unit if that changes.
- Each probe triggers one real capture, which also keeps the camera exercised.
- To pause the watchdog: `sudo systemctl stop platescope-watchdog`.
