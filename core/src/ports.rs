//! Hexagonal Architecture — Port (interface) 정의.
//!
//! Core 매니저는 이 trait 만 의존. 실 I/O 는 adapters/ 의 구현체가 담당.
//! BIBLE 의 "Core 순수성" 원칙 그대로 — 매니저가 fs / network / DB 직접 사용 X.
//!
//! Phase B 진행하며 17 포트 설정:
//!   IStoragePort / IVaultPort / IDatabasePort / ICronPort / ILlmPort / ISandboxPort /
//!   ILogPort / INetworkPort / IMcpClientPort / IAuthPort / IEmbedderPort /
//!   IToolRouterPort / IMediaPort / IImageProcessorPort / IImageGenPort /
//!   IEntityPort / IEpisodicPort

/// Infra layer 표준 결과 — InfraResult<T>. 옛 TS 의 패턴 그대로.
/// success=false 시 error 메시지. throw 안 함 (Infra 의 throw 금지 BIBLE 원칙).
pub type InfraResult<T> = Result<T, String>;

/// 디렉토리 entry — listDir / listFiles 결과.
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub is_directory: bool,
}

/// 바이너리 파일 read 결과 — base64 + mime + size. 옛 TS readBinary 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryReadResult {
    pub base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub size: usize,
}

/// grep 매치 1건 — file:line:text. 옛 TS grep 결과 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    pub file: String,
    pub line: usize,
    pub text: String,
}

/// grep 옵션 — path 안에서 검색, fileType 으로 확장자 필터, limit / ignoreCase 옵션.
#[derive(Debug, Clone, Default)]
pub struct GrepOpts<'a> {
    pub path: Option<&'a str>,
    pub file_type: Option<&'a str>,
    pub limit: Option<usize>,
    pub ignore_case: bool,
}

/// IStoragePort — 파일 시스템 접근. workspace zone 격리 (path traversal 차단).
///
/// Phase B-19 확장 — 옛 TS storage adapter 6개 메서드 추가:
/// - `read_binary` — 미디어 binary read (base64 + mime + size)
/// - `list` — 파일 이름만 (디렉토리 제외, list_dir 와 다름)
/// - `glob` — 패턴 매칭 (Node 24 fs.glob 1:1)
/// - `grep` — 콘텐츠 검색 (ripgrep 동등)
/// - `write_cache` / `delete_cache` — sysmod 결과 cache pattern (Core 만 호출)
#[async_trait::async_trait]
pub trait IStoragePort: Send + Sync {
    /// 텍스트 파일 read (UTF-8).
    async fn read(&self, path: &str) -> InfraResult<String>;

    /// 바이너리 파일 read — base64 인코딩 + mimeType (확장자 추론) + size.
    /// 옛 TS readBinary 1:1.
    async fn read_binary(&self, path: &str) -> InfraResult<BinaryReadResult>;

    /// 텍스트 파일 write — 디렉토리 자동 생성 (mkdir -p).
    async fn write(&self, path: &str, content: &str) -> InfraResult<()>;

    /// Internal cache write — Core.cacheData 만 호출. AI 도구 우회 차단.
    /// data/cache/ 안에 설정. 옛 TS writeCache 1:1.
    async fn write_cache(&self, path: &str, content: &str) -> InfraResult<()>;

    /// 파일 또는 디렉토리 delete (recursive).
    async fn delete(&self, path: &str) -> InfraResult<()>;

    /// Internal cache delete — Core.cacheDrop 만 호출. 옛 TS deleteCache 1:1.
    async fn delete_cache(&self, path: &str) -> InfraResult<()>;

    /// 디렉토리 안 파일 이름만 나열 (디렉토리 제외). 옛 TS list 1:1.
    /// list_dir 과 다름 — list_dir 은 (name, is_directory) 페어, list 는 이름만.
    async fn list(&self, path: &str) -> InfraResult<Vec<String>>;

    /// 디렉토리 안 entry 나열 — name + is_directory 페어.
    async fn list_dir(&self, path: &str) -> InfraResult<Vec<DirEntry>>;

    /// glob 패턴 매칭 — `**/*.ts` 같은 패턴으로 파일 검색. 옛 TS glob 1:1.
    /// limit 미지정 시 default 1000 (대용량 보호).
    async fn glob(&self, pattern: &str, limit: Option<usize>) -> InfraResult<Vec<String>>;

    /// 콘텐츠 grep — pattern (regex) 으로 파일 텍스트 검색. 옛 TS grep 1:1.
    async fn grep(
        &self,
        pattern: &str,
        opts: &GrepOpts<'_>,
    ) -> InfraResult<Vec<GrepMatch>>;

    /// 파일 존재 여부.
    async fn exists(&self, path: &str) -> bool;
}

/// IVaultPort — 시크릿 저장. SQLite key/value (옛 TS 의 VaultAdapter Rust 재구현).
///
/// Throw 안 함 (BIBLE 의 Infra throw 금지). 실패 시 false / None 반환.
/// 동기 인터페이스 — rusqlite 가 sync, async wrapping 비용보다 직접 호출이 효율.
pub trait IVaultPort: Send + Sync {
    fn get_secret(&self, key: &str) -> Option<String>;
    fn set_secret(&self, key: &str, value: &str) -> bool;
    fn delete_secret(&self, key: &str) -> bool;
    fn list_keys(&self) -> Vec<String>;
    fn list_keys_by_prefix(&self, prefix: &str) -> Vec<String>;
}

// ──────────────────────────────────────────────────────────────────────────
// Auth — 통합 세션 (session + api 토큰)
// ──────────────────────────────────────────────────────────────────────────

/// AuthSession — 세션 토큰 (24시간 만료) + API 토큰 (만료 없음) 통합 모델.
/// type='session' = 어드민 로그인 / type='api' = MCP 등 외부 사용.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub token: String,
    #[serde(rename = "type")]
    pub session_type: SessionType,
    pub role: SessionRole,
    pub created_at: i64,           // unix ms
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,   // None = 영구 (api 토큰)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Session,
    Api,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionRole {
    Admin,
}

/// IAuthPort — 세션 저장 (Vault 위에 설정). 동기 — Vault 와 동일.
pub trait IAuthPort: Send + Sync {
    fn save_session(&self, session: &AuthSession) -> bool;
    /// 만료 검사 후 반환 — 만료된 세션 자동 삭제.
    fn get_session(&self, token: &str) -> Option<AuthSession>;
    fn delete_session(&self, token: &str) -> bool;
    /// 특정 type 의 모든 세션 — 만료된 세션 자동 정리 후 반환 (lazy sweep).
    fn list_sessions(&self, session_type: SessionType) -> Vec<AuthSession>;
    /// 특정 type 의 모든 세션 일괄 삭제 — 갯수 반환.
    fn delete_sessions(&self, session_type: SessionType) -> usize;
}

// ──────────────────────────────────────────────────────────────────────────
// Log
// ──────────────────────────────────────────────────────────────────────────

/// ILogPort — 옛 TS 의 ILogPort 4 레벨 (info/warn/error/debug) Rust port.
/// Core 매니저는 stdout/stderr 직접 사용 X. ILogPort 만 거침 (Hexagonal).
pub trait ILogPort: Send + Sync {
    fn info(&self, msg: &str);
    fn warn(&self, msg: &str);
    fn error(&self, msg: &str);
    fn debug(&self, msg: &str);

    /// category 명시 로그 — admin 로그 탭 / sqlite 필터용. 기존 4 메서드는 category 없이
    /// 호출되므로, 카테고리를 붙이고 싶은 매니저는 CategoryLogger 로 감싸 이 메서드로 라우팅한다.
    /// default 구현은 category 를 무시하고 level 별 기존 메서드로 위임 (하위 호환).
    fn log_with(&self, _category: &str, level: &str, msg: &str) {
        match level {
            "warn" => self.warn(msg),
            "error" => self.error(msg),
            "debug" => self.debug(msg),
            _ => self.info(msg),
        }
    }
}

/// 알림 우선순위 — adapter 가 채널 선택 / 무음 시간 / rate-limit 결정에 활용.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum NotifyLevel {
    /// 일반 정보 — 운영 통계 / 배치 완료 등.
    Info,
    /// 주의 — brute force 시도 / 일시 lock / 자동 재시도 발생 등.
    Warn,
    /// 즉시 대응 필요 — 시스템 다운 / 보안 사건 / 비용 한도 초과 등.
    Critical,
}

/// INotifierPort — 외부 알림 채널 추상화 (Telegram / Discord / Email / Slack 등).
/// Hexagonal — 매니저는 알림 채널 직접 호출 X. 이 trait 만 통과.
/// Adapter 가 자체 toggle / rate-limit / 채널 선택 책임. 호출 측은 fire-and-forget.
#[async_trait::async_trait]
pub trait INotifierPort: Send + Sync {
    /// 알림 발송 시도. adapter 자체 toggle 검사 후 실 발송. 실패 silent (운영 차단 X).
    async fn notify(&self, level: NotifyLevel, title: &str, message: &str);
}

