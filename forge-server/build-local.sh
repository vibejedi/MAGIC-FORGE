#!/usr/bin/env bash
# Clone Forge at the pinned commit and apply the dedicated-server patch, without Docker.
# Usage: forge-server/build-local.sh [target-dir]   (default: ./forge-src)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="${1:-forge-src}"
commit="$(cat "$here/FORGE_COMMIT")"
git init -q "$dest"
cd "$dest"
git remote add origin https://github.com/Card-Forge/forge.git 2>/dev/null || true
git fetch --depth 1 origin "$commit"
git checkout -q FETCH_HEAD
git apply "$here"/patches/*.patch
mvn -B -pl forge-gui-desktop -am -DskipTests -Dcheckstyle.skip compile
echo "Built. Run the server from $dest/forge-gui-desktop (see README)."
