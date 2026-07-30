#!/bin/bash
#
# Weekly production backup -> Google Drive.
#
# Railway's own volume snapshots are not available on the Hobby plan
# (volumes.maxBackupsCount = 0), so this is the only backup that exists. It is driven by a
# LaunchAgent (see scripts/com.phoneup.backup.plist); run it by hand any time to take an
# extra copy.
#
# Design notes:
#   - The production password is never written to disk. It is fetched from the Railway CLI
#     at run time, which uses the login token already on this machine.
#   - DATABASE_PUBLIC_URL, not DATABASE_URL: the latter points at postgres.railway.internal,
#     which only resolves inside Railway's network.
#   - Production runs Postgres 18, so the v18 client is put first on PATH. A v16 pg_dump
#     cannot dump an v18 server, and packages/db/src/backup.ts refuses rather than writing
#     a broken archive.
#   - Failures write a visible marker file into the Drive folder, because a LaunchAgent that
#     quietly stops running looks exactly like one that has nothing to do.

set -uo pipefail

REPO="/Users/seandm/Projects/1_PHONE_RR"
DRIVE_DIR="/Users/seandm/Library/CloudStorage/GoogleDrive-seanzmc9613@gmail.com/My Drive/PhoneUp Backups"
LOG="$DRIVE_DIR/backup.log"
KEEP=8 # weekly dumps retained, roughly two months

export PATH="/opt/homebrew/opt/postgresql@18/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$DRIVE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

fail() {
  log "FAILED: $*"
  # surfaced where the backups live, so a silent failure is still visible
  echo "Backup failed at $(date). Reason: $*" > "$DRIVE_DIR/BACKUP-FAILED.txt"
  exit 1
}

log "starting"
rm -f "$DRIVE_DIR/BACKUP-FAILED.txt"

cd "$REPO" || fail "repo not found at $REPO"

# Fetch the production connection string at run time; never persisted.
DB_URL=$(railway variables --service Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
[ -n "$DB_URL" ] || fail "could not read DATABASE_PUBLIC_URL from Railway (is the CLI still logged in? run: railway login)"

DATABASE_URL="$DB_URL" pnpm --filter @phoneup/db backup "$DRIVE_DIR" >> "$LOG" 2>&1 \
  || fail "pnpm backup exited non-zero — see $LOG"

LATEST=$(ls -t "$DRIVE_DIR"/*.dump 2>/dev/null | head -1)
[ -n "$LATEST" ] || fail "backup reported success but no .dump file was written"
log "wrote $(basename "$LATEST") ($(du -h "$LATEST" | cut -f1))"

# Prune oldest dumps and their manifests, keeping the most recent $KEEP.
ls -t "$DRIVE_DIR"/*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  log "pruning $(basename "$old")"
  rm -f "$old" "${old%.dump}.manifest.json"
done

log "done"
