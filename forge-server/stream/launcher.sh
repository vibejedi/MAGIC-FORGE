#!/usr/bin/env bash
# Runs as root inside a stream container. Starts a virtual display, a VNC server and noVNC,
# then asks the rewards service which player holds this slot and runs Forge for them as the
# unprivileged "player" user, with a fresh profile per session. The secrets in this process's
# environment are not passed to Forge.
set -u
: "${SLOT:?}" "${REWARDS_URL:?}" "${STREAM_SECRET:?}"
GEOMETRY="${STREAM_GEOMETRY:-1600x900}"
JAVA_OPTS="${JAVA_OPTS:--Xmx1200m}"
export DISPLAY=:1

Xvfb :1 -screen 0 "${GEOMETRY}x24" -nolisten tcp &
for _ in $(seq 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.2; done
runuser -u player -- openbox --config-file /opt/stream/openbox.xml &
x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5900 -quiet -noxdamage >/dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

assignment() {
  local body ts sig
  body="{\"slot\":${SLOT}}"
  ts="$(date +%s)"
  sig="$(printf '%s' "${ts}.${body}" | openssl dgst -sha256 -hmac "${STREAM_SECRET}" -hex | sed 's/^.* //')"
  curl -fsS --max-time 5 -H 'content-type: application/json' -H "x-timestamp: ${ts}" -H "x-signature: ${sig}" \
    -d "${body}" "${REWARDS_URL%/}/api/stream/assignment"
}

FORGE_PID=""
stop_forge() {
  if [ -n "$FORGE_PID" ]; then
    pkill -TERM -u player -f forge.view.Main 2>/dev/null
    for _ in $(seq 25); do pgrep -u player -f forge.view.Main >/dev/null || break; sleep 0.2; done
    pkill -KILL -u player -f forge.view.Main 2>/dev/null
    FORGE_PID=""
  fi
}

start_forge() {
  local user="$1"
  # Fresh profile (decks, settings) for every session; the card image cache is kept.
  runuser -u player -- bash -c 'rm -rf "$HOME/.forge" && mkdir -p "$HOME/.forge/preferences"'
  runuser -u player -- bash -c "printf 'PLAYER_NAME=%s\nUI_FULLSCREEN_MODE=false\n' '$user' > \"\$HOME/.forge/preferences/forge.preferences\""
  cd /forge/forge-gui-desktop || exit 1
  env -i HOME=/home/player USER=player DISPLAY=:1 PATH="$PATH" JAVA_HOME="${JAVA_HOME:-}" \
    runuser -u player -- java $JAVA_OPTS ${FORGE_JVM_FLAGS:-} \
      -cp "target/classes:../forge-gui/target/classes:../forge-ai/target/classes:../forge-game/target/classes:../forge-core/target/classes:/forge/lib/*" \
      forge.view.Main >/tmp/forge-session.log 2>&1 &
  FORGE_PID=$!
  echo "[stream ${SLOT}] started Forge for ${user}"
}

CURRENT=""
while true; do
  if resp="$(assignment 2>/dev/null)"; then
    user="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("username") or "")' <<<"$resp")"
    session="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("session") or "")' <<<"$resp")"
    # Usernames are [A-Za-z0-9_]; refuse anything else rather than pass it to a shell.
    if [ -n "$user" ] && ! [[ "$user" =~ ^[A-Za-z0-9_]{3,20}$ ]]; then user=""; session=""; fi
    if [ "$session" != "$CURRENT" ]; then
      stop_forge
      [ -n "$user" ] && start_forge "$user" || echo "[stream ${SLOT}] idle"
      CURRENT="$session"
    elif [ -n "$user" ] && ! kill -0 "$FORGE_PID" 2>/dev/null; then
      start_forge "$user"   # the player quit Forge; bring it back for the rest of the session
    fi
  fi
  sleep 3
done
