#!/usr/bin/env bash
#
# Firebat 복구 스크립트.
#
# 사용:
#   ./scripts/restore.sh data/backups/firebat-20260415-030000.tar.gz
#
# 복구 흐름:
#   1) systemd 서비스 중지 (있으면).
#   2) 기존 data/*.db, data/*.json, user/media, user/modules, system/media 백업 (data/restore-backup-<ts>/ 로 이동).
#   3) tar.gz 해제 → 원위치 복원.
#   4) systemd 서비스 재시작.
#
# 주의: 복구 전 항상 현재 상태가 자동 백업됨 (실수 복구 가능).
#
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "사용법: $0 <backup-file.tar.gz>"
  exit 1
fi

ARCHIVE="$1"
if [ ! -f "$ARCHIVE" ]; then
  echo "[restore] 파일 없음: $ARCHIVE"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
SAFE_DIR="data/restore-backup-$TS"

echo "[restore] 시작: $ARCHIVE"
echo "[restore] 안전 백업: $SAFE_DIR (롤백용)"
mkdir -p "$SAFE_DIR"

# 1) systemd 중지 (있으면)
if command -v systemctl >/dev/null 2>&1; then
  echo "[restore] systemd firebat / firebat-frontend 중지"
  systemctl stop firebat firebat-frontend 2>/dev/null || true
fi

# 2) 기존 상태 보존
for f in data/*.db data/*.json; do
  [ -f "$f" ] || continue
  cp "$f" "$SAFE_DIR/" 2>/dev/null || true
done
[ -d user/media   ] && mv user/media   "$SAFE_DIR/user-media"   || true
[ -d user/modules ] && mv user/modules "$SAFE_DIR/user-modules" || true
[ -d system/media ] && mv system/media "$SAFE_DIR/system-media" || true

# 3) 복원
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP_DIR"

# .db 파일들 — 백업이 sqlite3 .backup 으로 만든 단일 .db 라 그대로 복사
for db_file in "$TMP_DIR"/*.db; do
  [ -f "$db_file" ] || continue
  cp "$db_file" data/
  echo "[restore] DB: $(basename "$db_file")"
done

# json 파일들
if [ -d "$TMP_DIR/json" ]; then
  cp "$TMP_DIR/json/"* data/ 2>/dev/null || true
fi

# 미디어 / 모듈
[ -d "$TMP_DIR/media" ]   && mkdir -p user && cp -r "$TMP_DIR/media"   user/    || true
[ -d "$TMP_DIR/modules" ] && mkdir -p user && cp -r "$TMP_DIR/modules" user/    || true

# 4) 재시작
if command -v systemctl >/dev/null 2>&1; then
  echo "[restore] systemd 재시작 (firebat + firebat-frontend)"
  systemctl restart firebat 2>/dev/null || true
  systemctl restart firebat-frontend 2>/dev/null || true
fi

echo "[restore] 완료. 롤백 필요 시: $SAFE_DIR 에서 수동 복원."
