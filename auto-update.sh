#!/usr/bin/env bash
# CourseSentry — cron auto-updater
# Checks the git checkout for upstream changes; if any are found, pulls them
# and runs `bash update.sh` to deploy.
#
# Usage: bash auto-update.sh
#
# Intended to run unattended from crontab in the git checkout directory
# (NOT /srv/CourseSentry — that's the deployed copy update.sh rsyncs to).
# Example crontab entry (checks every 5 minutes):
#   */5 * * * * /usr/bin/flock -n /tmp/coursesentry-autoupdate.lock bash /path/to/checkout/auto-update.sh >> /var/log/coursesentry-autoupdate.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
cd "${REPO_DIR}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

if [ -n "$(git status --porcelain)" ]; then
  log "ERROR: working tree has uncommitted changes, refusing to pull. Resolve manually in ${REPO_DIR}."
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

log "Fetching origin/${BRANCH}..."
git fetch --quiet origin "${BRANCH}"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"

if [ "${LOCAL}" = "${REMOTE}" ]; then
  log "Already up to date (${LOCAL:0:7})."
  exit 0
fi

log "Update available: ${LOCAL:0:7} -> ${REMOTE:0:7}. Pulling..."
git merge --ff-only "origin/${BRANCH}"

log "Running update.sh..."
bash update.sh

log "Deploy complete at $(git rev-parse --short HEAD)."
