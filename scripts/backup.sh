#!/usr/bin/env bash
#
# Firebat 백업 스크립트.
#
# 백업 대상:
#   - data/*.db        SQLite (.backup 명령으로 WAL 안전 백업)
#   - data/*.json      cron jobs / cron logs / mcp servers / plan store 등
#   - user/media/      AI 생성 이미지·업로드 이미지
#   - user/modules/    사용자 모듈
#   - system/media/    시스템 이미지 (있으면)
#
# 사용:
#   ./scripts/backup.sh                     # data/backups/firebat-YYYYMMDD-HHMMSS.tar.gz
#   ./scripts/backup.sh /custom/path        # 지정 디렉토리에 저장
#
# Cron 등록 예 (매일 새벽 3시):
#   0 3 * * * cd /var/www/firebat && ./scripts/backup.sh >> data/logs/backup.log 2>&1
#
# 보관 정책:
#   기본 30일 (BACKUP_RETENTION_DAYS env 로 override).
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

DEST_DIR="${1:-data/backups}"
mkdir -p "$DEST_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[backup] 시작: $TS"
echo "[backup] 대상 디렉토리: $ROOT_DIR"

# ── 1) SQLite WAL 안전 백업 ─────────────────────────────────────────
# better-sqlite3 와 호환되는 sqlite3 CLI 의 .backup 명령은
# WAL/SHM 동기화 후 단일 .db 파일로 출력. 동시 쓰기 중에도 안전.
if command -v sqlite3 >/dev/null 2>&1; then
  for db_file in data/*.db; do
    [ -f "$db_file" ] || continue
    name="$(basename "$db_file")"
    sqlite3 "$db_file" ".backup '$TMP_DIR/$name'"
    echo "[backup] SQLite: $name (WAL safe)"
  done
else
  echo "[backup] sqlite3 CLI 없음 — 단순 cp 모드 (WAL 데이터 누락 가능)"
  cp data/*.db "$TMP_DIR/" 2>/dev/null || true
fi

# ── 2) JSON 영속 파일 ───────────────────────────────────────────────
mkdir -p "$TMP_DIR/json"
for f in data/*.json; do
  [ -f "$f" ] || continue
  cp "$f" "$TMP_DIR/json/"
done

# ── 3) 미디어 + 사용자 모듈 ─────────────────────────────────────────
[ -d user/media   ] && cp -r user/media   "$TMP_DIR/" || true
[ -d user/modules ] && cp -r user/modules "$TMP_DIR/" || true
[ -d system/media ] && cp -r system/media "$TMP_DIR/" || true

# ── 4) tar.gz 생성 ─────────────────────────────────────────────────
ARCHIVE="$DEST_DIR/firebat-$TS.tar.gz"
tar -czf "$ARCHIVE" -C "$TMP_DIR" .
SIZE_MB=$(du -m "$ARCHIVE" | cut -f1)
echo "[backup] 완료: $ARCHIVE (${SIZE_MB}MB)"

# ── 5) 보관 정책 — 오래된 백업 자동 삭제 ─────────────────────────────
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
find "$DEST_DIR" -name 'firebat-*.tar.gz' -type f -mtime +"$RETENTION" -print -delete | sed 's/^/[backup] 삭제: /'

echo "[backup] 끝"
