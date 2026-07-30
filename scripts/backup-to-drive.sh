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
#     cannot dump a v18 server, and packages/db/src/backup.ts refuses rather than writing
#     a broken archive.
#   - Failures write a visible marker file into the Drive folder, because a LaunchAgent that
#     quietly stops running looks exactly like one that has nothing to do.
#
# macOS privacy control shapes the whole layout. ~/Library/CloudStorage is protected: a
# process may CREATE files there and DELETE ones it knows by name, but it may not ENUMERATE
# the directory. Globbing it from a LaunchAgent silently returns nothing, which first looked
# like "the backup produced no file" when the file was sitting right there. So:
#   - dumps are written to a local staging directory, where verification and pruning work;
#   - only finished files are copied into Drive;
#   - Drive pruning deletes explicit paths recorded in a local index, never a listing.
# The alternative was granting /bin/bash Full Disk Access, which is far too broad a grant
# for a backup script.

set -uo pipefail

REPO="/Users/seandm/Projects/1_PHONE_RR"
DRIVE_DIR="/Users/seandm/Library/CloudStorage/GoogleDrive-seanzmc9613@gmail.com/My Drive/PhoneUp Backups"
STAGING="$HOME/.phoneup-backups"
INDEX="$STAGING/drive-index.txt" # newest-last list of filenames copied into Drive
KEEP=8                           # weekly dumps retained, roughly two months

export PATH="/opt/homebrew/opt/postgresql@18/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/phoneup-backup.log"
mkdir -p "$LOG_DIR" "$STAGING" "$DRIVE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

fail() {
  log "FAILED: $*"
  # Best-effort: a failure to report a failure must not mask the original one.
  echo "Backup failed at $(date). Reason: $*" > "$DRIVE_DIR/BACKUP-FAILED.txt" 2>/dev/null || true
  exit 1
}

log "starting"
rm -f "$DRIVE_DIR/BACKUP-FAILED.txt" 2>/dev/null || true

cd "$REPO" || fail "repo not found at $REPO"

# Fetch the production connection string at run time; never persisted.
DB_URL=$(railway variables --service Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
[ -n "$DB_URL" ] || fail "could not read DATABASE_PUBLIC_URL from Railway (is the CLI still logged in? run: railway login)"

DATABASE_URL="$DB_URL" pnpm --filter @phoneup/db backup "$STAGING" >> "$LOG" 2>&1 \
  || fail "pnpm backup exited non-zero — see $LOG"

# Staging is an ordinary directory, so this listing is reliable.
LATEST=$(ls -t "$STAGING"/*.dump 2>/dev/null | head -1)
[ -n "$LATEST" ] || fail "backup reported success but no .dump file appeared in $STAGING"
BASE=$(basename "$LATEST")
MANIFEST="${LATEST%.dump}.manifest.json"

cp "$LATEST" "$DRIVE_DIR/$BASE" || fail "could not copy $BASE into Drive"
[ -f "$MANIFEST" ] && cp "$MANIFEST" "$DRIVE_DIR/$(basename "$MANIFEST")"
log "copied $BASE ($(du -h "$LATEST" | cut -f1)) to Drive"

echo "$BASE" >> "$INDEX"

# Prune Drive by explicit path — the directory is never listed.
if [ "$(wc -l < "$INDEX")" -gt "$KEEP" ]; then
  head -n -"$KEEP" "$INDEX" | while read -r old; do
    [ -n "$old" ] || continue
    log "pruning $old from Drive"
    rm -f "$DRIVE_DIR/$old" "$DRIVE_DIR/${old%.dump}.manifest.json" 2>/dev/null || true
  done
  tail -n "$KEEP" "$INDEX" > "$INDEX.tmp" && mv "$INDEX.tmp" "$INDEX"
fi

# Prune staging the ordinary way.
ls -t "$STAGING"/*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "${old%.dump}.manifest.json"
done

log "done"
