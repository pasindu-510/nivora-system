#!/usr/bin/env bash
# One-command backend deploy for the cPanel server (nivora.lk).
#
#   bash ~/repositories/nivora-system/deploy-backend.sh
#
# Steps: pull latest code -> install/upgrade Python packages -> migrate DB ->
# collect static files -> restart the Python app -> health check.
# Stops at the first failure, so a broken step never restarts a half-updated app.
set -euo pipefail

REPO="$HOME/repositories/nivora-system"
APP_ROOT_REL="repositories/nivora-system/backend"
VENV="$HOME/virtualenv/$APP_ROOT_REL/3.12/bin/activate"
HEALTH_URL="https://api.nivora.lk/api/health/"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }

cd "$REPO"

step "Pulling latest code"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Server copy has local edits; setting them aside (git stash) so the pull can run."
  git stash push -m "auto-stash by deploy-backend.sh $(date +%F_%T)"
fi
git pull --ff-only
git log --oneline -1

# shellcheck disable=SC1090
source "$VENV"
cd backend

step "Installing Python packages"
pip install -q -r requirements-pymysql.txt

step "Applying database migrations"
python manage.py migrate --noinput

step "Collecting static files"
python manage.py collectstatic --noinput -v 0

step "Restarting the app"
mkdir -p tmp && touch tmp/restart.txt
if command -v cloudlinux-selector >/dev/null 2>&1; then
  cloudlinux-selector restart --json --interpreter python --app-root "$APP_ROOT_REL" >/dev/null \
    && echo "Restarted via Setup Python App." \
    || echo "Could not restart via cloudlinux-selector — click Restart in Setup Python App."
else
  echo "Touched tmp/restart.txt (click Restart in Setup Python App if changes don't show)."
fi

step "Health check"
sleep 3
if curl -fsS --max-time 20 "$HEALTH_URL"; then
  printf '\n\033[1;32mDeploy finished OK.\033[0m\n'
else
  printf '\n\033[1;31mHealth check failed — see backend/stderr.log or click Restart in Setup Python App.\033[0m\n'
  exit 1
fi
