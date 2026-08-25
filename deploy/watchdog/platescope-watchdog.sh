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
INTERVAL="${WATCHDOG_INTERVAL:-180}"       # seconds between probes
TIMEOUT="${WATCHDOG_TIMEOUT:-40}"          # per-probe capture timeout (s)
THRESHOLD="${WATCHDOG_THRESHOLD:-2}"       # consecutive fails before a restart
COOLDOWN="${WATCHDOG_COOLDOWN:-45}"        # seconds to wait after a restart
MAX_RESTARTS="${WATCHDOG_MAX_RESTARTS:-3}" # futile restarts before giving up
BACKOFF="${WATCHDOG_BACKOFF:-900}"         # when given up, just watch this often

# A restart recovers a *wedge*. But if the camera is hard-down (e.g. a loose
# ribbon), restarting never helps -- and looping restarts forever also bounces
# the backend, which takes the STAGE control UI offline too. So: restart at
# most MAX_RESTARTS times; if the camera still won't come back, assume hardware,
# stop restarting (leave the rest of the system up), and just keep watching.
fails=0
restart_streak=0   # consecutive restarts that did NOT bring the camera back
giving_up=0

echo "[watchdog] started: probe every ${INTERVAL}s; restart after ${THRESHOLD} fails; give up after ${MAX_RESTARTS} futile restarts"

while true; do
    if curl -sf --max-time "$TIMEOUT" "${URL}&t=$(date +%s)" -o /dev/null; then
        if [ "$giving_up" -eq 1 ]; then
            echo "[watchdog] camera recovered -> resuming normal watch"
            giving_up=0
        elif [ "$fails" -ne 0 ] || [ "$restart_streak" -ne 0 ]; then
            echo "[watchdog] camera OK again"
        fi
        fails=0
        restart_streak=0
    else
        fails=$((fails + 1))
        echo "[watchdog] camera probe FAILED (${fails}/${THRESHOLD})"
        if [ "$fails" -ge "$THRESHOLD" ]; then
            fails=0
            if [ "$giving_up" -eq 1 ]; then
                echo "[watchdog] camera still down; NOT restarting (looks like hardware — check the ribbon). Stage/UI left running."
                sleep "$BACKOFF"
                continue
            fi
            restart_streak=$((restart_streak + 1))
            if [ "$restart_streak" -gt "$MAX_RESTARTS" ]; then
                echo "[watchdog] ${MAX_RESTARTS} restarts did not recover the camera -> likely hardware (loose ribbon?). Pausing restarts so stage control/UI stay up; still watching."
                giving_up=1
                sleep "$BACKOFF"
                continue
            fi
            echo "[watchdog] camera wedged -> restarting platescope (attempt ${restart_streak}/${MAX_RESTARTS})"
            systemctl restart platescope
            sleep "$COOLDOWN"   # let the service + camera come back before probing again
        fi
    fi
    sleep "$INTERVAL"
done
