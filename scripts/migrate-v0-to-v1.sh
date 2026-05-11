#!/bin/bash
# Firebat v0.1 (systemd 운영) → v1.0 (Docker compose 운영) 자동 마이그레이션.
#
# 사용법:
#   cd /opt/firebat && sudo ./scripts/migrate-v0-to-v1.sh
#
# 동작 순서:
#   1. 옛 systemd unit 중지 (firebat / firebat-frontend)
#   2. 옛 데이터 백업 (/opt/firebat-backup-<timestamp>)
#   3. data / user / system 디렉토리 권한 (Docker UID 1000)
#   4. Caddyfile 확인 (도메인 / 이메일 치환 안 됐으면 경고)
#   5. docker compose build + up
#   6. firebat-core health check (~30초)
#   7. 결과 보고

set -e
set -o pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[migrate]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
fail() { echo -e "${RED}[fail]${NC} $1"; exit 1; }

# ── 0. 사전 점검 ──
[ "$EUID" -ne 0 ] && fail "root 권한 필요 — sudo 으로 실행"
[ ! -f "docker-compose.yml" ] && fail "현재 디렉토리에 docker-compose.yml 없음. firebat 소스 루트에서 실행"
command -v docker >/dev/null 2>&1 || fail "docker 미설치. https://docs.docker.com/engine/install/ 참고"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin 미설치"

# ── 1. 옛 운영 중지 ──
log "옛 systemd 운영 중지 (firebat / firebat-frontend)"
systemctl stop firebat firebat-frontend 2>/dev/null || warn "옛 systemd unit 없음 (신규 설치)"
systemctl disable firebat firebat-frontend 2>/dev/null || true

# ── 2. 옛 데이터 백업 ──
TS=$(date +%Y%m%d-%H%M%S)
BACKUP="/opt/firebat-backup-$TS"
log "옛 데이터 백업 → $BACKUP"
mkdir -p "$BACKUP"
[ -d "./data" ] && cp -a ./data "$BACKUP/" && log "data 백업 완료"
[ -d "./user" ] && cp -a ./user "$BACKUP/" && log "user 백업 완료"
[ -d "./system/media" ] && mkdir -p "$BACKUP/system" && cp -a ./system/media "$BACKUP/system/" && log "system/media 백업 완료"

# ── 3. 디렉토리 권한 ──
log "디렉토리 권한 설정 (Docker UID 1000)"
mkdir -p ./data ./user/media ./user/attachments ./system/media ./data/logs/caddy
chown -R 1000:1000 ./data ./user 2>/dev/null || warn "chown 실패 — Docker 컨테이너 안 권한 문제 가능"

# ── 4. Caddyfile 검증 ──
if [ -f "./caddy/Caddyfile" ]; then
  if grep -q "YOUR_DOMAIN_HERE\|YOUR_EMAIL_HERE" ./caddy/Caddyfile; then
    warn "caddy/Caddyfile 의 YOUR_DOMAIN_HERE / YOUR_EMAIL_HERE 가 치환 안 됨"
    warn "  TLS 발급 안 되므로 Caddy 시작 전 도메인 / 이메일 치환 필요"
    warn "  계속 진행하려면 enter, 중단하려면 Ctrl-C"
    read -r _
  fi
else
  warn "caddy/Caddyfile 없음 — Caddy 컨테이너 시작 안 됨"
fi

# ── 5. Docker build + up ──
log "docker compose build (5~10분 소요, Rust 빌드 + Python pip + playwright chromium)"
docker compose build 2>&1 | tail -20

log "docker compose up -d"
docker compose up -d

# ── 6. firebat-core health check ──
log "firebat-core health check (~30초)"
sleep 5
for i in 1 2 3 4 5 6; do
  if docker compose ps firebat-core --format json 2>/dev/null | grep -q '"Health":"healthy"\|"State":"running"'; then
    log "firebat-core 정상 기동 ✓"
    break
  fi
  [ "$i" = "6" ] && fail "firebat-core health check 타임아웃. docker compose logs firebat-core 확인"
  sleep 5
done

# ── 7. 결과 보고 ──
echo ""
log "마이그레이션 완료 ✓"
echo ""
echo "  백업 위치 : $BACKUP"
echo "  로그 확인 : docker compose logs -f firebat-core"
echo "             docker compose logs -f firebat-renderer"
echo "  중지     : docker compose down"
echo "  재시작   : docker compose restart"
echo ""
echo "  검증 체크리스트:"
echo "    1. 웹 접속 (https://YOUR_DOMAIN) — 로그인 화면"
echo "    2. 채팅 호출 — sysmod 도구 (yfinance / 한투 / 키움) 정상 응답"
echo "    3. cron 잡 자동 실행 — 어드민 → 일정 탭"
echo "    4. 에러 7일 무사고 후 백업 디렉토리 삭제 가능"
