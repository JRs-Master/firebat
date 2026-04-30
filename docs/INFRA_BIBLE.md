# FIREBAT INFRA BIBLE — 행동 대장 수칙

> 최종 개정: 2026-04-18 (v0.1)

## 전문(前文)

이 문서는 `infra/` 계층의 설계 및 행동 규격을 정의한다.
Infra는 Core의 순수성을 지키기 위해 물리적 세계(파일 시스템, 프로세스, 네트워크)와 직접 맞닿아 궂은일을 수행하는 **유일한 I/O 실행 계층**이다.

---

## 제1장: 절대 원칙

1. **독점적 I/O 권한**: `fs`, `child_process`, `fetch`, DB 라이브러리 등을 호출할 수 있는 유일한 계층.
2. **에러 캡슐화**: 모든 에러를 catch하여 `InfraResult` 객체로 Core에 반환. 절대 throw하지 않는다.
3. **Core 의존성 배제**: `core/ports/`의 인터페이스만 참조. Core 내부 로직을 import하지 않는다.
4. **설정 중앙 관리**: 모든 설정 상수는 `infra/config.ts`에서 관리 (환경변수 우선, 기본값 폴백).

---

## 제2장: 10개 어댑터 구현 규격

### 1. Storage Adapter (`infra/storage/`)
- `IStoragePort` 구현.
- **경로 탐색 공격 차단**: `isInsideZone` + `path.resolve` containment 체크.
- **쓰기 허용 구역**: `app/(user)/`, `user/`
- **읽기 허용 구역**: `app/(user)/`, `user/`, `docs/`, `system/modules/`, `system/services/`
- `listDir(path)`: `{name, isDirectory}[]` 반환.

### 2. Log Adapter (`infra/log/`)
- `ILogPort` 구현 (info/warn/error/debug 4레벨).
- 파일 로깅: `data/logs/app-YYYY-MM-DD.log` (일반) + `data/logs/training-YYYY-MM-DD.jsonl` (학습 데이터).
- `[USER_AI_TRAINING]`, `[CORE_AI_TRAINING]` 프리픽스 감지 시 JSONL 자동 분리 저장.

### 3. Sandbox Adapter (`infra/sandbox/`)
- `ISandboxPort` 구현.
- **경로 검증**: `canExecute` 메서드로 `user/modules/`, `system/modules/` 외 실행 차단.
- **언어 중립**: `.py`, `.js`, `.mjs`, `.php`, `.rs`, `.wasm`, `.sh` 지원.
- **config.json 선제 설치**: `packages` 필드 의존성을 실행 전 자동 설치.
- **시크릿 env 주입**: `secrets` 배열 → Vault에서 값 조회 → 환경변수로 전달.
- **타임아웃**: 30초 (`SANDBOX_TIMEOUT_MS`).
- **stdin/stdout**: `{ correlationId, data }` 주입 → 마지막 줄 단일 JSON 수신.
- **`__updateSecrets` 영속**: 모듈이 stdout JSON에 `__updateSecrets: {키:값}` 필드를 포함하면 sandbox가 Vault(`user:{키}`)에 자동 저장.
  - **엄격 검증**: 키는 대문자/숫자/언더스코어(`^[A-Z0-9_]+$`)만, 값은 string + 8KB 제한, **config.json `secrets` 배열에 선언된 이름만 허용** (오염 방지).
  - `tokenCache` 키와 일치하면 `ttlHours` 기반 `__expires` 자동 기록 (TTL 만료 후 자동 갱신 흐름에 연계).
  - 예: 카카오톡 모듈이 401 → refresh_token으로 갱신 → 새 `KAKAO_ACCESS_TOKEN`(+ rotating `KAKAO_REFRESH_TOKEN`)을 `__updateSecrets`로 반환 → Vault 영속 → 다음 실행 시 재사용.

### 4. LLM Adapter (`infra/llm/config-adapter.ts` + format handlers) — 2026-04-18 Config-driven 개편
- `ILlmPort` 구현은 **ConfigDrivenAdapter 단일**. 프로바이더별 개별 어댑터 금지.
- **Config 파일** (`infra/llm/configs/*.json`): 모델당 1개. 새 LLM 도입 시 JSON 추가만으로 확장.
  - 필수: `id`, `displayName`, `provider`, `format`, `endpoint`, `apiKeyVaultKey`.
  - 선택: `features` (mcpConnector/strictTools/reasoning/thinking/extendedThinking/toolSearch/promptCache24h 등), `pricing`, `extraHeaders`.