// ──────────────────────────────────────────────────────────────────────────
// Database — pages / conversations 등 SQL 저장
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageListItem {
    pub slug: String,
    pub status: String,
    pub project: Option<String>,
    pub visibility: Option<String>,
    pub title: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "featuredImage", skip_serializing_if = "Option::is_none")]
    pub featured_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRecord {
    pub slug: String,
    pub spec: String, // JSON-stringified PageSpec
    pub status: String,
    pub project: Option<String>,
    pub visibility: Option<String>,
    pub password: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUsageEntry {
    #[serde(rename = "pageSlug")]
    pub page_slug: String,
    #[serde(rename = "usedAt")]
    pub used_at: i64,
}

/// IDatabasePort — pages / conversations 등 SQL CRUD 통합 port.
/// 동기 — rusqlite 가 sync, 단순함 우선. 매니저는 tokio task 로 wrap 가능.
pub trait IDatabasePort: Send + Sync {
    // Pages
    fn list_pages(&self) -> Vec<PageListItem>;
    fn list_pages_by_project(&self, project: &str) -> Vec<String>;
    fn get_page(&self, slug: &str) -> Option<PageRecord>;
    fn save_page(
        &self,
        slug: &str,
        spec: &str,
        status: &str,
        project: Option<&str>,
        visibility: Option<&str>,
        password: Option<&str>,
    ) -> bool;
    fn delete_page(&self, slug: &str) -> bool;
    fn delete_pages_by_project(&self, project: &str) -> Vec<String>;
    fn search_pages(&self, query: &str, limit: usize) -> Vec<PageListItem>;
    fn set_page_visibility(&self, slug: &str, visibility: &str, password: Option<&str>) -> bool;
    fn verify_page_password(&self, slug: &str, password: &str) -> bool;

    // Page redirects
    fn upsert_page_redirect(&self, from_slug: &str, to_slug: &str) -> bool;
    fn get_page_redirect(&self, from_slug: &str) -> Option<String>;

    // Media usage
    fn replace_media_usage(&self, page_slug: &str, media_slugs: &[String]) -> bool;
    fn delete_media_usage_for_page(&self, page_slug: &str) -> bool;
    fn find_media_usage(&self, media_slug: &str) -> Vec<MediaUsageEntry>;

    // Conversations
    fn list_conversations(&self, owner: &str) -> Vec<ConversationSummary>;
    fn get_conversation(&self, owner: &str, id: &str) -> Option<ConversationRecord>;
    fn save_conversation(
        &self,
        owner: &str,
        id: &str,
        title: &str,
        messages_json: &str,
        created_at: Option<i64>,
    ) -> bool;
    /// 삭제 — soft delete. conversations.deleted_at 설정 + tombstone 기록.
    /// 30일 후 cleanup_old_deleted 가 cascade hard delete.
    fn delete_conversation(&self, owner: &str, id: &str) -> bool;
    fn is_conversation_deleted(&self, owner: &str, id: &str) -> bool;
    /// 휴지통 목록 — deleted_at IS NOT NULL 인 conversations. 최신 삭제 순.
    fn list_deleted_conversations(&self, owner: &str) -> Vec<ConversationSummary>;
    /// 휴지통에서 복원 — deleted_at NULL 설정. tombstone 도 제거 (다기기 동기화).
    fn restore_conversation(&self, owner: &str, id: &str) -> bool;
    /// 영구 삭제 — row 자체 + 임베딩 cascade. tombstone 은 그대로 유지 (다기기 stale POST 차단).
    fn permanent_delete_conversation(&self, owner: &str, id: &str) -> bool;
    /// 30일 retention cleanup — `cutoff_ms` 보다 이전에 삭제된 거 일괄 hard delete.
    /// 응답: 삭제된 conversation 개수.
    fn cleanup_old_deleted_conversations(&self, cutoff_ms: i64) -> i64;
    fn get_cli_session(&self, conversation_id: &str, current_model: &str) -> Option<String>;
    fn set_cli_session(&self, conversation_id: &str, session_id: &str, model: &str) -> bool;
    fn get_active_plan_state(&self, conversation_id: &str) -> Option<String>;
    fn set_active_plan_state(&self, conversation_id: &str, state: Option<&str>) -> bool;

    // Conversation embeddings — 메시지 단위 벡터 (search_history cosine 검색용).
    // 옛 TS infra/database/index.ts 의 conversation_embeddings 테이블 1:1 port.

    /// 특정 대화의 기존 임베딩 (msg_idx, content_hash) 목록 — sync 시 변경 감지용.
    fn list_conversation_embeddings(
        &self,
        owner: &str,
        conv_id: &str,
    ) -> Vec<ConversationEmbeddingMeta>;

    /// 메시지 임베딩 upsert (PRIMARY KEY conv_id+msg_idx 기준).
    fn upsert_conversation_embedding(&self, row: &ConversationEmbeddingRow) -> bool;

    /// 특정 msg_idx 들 일괄 삭제 (메시지 배열 길이 줄어 사라진 인덱스).
    fn delete_conversation_embeddings_by_idx(
        &self,
        owner: &str,
        conv_id: &str,
        msg_idxs: &[i64],
    ) -> bool;

    /// 대화 전체 임베딩 삭제 — delete_conversation 시 cascade 정리.
    fn delete_all_conversation_embeddings(&self, owner: &str, conv_id: &str) -> bool;

    /// search_history 후보 row 일괄 로드 — owner + cutoff (created_at >= cutoff).
    /// LEFT JOIN 으로 conv_title 도 포함. cosine 매칭은 호출자 (ConversationManager) 에서.
    fn query_conversation_embeddings_since(
        &self,
        owner: &str,
        cutoff_ms: i64,
    ) -> Vec<ConversationEmbeddingRow>;

    // ────────────────────────────────────────────────────────────────────────
    // 공유된 대화 (turn 또는 full) — 외부 URL 으로 공유 가능. 옛 TS shared_conversations 1:1.
    // ────────────────────────────────────────────────────────────────────────

    /// 공유 생성 — slug 자동 발급. dedup_key 설정되어 있고 유효 share 존재 시 재사용 (reused=true).
    /// 옛 TS createShare 1:1.
    fn create_share(&self, input: &CreateShareInput) -> InfraResult<CreateShareResult>;

    /// 공유 조회 — 만료 시 None 반환 (404 처리용). 옛 TS getShare 1:1.
    fn get_share(&self, slug: &str) -> Option<SharedConversationRecord>;

    /// 만료된 공유 정리 — 1시간마다 cron 에서 호출. 삭제된 row 수 반환. 옛 TS cleanupExpiredShares 1:1.
    fn cleanup_expired_shares(&self) -> i64;

    // ────────────────────────────────────────────────────────────────────────
    // LLM cost 누적 — CostManager 가 비용·통계 집계. 도메인 메서드로 노출 (DB-agnostic motto).
    // 옛 SqliteDatabaseAdapter::with_conn 으로 직접 SQL 설정한 거 trait 으로 격리.
    // ────────────────────────────────────────────────────────────────────────

    /// LLM 호출 1건 비용 record — `llm_costs` 테이블 INSERT.
    fn record_llm_cost(
        &self,
        ts: i64,
        model: &str,
        input_tokens: i64,
        output_tokens: i64,
        cached_tokens: i64,
        cost_usd: f64,
        purpose: Option<&str>,
    ) -> bool;

    /// LLM 비용 통계 조회 — filter 적용 후 SUM/COUNT 집계.
    fn query_llm_cost_stats(&self, filter: &LlmCostStatsFilter) -> LlmCostStatsSummary;

    // ─────────────────────────────────────────────────────────────────────
    // Raw SELECT escape hatch — gRPC DatabaseService 가 사용 (`services/database.rs`).
    // SELECT 만 허용. INSERT/UPDATE/DELETE 은 거부 (도메인 메서드 사용).
    // SQL dialect 는 어댑터별 (sqlite / mariadb / postgres) — 각 어댑터가 dialect 적응.
    // ─────────────────────────────────────────────────────────────────────

    /// Raw SELECT 실행. INSERT/UPDATE/DELETE/DROP/CREATE/ALTER 는 거부 (Err 반환).
    /// 결과는 column → JsonValue 의 row 배열. NULL → JsonValue::Null,
    /// integer → Number, real → Number, text → String, blob → base64 string.
    fn run_select_query(&self, sql: &str) -> InfraResult<Vec<RawSqlRow>>;
}

/// LLM 비용 통계 filter — 옛 TS getStats 의 input 1:1.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostStatsFilter {
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub model: Option<String>,
    pub purpose: Option<String>,
}

/// LLM 비용 단일 row — date / model 별 누적 통계 (frontend 표·차트용).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostStatsRecord {
    pub date: String,         // YYYY-MM-DD (사용자 timezone 기준)
    pub model: String,
    pub calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

/// LLM 비용 통계 결과 — 옛 TS getStats 의 return 1:1.
/// frontend camelCase 호환 — serde rename_all 적용으로 응답 자동 totalInputTokens 등.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmCostStatsSummary {
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cached_tokens: i64,
    pub total_cost_usd: f64,
    /// 옛 frontend `stats.totalCalls` 호환 — `call_count` 의 camelCase 매핑은 callCount
    /// 라 옛 totalCalls 와 mismatch. serde rename 으로 응답 totalCalls 통일.
    #[serde(rename = "totalCalls")]
    pub call_count: i64,
    /// per-day / per-model 누적 row (frontend 일별·모델별 표·차트용). default 빈 배열.
    #[serde(default)]
    pub records: Vec<LlmCostStatsRecord>,
}

/// 공유 생성 인자 — 옛 TS `createShare(input)` 의 input 1:1.
#[derive(Debug, Clone)]
pub struct CreateShareInput {
    /// 'turn' (한 turn 만) 또는 'full' (전체 대화).
    pub share_type: String,
    pub title: String,
    pub messages: Vec<serde_json::Value>,
    pub owner: Option<String>,
    pub source_conv_id: Option<String>,
    /// TTL milliseconds — now + ttl_ms 가 expires_at.
    pub ttl_ms: i64,
    /// 설정되어 있고 같은 dedup 의 유효 share 존재 시 재사용.
    pub dedup_key: Option<String>,
}

/// 공유 생성 결과.
#[derive(Debug, Clone)]
pub struct CreateShareResult {
    pub slug: String,
    pub expires_at: i64,
    /// dedup_key 매칭으로 기존 share 재사용된 경우 true.
    pub reused: bool,
}

/// 공유 조회 결과 — 옛 TS getShare 의 data 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedConversationRecord {
    pub slug: String,
    #[serde(rename = "type")]
    pub share_type: String,
    pub title: String,
    pub messages: Vec<serde_json::Value>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
}

/// 임베딩 sync 시 변경 감지용 — content_hash 비교만 필요.
#[derive(Debug, Clone)]
pub struct ConversationEmbeddingMeta {
    pub msg_idx: i64,
    pub content_hash: String,
}

