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
