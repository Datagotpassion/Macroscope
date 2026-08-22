#!/bin/bash
# PlateScope camera watchdog.
#
# The IMX477 on a marginal CSI ribbon occasionally wedges: picamera2/libcamera
# hangs holding the camera lock, so every capture (preview + timelapse) blocks
# forever. It's a silent hang -- no kernel error, no process exit -- so nothing
# inside the app can catch it. This external probe restarts the service when it
# happens, turning a dead night into a ~few-minute gap. The client-side
# timelapse skips the failed captures and resumes on its own once the camera
# is back.
#
# Install: see deploy/watchdog/README (or the platescope-watchdog.service unit).
#
# Tunables via environment (with sane defaults):
set -u

URL="${WATCHDOG_URL:-http://localhost:8000/api/plate/image?annotate=false&fresh=true}"
INTERVAL="${WATCHDOG_INTERVAL:-180}"     # seconds between probes
TIMEOUT="${WATCHDOG_TIMEOUT:-40}"        # per-probe capture timeout (s)
THRESHOLD="${WATCHDOG_THRESHOLD:-2}"     # consecutive fails before restart
COOLDOWN="${WATCHDOG_COOLDOWN:-45}"      # seconds to wait after a restart

fails=0
echo "[watchdog] started: probing every ${INTERVAL}s (timeout ${TIMEOUT}s, restart after ${THRESHOLD} fails)"

while true; do
    if curl -sf --max-time "$TIMEOUT" "${URL}&t=$(date +%s)" -o /dev/null; then
        if [ "$fails" -ne 0 ]; then
            echo "[watchdog] camera probe OK again (was ${fails} fail(s))"
        fi
        fails=0
    else
        fails=$((fails + 1))
        echo "[watchdog] camera probe FAILED (${fails}/${THRESHOLD})"
        if [ "$fails" -ge "$THRESHOLD" ]; then
            echo "[watchdog] camera wedged -> restarting platescope"
            systemctl restart platescope
            fails=0
            sleep "$COOLDOWN"   # let the service + camera come back before probing again
        fi
    fi
    sleep "$INTERVAL"
done