/// 임베딩 row 전체 — search_history 후보 조회 + upsert 양쪽 활용.
#[derive(Debug, Clone)]
pub struct ConversationEmbeddingRow {
    pub conv_id: String,
    pub conv_title: Option<String>,
    pub owner: String,
    pub msg_idx: i64,
    pub role: String,
    pub content_hash: String,
    pub content_preview: String,
    pub embedding: Vec<u8>,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRecord {
    pub id: String,
    pub title: String,
    pub messages: serde_json::Value, // 메시지 배열 (JSON)
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

// ──────────────────────────────────────────────────────────────────────────
// Sandbox — sysmod 자식 process 실행
// ──────────────────────────────────────────────────────────────────────────

/// 현재 Module I/O envelope schema 버전.
/// Phase B-post audit E1 (2026-05-06) 설정 — 미래 break change 방어.
/// 모듈 stdout JSON 에 `protocolVersion: "1.0"` 설정되어 있으면 명시 호환 검사.
/// 미설정 (옛 모듈) 도 default "1.0" 으로 처리 — 옛 모듈 호환 보장.
pub const MODULE_PROTOCOL_VERSION: &str = "1.0";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleOutput {
    /// I/O envelope schema 버전 — 미설정 시 default "1.0" 폴백 (옛 모듈 호환).
    /// 명시 설정되어 있는데 backend 호환 X 면 sandbox 가 warn 로그.
    #[serde(rename = "protocolVersion", default = "default_protocol_version", skip_serializing_if = "is_default_protocol_version")]
    pub protocol_version: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// i18n key — `error.X.Y` 형태. SysmodToolHandler 가 `module.{name}.X.Y` 형태로 lookup 변환.
    /// 매 sysmod 가 응답 시점에 설정 (옛 raw `error` 와 동시 설정 — fallback 호환).
    #[serde(rename = "errorKey", default, skip_serializing_if = "Option::is_none")]
    pub error_key: Option<String>,
    /// i18n placeholder param — `{{name}}` 같은 영역 치환. 매 value = string.
    #[serde(rename = "errorParams", default, skip_serializing_if = "Option::is_none")]
    pub error_params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

fn default_protocol_version() -> String {
    MODULE_PROTOCOL_VERSION.to_string()
}

fn is_default_protocol_version(v: &str) -> bool {
    v == MODULE_PROTOCOL_VERSION
}

impl Default for ModuleOutput {
    fn default() -> Self {
        Self {
            protocol_version: MODULE_PROTOCOL_VERSION.to_string(),
            success: false,
            data: serde_json::Value::Null,
            error: None,
            error_key: None,
            error_params: None,
            stderr: None,
            exit_code: None,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxExecuteOpts {
    /// 추가 환경 변수 (Vault 시크릿 자동 주입 외).
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// timeout milliseconds. None = 기본값 (Phase B 진행 시 SANDBOX_TIMEOUT_MS 상수 활용).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Sysmod 패키지 status — 설정 화면 [설치] / [업그레이드] 버튼 UI + 진행 상태 표시.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageStatusKind {
    /// pip 설치 완료 — workspace 디스크에 존재.
    Installed,
    /// 설치 안 됨 — 사용자가 설정 화면에서 [설치] 클릭 필요.
    Missing,
    /// StatusManager job Queued / Running.
    InProgress,
    /// 최근 install 시도 실패 — error 필드 참조.
    Failed,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageStatus {
    /// pip 패키지명 (version specifier 제거) — "playwright", "yfinance" 등.
    pub name: String,
    pub status: PackageStatusKind,
    /// StatusManager job_id — frontend 가 진행 상세 polling 가능.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// Failed 시 사용자 노출 메시지 (이미 i18n 변환).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 디스크에 설치된 버전 (dist-info 에서 추출) — `2.32.3` 형식. 미설치 / 추출 실패 = None.
    /// 사용자 표시 정보 (참고용) — 업그레이드 판단에는 사용 X.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// config.json 안 명시 버전 (`==X.Y.Z` specifier 안 매칭). 다른 specifier (>=, ~=) = None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_version: Option<String>,
    /// PyPI registry 안 최신 stable 버전 (`https://pypi.org/pypi/<pkg>/json` 조회). 1시간 캐시.
    /// 네트워크 실패 / 미설치 패키지 = None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    /// 업그레이드 가능 — `latest_version > required_version` (semver 비교) 인 경우만 true.
    /// frontend SystemModuleSettings 안 [업그레이드] 버튼 표시 조건. 옛 동작은 항상 표시였던 것을
    /// 정정 — PyPI 에 새 버전 존재 + 사용자가 업그레이드할 가치 있을 때만.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub upgrade_available: bool,
}

/// ISandboxPort — sysmod 자식 process spawn (Node / Python / etc).
///
/// Phase B 의 minimum stub — 실 sysmod spawn 구현은 후속 phase 에서 저장.
/// (tokio::process::Command + Vault 시크릿 env 주입 + path containment + timeout)
#[async_trait::async_trait]
pub trait ISandboxPort: Send + Sync {
    /// targetPath 의 모듈 entry 실행. inputData 는 stdin JSON.
    async fn execute(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput>;

    /// Sandbox 격리 능력 — adapter 마다 다름. main.rs / 어드민 UI 가 사용자에게 보여주거나
    /// 모듈 실행 정책 결정 시 참조.
    /// Phase B-post audit (2026-05-06) 설정 — BIBLE Sandbox 정신 + 코드 현실 mismatch 정정 시작점.
    fn capabilities(&self) -> SandboxCapabilities;

    /// 모듈 디렉토리의 config.json `packages` 배열 기반 install — 매 패키지 background spawn +
    /// StatusManager job 등록. `upgrade=true` 시 `pip install --upgrade`.
    /// 반환값 = 새로 시작한 job_id 목록 (이미 설치 / 진행 중 패키지는 제외).
    /// silent install 폐기 (2026-05-16) — 매 install 은 설정 화면의 명시 trigger.
    async fn install_packages(&self, module_dir: &str, upgrade: bool) -> InfraResult<Vec<String>> {
        let _ = (module_dir, upgrade);
        Ok(Vec::new())
    }

    /// 매 패키지 status 조회 — 설정 화면 polling.
    async fn get_package_status(&self, module_dir: &str) -> InfraResult<Vec<PackageStatus>> {
        let _ = module_dir;
        Ok(Vec::new())
    }
}

/// Sandbox 어댑터의 격리 능력 명세.
///
/// 옛 BIBLE 의 "격리(Sandbox)" 문구는 진짜 OS 레벨 격리를 시사하지만 실 코드 (옛
/// `tokio::process::Command`) 만으로는 `os.system("rm -rf /")` 차단 0. 진짜 격리 설정하는 step:
/// 1. `BasicProcessSandbox` (현재) — fs_readonly: false / network_deny: false / cpu_limit_ms: timeout 만 / memory_limit_mb: 0
/// 2. `LinuxCgroupsSandbox` (Phase C) — cgroups v2 + seccomp + network namespace
/// 3. `MacOsSandbox` / `WindowsSandbox` (v2.0+ Tauri 재시작 시점) — App Sandbox / AppContainer
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCapabilities {
    /// 어댑터 식별자 — `"basic-process"` / `"linux-cgroups"` / `"macos-sandbox"` / `"windows-appcontainer"` 등.
    pub kind: String,
    /// Filesystem readonly — 모듈이 path containment 외 파일 시스템 쓰기 차단.
    pub fs_readonly: bool,
    /// Network deny — 모듈 spawn 시 network namespace 설정하여 외부 fetch 차단 (sysmod 는 별도 조치).
    pub network_deny: bool,
    /// CPU 제한 (ms) — 0 = 미제한. 옛 timeout 과 별도 — runtime 추정 통계 활용.
    pub cpu_limit_ms: u64,
    /// Memory 제한 (MB) — 0 = 미제한 (cgroup memory.max 등).
    pub memory_limit_mb: u64,
    /// Syscall whitelist 활성 (seccomp). false 면 모든 syscall 허용.
    pub seccomp_filter: bool,
    /// 운영자에게 사용자 경고용 메시지 — `BasicProcessSandbox` 면 "OS 격리 0 — Phase C 까지 신뢰된 모듈만" 등.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

// ──────────────────────────────────────────────────────────────────────────
// Embedder — 텍스트 → 임베딩 벡터 (E5 prefix 분리 패턴)
// ──────────────────────────────────────────────────────────────────────────

/// IEmbedderPort — 텍스트 임베딩 변환 port.
///
/// 옛 TS `infra/llm/embedder.ts` + `embedder-adapter.ts` 1:1 port.
/// 모델: `Xenova/multilingual-e5-small` (transformers.js 로컬 ONNX, 384차원, 한국어 retrieval 용).
/// E5 prefix 패턴 — 쿼리·문서 벡터 분포 분리:
///   - `embed_query` → `query: ...` prefix (사용자 검색 입력)
///   - `embed_passage` → `passage: ...` prefix (인덱스 대상 문서)
///
/// 사용처: ConversationManager.search_history (cosine 검색) +
///         EntityManager.search_entities + EpisodicManager.search_events.
///
/// ConfigDrivenAdapter 패턴 (LLM 처럼 여러 provider 혼합) 하지 않은 이유 — 옛 TS 가
/// 단일 로컬 모델만 사용. provider 교체 시점에 확장 검토.
#[async_trait::async_trait]
pub trait IEmbedderPort: Send + Sync {
    /// 모델 버전 — 캐시 무효화 키. 모델 교체 시 값 변경 → 기존 SQLite BLOB 자동 재임베딩 trigger.
    fn version(&self) -> &str;

    /// 사용자 쿼리 임베딩 (검색 입력) — `query: ...` prefix.
    async fn embed_query(&self, text: &str) -> InfraResult<Vec<f32>>;

    /// 인덱스 대상 문서 임베딩 (대화 메시지·entity·event content 등) — `passage: ...` prefix.
    async fn embed_passage(&self, text: &str) -> InfraResult<Vec<f32>>;

    /// 정규화된 벡터 간 cosine similarity = dot product (mean pool + L2 norm 가정).
    fn cosine(&self, a: &[f32], b: &[f32]) -> f32 {
        let n = a.len().min(b.len());
        let mut dot = 0.0;
        for i in 0..n {
            dot += a[i] * b[i];
        }
        dot
    }

    /// Vec<f32> → bytes (SQLite BLOB 저장용). little-endian f32 raw 바이트.
    fn vec_to_bytes(&self, v: &[f32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(v.len() * 4);
        for f in v {
            out.extend_from_slice(&f.to_le_bytes());
        }
        out
    }

    /// bytes → Vec<f32> (SQLite BLOB 복원). 4바이트 단위 little-endian f32.
    fn bytes_to_vec(&self, b: &[u8]) -> Vec<f32> {
        let n = b.len() / 4;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let off = i * 4;
            out.push(f32::from_le_bytes([
                b[off], b[off + 1], b[off + 2], b[off + 3],
            ]));
        }
        out
    }

    /// 벡터 차원 — 어댑터별 명시 (E5-small 384). DB schema 호환성 검증용.
    fn dimension(&self) -> usize;
}

// ──────────────────────────────────────────────────────────────────────────
// Library Phase 1 — Reference / Source / Chunk 영역 (2026-05-17 신설)
// NotebookLM 같은 RAG 영역 — 매 Reference = 자료 그룹 (예: "법률 자료 2026").
// 매 Source = 매 자료 (PDF / TXT / MD / URL / 직접 입력). 매 Chunk = E5 임베딩 단위.
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryReference {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub owner: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySource {
    pub id: String,
    pub reference_id: String,
    pub name: String,
    /// `"pdf"` / `"txt"` / `"md"` / `"url"` / `"text"` — 매 영역 의 추출 path 다름.
    pub source_type: String,
    pub source_url: Option<String>,
    pub file_path: Option<String>,
    pub full_text: String,
    pub char_count: i64,
    pub chunk_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChunk {
    pub id: String,
    pub source_id: String,
    pub chunk_index: i64,
    pub content: String,
    /// Arctic 1024-dim 영역 (4096 bytes). 매 chunk 단위 임베딩.
    #[serde(skip)]
    pub embedding: Option<Vec<u8>>,
    /// PDF 영역의 page 번호 — citation 표시용.
    pub page_number: Option<i64>,
    pub start_char: i64,
    pub end_char: i64,
}

/// 매 search hit — score + source 메타 + chunk 영역 포함.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryHit {
    pub source_id: String,
    pub source_name: String,
    pub reference_id: String,
    pub reference_name: String,
    pub chunk_id: String,
    pub chunk_index: i64,
    pub content: String,
    pub page_number: Option<i64>,
    /// cosine similarity (0.0 ~ 1.0)
    pub score: f32,
}

#[async_trait::async_trait]
pub trait ILibraryPort: Send + Sync {
    // Reference (그룹 단위 — 예: "법률 자료 2026")
    async fn create_reference(
        &self,
        id: &str,
        name: &str,
        description: Option<&str>,
        owner: &str,
    ) -> InfraResult<()>;

    async fn list_references(&self, owner: &str) -> InfraResult<Vec<LibraryReference>>;

    async fn delete_reference(&self, id: &str) -> InfraResult<()>;

    // Source (매 자료 단위)
    async fn create_source(
        &self,
        id: &str,
        reference_id: &str,
        name: &str,
        source_type: &str,
        source_url: Option<&str>,
        file_path: Option<&str>,
        full_text: &str,
        content_hash: Option<&str>,
    ) -> InfraResult<()>;

    async fn list_sources(&self, reference_id: &str) -> InfraResult<Vec<LibrarySource>>;

    async fn get_source(&self, id: &str) -> InfraResult<Option<LibrarySource>>;

    /// 같은 reference 안에서 동일 content_hash 의 source 조회 — 중복 업로드 dedup 용. 없으면 None.
    /// default = Ok(None) — mock / 구버전 어댑터 무영향 (dedup 없이 자연 진행).
    async fn find_source_by_hash(
        &self,
        _reference_id: &str,
        _content_hash: &str,
    ) -> InfraResult<Option<LibrarySource>> {
        Ok(None)
    }

    async fn delete_source(&self, id: &str) -> InfraResult<()>;

    // Chunk (매 임베딩 단위)
    async fn save_chunk(
        &self,
        id: &str,
        source_id: &str,
        chunk_index: i64,
        content: &str,
        embedding: &[u8],
        page_number: Option<i64>,
        start_char: i64,
        end_char: i64,
    ) -> InfraResult<()>;

    /// chunk_count 업데이트 — Source 생성 후 매 chunk 저장이 끝나는 시점.
    async fn update_source_chunk_count(&self, source_id: &str, chunk_count: i64) -> InfraResult<()>;

    /// 매 reference 의 모든 chunk — search 시점에 cosine 비교용.
    async fn list_chunks_for_search(
        &self,
        reference_ids: &[String],
    ) -> InfraResult<Vec<LibraryChunk>>;

    /// BM25 (FTS5 trigram) sparse 검색 — query 와 어휘적으로 매치되는 chunk_id 를 best-first 순서로.
    /// dense cosine 과 RRF 융합용 (하이브리드 검색). reference_ids 로 범위 제한, limit 으로 상한.
    /// 정확 토큰(고유명사·법조문 코드·숫자)을 잡아 dense 의미 검색을 보완. 매치 0건이면 빈 Vec.
    async fn search_chunks_bm25(
        &self,
        reference_ids: &[String],
        query: &str,
        limit: usize,
    ) -> InfraResult<Vec<String>>;
}

// ──────────────────────────────────────────────────────────────────────────
// Image Processor — 이미지 후처리 (resize/convert/blurhash/placeholder).
// 옛 TS `infra/image-processor/sharp-adapter.ts` 1:1 port. Rust 측에서는 image-rs +
// fast_image_resize + blurhash crate 조합 (sharp = libvips Node binding 의 Rust 등가).
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMetadata {
    pub width: u32,
    pub height: u32,
    /// `'png' | 'jpeg' | 'webp' | 'avif' | ...` — 어댑터가 감지한 raw format
    pub format: String,
    pub bytes: u64,
    #[serde(rename = "hasAlpha", default, skip_serializing_if = "Option::is_none")]
    pub has_alpha: Option<bool>,
}

/// 크롭 위치 — `cover` / `outside` fit 일 때만 의미.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CropPosition {
    /// saliency 자동 (인물·제품 자동 중심) — 어댑터별 implementation 다름
    /// (sharp 는 libvips 내장, image-rs 는 entropy 폴백 권장).
    Attention,
    /// 엔트로피 최대 영역 (디테일 많은 곳)
    Entropy,
    /// 가운데 (default)
    Center,
    /// 0~1 상대 좌표 수동 지정 (0.5, 0.5 = 정중앙)
    Focus { x: f32, y: f32 },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FitMode {
    Contain,
    Cover,
    Fill,
    Inside,
    Outside,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
    Avif,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<FitMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<CropPosition>,
    /// 출력 포맷 — 미지정 시 원본 유지
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ImageFormat>,
    /// 품질 (jpeg/webp/avif 만, 0~100)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<u8>,
    /// progressive encoding (jpeg/webp)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progressive: Option<bool>,
    /// EXIF 등 메타데이터 제거
    #[serde(rename = "stripMetadata", default, skip_serializing_if = "Option::is_none")]
    pub strip_metadata: Option<bool>,
}

#[async_trait::async_trait]
pub trait IImageProcessorPort: Send + Sync {
    /// 이미지 메타데이터 파싱 (포맷 무관). 헤더만 읽어 width/height/format 즉시 반환.
    async fn get_metadata(&self, binary: &[u8]) -> InfraResult<ImageMetadata>;

    /// 리사이즈 + 포맷 변환. attention/entropy/focus crop 활성 (cover/outside fit 시).
    async fn process(&self, binary: &[u8], opts: &ResizeOpts) -> InfraResult<Vec<u8>>;

    /// Blurhash LQIP 문자열 (~32자 base83). components 미설정 시 default 4x4.
    /// 페이지 reload 전 placeholder 로 표시 (PageSpec 의 Image 블록에 자동 설정).
    async fn blurhash(
        &self,
        binary: &[u8],
        components: Option<(u32, u32)>,
    ) -> InfraResult<String>;

    /// Placeholder PNG — 비동기 image_gen "렌더링중" 임시 이미지. 단순 회색 사각형.
    /// 텍스트 없음 (locale·폰트 의존 회피). 사용자는 갤러리 status='rendering' 카드 + 페이지
    /// reload 시 swap 으로 진행 인지.
    async fn create_placeholder(&self, width: u32, height: u32) -> InfraResult<Vec<u8>>;
}

// ──────────────────────────────────────────────────────────────────────────
// Image Generation (AI 이미지 생성) — LLM 과 대칭 ConfigDrivenAdapter 패턴.
// 옛 TS `infra/image/` 1:1 port. format handler 3종: openai-image / gemini-native-image /
// cli-codex-image. JSON config 4개 (gpt-image-1 / gpt-image-2 / gemini-3-1-flash-image /
// cli-codex-image). Vault `system:image:model` 으로 활성 모델 swap.
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ImageReferenceImage {
    pub binary: Vec<u8>,
    pub content_type: String,
}

#[derive(Debug, Clone, Default)]
pub struct ImageGenOpts {
    pub prompt: String,
    /// 출력 크기 — 공식 지원 값 중 하나. 예: `"1024x1024"` / `"1792x1024"`.
    pub size: Option<String>,
    /// 품질 — provider 별 해석 (`"standard" | "hd" | "low" | "medium" | "high"` 등).
    pub quality: Option<String>,
    /// 스타일 지시 (선택)
    pub style: Option<String>,
    /// n 개 생성 (1 권장, 다수 지원 provider 만)
    pub n: Option<u32>,
    /// 모델 ID override — 미설정 시 ImageGenCallOpts 의 default
    pub model: Option<String>,
    /// 참조 이미지 (image-to-image). MediaManager 가 slug/url/base64 → binary 로 resolve 후 주입.
    /// - OpenAI: `/v1/images/edits` 엔드포인트 + multipart
    /// - Gemini: `contents.parts` 에 inline_data part 추가
    /// - Codex CLI: 미지원 (description 에 명시)
    pub reference_image: Option<ImageReferenceImage>,
}

#[derive(Debug, Clone, Default)]
pub struct ImageGenCallOpts {
    /// 모델 ID — config-adapter 가 이걸로 config 선택
    pub model: Option<String>,
    /// 요청 상관 ID — 로깅 추적
    pub corr_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ImageGenResult {
    /// 생성된 이미지 binary (PNG/WEBP 등)
    pub binary: Vec<u8>,
    pub content_type: String,
    /// 감지 가능한 경우 해상도
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// provider 가 반환한 revised_prompt 등
    pub revised_prompt: Option<String>,
    /// 이미지 1장 비용 USD — 어댑터가 config.pricing 으로 산정.
    /// 구독 기반 (CLI) 은 `None`. CostManager 가 LLM 비용 통계에 통합 누적.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageModelInfo {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub provider: String,
    pub format: String,
    #[serde(
        rename = "requiresOrganizationVerification",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub requires_organization_verification: Option<bool>,
    /// 지원 사이즈 목록 — 설정 UI drop-down 노출. `["auto"]` 면 모델 자동.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sizes: Vec<String>,
    /// 지원 품질 목록 — `["standard"]` 면 품질 고정.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub qualities: Vec<String>,
    /// CLI 구독 기반 여부 — API 키 불필요, 과금 구독 포함.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription: Option<bool>,
}

#[async_trait::async_trait]
pub trait IImageGenPort: Send + Sync {
    /// 현재 활성 모델 ID — Vault `system:image:model` 또는 default.
    fn get_model_id(&self) -> String;

    /// 설정 UI 용 모델 목록 — registry 에서 로드된 모든 config + builtin carousel.
    fn list_models(&self) -> Vec<ImageModelInfo>;

    /// 이미지 생성 — Core 의 MediaManager 가 이 결과를 IMediaPort 로 저장 후 후처리.
    async fn generate(
        &self,
        opts: &ImageGenOpts,
        call_opts: &ImageGenCallOpts,
    ) -> InfraResult<ImageGenResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// LLM — User AI / Code Assistant / AI Assistant 통합 port
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "inputSchema", default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    #[serde(rename = "callId")]
    pub call_id: String,
    pub name: String,
    pub result: serde_json::Value,
    #[serde(default)]
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 멀티턴 도구 교환 한 turn 단위 — 옛 TS `ToolExchangeEntry` 1:1 port.
///
/// Gemini (native + Vertex) 의 thought_signature 보존을 위해 어댑터가 첫 turn 에서 받은
/// `rawModelParts` (functionCall + thought 포함) 를 다음 turn `contents` 에 그대로 echo 해야 함.
/// `rawModelParts` 미설정 시 어댑터는 `tool_calls` 로 functionCall part 합성 fallback.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExchangeEntry {
    #[serde(default, rename = "toolCalls")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, rename = "toolResults")]
    pub tool_results: Vec<ToolResult>,
    /// Gemini 가 첫 turn 에서 응답한 candidates[0].content.parts 원본.
    /// 다음 turn 의 `contents` 에 `{role:'model', parts: rawModelParts}` 형식으로 echo.
    /// thought_signature / thinkingConfig 호환성 유지에 필수.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "rawModelParts")]
    pub raw_model_parts: Option<serde_json::Value>,
}

/// 대화 메시지 — 옛 TS `ChatMessage` 1:1 port.
///
/// CLI 어댑터의 `buildPromptWithHistory` 가 resume session 미사용 시 prompt 앞에 history 주입할 때 사용.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// `"user"` / `"assistant"` / `"system"` 등.
    pub role: String,
    /// 메시지 본문. JSON 객체일 수도 있어 `serde_json::Value` 로 받음.
    #[serde(default)]
    pub content: serde_json::Value,
    /// 첨부 이미지 (옵션) — base64 또는 data URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "imageMimeType")]
    pub image_mime_type: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmCallOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 플랜 모드 — frontend 의 `planMode` 값 (off/auto/always). 매니저는 AiRequestOpts.plan_mode 로
    /// 매핑. 옛에는 AiRequestOpts 에만 있고 LlmCallOpts 에는 없어서 frontend 가
    /// 보낸 planMode 가 backend 에서 무시되던 root cause.
    #[serde(rename = "planMode", default)]
    pub plan_mode: PlanMode,
    #[serde(rename = "thinkingLevel", default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(rename = "systemPrompt", default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(rename = "maxTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// 대화 owner — HistoryResolver 가 자동 history 컨텍스트 인출 시 활용. 미설정 시 기본 "admin".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// 대화 ID — HistoryResolver 가 recent N 메시지 조회. 미설정 시 history 컨텍스트 비활성.
    #[serde(rename = "conversationId", default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// CLI 모드 (Claude Code / Codex / Gemini CLI) 의 resume session_id — 옛 TS `cliResumeSessionId` 1:1.
    /// 설정되어 있으면 어댑터가 `--resume <id>` / `exec resume <id>` / `--resume <uuid>` 로 cold spawn.
    #[serde(rename = "cliResumeSessionId", default, skip_serializing_if = "Option::is_none")]
    pub cli_resume_session_id: Option<String>,
    /// OpenAI Responses API 의 previous_response_id — 서버 history persistence (멀티턴 토큰 절감).
    /// 옛 TS `previousResponseId` 1:1.
    #[serde(rename = "previousResponseId", default, skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
    /// 첨부 이미지 — base64 string (data: URL 또는 raw). 멀티모달 LLM 입력용.
    /// API 모드 (Anthropic / OpenAI / Gemini) 는 message content 에 inline.
    /// CLI 모드 (Codex / Gemini CLI) 는 cli_image_helper 로 임시 파일 → 인자 / `@<path>` 저장.
    /// Claude Code CLI 는 stream-json input 으로 base64 직접 전달.
    /// 옛 TS `LlmCallOpts.image` 1:1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// `image` 의 MIME 타입 (e.g. `image/png`). 미지정 시 data: URL 에서 추론 또는 png default.
    /// 옛 TS `LlmCallOpts.imageMimeType` 1:1.
    #[serde(rename = "imageMimeType", default, skip_serializing_if = "Option::is_none")]
    pub image_mime_type: Option<String>,
    /// 멀티턴 도구 교환 누적 — 옛 TS `LlmCallOpts.toolExchanges` 1:1.
    ///
    /// Gemini API (native + Vertex) 가 thought_signature 보존을 위해 매 turn `rawModelParts` echo 필요.
    /// 우리 `prior_results` 인자만으로는 첫 turn 의 functionCall 원본 args 가 유실 → 어댑터가
    /// thought_signature 손실. `tool_exchanges` 에 (calls, results, rawModelParts) 누적해서 어댑터가
    /// 정확한 멀티턴 contents 빌드.
    ///
    /// 비어있으면 어댑터는 `prior_results` 에서 fallback (Anthropic / OpenAI 호환 유지).
    #[serde(rename = "toolExchanges", default, skip_serializing_if = "Vec::is_empty")]
    pub tool_exchanges: Vec<ToolExchangeEntry>,
    /// 대화 history — 옛 TS `LlmCallOpts.history` 1:1. CLI 어댑터의 `buildPromptWithHistory` 가
    /// resume session 미사용 시 prompt 앞에 [이전 대화] 블록으로 주입.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<ChatMessage>,
    /// MCP bearer token (CLI 모드 전용) — 옛 TS `ctx.resolveMcpConfig().token` 1:1.
    /// CLI 어댑터가 mcp 설정 파일 (Claude `--mcp-config`, Codex `CODEX_HOME`, Gemini `workspace/.gemini/settings.json`) 생성 시 사용.
    #[serde(rename = "mcpToken", default, skip_serializing_if = "Option::is_none")]
    pub mcp_token: Option<String>,
    /// MCP 메인 프로세스 base URL (e.g. `http://127.0.0.1:3000`). CLI 모드 전용.
    /// 옛 TS `ctx.resolveMcpConfig().url.replace(/\/api\/mcp-internal.*$/, '')` 1:1.
    #[serde(rename = "mcpBaseUrl", default, skip_serializing_if = "Option::is_none")]
    pub mcp_base_url: Option<String>,
    /// CLI 전용 모델 ID (예: `sonnet-4-5`). 어댑터가 `--model <id>` 인자로 전달.
    /// 미설정 시 CLI 기본 모델 사용. 옛 TS `ctx.config.cliModel` 1:1.
    #[serde(rename = "cliModel", default, skip_serializing_if = "Option::is_none")]
    pub cli_model: Option<String>,
    /// Anthropic prompt cache 토글 — Vault `system:llm:anthropic-cache` 값.
    /// ON 시 anthropic 어댑터가 system block + 마지막 tool 에 `cache_control: ephemeral` 마커 추가.
    /// 옛 TS `ctx.resolveAnthropicCache()` 1:1. ConfigDrivenAdapter 가 anthropic-messages format 호출 시
    /// Vault 자동 조회. 호출자 (AiManager) 직접 조회 불필요.
    #[serde(rename = "anthropicCacheEnabled", default, skip_serializing_if = "Option::is_none")]
    pub anthropic_cache_enabled: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmTextResponse {
    pub text: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "costUsd", default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(rename = "tokensIn", default, skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<i64>,
    #[serde(rename = "tokensOut", default, skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<i64>,
    /// `tokens_in` 중 프롬프트 캐시에서 읽힌 부분집합 (전체 입력의 subset, 별도 추가 아님).
    /// Anthropic `cache_read_input_tokens` / OpenAI `input_tokens_details.cached_tokens` /
    /// Gemini `cachedContentTokenCount` / Codex `cached_input_tokens` 통합. 비용 통계 표시용.
    #[serde(rename = "cachedTokens", default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<i64>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmToolResponse {
    #[serde(default)]
    pub text: String,
    #[serde(default, rename = "toolCalls")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(rename = "modelId", default)]
    pub model_id: String,
    #[serde(rename = "costUsd", default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(rename = "tokensIn", default, skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<i64>,
    #[serde(rename = "tokensOut", default, skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<i64>,
    /// `tokens_in` 중 프롬프트 캐시에서 읽힌 부분집합 (전체 입력의 subset, 별도 추가 아님).
    /// Anthropic `cache_read_input_tokens` / OpenAI `input_tokens_details.cached_tokens` /
    /// Gemini `cachedContentTokenCount` / Codex `cached_input_tokens` 통합. 비용 통계 표시용.
    #[serde(rename = "cachedTokens", default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<i64>,
    /// CLI 모드 어댑터가 첫 turn 에서 잡은 session_id — 옛 TS `onCliSessionId` 콜백 패턴 대신
    /// response 에 설정하여 callee (AiManager) 가 직접 DB 영속화. 다음 turn `cli_resume_session_id` 으로 사용.
    #[serde(rename = "cliSessionId", default, skip_serializing_if = "Option::is_none")]
    pub cli_session_id: Option<String>,
    /// OpenAI Responses API 가 발급한 response_id — 다음 turn `previous_response_id` 으로 재사용.
    /// 옛 TS `responseId` 1:1.
    #[serde(rename = "responseId", default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    /// CLI 가 자체 MCP loop 안에서 호출한 도구 이름 목록 — 옛 TS `internallyUsedTools` 1:1.
    /// AiManager 가 외부 dispatch 가 아니라 CLI 내부 처리임을 인지하고 UI executedActions 에 표시.
    #[serde(rename = "internallyUsedTools", default, skip_serializing_if = "Vec::is_empty")]
    pub internally_used_tools: Vec<String>,
    /// CLI 가 자체 MCP loop 에서 받은 render_* 도구 결과 → UI 컴포넌트 블록.
    /// 옛 TS `renderedBlocks` 1:1. 형식: `{type:'text'|'html'|'component', ...}` JSON value.
    #[serde(rename = "renderedBlocks", default, skip_serializing_if = "Vec::is_empty")]
    pub rendered_blocks: Vec<serde_json::Value>,
    /// CLI 가 자체 MCP loop 에서 호출한 승인 대기 도구 (schedule_task / save_page 등) → UI pending 카드.
    /// 옛 TS `pendingActions` 1:1. 형식: `{planId, name, summary, args, status?, originalRunAt?}` JSON value.
    #[serde(rename = "pendingActions", default, skip_serializing_if = "Vec::is_empty")]
    pub pending_actions: Vec<serde_json::Value>,
    /// CLI 가 자체 MCP loop 에서 호출한 `suggest` / `propose_plan` 도구 결과 suggestions.
    /// 옛 TS `suggestions` 1:1. 임의 JSON value (string / `{type, label, ...}`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<serde_json::Value>,
    /// Gemini API 가 응답한 candidates[0].content.parts 원본 — 옛 TS `rawModelParts` 1:1.
    /// AiManager 가 다음 turn `tool_exchanges` 에 echo → thought_signature 보존.
    #[serde(rename = "rawModelParts", default, skip_serializing_if = "Option::is_none")]
    pub raw_model_parts: Option<serde_json::Value>,
    /// CLI 가 자체 MCP loop 에서 받은 도구 결과 요약 (성공/실패 모두) — Frontend 에러 뱃지 UI 용.
    /// 옛 TS 의 에러 뱃지 표시 채널 1:1 port. `internallyUsedTools` 가 도구 이름만 전달하던 한계 보완.
    /// 형식: `{name: string, success: bool, error?: string, input?: object}`.
    #[serde(rename = "toolResults", default, skip_serializing_if = "Vec::is_empty")]
    pub tool_results: Vec<ToolResultSummary>,
    /// extended thinking / reasoning content — API 모드 어댑터가 응답 안 thinking 블록 별도 추출 후 set.
    /// Anthropic Extended Thinking 의 `content[type=thinking]`, OpenAI Responses 의
    /// `output[type=reasoning].summary[*].text`, Gemini Native + Vertex 의 `parts[thought=true].text` 통합.
    /// AiManager 가 매 turn 결과 시점 이 영역 emit (`event_type="thinking"`) → frontend ThinkingBlock bodyText.
    #[serde(rename = "thinkingText", default, skip_serializing_if = "Option::is_none")]
    pub thinking_text: Option<String>,
}

/// CLI 자체 MCP loop 안에서 호출된 도구 한 건의 결과 요약. Frontend 에러 뱃지 표시 용.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ToolResultSummary {
    pub name: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
}

/// 플랜모드 — 옛 TS `AiRequestOpts.planMode` 1:1.
///
/// - `Off` — plan 강제 X. AI 자유 판단 (default)
/// - `Auto` — destructive·복합 작업만 propose_plan, 단순 read-only 는 즉시 도구 호출
/// - `Always` — 모든 요청에 plan 강제 (인사·단답 포함)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanMode {
    #[default]
    Off,
    Auto,
    Always,
}

/// AiManager 요청 옵션 — 옛 TS `AiRequestOpts` 1:1 port.
///
/// LlmCallOpts 와 분리되는 이유: AiManager 차원 (plan / cron_agent / approval gate)
/// vs LLM 호출 차원 (model / temperature / system_prompt) 의 책임 경계.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequestOpts {
    /// 모델 ID — `LlmCallOpts.model` 로 전파.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 대화 owner — HistoryResolver / search_history 가 활용. 기본 "admin".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// 대화 ID — recent N 메시지 prepend / search_history / CLI session resume.
    #[serde(rename = "conversationId", default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// 플랜모드 — off / auto / always.
    #[serde(rename = "planMode", default)]
    pub plan_mode: PlanMode,
    /// Cron agent 모드 — 사용자 부재 자율 발행. MAX_TOOL_TURNS 25 + 승인 게이트 우회.
    #[serde(rename = "cronAgent", default, skip_serializing_if = "Option::is_none")]
    pub cron_agent: Option<CronAgentOpts>,
    /// Hub 컨텍스트 — 외부 사이트 챗봇 인스턴스 안에서 호출 시 set. None = admin 정상 모드.
    /// 설정되어 있으면 AiManager 가:
    ///   - 도구 list 안 sysmod_* 영역 `allowed_sysmods` 만 retain + mcp_* 영역 차단
    ///     (외부 도용 방지 — admin 내장 도구 노출 최소)
    ///   - RetrievalEngine 의 library 영역 `allowed_references` 안 Reference ID 만 검색
    ///   - HistoryResolver 우회 + `history` 영역 직접 prepend (hub_conversations 별도 테이블)
    #[serde(rename = "hubContext", default, skip_serializing_if = "Option::is_none")]
    pub hub_context: Option<HubContext>,
    /// 사용자가 직전 plan card 의 ✓실행 버튼 누른 시점 frontend 가 동봉하는 planId.
    /// 설정되어 있으면 AiManager 가 plan_store 조회 → 시스템 프롬프트 안 plan_to_instruction 주입 +
    /// consume_plan 으로 일회성 처리. 옛 TS `planExecuteId` 1:1.
    #[serde(rename = "planExecuteId", default, skip_serializing_if = "Option::is_none")]
    pub plan_execute_id: Option<String>,
    /// 사용자가 직전 plan card 의 ⚙수정 제안 안 텍스트 입력 후 전송한 시점 frontend 가 동봉하는 planId.
    /// 설정되어 있으면 AiManager 가 plan_store 조회 → 시스템 프롬프트 안 plan_to_revise_instruction 주입 →
    /// AI 가 propose_plan 도구 재호출 강제. 옛 TS `planReviseId` 1:1.
    #[serde(rename = "planReviseId", default, skip_serializing_if = "Option::is_none")]
    pub plan_revise_id: Option<String>,
}

/// Hub 컨텍스트 — `AiRequestOpts.hub_context` 안 값.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubContext {
    /// 인스턴스 ID (logging / 추적 영역).
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    /// 방문자 session id — owner 에 포함되어 visitor 끼리 자료 격리.
    /// `hub:<instance_id>:<session_id>` 형태 owner 가 매 도구 호출 시 자동 주입.
    /// 빈 string = 옛 호환 (visitor 격리 X, instance 단위만).
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    /// 허용 sysmod 이름 배열 (예: `["yfinance", "korea-invest"]`). 빈 배열 = 모든 sysmod 차단.
    #[serde(rename = "allowedSysmods", default)]
    pub allowed_sysmods: Vec<String>,
    /// 허용 Library Reference ID 배열. 빈 배열 = library 검색 0.
    #[serde(rename = "allowedReferences", default)]
    pub allowed_references: Vec<String>,
    /// hub 대화 history — hub_messages 테이블 영역 recent N 메시지.
    /// AiManager 가 system_prompt 영역에 prepend (HistoryResolver 우회).
    #[serde(default)]
    pub history: Vec<ChatMessage>,
    /// hub instance 커스텀 시스템 프롬프트 (선택). AiManager 가 기본 시스템 프롬프트(에이전트·plan·render 규칙)에
    /// **추가** 합성한다 — 옛 방식(llm_opts.system_prompt 로 replace)은 plan_prefix·plan_instruction(실행 지시)·
    /// history·메모리 빌드 블록 전체를 건너뛰어 hub 가 admin 과 다르게 행동(인사·plan 실행 누락)하던 root. None = 기본만.
    #[serde(rename = "instanceDirective", default)]
    pub instance_directive: Option<String>,
}

/// Cron agent 컨텍스트 — 옛 TS `AiRequestOpts.cronAgent` 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronAgentOpts {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// LLM 어댑터 → AiManager 스트리밍 이벤트 (turn 중 실시간). CLI 어댑터가 stream-json 을 줄 단위로
/// 파싱하며 thinking 본문 / 도구 호출 진행을 흘려보냄. AiManager 가 AiStreamEvent 로 매핑해 frontend
/// 로 전달 → "생각중" 옆 추론·도구 진행 표시. (API 어댑터는 batch 라 미사용 — 기본 동작.)
#[derive(Debug, Clone)]
pub enum LlmStreamEvent {
    /// extended thinking / reasoning 본문 조각.
    Thinking(String),
    /// 도구 호출 진행 — status: "start" | "done" | "error".
    ToolStep { name: String, status: String },
}

/// 스트리밍 sink — 어댑터가 turn 중 try_send. None 이면 비스트리밍 (기존 batch 동작).
/// 채널 방식 (Arc<dyn Fn> 호출 문법 모호성 회피). AiManager 가 받아 AiStreamEvent 로 매핑.
pub type LlmStreamSink = tokio::sync::mpsc::Sender<LlmStreamEvent>;

/// CLI 에이전트(Claude Code / Codex / Gemini)가 자체적으로 쓰는 내부 계획·할 일 추적 도구인지 판정.
/// 모델이 멀티스텝 작업을 스스로 정리하는 스캐폴드로, 사용자 승인 게이트인 우리 `propose_plan` 과는 별개다.
/// 일반 도구 호출 뱃지로 노출하면 ×N 반복처럼 보이므로, 단일 "계획 정리" 진행 표시로 통합하고
/// tool_results 에서는 제외한다. 세 CLI 가 이름·표출 형태가 모두 달라 공유 분류기로 일반화:
/// - Claude Code v2.1.142+: TaskCreate / TaskUpdate / TaskGet / TaskList (+ 옛 TodoWrite)
/// - OpenAI Codex: update_plan (codex exec --json 에선 todo_list 아이템으로 표출 — 어댑터가 따로 처리)
/// - Gemini CLI: write_todos (+ 비기본 tracker_* 묶음)
pub fn is_native_plan_tool(name: &str) -> bool {
    matches!(
        name,
        "TaskCreate"
            | "TaskUpdate"
            | "TaskGet"
            | "TaskList"
            | "TodoWrite"
            | "update_plan"
            | "write_todos"
    ) || name.starts_with("tracker_")
}

/// ILlmPort — 옛 TS ILlmPort Rust port.
///
/// Phase B-16 minimum: trait 정의 + Stub 구현체 (실 LLM 호출 없음, dispatch 흐름만 작동).
/// Phase B-17+ 후속: 5 API format (openai-responses / anthropic-messages / gemini-native /
/// vertex-gemini / openai-chat) + 3 CLI format (cli-claude-code / cli-codex / cli-gemini)
/// 실 wiring. ConfigDrivenAdapter 패턴으로 단일 어댑터 + 포맷 핸들러 분기.
#[async_trait::async_trait]
pub trait ILlmPort: Send + Sync {
    fn get_model_id(&self) -> String;
    /// MCP 자체 처리 모델 여부 — CLI 3종 (Claude Code / Codex / Gemini) +
    /// Anthropic API (Claude messages) + OpenAI Responses API 가 hosted MCP connector
    /// 또는 자체 MCP loop 를 통해 Firebat MCP server (`/api/mcp-internal`) 인증 토큰
    /// (`opts.mcp_token`) 만 있으면 도구 schema 별도 전달 불필요.
    /// false 응답 모델 (Gemini native / Vertex / 옛 OpenAI Chat) 은 ai.rs 의
    /// effective_tools schema 가 전달되어야 함 (Function Calling 표준).
    /// opts.model 이 있으면 그 모델 기준, 없으면 current default 기준.
    /// 미구현 implementor 는 default false (안전한 쪽).
    fn supports_hosted_mcp(&self, _opts: &LlmCallOpts) -> bool { false }
    async fn ask_text(&self, prompt: &str, opts: &LlmCallOpts) -> InfraResult<LlmTextResponse>;
    async fn ask_with_tools(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse>;

    /// 스트리밍 변형 — emit sink 가 있으면 어댑터가 turn 중 thinking/tool step 을 흘려보냄.
    /// 기본 구현 = 비스트리밍 ask_with_tools 위임 (sink 무시). CLI 어댑터만 override 해 실시간 emit.
    async fn ask_with_tools_streaming(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
        emit: Option<LlmStreamSink>,
    ) -> InfraResult<LlmToolResponse> {
        let _ = emit;
        self.ask_with_tools(prompt, tools, prior_results, opts).await
    }
}

// ──────────────────────────────────────────────────────────────────────────
// MCP Client — 외부 MCP 서버 (Gmail, Slack, 카톡 등) 등록·연결·도구 호출
// ──────────────────────────────────────────────────────────────────────────

/// 옛 TS McpServerConfig Rust 재현. 전송 방식 stdio / sse 두 가지.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Sse,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema", default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

/// IEmbedderCachePort — embedding vector disk 영속화.
///
/// 옛 component_search_index / tool_search_index 가 std::fs / std::env 직접 호출하던 영역을
/// Hexagonal 정공 port 로 추상화 (2026-05-13).
///
/// Core 가 fs / env 호출 0 — `infra::adapters::embedder_cache::FileEmbedderCacheAdapter` 가 file I/O 담당.
/// cache_name = "component-embeddings.json" / "tool-embeddings.json" 등 파일명. 디렉토리는 adapter resolve.
pub trait IEmbedderCachePort: Send + Sync {
    /// 캐시 read — 미존재 또는 read 실패 시 None.
    fn load(&self, cache_name: &str) -> Option<String>;
    /// 캐시 write — 디렉토리 자동 생성. 실패는 silent (운영 cache 라 panic 회피).
    fn save(&self, cache_name: &str, json: &str);
}

/// IConfigPort — env / config 영역 추상화.
///
/// 옛 std::env::var 직접 호출하던 영역 (FIREBAT_MCP_BASE_URL 등) Hexagonal 정공 적용 (2026-05-13).
/// adapter = `infra::adapters::config::EnvConfigAdapter` — std::env::var 래핑.
pub trait IConfigPort: Send + Sync {
    /// config key (예: "FIREBAT_MCP_BASE_URL") → 값 또는 None.
    fn get(&self, key: &str) -> Option<String>;
}

// IPromptLoaderPort 폐기 (2026-05-16) — 시스템 prompt 영역이 `firebat_core::i18n` 의 통합
// 다국어 service 안으로 흡수됨. 매 prompt 의 다국어 .md 파일은 `system/prompts/{name}/lang/{lang}.md`
// 에 위치하며 `i18n::init()` 부팅 시점에 자동 scan + `prompt.{name}` namespace 안 lookup.
// caller 는 `firebat_core::i18n::prompt(name, None)` 직접 호출 — adapter wiring 0.

/// IMcpClientPort — 외부 MCP 서버 풀 클라이언트.
///
/// 설정 (2026-05-07): stdio + HTTP+SSE 두 transport 설정 (직접 JSON-RPC 2.0 구현).
///   - stdio: child process spawn + stdin/stdout line frames (Claude Code / Cursor / 로컬 도구)
///   - sse: GET text/event-stream → endpoint event → POST JSON-RPC (외부 SaaS)
///
/// 영속 — `data/mcp-servers.json` (옛 TS 와 동일 포맷).
#[async_trait::async_trait]
pub trait IMcpClientPort: Send + Sync {
    fn list_servers(&self) -> Vec<McpServerConfig>;
    async fn add_server(&self, config: McpServerConfig) -> InfraResult<()>;
    async fn remove_server(&self, name: &str) -> InfraResult<()>;
    async fn list_tools(&self, server_name: &str) -> InfraResult<Vec<McpToolInfo>>;
    async fn list_all_tools(&self) -> InfraResult<Vec<McpToolInfo>>;
    async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value>;
    /// 셧다운 — 모든 stdio 자식 process kill / sse 연결 close.
    async fn disconnect_all(&self);
}

// ──────────────────────────────────────────────────────────────────────────
// Memory 4-tier — Entity (Phase 1) + Episodic (Phase 2) + Consolidation (Phase 4)
// ──────────────────────────────────────────────────────────────────────────

/// Entity tier — 종목·인물·프로젝트·이벤트 단위 영속 추적 대상.
/// 옛 TS EntityRecord / EntityFactRecord Rust 재현.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRecord {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(rename = "sourceConvId", default, skip_serializing_if = "Option::is_none")]
    pub source_conv_id: Option<String>,
    #[serde(rename = "factCount", default)]
    pub fact_count: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    /// 데이터 격리 — "admin" = 본인 메모리 (default), "hub:<instance_id>" = hub 방문자 메모리.
    /// hub mode 안 admin 데이터 접근 차단 + admin 안 hub 데이터 노출 차단 양방향.
    #[serde(default = "default_owner")]
    pub owner: String,
}

fn default_owner() -> String { "admin".to_string() }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityFactRecord {
    pub id: i64,
    #[serde(rename = "entityId")]
    pub entity_id: i64,
    pub content: String,
    #[serde(rename = "factType", default, skip_serializing_if = "Option::is_none")]
    pub fact_type: Option<String>,
    #[serde(rename = "occurredAt", default, skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(rename = "sourceConvId", default, skip_serializing_if = "Option::is_none")]
    pub source_conv_id: Option<String>,
    #[serde(rename = "expiresAt", default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// owner — entity 의 owner 와 동일 (cascade 일관성). entity_facts.owner 갱신 자체는
    /// adapter 가 entity 의 owner 자동 매핑.
    #[serde(default = "default_owner")]
    pub owner: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySearchOpts {
    #[serde(default)]
    pub query: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    /// owner filter — None = admin (default), Some("hub:<id>") = 해당 hub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactSearchOpts {
    #[serde(default)]
    pub query: String,
    #[serde(rename = "entityId", default, skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<i64>,
    #[serde(rename = "factType", default, skip_serializing_if = "Option::is_none")]
    pub fact_type: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(rename = "fromTime", default, skip_serializing_if = "Option::is_none")]
    pub from_time: Option<i64>,
    #[serde(rename = "toTime", default, skip_serializing_if = "Option::is_none")]
    pub to_time: Option<i64>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SaveEntityInput {
    pub name: String,
    pub entity_type: String,
    pub aliases: Vec<String>,
    pub metadata: Option<serde_json::Value>,
    pub source_conv_id: Option<String>,
    /// None = admin (default), Some("hub:<id>") = 해당 hub.
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateEntityPatch {
    pub name: Option<String>,
    pub entity_type: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default)]
pub struct SaveFactInput {
    pub entity_id: i64,
    pub content: String,
    pub fact_type: Option<String>,
    pub occurred_at: Option<i64>,
    pub tags: Vec<String>,
    pub source_conv_id: Option<String>,
    pub ttl_days: Option<i64>,
    pub dedup_threshold: Option<f64>,
    /// Caller owner scope — when Some(non-empty), save_fact only proceeds if the target entity
    /// belongs to this owner (hub cross-tenant write guard). None/empty = admin (no check).
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateFactPatch {
    pub content: Option<String>,
    pub fact_type: Option<String>,
    pub occurred_at: Option<i64>,
    pub tags: Option<Vec<String>>,
    pub ttl_days: Option<i64>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineOpts {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(rename = "orderBy", default)]
    pub order_by: Option<String>, // "occurredAt" | "createdAt"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

/// IEntityPort — Phase 1 entity tier port.
///
/// save_entity / save_fact / search_entities / search_facts 4개는 async — IEmbedderPort
/// async fn (`embed_passage` / `embed_query`) 호출하기 때문. 다른 메서드 (update / remove /
/// get / find / list / cleanup / count) 는 임베딩 미사용 — sync 유지.
#[async_trait::async_trait]
pub trait IEntityPort: Send + Sync {
    async fn save_entity(&self, input: &SaveEntityInput) -> InfraResult<(i64, bool)>;
    fn update_entity(&self, id: i64, patch: &UpdateEntityPatch) -> InfraResult<()>;
    fn remove_entity(&self, id: i64) -> InfraResult<()>;
    fn get_entity(&self, id: i64) -> InfraResult<Option<EntityRecord>>;
    fn find_entity_by_name(&self, name: &str) -> InfraResult<Option<EntityRecord>>;
    async fn search_entities(&self, opts: &EntitySearchOpts) -> InfraResult<Vec<EntityRecord>>;

    async fn save_fact(&self, input: &SaveFactInput) -> InfraResult<(i64, bool, Option<f64>)>;
    fn update_fact(&self, id: i64, patch: &UpdateFactPatch) -> InfraResult<()>;
    fn remove_fact(&self, id: i64) -> InfraResult<()>;
    fn get_fact(&self, id: i64) -> InfraResult<Option<EntityFactRecord>>;
    fn list_facts_by_entity(
        &self,
        entity_id: i64,
        opts: &TimelineOpts,
    ) -> InfraResult<Vec<EntityFactRecord>>;
    async fn search_facts(&self, opts: &FactSearchOpts) -> InfraResult<Vec<EntityFactRecord>>;
    fn cleanup_expired_facts(&self) -> InfraResult<i64>;

    /// 통계 — 매니저 retrieve_context / health stats 에서 활용.
    fn count_entities(&self) -> InfraResult<i64>;
    fn count_facts(&self) -> InfraResult<i64>;
    fn count_entities_by_type(&self) -> InfraResult<Vec<(String, i64)>>;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: i64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Value>,
    #[serde(rename = "occurredAt")]
    pub occurred_at: i64,
    #[serde(rename = "entityIds", default, skip_serializing_if = "Vec::is_empty")]
    pub entity_ids: Vec<i64>,
    #[serde(rename = "sourceConvId", default, skip_serializing_if = "Option::is_none")]
    pub source_conv_id: Option<String>,
    #[serde(rename = "expiresAt", default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(default = "default_owner")]
    pub owner: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSearchOpts {
    #[serde(default)]
    pub query: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    #[serde(rename = "entityId", default, skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<i64>,
    #[serde(rename = "fromTime", default, skip_serializing_if = "Option::is_none")]
    pub from_time: Option<i64>,
    #[serde(rename = "toTime", default, skip_serializing_if = "Option::is_none")]
    pub to_time: Option<i64>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SaveEventInput {
    pub event_type: String,
    pub title: String,
    pub description: Option<String>,
    pub who: Option<String>,
    pub context: Option<serde_json::Value>,
    pub occurred_at: Option<i64>,
    pub entity_ids: Vec<i64>,
    pub source_conv_id: Option<String>,
    pub ttl_days: Option<i64>,
    pub dedup_threshold: Option<f64>,
    /// None = admin (default), Some("hub:<id>") = 해당 hub.
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateEventPatch {
    pub event_type: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub who: Option<String>,
    pub context: Option<serde_json::Value>,
    pub occurred_at: Option<i64>,
    pub entity_ids: Option<Vec<i64>>,
    pub ttl_days: Option<i64>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRecentOpts {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

// ──────────────────────────────────────────────────────────────────────────
// Cron — 스케줄러 (반복 / 1회 예약 / N초 후)
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CronJobMode {
    Cron,
    Once,
    Delay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CronTriggerType {
    CronScheduler,
    ScheduledOnce,
    DelayedRun,
}

/// runWhen 의 cron pre-condition 평가 — sysmod 호출 결과 의 특정 field 비교.
/// schema: `{ check: { sysmod, action, inputData? }, field, op, value }`. 2026-05-13 typed 적용 (옛 JSON Value).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunWhen {
    /// 평가 대상 — sysmod action 호출 결과의 field 검사.
    pub check: CronRunWhenCheck,
    /// 검사할 field path — `$prev.X` 또는 `X.Y` 형태. utils::condition.rs 가 평가.
    pub field: String,
    /// 비교 연산자 — `==` / `!=` / `>` / `<` / `>=` / `<=` / `contains` / `truthy` 등.
    pub op: String,
    /// 비교 값. truthy 등 인자 0 op 은 None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunWhenCheck {
    /// sysmod 이름 (예: "korea-invest").
    pub sysmod: String,
    /// sysmod action 이름 (예: "is-business-day").
    pub action: String,
    /// sysmod 호출 inputData — 비어있으면 omit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_data: Option<serde_json::Value>,
}

/// 실행 실패 시 retry 정책 — `{ count, delayMs? }`. 2026-05-13 typed 적용.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRetry {
    /// 재시도 횟수 (0 = 안 함). MAX_RETRY_COUNT 로 clamp.
    pub count: i64,
    /// 재시도 간 대기 시간 ms — 미설정 시 DEFAULT_RETRY_DELAY_MS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<i64>,
}

/// 알림 hook — 성공/실패 시 sysmod 호출 + template 치환. 2026-05-13 typed 적용.
/// schema: `{ onSuccess?: { sysmod, template?, chatId? }, onError?: {...} }`.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronNotify {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_success: Option<CronNotifyHook>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<CronNotifyHook>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronNotifyHook {
    /// 호출 sysmod (예: "telegram").
    pub sysmod: String,
    /// template (예: "✓ {title} 완료 ({durationMs}ms)") — 미설정 시 default template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    /// chat ID (예: 텔레그램 chat_id). sysmod 별 의미 다름.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
}

/// CronScheduleOptions — 스케줄링 등록 옵션.
/// 2026-05-14 A1-full Step 3: pipeline / runWhen / retry / notify 모두 typed.
/// inputData 만 동적 LLM payload 영역 — serde_json::Value 유지.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronScheduleOptions {
    #[serde(rename = "cronTime", default, skip_serializing_if = "Option::is_none")]
    pub cron_time: Option<String>,
    #[serde(rename = "runAt", default, skip_serializing_if = "Option::is_none")]
    pub run_at: Option<String>,
    #[serde(rename = "delaySec", default, skip_serializing_if = "Option::is_none")]
    pub delay_sec: Option<i64>,
    #[serde(rename = "startAt", default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(rename = "endAt", default, skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    #[serde(rename = "inputData", default, skip_serializing_if = "Option::is_none")]
    pub input_data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<Vec<crate::managers::task::PipelineStep>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "oneShot", default, skip_serializing_if = "Option::is_none")]
    pub one_shot: Option<bool>,
    #[serde(rename = "runWhen", default, skip_serializing_if = "Option::is_none")]
    pub run_when: Option<CronRunWhen>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<CronRetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify: Option<CronNotify>,
    #[serde(rename = "executionMode", default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(rename = "agentPrompt", default, skip_serializing_if = "Option::is_none")]
    pub agent_prompt: Option<String>,
    /// 데이터 격리 — None = admin (default), Some("hub:<id>") = 해당 hub visitor 소유.
    /// visitor 가 chat 안에서 자기 cron 을 만들 때 AI 가 자동 주입. admin endpoint 는 owner=None,
    /// 익명 hub endpoint 는 owner='hub:<instance.id>' 강제.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobInfo {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    pub mode: CronJobMode,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(flatten)]
    pub options: CronScheduleOptions,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTriggerInfo {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    pub trigger: CronTriggerType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(rename = "inputData", default, skip_serializing_if = "Option::is_none")]
    pub input_data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<Vec<crate::managers::task::PipelineStep>>,
    #[serde(rename = "oneShot", default, skip_serializing_if = "Option::is_none")]
    pub one_shot: Option<bool>,
    #[serde(rename = "runWhen", default, skip_serializing_if = "Option::is_none")]
    pub run_when: Option<CronRunWhen>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<CronRetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify: Option<CronNotify>,
    #[serde(rename = "executionMode", default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(rename = "agentPrompt", default, skip_serializing_if = "Option::is_none")]
    pub agent_prompt: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobResult {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    pub trigger: CronTriggerType,
    pub success: bool,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(rename = "stepsExecuted", default, skip_serializing_if = "Option::is_none")]
    pub steps_executed: Option<i64>,
    #[serde(rename = "stepsTotal", default, skip_serializing_if = "Option::is_none")]
    pub steps_total: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronLogEntry {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(rename = "triggeredAt")]
    pub triggered_at: String,
    pub success: bool,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(rename = "stepsExecuted", default, skip_serializing_if = "Option::is_none")]
    pub steps_executed: Option<i64>,
    #[serde(rename = "stepsTotal", default, skip_serializing_if = "Option::is_none")]
    pub steps_total: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronNotification {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub url: String,
    #[serde(rename = "triggeredAt")]
    pub triggered_at: String,
}

/// 캘린더 투영용 — cron 잡의 특정 구간 내 발화 시각 1건. cron 잡 자체가 source of truth 이고
/// 캘린더는 read-only 투영(중복 저장 0). 반복(cron_time)은 구간 내 N건으로 전개, runAt/delay 는
/// 1건. occurs_at = RFC3339 UTC (프론트가 로컬 표시).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronOccurrence {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(rename = "targetPath")]
    pub target_path: String,
    #[serde(rename = "occursAt")]
    pub occurs_at: String,
    /// "cron" | "once" | "delay"
    pub mode: String,
}

/// 트리거 콜백 — 매니저가 cron 어댑터에 등록. 타이머 발화 시 호출됨.
/// 매니저 → core.handleCronTrigger 위임 (BIBLE: cron 콜백도 Core facade 경유).
pub type CronTriggerCallback = std::sync::Arc<
    dyn Fn(
            CronTriggerInfo,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = CronJobResult> + Send>>
        + Send
        + Sync,
>;

/// ICronPort — 스케줄러 port. 옛 TS infra/cron/index.ts Rust 재현.
///
/// 동기 + async 혼합 — list / getLogs / consumeNotifications 는 sync (in-memory),
/// schedule / cancel / triggerNow 는 async (파일 영속 + tokio task spawn).
#[async_trait::async_trait]
pub trait ICronPort: Send + Sync {
    async fn schedule(
        &self,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()>;
    /// 매 job 의 cancel 결과 — `Ok(true)` = cancelled, `Ok(false)` = job_id 미존재, `Err` = internal.
    /// 옛 단순 `InfraResult<()>` 의 not_found 와 internal 구분 불가 문제 해결.
    async fn cancel(&self, job_id: &str) -> InfraResult<bool>;
    async fn trigger_now(&self, job_id: &str) -> InfraResult<()>;
    fn list(&self) -> Vec<CronJobInfo>;
    fn set_timezone(&self, tz: &str);
    fn get_timezone(&self) -> String;
    fn on_trigger(&self, callback: CronTriggerCallback);
    fn get_logs(&self, limit: Option<usize>) -> Vec<CronLogEntry>;
    fn clear_logs(&self);
    fn consume_notifications(&self) -> Vec<CronNotification>;
    fn append_notify(&self, entry: CronNotification);

    /// 캘린더 투영용 — [from_iso, to_iso] 구간 내 모든 cron 발화 시각 전개. 반복(cron_time)은
    /// 구간 내 N건, runAt/delay 는 1건(구간 포함 시). owner 필터 (None=admin scope).
    /// default = 빈 Vec — occurrence 계산은 cron crate 가 있는 infra 책임이라 mock·미구현 어댑터 무영향.
    fn list_occurrences(
        &self,
        _from_iso: &str,
        _to_iso: &str,
        _owner: Option<&str>,
    ) -> Vec<CronOccurrence> {
        Vec::new()
    }

    /// schedule + spawn 통합 — 옛 TS 의 Manager 측 helper 가 trait 으로 격리.
    /// `self: Arc<Self>` 시그니처 — adapter 가 weak ref 로 task 안에서 self.upgrade() 해야 하므로.
    async fn schedule_with_spawn(
        self: std::sync::Arc<Self>,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()>;

    /// 부팅 시 영속 파일에 설정되어 있던 잡들 task 재시작.
    /// delay 잡은 복원 불가 (시각 정보 부재), cron / once 만 복원.
    /// `self: Arc<Self>` — spawn_task 가 Arc::downgrade(self) 필요.
    async fn restore(self: std::sync::Arc<Self>);
}

// ──────────────────────────────────────────────────────────────────────────
// Media — AI 생성 이미지 / OG / 업로드 공용 인프라
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaScope {
    User,
    System,
}

impl MediaScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaScope::User => "user",
            MediaScope::System => "system",
        }
    }

    /// `"user"` / `"system"` 외 입력은 `User` 폴백 (옛 TS default 와 동일).
    pub fn from_str_or_user(s: &str) -> Self {
        match s {
            "system" => MediaScope::System,
            _ => MediaScope::User,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSaveOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(rename = "filenameHint", default, skip_serializing_if = "Option::is_none")]
    pub filename_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MediaScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(rename = "revisedPrompt", default, skip_serializing_if = "Option::is_none")]
    pub revised_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(rename = "aspectRatio", default, skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>, // "ai-generated" / "upload"
    /// hub instance id — Some 이면 `user/hub/<id>/media/` 영역에 저장 (scope 무시).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "hubOwner")]
    pub hub_owner: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaVariant {
    pub width: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    pub format: String,
    pub url: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSaveResult {
    pub slug: String,
    pub url: String,
    #[serde(rename = "thumbnailUrl", default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<MediaVariant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blurhash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    pub bytes: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileRecord {
    pub slug: String,
    pub ext: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    pub bytes: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MediaScope>,
    #[serde(rename = "filenameHint", default, skip_serializing_if = "Option::is_none")]
    pub filename_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(rename = "revisedPrompt", default, skip_serializing_if = "Option::is_none")]
    pub revised_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(rename = "aspectRatio", default, skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<MediaVariant>,
    #[serde(rename = "thumbnailUrl", default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blurhash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>, // 'rendering' | 'done' | 'error'
    #[serde(rename = "errorMsg", default, skip_serializing_if = "Option::is_none")]
    pub error_msg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// hub instance id — Some 이면 hub-scoped (`user/hub/<id>/media/<slug>.<ext>`).
    /// None = admin scope (user/system).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "hubOwner")]
    pub hub_owner: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaListOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MediaScope>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    /// hub instance id — Some 이면 `user/hub/<id>/media/` 영역만 조회 (scope 무시).
    /// None = admin 영역 (`user/media` + `system/media`).
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "hubOwner")]
    pub hub_owner: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaListResult {
    pub items: Vec<MediaFileRecord>,
    pub total: usize,
}

/// 단일 variant 메타 — `width / height / format / bytes` (URL 은 save_variant 반환).
/// `MediaVariant` 와 같은 타입 (i64) 통일 — variants 배열에 직접 push 가능.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaVariantMeta {
    pub width: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    pub format: String,
    pub bytes: i64,
}

/// IMediaPort — 미디어 (이미지) 영속 + 갤러리 + variants + placeholder swap.
///
/// 옛 TS `infra/media/local-adapter.ts` 1:1 port. Phase B-18 Step 2d 설정:
///   - save_variant (resize 결과 저장) + finalize_base (비동기 image_gen placeholder swap)
///   - 모든 메서드 async (FS I/O — tokio::fs)
#[async_trait::async_trait]
pub trait IMediaPort: Send + Sync {
    /// binary 저장 + URL 발급. 원본만 저장 — variants 는 save_variant 로 별도 기록.
    async fn save(
        &self,
        binary: &[u8],
        content_type: &str,
        opts: &MediaSaveOptions,
    ) -> InfraResult<MediaSaveResult>;

    /// 실패 기록 저장 — 원본 binary 없이 메타 JSON 만 `status='error'` 로 기록.
    /// 사용자가 갤러리에서 재생성·삭제 결정할 수 있도록 prompt·model 등 보존.
    async fn save_error_record(
        &self,
        opts: &MediaSaveOptions,
        error_msg: &str,
    ) -> InfraResult<String>;

    /// 기존 slug 의 base 파일을 새 binary 로 교체 (placeholder → 실제 이미지 swap).
    /// 비동기 image_gen 패턴 — startGenerate 가 placeholder 저장 후 reserve 한 slug 를 백그라운드에서 finalize.
    /// meta 도 함께 업데이트 (bytes/contentType) — status 는 caller 가 별도 update_meta 로 'done' 설정.
    /// `ext_override` 설정되어 있으면 새 확장자 (`png` → `webp` 변환 시), 미설정 시 content_type 에서 추론.
    async fn finalize_base(
        &self,
        slug: &str,
        scope: &str,
        binary: &[u8],
        content_type: &str,
        ext_override: Option<&str>,
    ) -> InfraResult<()>;

    /// variant / thumbnail binary 를 기존 slug 에 연결해 저장.
    /// suffix 규칙: `'480w'`, `'thumb'`, `'full'` 등. 반환 = variant URL.
    async fn save_variant(
        &self,
        slug: &str,
        scope: &str,
        suffix: &str,
        format: &str,
        binary: &[u8],
        variant_meta: &MediaVariantMeta,
    ) -> InfraResult<String>;

    async fn read(&self, slug: &str) -> InfraResult<Option<(Vec<u8>, String, MediaFileRecord)>>;
    async fn stat(&self, slug: &str) -> InfraResult<Option<MediaFileRecord>>;
    async fn remove(&self, slug: &str) -> InfraResult<()>;
    async fn list(&self, opts: &MediaListOpts) -> InfraResult<MediaListResult>;
    async fn update_meta(&self, slug: &str, patch: &serde_json::Value) -> InfraResult<()>;

    /// 채팅 첨부 이미지 임시 저장 — sharp variants 0, raw 그대로. 별도 디렉토리 (`user/attachments/`).
    /// 갤러리 (`user/media/`) 와 분리 — 1회성 첨부 누적 차단 + 30일 후 cleanup cron 이 자동 삭제.
    /// 응답: `/user/attachments/<slug>.<ext>` URL.
    /// 보안: caller (MediaManager) 가 magic byte 검증 + 크기 제한 처리 후 호출.
    async fn save_temp_attachment(&self, binary: &[u8], ext: &str) -> InfraResult<String>;

    /// 채팅 첨부 임시 이미지 read — `/user/attachments/<filename>` URL handler 가 호출.
    /// Returns: (binary, content_type). 미존재 시 Ok(None).
    /// filename = `<slug>.<ext>` (path traversal 가드 — `..` / `/` 차단은 caller 책임).
    async fn read_temp_attachment(
        &self,
        filename: &str,
    ) -> InfraResult<Option<(Vec<u8>, String)>>;

    /// 30일 retention cleanup — `cutoff_ms` 보다 mtime 이 오래된 임시 첨부 일괄 삭제.
    /// 응답: 삭제된 파일 개수.
    async fn cleanup_old_attachments(&self, cutoff_ms: i64) -> InfraResult<i64>;
}

/// IEpisodicPort — Phase 2 episodic tier port.
///
/// save_event / search_events 2개는 async — IEmbedderPort 호출 (`embed_passage` 자동
/// 임베딩 + `embed_query` cosine 검색). 나머지는 임베딩 미사용 — sync 유지.
#[async_trait::async_trait]
pub trait IEpisodicPort: Send + Sync {
    async fn save_event(&self, input: &SaveEventInput) -> InfraResult<(i64, bool, Option<f64>)>;
    fn update_event(&self, id: i64, patch: &UpdateEventPatch) -> InfraResult<()>;
    fn remove_event(&self, id: i64) -> InfraResult<()>;
    fn get_event(&self, id: i64) -> InfraResult<Option<EventRecord>>;
    async fn search_events(&self, opts: &EventSearchOpts) -> InfraResult<Vec<EventRecord>>;
    fn list_recent_events(&self, opts: &ListRecentOpts) -> InfraResult<Vec<EventRecord>>;
    fn link_event_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()>;
    fn unlink_event_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()>;
    fn cleanup_expired_events(&self) -> InfraResult<i64>;

    fn count_events(&self) -> InfraResult<i64>;
    fn count_events_by_type(&self) -> InfraResult<Vec<(String, i64)>>;
}

// ──────────────────────────────────────────────────────────────────────────
// IPostTurnExtractor — 답변 완료 후 백그라운드 메모리 추출 (Stage 2).
//
// AiManager 가 한 턴(멀티턴 도구 루프 포함) 응답을 끝낸 뒤 detached 로 1회 호출. 방금 exchange 에서
// Recall 사실 + Memory 교훈을 추출·저장. AiManager → ConsolidationManager 직접 의존(Arc 사이클)을
// 피하려 port 로 추출 — AiManager 는 trait 만 의존. 구현은 ConsolidationManager.
// fire-and-forget — 에러는 구현부 로깅, 반환 없음.
// ──────────────────────────────────────────────────────────────────────────

#[async_trait::async_trait]
pub trait IPostTurnExtractor: Send + Sync {
    async fn extract_after_turn(
        &self,
        owner: &str,
        conv_id: Option<&str>,
        user_msg: &str,
        assistant_msg: &str,
    );
}

// ──────────────────────────────────────────────────────────────────────────
// IMemoryFacadePort — 메모리 4-tier facade.
//
// ConsolidationManager 가 EntityManager + EpisodicManager 를 직접 의존하던 BIBLE 위반
// (매니저 간 직접 호출) 정정. trait 추출로 hexagonal port-adapter 정신 정확 복구.
// 구현은 `core/src/managers/memory_facade.rs::MemoryFacade` (Entity/Episodic wrapper).
// ──────────────────────────────────────────────────────────────────────────

#[async_trait::async_trait]
pub trait IMemoryFacadePort: Send + Sync {
    // Read / 통계
    fn count_entities(&self) -> InfraResult<i64>;
    fn count_facts(&self) -> InfraResult<i64>;
    fn count_events(&self) -> InfraResult<i64>;
    fn count_entities_by_type(&self) -> InfraResult<Vec<(String, i64)>>;
    fn count_events_by_type(&self) -> InfraResult<Vec<(String, i64)>>;

    // 정리
    fn cleanup_expired_facts(&self) -> InfraResult<i64>;
    fn cleanup_expired_events(&self) -> InfraResult<i64>;

    // Mutation — ConsolidationManager 의 save_extracted 가 사용 (LLM 추출 결과 일괄 저장).
    fn find_entity_by_name(&self, name: &str) -> InfraResult<Option<EntityRecord>>;
    async fn save_entity(&self, input: SaveEntityInput) -> InfraResult<(i64, bool)>;
    async fn save_fact(&self, input: SaveFactInput) -> InfraResult<(i64, bool, Option<f64>)>;
    async fn save_event(&self, input: SaveEventInput) -> InfraResult<(i64, bool, Option<f64>)>;
}

// ──────────────────────────────────────────────────────────────────────────
// IDatabasePort — raw SQL escape hatch (Phase C 진입 전 cleanup, 2026-05-06).
//
// 옛 services/database.rs 가 rusqlite::Connection 직접 의존하던 BIBLE 위반 (Core 순수성)
// 정정. SELECT 만 허용 — INSERT/UPDATE/DELETE 는 도메인 메서드 사용 권장.
// 단일 SQLite 단계에선 escape hatch 단계, MariaDB / PostgreSQL swap 시점에 어댑터별
// SQL dialect 분리 가능.
// ──────────────────────────────────────────────────────────────────────────

/// Raw SELECT 쿼리 결과 — 행마다 column → JSON value map.
pub type RawSqlRow = serde_json::Map<String, serde_json::Value>;

// ──────────────────────────────────────────────────────────────────────────
// INetworkPort — services (network / telegram) 의 외부 HTTP 호출 추상화.
//
// 옛 services 가 reqwest 직접 의존하던 BIBLE Core 순수성 위반 정정 (Phase B-post audit, 2026-05-06).
// 구현은 `infra/src/adapters/network.rs::ReqwestNetworkAdapter` (reqwest 0.12).
// telegram bot API 호출 / sandbox NETWORK_REQUEST step / network gRPC service 모두 이 port 경유.
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRequest {
    pub url: String,
    /// HTTP method — `"GET"` / `"POST"` / `"PUT"` / `"DELETE"` 등. parse 실패 시 어댑터에서 Err.
    #[serde(default = "default_get_method")]
    pub method: String,
    /// Headers map — 미설정 시 기본값.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
    /// Body — string 이면 raw, object/array 면 JSON serialize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
    /// Timeout ms (default 30s).
    #[serde(rename = "timeoutMs", default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_get_method() -> String { "GET".to_string() }
fn default_timeout_ms() -> u64 { 30_000 }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: std::collections::HashMap<String, String>,
    /// JSON parsable body 면 parse, 아니면 string.
    pub body: serde_json::Value,
}

#[async_trait::async_trait]
pub trait INetworkPort: Send + Sync {
    async fn fetch(&self, req: NetworkRequest) -> InfraResult<NetworkResponse>;
}

// ─── Hub Phase 1 (2026-05-17) ─────────────────────────────────────────
// system service `hub` 의 데이터 모델 + Port. 외부 워드프레스 사이트 연결용.
// admin chat 과 별개 (conversation / message 테이블 분리).

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubInstance {
    pub id: String,
    pub slug: String,                       // URL (예: "lawassistant")
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,      // Hub 페르소나 / 가드레일
    pub allowed_references: Vec<String>,    // Library Reference id 배열
    pub allowed_sysmods: Vec<String>,       // sysmod 이름 배열 (빈 = 0개 노출)
    pub model_id: Option<String>,           // LLM 영역. None = system default
    pub enabled: bool,
    pub api_token: String,                  // 외부 호출 인증 (32 byte hex 자동 생성)
    pub allowed_domains: Vec<String>,       // origin whitelist (외부 사이트 임베드만, self host 자동 허용)
    pub created_at: i64,
    pub updated_at: i64,
    // 노출 형태 — 한 instance 가 widget / page 둘 다 활성 가능. default 둘 다 true.
    pub expose_widget: bool,                // 외부 사이트 임베드 풍선 widget (allowed_domains 검증)
    pub expose_page: bool,                  // 우리 사이트 풀스크린 URL `/<slug>` (self host 자동 허용)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubConversation {
    pub id: String,
    pub instance_id: String,
    pub session_id: String,                 // 방문자 localStorage UUID
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,                       // "user" / "system"
    pub content: Option<String>,            // 본문
    pub data_json: Option<String>,          // blocks / tool_results / library_hits (raw JSON)
    pub created_at: i64,
}

#[async_trait::async_trait]
pub trait IHubPort: Send + Sync {
    // ── Instance CRUD ──
    async fn create_instance(&self, instance: &HubInstance) -> InfraResult<()>;

    async fn list_instances(&self) -> InfraResult<Vec<HubInstance>>;

    async fn get_instance(&self, id: &str) -> InfraResult<Option<HubInstance>>;

    /// slug 영역 lookup — 외부 endpoint 에서 /api/hub/<slug>/chat 호출 시.
    async fn get_instance_by_slug(&self, slug: &str) -> InfraResult<Option<HubInstance>>;

    async fn update_instance(&self, instance: &HubInstance) -> InfraResult<()>;

    async fn delete_instance(&self, id: &str) -> InfraResult<()>;

    // ── Conversation CRUD ──
    /// (instance_id, session_id) → 옛 대화 있으면 그 id, 없으면 새 conversation 생성 + id 반환.
    async fn ensure_conversation(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<String>;

    /// (instance_id, session_id) → 항상 새 conversation 생성 + id 반환. multi-conv 영역에서
    /// 사용자가 "새 대화" 누를 때 호출. ensure 와 달리 옛 conv 있어도 새 conv 추가.
    async fn create_conversation(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<String>;

    async fn list_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<HubConversation>>;

    /// 휴지통 목록 — deleted_at IS NOT NULL. 최신 삭제 순.
    async fn list_deleted_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<HubConversation>>;

    async fn get_conversation(&self, id: &str) -> InfraResult<Option<HubConversation>>;

    /// soft delete — deleted_at 갱신. 30일 후 cron 이 영구 삭제.
    async fn delete_conversation(&self, id: &str) -> InfraResult<()>;

    /// 휴지통에서 복원 — deleted_at NULL.
    async fn restore_conversation(&self, id: &str) -> InfraResult<()>;

    /// 영구 삭제 — hard delete. messages cascade.
    async fn permanent_delete_conversation(&self, id: &str) -> InfraResult<()>;

    /// 30일 retention cleanup — `cutoff_ms` 이전 deleted_at row 일괄 hard delete.
    /// 응답: 삭제된 row 개수.
    async fn cleanup_old_deleted_conversations(&self, cutoff_ms: i64) -> InfraResult<i64>;

    /// title 자동 업데이트 (첫 user 메시지 요약 등).
    async fn update_conversation_title(&self, id: &str, title: &str) -> InfraResult<()>;

    // ── Message CRUD ──
    async fn append_message(&self, msg: &HubMessage) -> InfraResult<()>;

    async fn list_messages(&self, conversation_id: &str) -> InfraResult<Vec<HubMessage>>;
}

