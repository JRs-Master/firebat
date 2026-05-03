//! Hexagonal Architecture — Port (interface) 정의.
//!
//! Core 매니저는 이 trait 만 의존. 실 I/O 는 adapters/ 의 구현체가 담당.
//! BIBLE 의 "Core 순수성" 원칙 그대로 — 매니저가 fs / network / DB 직접 사용 X.
//!
//! Phase B 진행하며 17 포트 박힘:
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

/// IStoragePort — 파일 시스템 접근. workspace zone 격리 (path traversal 차단).
#[async_trait::async_trait]
pub trait IStoragePort: Send + Sync {
    /// 텍스트 파일 read (UTF-8).
    async fn read(&self, path: &str) -> InfraResult<String>;

    /// 텍스트 파일 write — 디렉토리 자동 생성 (mkdir -p).
    async fn write(&self, path: &str, content: &str) -> InfraResult<()>;

    /// 파일 또는 디렉토리 delete (recursive).
    async fn delete(&self, path: &str) -> InfraResult<()>;

    /// 디렉토리 안 entry 나열.
    async fn list_dir(&self, path: &str) -> InfraResult<Vec<DirEntry>>;

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

/// IAuthPort — 세션 저장 (Vault 위에 박힘). 동기 — Vault 와 동일.
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
}

// ──────────────────────────────────────────────────────────────────────────
// Database — pages / conversations 등 SQL 저장
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    fn delete_conversation(&self, owner: &str, id: &str) -> bool;
    fn is_conversation_deleted(&self, owner: &str, id: &str) -> bool;
    fn get_cli_session(&self, conversation_id: &str, current_model: &str) -> Option<String>;
    fn set_cli_session(&self, conversation_id: &str, session_id: &str, model: &str) -> bool;
    fn get_active_plan_state(&self, conversation_id: &str) -> Option<String>;
    fn set_active_plan_state(&self, conversation_id: &str, state: Option<&str>) -> bool;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModuleOutput {
    pub success: bool,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SandboxExecuteOpts {
    /// 추가 환경 변수 (Vault 시크릿 자동 주입 외).
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// timeout milliseconds. None = 기본값 (Phase B 진행 시 SANDBOX_TIMEOUT_MS 상수 활용).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// ISandboxPort — sysmod 자식 process spawn (Node / Python / etc).
///
/// Phase B 의 minimum stub — 실 sysmod spawn 구현은 후속 phase 에서 박음.
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
}

// ──────────────────────────────────────────────────────────────────────────
// MCP Client — 외부 MCP 서버 (Gmail, Slack, 카톡 등) 등록·연결·도구 호출
// ──────────────────────────────────────────────────────────────────────────

/// 옛 TS McpServerConfig Rust 재현. 전송 방식 stdio / sse 두 가지.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema", default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

/// IMcpClientPort — 옛 TS IMcpClientPort Rust port.
///
/// Phase B-11 minimum: listServers / addServer / removeServer 만 박힘 (JSON 파일 영속).
/// listTools / callTool 은 Phase B-15+ 후속 — `rmcp` crate (stdio + sse) 박힌 후 활성.
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
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct EntitySearchOpts {
    #[serde(default)]
    pub query: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
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
}

#[derive(Debug, Clone, Default)]
pub struct SaveEntityInput {
    pub name: String,
    pub entity_type: String,
    pub aliases: Vec<String>,
    pub metadata: Option<serde_json::Value>,
    pub source_conv_id: Option<String>,
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
pub struct TimelineOpts {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(rename = "orderBy", default)]
    pub order_by: Option<String>, // "occurredAt" | "createdAt"
}

/// IEntityPort — Phase 1 entity tier port.
///
/// 동기 — rusqlite 가 sync (다른 IDatabasePort 와 통일).
/// Phase B-12 minimum: 임베딩 미박음 (search = name + alias substring 매칭).
/// Phase B-15+ 에서 IEmbedderPort 박힌 후 cosine search 활성.
pub trait IEntityPort: Send + Sync {
    fn save_entity(&self, input: &SaveEntityInput) -> InfraResult<(i64, bool)>;
    fn update_entity(&self, id: i64, patch: &UpdateEntityPatch) -> InfraResult<()>;
    fn remove_entity(&self, id: i64) -> InfraResult<()>;
    fn get_entity(&self, id: i64) -> InfraResult<Option<EntityRecord>>;
    fn find_entity_by_name(&self, name: &str) -> InfraResult<Option<EntityRecord>>;
    fn search_entities(&self, opts: &EntitySearchOpts) -> InfraResult<Vec<EntityRecord>>;

    fn save_fact(&self, input: &SaveFactInput) -> InfraResult<(i64, bool, Option<f64>)>;
    fn update_fact(&self, id: i64, patch: &UpdateFactPatch) -> InfraResult<()>;
    fn remove_fact(&self, id: i64) -> InfraResult<()>;
    fn get_fact(&self, id: i64) -> InfraResult<Option<EntityFactRecord>>;
    fn list_facts_by_entity(
        &self,
        entity_id: i64,
        opts: &TimelineOpts,
    ) -> InfraResult<Vec<EntityFactRecord>>;
    fn search_facts(&self, opts: &FactSearchOpts) -> InfraResult<Vec<EntityFactRecord>>;
    fn cleanup_expired_facts(&self) -> InfraResult<i64>;

    /// 통계 — 매니저 retrieve_context / health stats 에서 활용.
    fn count_entities(&self) -> InfraResult<i64>;
    fn count_facts(&self) -> InfraResult<i64>;
    fn count_entities_by_type(&self) -> InfraResult<Vec<(String, i64)>>;
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
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
pub struct ListRecentOpts {
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

/// IEpisodicPort — Phase 2 episodic tier port.
pub trait IEpisodicPort: Send + Sync {
    fn save_event(&self, input: &SaveEventInput) -> InfraResult<(i64, bool, Option<f64>)>;
    fn update_event(&self, id: i64, patch: &UpdateEventPatch) -> InfraResult<()>;
    fn remove_event(&self, id: i64) -> InfraResult<()>;
    fn get_event(&self, id: i64) -> InfraResult<Option<EventRecord>>;
    fn search_events(&self, opts: &EventSearchOpts) -> InfraResult<Vec<EventRecord>>;
    fn list_recent_events(&self, opts: &ListRecentOpts) -> InfraResult<Vec<EventRecord>>;
    fn link_event_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()>;
    fn unlink_event_entity(&self, event_id: i64, entity_id: i64) -> InfraResult<()>;
    fn cleanup_expired_events(&self) -> InfraResult<i64>;

    fn count_events(&self) -> InfraResult<i64>;
    fn count_events_by_type(&self) -> InfraResult<Vec<(String, i64)>>;
}
