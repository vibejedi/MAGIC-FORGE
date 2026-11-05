#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 22.04/24.04 VPS (e.g. Contabo). Run as root.
set -euo pipefail

apt-get update
apt-get install -y ca-certificates curl git ufw

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# Firewall: SSH, HTTP/HTTPS for the website, and one TCP port per Forge server.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 36743:36746/tcp
ufw --force enable

# Docker publishes ports around ufw; with host networking (used here) ufw rules apply as normal.
echo "Done. Next: cd deploy && cp .env.example .env && cp goals.example.json goals.json, edit both, then: docker compose up -d --build"
