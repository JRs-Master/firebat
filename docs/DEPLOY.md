# Firebat v1.0 Final — self-hosted Docker 배포 가이드

Phase C 박힘 (2026-05-04). Rust Core + (옵션) Next.js renderer + nginx TLS.

## 시스템 요구사항

- **OS**: Ubuntu 24.04 LTS / 26.04 / Debian 12+ / Alpine 3.20+
- **CPU**: 2 vCPU+ (Rust 빌드 시점만 무거움. runtime 은 ~100MB RAM)
- **RAM**: 1GB+ (CLI 모드 LLM daemon 동시 실행 시 2GB 권장)
- **Disk**: 5GB+ (DB / 미디어 / 로그)
- **Docker**: 24.0+ (compose v2 plugin 포함)
- **포트**: 80/443 (nginx), 50051 (Core gRPC, 외부 노출 X)

## 처음 배포

```bash
# 1. 코드 clone
git clone https://github.com/JRs-Master/firebat.git /opt/firebat
cd /opt/firebat

# 2. 데이터 디렉토리 권한 (Docker 사용자 1000:1000)
mkdir -p data user/media system/media
sudo chown -R 1000:1000 data user system

# 3. nginx 설정 (실 도메인 운영 시)
cp nginx/firebat.conf.example nginx/firebat.conf
# firebat.conf 안 server_name / ssl cert path 수정

# 4. SSL cert (Let's Encrypt)
# certbot --nginx -d firebat.co.kr -d www.firebat.co.kr
# 또는 Cloudflare Origin Cert 사용 — /etc/nginx/certs/ 에 fullchain.pem + privkey.pem 박음

# 5. docker-compose.yml 의 renderer / nginx 주석 해제 (옵션)

# 6. 빌드 + 실행 (첫 빌드 ~5-8분 — Rust 정적 링크 + 모든 deps 컴파일)
docker compose up -d --build

# 7. 로그 확인
docker compose logs -f firebat-core
```

## 옛 firebat.co.kr → 새 서버 cutover

옛 Node 서버에서 새 Rust + Docker 서버로 무손실 이전. **AdSense 진행 중인 글 안 잃음** —
도메인 / sitemap URL / 페이지 slug 모두 그대로.

```bash
# 1. 옛 서버에서 PM2 stop
ssh root@firebat "pm2 stop firebat"

# 2. 데이터 통째 rsync (DB + 미디어 + cron 영속)
rsync -av --progress \
  root@firebat:/root/firebat/data/ \
  /opt/firebat/data/

rsync -av --progress \
  root@firebat:/root/firebat/user/ \
  /opt/firebat/user/

rsync -av --progress \
  root@firebat:/root/firebat/system/media/ \
  /opt/firebat/system/media/

# 3. 권한 (Docker 사용자)
sudo chown -R 1000:1000 /opt/firebat/{data,user,system}

# 4. Rust Core 부팅 → 자동 인식 (cron 영속 복원 / pages list / vault 시크릿 모두 호환)
docker compose up -d --build

# 5. health 검증
curl http://localhost:50051  # gRPC reflect 또는 grpc_health_probe
docker compose logs --tail=50 firebat-core | grep "Firebat Core v"

# 6. cron 잡 복원 검증
docker compose exec firebat-core sh -c \
  'grpcurl -plaintext localhost:50051 firebat.v1.ScheduleService/ListCron'

# 7. DNS A 레코드 새 서버 IP 로 변경 (Vultr / Cloudflare 패널)
# 8. propagation 5~30분 대기. 옛 서버는 1주 정도 보존 후 종료.
```

## 호환성 검증

옛 TS Core 와 새 Rust Core 의 데이터 포맷 1:1:

| 데이터 | 위치 | 호환 |
|---|---|---|
| Pages (글) | `data/app.db` (pages 테이블) | ✓ schema 동일 |
| Conversations (대화) | `data/app.db` (conversations 테이블) | ✓ schema 동일 |
| Cron 잡 영속 | `data/cron-jobs.json` | ✓ serde JSON 1:1 |
| Cron 로그 | `data/cron-logs.json` | ✓ |
| Vault 시크릿 | `data/vault.db` | ✓ schema 동일 |
| 미디어 파일 | `user/media/*.{ext,meta.json}` | ✓ |
| MCP 서버 등록 | `data/mcp-servers.json` | ✓ |