- **포맷 핸들러 8종** (`infra/llm/formats/*.ts`) — API 5 + CLI 3:
  | format | SDK / 실행 | 용도 |
  |---|---|---|
  | `openai-responses` | `openai` (`client.responses`) | OpenAI Responses API — GPT-5.4 (MCP connector, tool_search + defer_loading, previous_response_id, 24h cache, reasoning.effort) |
  | `anthropic-messages` | `@anthropic-ai/sdk` (`client.beta.messages`) | Claude 4 Messages API — MCP connector 2025-11-20 (`betas + mcp_toolset` 필수), extended thinking, max_tokens 32K, **prompt caching 토글** (`VK_LLM_ANTHROPIC_CACHE`, 기본 OFF — cache write 25% 비용 회피, 같은 prefix 5분 재호출 시 ON 권장) |
  | `gemini-native` | `@google/genai` (apiKey) | Gemini AI Studio — 네이티브 functionCall/functionResponse 멀티턴 (rawModelParts 보존) |
  | `vertex-gemini` | `@google/genai` (vertexai:true) | GCP Vertex AI — Service Account JSON + OAuth access token 자동 갱신 |
  | `openai-chat` | `openai` (`client.chat.completions`) | OpenAI Chat Completions 호환 (Ollama/OpenRouter/LM Studio 등 예비, 현재 등록 모델 없음) |
  | `cli-claude-code` | `claude` 자식 프로세스 | Claude Pro/Max 구독. `--print --output-format stream-json --verbose --allowed-tools 'mcp__firebat__*' --mcp-config <json> --effort <level>`. **Daemon 지원**: `conversationId` 있으면 `--input-format stream-json` 으로 대화당 프로세스 재사용 |
  | `cli-codex` | `codex exec` 자식 프로세스 | ChatGPT Plus/Pro 구독. 임시 `CODEX_HOME/config.toml` ([mcp_servers.firebat]) + env 주입, `--json --skip-git-repo-check --full-auto -c model_reasoning_effort="<level>"`. 이벤트: `thread.started` / `turn.{started,completed,failed}` / `item.{started,completed}.item.type:agent_message\|reasoning\|mcp_tool_call` |
  | `cli-gemini` | `gemini -p` 자식 프로세스 | Google AI Pro 구독. `workspace/.gemini/settings.json` (프로젝트 로컬 MCP, cwd 자동 로드) + `GEMINI.md` (시스템 프롬프트) + cwd 설정. `--output-format stream-json --approval-mode yolo`. **도구 이름 `mcp_firebat_` 접두사**. 이벤트: `init` / `message{role}` / `tool_use{tool_name,tool_id,parameters}` / `tool_result{tool_id,output}` / `result` |

- **CLI 세션 resume** (3사 공통):
  - DB: `conversations` 테이블 `cli_session_id`, `cli_model` 컬럼. 모델 변경 시 자동 무효화.
  - 플래그: Claude `--resume <uuid>`, Codex `exec resume <id>`, Gemini `--resume <uuid>`
  - resume 시 prompt 에 history 중복 주입 금지 (CLI 세션이 이미 보유)
- **CLI 통일 패턴** (Claude/Codex/Gemini 모두 동일 — 2026-04-30 daemon 폐기):
  - 매 turn cold spawn (자식 프로세스) + `--resume <session_id>` 로 컨텍스트 유지
  - DB cli_session_id 영속 → 다음 turn 시 CLI 가 이전 컨텍스트 보유
  - 이전 Claude 전용 daemon (LRU 5 + 30분 idle) 폐기 — 메모리 100-500MB + 코드 400줄 + key hash quirk vs spawn 5-10초 절약 trade-off 에서 단순함 우선
  - 매 turn 5-10초 spawn 오버헤드 추가 (LLM 응답 30-60초 → 체감 영향 작음)
