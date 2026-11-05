#!/usr/bin/env bash
# One-command install on a fresh Ubuntu VPS (e.g. Contabo). Run as root from the repo:
#   ./deploy/install.sh play.yourdomain.com
# Safe to re-run: keeps an existing deploy/.env and goals.json, then rebuilds and restarts.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (or with sudo)." >&2
  exit 1
fi

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "Domain for the website (e.g. play.yourdomain.com): " DOMAIN
fi
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%/}"
if ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "'$DOMAIN' doesn't look like a domain name." >&2
  exit 1
fi

cd "$(dirname "$0")"

echo "==> Installing Docker and configuring the firewall"
./setup-vps.sh

echo "==> Checking DNS"
SERVER_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)"
if [ -n "$SERVER_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
  echo "WARNING: $DOMAIN resolves to '${DNS_IP:-nothing}', but this server is $SERVER_IP."
  echo "         Add an A record for $DOMAIN -> $SERVER_IP. HTTPS starts working once it resolves;"
  echo "         then run: cd $(pwd) && docker compose restart caddy"
fi
if getent ahostsv6 "$DOMAIN" | grep -q ':'; then
  echo "WARNING: $DOMAIN has an IPv6 (AAAA) record. Remove it, or ranked logins may be refused."
fi

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
[ -f goals.json ] || cp goals.example.json goals.json

echo "==> Building and starting (first build takes 5-10 minutes)"
docker compose up -d --build

echo
echo "Done."
echo "  Website:        https://$DOMAIN"
echo "  Forge servers:  $DOMAIN:36743 and $DOMAIN:36744 (they need ~1 minute to load cards)"
echo "  Admin token:    grep ADMIN_TOKEN $(pwd)/.env"
echo "  Logs:           cd $(pwd) && docker compose logs -f"
echo "Payouts are in test mode (PAYOUT_MODE=dry-run) until you change deploy/.env."
