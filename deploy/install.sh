#!/usr/bin/env bash
# One-command install on an Ubuntu VPS (e.g. Contabo). Run as root from the repo:
#   ./deploy/install.sh yourdomain.com
# Safe to re-run: keeps an existing deploy/.env and goals.json, then rebuilds and restarts.
#
# If the server already runs Caddy (systemd) for other sites, the site is added to
# /etc/caddy/Caddyfile (after a backup, reloaded only if the config validates).
# Otherwise a bundled Caddy container serves it.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (or with sudo)." >&2
  exit 1
fi

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "Domain for the game (e.g. yourdomain.com): " DOMAIN
fi
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%/}"
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "'$DOMAIN' doesn't look like a domain name." >&2
  exit 1
fi

cd "$(dirname "$0")"
REWARDS_PORT=8080
FORGE_PORTS="36743 36744 36745"

# --- ports we need must be free (or already ours) ---
for port in $REWARDS_PORT $FORGE_PORTS; do
  owner="$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -o 'users:(("[^"]*' | cut -d'"' -f2 | head -1 || true)"
  if [ -n "$owner" ] && [ "$owner" != "node" ] && [ "$owner" != "java" ]; then
    echo "Port $port is already used by '$owner'. Free it or change the port in docker-compose.yml." >&2
    exit 1
  fi
done

# --- Docker ---
if ! command -v docker >/dev/null; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# --- firewall: only add the game ports, never change existing rules ---
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "==> Opening Forge ports in ufw (existing rules unchanged)"
  for port in $FORGE_PORTS; do ufw allow "$port/tcp" >/dev/null; done
else
  echo "NOTE: ufw is not active. Make sure ports 80, 443 and $FORGE_PORTS (TCP) are reachable."
fi

# --- DNS sanity check ---
echo "==> Checking DNS"
SERVER_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)"
if [ -n "$SERVER_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
  echo "WARNING: $DOMAIN resolves to '${DNS_IP:-nothing}', but this server is $SERVER_IP."
  echo "         Add an A record for $DOMAIN -> $SERVER_IP. HTTPS starts working once it resolves."
fi
if getent ahostsv6 "$DOMAIN" | grep -q ':'; then
  echo "WARNING: $DOMAIN has an IPv6 (AAAA) record. Remove it, or ranked logins may be refused."
fi

# --- web server ---
SYSTEM_CADDY=0
if systemctl is-active --quiet caddy 2>/dev/null; then
  SYSTEM_CADDY=1
elif ss -tlnH 'sport = :443' | grep -q LISTEN; then
  echo "Something other than Caddy already serves port 443. Add a reverse proxy for $DOMAIN -> 127.0.0.1:$REWARDS_PORT to it yourself," >&2
  echo "then re-run this script with SKIP_WEB=1." >&2
  [ "${SKIP_WEB:-0}" = "1" ] || exit 1
fi

# --- config ---
if [ -f .env ]; then
  echo "==> Keeping existing deploy/.env"
else
  echo "==> Writing deploy/.env"
  sed -e "s#^DOMAIN=.*#DOMAIN=$DOMAIN#" \
      -e "s#^PUBLIC_HOST=.*#PUBLIC_HOST=$DOMAIN#" \
      -e "s#^PUBLIC_ORIGIN=.*#PUBLIC_ORIGIN=https://$DOMAIN#" \
      -e "s#^GAME_SERVER_SECRET=.*#GAME_SERVER_SECRET=$(openssl rand -hex 32)#" \
      -e "s#^ADMIN_TOKEN=.*#ADMIN_TOKEN=$(openssl rand -hex 32)#" \
      .env.example > .env
  chmod 600 .env
fi
# Add settings introduced by newer versions, and generate any secret that is still empty.
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  key="${line%%=*}"
  grep -q "^${key}=" .env || echo "$line" >> .env
done < .env.example
for key in GAME_SERVER_SECRET ADMIN_TOKEN STREAM_SECRET; do
  if grep -qE "^${key}=$" .env; then
    sed -i "s#^${key}=\$#${key}=$(openssl rand -hex 32)#" .env
  fi
done
if grep -qE '^STREAM_ALLOWED_USERS=$' .env && [ -t 0 ]; then
  read -rp "Usernames allowed to play in the browser (comma-separated, * for everyone, Enter for nobody): " STREAM_USERS
  [ -n "$STREAM_USERS" ] && sed -i "s#^STREAM_ALLOWED_USERS=\$#STREAM_ALLOWED_USERS=${STREAM_USERS//#/}#" .env
fi

# Which compose profile runs: the bundled Caddy only when there is no web server already.
# Keep any profiles the admin added (e.g. pvp2) and add or remove bundled-caddy as needed.
PROFILES="$(grep -E '^COMPOSE_PROFILES=' .env | tail -1 | cut -d= -f2 | tr ',' '\n' | grep -v '^bundled-caddy$' | grep -v '^$' | paste -sd, - || true)"
if [ "$SYSTEM_CADDY" = "0" ] && [ "${SKIP_WEB:-0}" != "1" ]; then
  PROFILES="${PROFILES:+$PROFILES,}bundled-caddy"
fi
sed -i '/^COMPOSE_PROFILES=/d' .env
[ -n "$PROFILES" ] && echo "COMPOSE_PROFILES=$PROFILES" >> .env
[ -f goals.json ] || cp goals.example.json goals.json

# --- add the site to the system Caddy ---
if [ "$SYSTEM_CADDY" = "1" ]; then
  CADDYFILE=/etc/caddy/Caddyfile
  MARK="# ranked-forge: $DOMAIN"
  if grep -qF "$MARK" "$CADDYFILE"; then
    echo "==> $DOMAIN is already in $CADDYFILE"
  else
    echo "==> Adding $DOMAIN to the existing Caddy ($CADDYFILE)"
    BACKUP="$CADDYFILE.bak-$(date +%Y%m%d%H%M%S)"
    cp "$CADDYFILE" "$BACKUP"
    cat >> "$CADDYFILE" <<EOF

$MARK
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$REWARDS_PORT
}
EOF
    if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
      systemctl reload caddy
      echo "    Caddy reloaded. Backup of the previous config: $BACKUP"
    else
      cp "$BACKUP" "$CADDYFILE"
      echo "The new Caddy config did not validate; restored $BACKUP and left Caddy untouched." >&2
      caddy validate --config "$CADDYFILE" --adapter caddyfile || true
      exit 1
    fi
  fi
fi

echo "==> Building and starting (first build takes 5-10 minutes)"
docker compose up -d --build

echo
echo "Done."
echo "  Website:        https://$DOMAIN"
echo "  Forge servers:  $DOMAIN:36743 (PvP), $DOMAIN:36745 (vs AI); ~1 minute to load cards"
echo "  Browser play:   \"Play in browser\" on the website (users in STREAM_ALLOWED_USERS)"
echo "  Admin token:    grep ADMIN_TOKEN $(pwd)/.env"
echo "  Logs:           cd $(pwd) && docker compose logs -f"
echo "Payouts are in test mode (PAYOUT_MODE=dry-run) until you change deploy/.env."