- **ConfigDrivenAdapter**: `config.format` → 해당 FormatHandler에 위임. 각 핸들러는 `ask/askText/askWithTools` 시그니처 통일.
- **Lazy 인증**: API Key/Service Account는 resolver 함수로 첫 호출 시 로드. Vault 변경 시 WeakMap 캐시 무효화.
- **인증 분리**: API Key (OpenAI/Gemini/Anthropic) vs Service Account JSON (Vertex).
- **Gemini 공통 스키마 어댑터**: `enum`은 string 배열, `integer`/`number` + `enum` 조합 금지 (Gemini 제약 우회).
- **요청별 모델 오버라이드**: `LlmCallOpts.model`로 호출마다 config 재해석 — 같은 Adapter 인스턴스로 다중 프로바이더 커버.
- **스트리밍**: `onChunk` 콜백으로 thinking/text 청크 실시간 전달. SSE `chunk` 이벤트로 프론트엔드 전파.
- **Firebat 내부 도구 노출**:
  - GPT/Claude (MCP connector 지원): hosted MCP 서버 URL만 전달 → 프로바이더가 Firebat MCP 서버로 직접 접속.
  - Gemini/Vertex: function calling — `functionDeclarations` inline 전달.
- 타임아웃: 60초 (`LLM_TIMEOUT_MS`).

**원칙**: "어떤 LLM 선택해도 동작해야 하고 개별 어댑터를 만들면 안 된다" — 새 모델은 JSON 파일 하나 추가. 새 포맷(새 인증/엔드포인트 체계)만 새 handler 추가.

### 5. Network Adapter (`infra/network/`)
- `INetworkPort` 구현.
- `fetch` 래퍼. `127.0.0.1`, `localhost` 접근 차단 (SSRF 방어).

### 6. Cron Adapter (`infra/cron/`)
- `ICronPort` 구현.
- `node-cron` 기반 백그라운드 스케줄러.
- **싱글톤**: `globalThis` 캐싱 (Next.js 핫리로드 시 중복 방지).
- **영속 저장**: `data/cron-jobs.json`에 잡 설정 저장, PM2 재시작 시 자동 복원.
- **3가지 모드**: `cronTime`(반복), `runAt`(1회 예약), `delaySec`(N초 후 1회).
- **기간 한정**: `startAt`/`endAt`으로 반복 기간 제한, 만료 시 자동 해제.
- **동적 타임존**: Vault `system:timezone` 키로 저장, `setTimezone()`/`getTimezone()` 지원.
- **페이지 URL 스케줄링**: `targetPath.startsWith('/')` → notify 파일 → 클라이언트 폴링 → window.open.

### 7. Database Adapter (`infra/database/`)
- `IDatabasePort` 구현.
- `better-sqlite3` 기반 (`data/app.db`).
- 자동 초기화: `pages` / `conversations` / `conversation_embeddings` / `routing_cache` / `media_usage` / `shared_conversations` / `deleted_conversations` / `page_redirects` 테이블 `CREATE TABLE IF NOT EXISTS`.
- CRUD: `savePage`, `getPage`, `listPages`, `deletePage`, `listPagesByProject`, `deletePagesByProject`.
- **마이그레이션 runner** (`infra/database/migrations/`, v0.1 2026-04-26): `_db_version` 테이블이 스키마 버전 추적. 부팅 시 `migrations/NNN-name.sql` 파일 검색 → currentVersion 보다 큰 것만 트랜잭션 보호로 순차 적용. 일방향 (up only). 새 변경은 v2+ 부터 (v1 = implicit baseline = 위 CREATE 자동초기화). 자세한 안내: `infra/database/migrations/README.md`.

### 8. Vault Adapter (`infra/storage/vault-adapter.ts`)
- `IVaultPort` 구현.
- `better-sqlite3` 기반 (`data/vault.db`).
- API 키, 시크릿 등 민감한 값의 CRUD.
- `user:` 접두사로 사용자 시크릿과 시스템 키 분리.
- `listKeysByPrefix(prefix)`: 특정 접두사의 키 목록 반환.
- 시스템 모듈 설정: `system:module:<name>:settings` 키에 JSON 저장.

