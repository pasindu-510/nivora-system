#!/usr/bin/env bash
# Nightly MySQL backup for the cPanel server (nivora.lk).
#
#   bash ~/repositories/nivora-system/backup-db.sh
#
# - Reads DB_NAME / DB_USER / DB_PASSWORD / DB_HOST / DB_PORT from backend/.env
#   (no credentials live in this repo).
# - Writes ~/backups/db/<db>_YYYY-MM-DD_HHMM.sql.gz  (outside public_html).
# - Keeps the newest $KEEP_DAYS days of backups, deletes older ones.
# - Copies each backup to Google Drive via rclone (remote "gdrive"), keeps 30 days there.
# - Logs to ~/backups/db/backup.log; exits non-zero on failure so cron mails it.
#
# Restore:  gunzip -c FILE.sql.gz | mysql -u USER -p DB_NAME
set -euo pipefail

REPO="$HOME/repositories/nivora-system"
ENV_FILE="$REPO/backend/.env"
BACKUP_DIR="$HOME/backups/db"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$HOME/backups" "$BACKUP_DIR"
LOG="$BACKUP_DIR/backup.log"
log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

# Read one KEY=value from .env (ignores comments, strips surrounding quotes).
env_get() {
  local line
  line=$(grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" | tail -n1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  line=${line#\"}; line=${line%\"}
  line=${line#\'}; line=${line%\'}
  printf '%s' "$line"
}

DB_NAME=$(env_get DB_NAME)
DB_USER=$(env_get DB_USER)
DB_PASSWORD=$(env_get DB_PASSWORD)
DB_HOST=$(env_get DB_HOST); DB_HOST=${DB_HOST:-localhost}
DB_PORT=$(env_get DB_PORT); DB_PORT=${DB_PORT:-3306}

if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
  log "ERROR: DB_NAME/DB_USER missing in $ENV_FILE"
  exit 1
fi

# Password goes in a private temp options file, never on the command line
# (where other processes could see it).
CNF=$(mktemp)
chmod 600 "$CNF"
trap 'rm -f "$CNF"' EXIT
# Quote the password so characters like # ; or spaces survive option parsing.
PW_ESC=${DB_PASSWORD//\\/\\\\}
PW_ESC=${PW_ESC//\"/\\\"}
printf '[client]\nuser=%s\npassword="%s"\nhost=%s\nport=%s\n' \
  "$DB_USER" "$PW_ESC" "$DB_HOST" "$DB_PORT" > "$CNF"

STAMP=$(date +%F_%H%M)
OUT="$BACKUP_DIR/${DB_NAME}_${STAMP}.sql.gz"
TMP="$OUT.partial"

# --single-transaction: consistent snapshot without locking the shop.
# --no-tablespaces: shared hosting users lack the PROCESS privilege.
if mysqldump --defaults-extra-file="$CNF" \
    --single-transaction --quick --routines --triggers --no-tablespaces \
    --default-character-set=utf8mb4 "$DB_NAME" | gzip -9 > "$TMP"; then
  mv "$TMP" "$OUT"
  chmod 600 "$OUT"
  log "OK  $OUT ($(du -h "$OUT" | cut -f1))"
else
  rm -f "$TMP"
  log "ERROR: mysqldump failed for $DB_NAME"
  exit 1
fi

# Retention: drop backups older than KEEP_DAYS days.
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime +"$KEEP_DAYS" -print -delete \
  | while read -r old; do log "deleted old backup $old"; done

# ── Off-server copy to Google Drive (rclone) ───────────────────────────────
# Enabled once an rclone remote named "gdrive" exists (see docs/deploy-cpanel.md).
# The local backup above is already safe even if this upload fails.
RCLONE="${RCLONE:-$(command -v rclone || echo "$HOME/bin/rclone")}"
GDRIVE_DEST="${GDRIVE_DEST:-gdrive:nivora-db-backups}"
GDRIVE_KEEP_DAYS="${GDRIVE_KEEP_DAYS:-30}"

if [ -x "$RCLONE" ] && "$RCLONE" listremotes 2>/dev/null | grep -qx "${GDRIVE_DEST%%:*}:"; then
  if "$RCLONE" copy "$OUT" "$GDRIVE_DEST" --retries 3 --low-level-retries 10 2>>"$LOG"; then
    log "OK  uploaded to $GDRIVE_DEST/$(basename "$OUT")"
    "$RCLONE" delete "$GDRIVE_DEST" --min-age "${GDRIVE_KEEP_DAYS}d" --include "${DB_NAME}_*.sql.gz" 2>>"$LOG" \
      || log "WARN: could not prune old Google Drive backups"
  else
    log "ERROR: Google Drive upload failed (local backup kept: $OUT)"
    exit 1
  fi
else
  log "NOTE: Google Drive upload skipped (rclone or remote '${GDRIVE_DEST%%:*}' not set up)"
fi