## 환경 변수 (docker-compose.yml override 가능)

```yaml
environment:
  FIREBAT_WORKSPACE_ROOT: /opt/firebat        # workspace root
  FIREBAT_CORE_LISTEN: 0.0.0.0:50051          # gRPC bind
  FIREBAT_TIMEZONE: Asia/Seoul                # cron / 페이지 발행 시각
  FIREBAT_DEFAULT_MODEL: claude-4-sonnet      # LLM 기본 모델
  FIREBAT_VAULT_DB: /opt/firebat/data/vault.db
  FIREBAT_APP_DB: /opt/firebat/data/app.db
  FIREBAT_MEMORY_DB: /opt/firebat/data/memory.db
  FIREBAT_CRON_JOBS: /opt/firebat/data/cron-jobs.json
  FIREBAT_MCP_SERVERS: /opt/firebat/data/mcp-servers.json
  RUST_LOG: info                               # debug / warn / error 도 가능
  RUST_BACKTRACE: 1                            # 패닉 시 스택 트레이스
```

## API 키 박기

LLM 호출은 Vault 에 API 키 박혀있어야 활성 (없으면 핸들러가 명시 에러 반환):

```bash
# Anthropic Claude
docker compose exec firebat-core sh -c \
  'echo "your-api-key" | grpcurl -plaintext -d @ localhost:50051 \
   firebat.v1.SecretService/SetUser \
   -d '"'"'{"key": "system:anthropic:api-key", "value": "sk-ant-..."}'"'"

# 또는 어드민 설정 모달에서 GUI 박음 (Phase B-17.5+ 활성)
```

빌트인 모델 carousel (Vault 키 박으면 활성):
- `claude-4-sonnet` ← `system:anthropic:api-key`
- `gpt-5` ← `system:openai:api-key`
- `gemini-3-pro` ← `system:gemini:api-key`
- `vertex-gemini-3-pro` ← `system:vertex:service-account-json`
- `cli-claude-code` / `cli-codex` / `cli-gemini` (구독 — API 키 불필요, 호스트에서 OAuth 로그인 1번)

## graceful shutdown

```bash
docker compose down              # SIGTERM → 30초 대기 → SIGKILL
# Phase B-17b 박힘 — SIGINT (ctrl+c) + SIGTERM 둘 다 listen, SQLite WAL 손상 방어.
```

## 백업 / 복구

```bash
# 백업 (cron 으로 매일 1회)
tar czf /backup/firebat-$(date +%F).tar.gz \
  /opt/firebat/data \
  /opt/firebat/user \
  /opt/firebat/system

# 복구
docker compose down
tar xzf /backup/firebat-2026-05-04.tar.gz -C /
docker compose up -d
```

## 빌드 시간 단축

첫 빌드 5~8분. 이후 incremental build 는 1-2분 (Cargo.toml 변경 없으면 deps 캐시 재사용).
CI/CD 에서 layer 캐시 활성화 권장:

```yaml
# .github/workflows/build.yml 등
- uses: docker/build-push-action@v5
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

## 트러블슈팅

- **포트 50051 충돌**: 다른 컨테이너가 점유. `lsof -i :50051` 후 종료.
- **권한 에러 (data dir)**: `sudo chown -R 1000:1000 /opt/firebat/{data,user,system}`
- **빌드 OOM**: 메모리 1GB 이하 VPS. Cargo profile dev 로 빌드 후 swap 박기 또는 외부 빌드 서버 사용.
- **SQLite locked**: 옛 서버 PM2 안 멈췄거나 다른 process 가 잡고 있음. `lsof data/app.db`.
- **grpc 호출 안 받음**: nginx 가 외부에 50051 노출 시 차단. `127.0.0.1:50051` 만 매핑 필수.

## 성능

- **메모리**: ~100MB idle. CLI daemon 활성 시 +200~500MB per daemon.
- **부팅**: ~3초 (DB open + cron 영속 복원 + gRPC bind).
- **gRPC throughput**: ~10K req/s (1 vCPU, in-process Mutex<Connection>).
- **graceful shutdown**: ~5-10초 (활성 cron 잡 / LLM 호출 완료 대기).