### 9. MCP Client Adapter (`infra/mcp-client/`)
- `IMcpClientPort` 구현.
- 외부 MCP 서버(Gmail, Slack 등) 접속 및 도구 호출.
- **전송 방식**: stdio (로컬 프로세스) + Streamable HTTP (원격 서버).
- **영속 저장**: `data/mcp-servers.json`.
- `addServer`/`removeServer`/`listTools`/`callTool`/`listAllTools`/`disconnectAll`.

### 10. Auth Adapter (`infra/auth/`)
- `IAuthPort` 구현 (VaultAuthAdapter).
- Vault 기반 세션 저장: `auth:session:{token}` 키에 AuthSession JSON 저장.
- 세션/API 토큰 CRUD: `saveSession`/`getSession`/`deleteSession`/`listSessions`/`deleteSessions`.
- 만료 검사 포함: `getSession()` 호출 시 `expiresAt` 체크, 만료 시 자동 삭제.

---

## 제3장: 부트스트랩

### 제1항. 어댑터 조립 (`infra/boot.ts`)
`getInfra()` 함수가 10개 어댑터를 1회 조립하여 `globalThis`에 캐시한다.
LLM 어댑터는 resolver 함수를 받아 lazy 초기화 (API 키 미설정 상태에서도 부팅 가능).

### 제2항. 서버 초기화
- `instrumentation.ts`: `NEXT_RUNTIME === 'nodejs'` 조건 하에 `instrumentation.node.ts` 동적 import.
- `instrumentation.node.ts`: Python/playwright 등 시스템 런타임 의존성 백그라운드 설치.

### 제3항. 설정 상수 (`infra/config.ts`)
| 상수 | 기본값 | 설명 |
|---|---|---|
| `DATA_DIR` | `data` | 데이터 저장 경로 |
| `DB_PATH` | `data/app.db` | SQLite DB 경로 |
| `DEFAULT_MODEL` | `gemini-3-flash-preview` | 기본 LLM 모델 |
| `LLM_TIMEOUT_MS` | `60000` | LLM 타임아웃 |
| `SANDBOX_TIMEOUT_MS` | `30000` | 샌드박스 타임아웃 |
| `CRON_DEFAULT_TIMEZONE` | `Asia/Seoul` | 기본 타임존 |
| `BASE_URL` | `http://localhost:3000` | SEO/OG 외부 노출 도메인. `NEXT_PUBLIC_BASE_URL` env 또는 `lib/base-url.ts` `getBaseUrl(req)` 로 요청 host 자동 감지 가능 |

---

## 제4장: Primary Adapter 규약 (app/api/)

1. **직접 I/O 금지**: `app/api/`에서 `fs`, `child_process`, `fetch`, LLM SDK를 직접 호출하지 않는다.
2. **Core Singleton 경유**: `getCore()`를 통해 싱글톤 Core를 획득하고, Core 메서드를 호출한다.
3. **예외**: 인증(`/api/auth`)은 부트스트랩 영역으로 Core 경유 대상에서 제외.
4. **인증 자격증명**: `FIREBAT_ADMIN_ID` / `FIREBAT_ADMIN_PASSWORD` 환경변수 (미설정 시 `admin`/`admin` 폴백).

---

## 제5장: 마이그레이션 로드맵 (v2.0)

현재 `infra/` 내에 직접 존재하는 어댑터를 `system/modules/`로 이전 예정.

| 현재 위치 | 마이그레이션 대상 |
|---|---|
| `infra/storage/` | `system/modules/local-storage/` |
| `infra/llm/` | `system/modules/vertex-llm/` |
| `infra/sandbox/` | `system/modules/process-sandbox/` |
| `infra/log/` | `system/modules/file-logger/` |
| `infra/network/` | `system/modules/fetch-network/` |
| `infra/cron/` | `system/modules/node-cron/` |
| `infra/database/` | `system/modules/sqlite-db/` |
| `infra/storage/vault-adapter.ts` | `system/modules/sqlite-vault/` |
| `infra/mcp-client/` | `system/modules/mcp-client/` |

마이그레이션 완료 후 `infra/`에는 부트 로더(`boot.ts`)와 설정(`config.ts`)만 남는다.
