#!/usr/bin/env bash
# CourseSentry — deploy update (preserves data/ directory)
# Usage: bash update.sh

set -euo pipefail

INSTALL_DIR="/srv/CourseSentry"
SERVICE_USER="www-data"

echo "=== CourseSentry Update ==="

sudo rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  "$(dirname "$(realpath "$0")")/" "${INSTALL_DIR}/"

sudo chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

echo "Installing/updating npm dependencies..."
cd "${INSTALL_DIR}"
sudo -u "${SERVICE_USER}" npm install --omit=dev

sudo systemctl restart coursesentry
echo "Service restarted."
echo "Logs: sudo journalctl -u coursesentry -f"
