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

/// 바이너리 파일 read 결과 — base64 + mime + size. 옛 TS readBinary 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BinaryReadResult {
    pub base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub size: usize,
}

/// grep 매치 1건 — file:line:text. 옛 TS grep 결과 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    /// data/cache/ 안에 박힘. 옛 TS writeCache 1:1.
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
/// ConfigDrivenAdapter 패턴 (LLM 처럼 여러 provider 혼합) 박지 않은 이유 — 옛 TS 가
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
// Image Processor — 이미지 후처리 (resize/convert/blurhash/placeholder).
// 옛 TS `infra/image-processor/sharp-adapter.ts` 1:1 port. Rust 측에서는 image-rs +
// fast_image_resize + blurhash crate 조합 (sharp = libvips Node binding 의 Rust 등가).
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

    /// Blurhash LQIP 문자열 (~32자 base83). components 미박음 시 default 4x4.
    /// 페이지 reload 전 placeholder 로 표시 (PageSpec 의 Image 블록에 자동 박힘).
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
    /// 모델 ID override — 미박음 시 ImageGenCallOpts 의 default
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
pub struct ToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "inputSchema", default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct LlmCallOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "thinkingLevel", default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(rename = "systemPrompt", default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(rename = "maxTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// 대화 owner — HistoryResolver 가 자동 history 컨텍스트 인출 시 활용. 미박힘 시 기본 "admin".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// 대화 ID — HistoryResolver 가 recent N 메시지 조회. 미박힘 시 history 컨텍스트 비활성.
    #[serde(rename = "conversationId", default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// CLI 모드 (Claude Code / Codex / Gemini CLI) 의 resume session_id — 옛 TS `cliResumeSessionId` 1:1.
    /// 박혀있으면 어댑터가 `--resume <id>` / `exec resume <id>` / `--resume <uuid>` 로 cold spawn.
    #[serde(rename = "cliResumeSessionId", default, skip_serializing_if = "Option::is_none")]
    pub cli_resume_session_id: Option<String>,
    /// OpenAI Responses API 의 previous_response_id — 서버 history persistence (멀티턴 토큰 절감).
    /// 옛 TS `previousResponseId` 1:1.
    #[serde(rename = "previousResponseId", default, skip_serializing_if = "Option::is_none")]
    pub previous_response_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
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
    /// CLI 모드 어댑터가 첫 turn 에서 잡은 session_id — 옛 TS `onCliSessionId` 콜백 패턴 대신
    /// response 에 박아 callee (AiManager) 가 직접 DB 영속화. 다음 turn `cli_resume_session_id` 으로 사용.
    #[serde(rename = "cliSessionId", default, skip_serializing_if = "Option::is_none")]
    pub cli_session_id: Option<String>,
    /// OpenAI Responses API 가 발급한 response_id — 다음 turn `previous_response_id` 으로 재사용.
    /// 옛 TS `responseId` 1:1.
    #[serde(rename = "responseId", default, skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
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
}

/// Cron agent 컨텍스트 — 옛 TS `AiRequestOpts.cronAgent` 1:1.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CronAgentOpts {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
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
    async fn ask_text(&self, prompt: &str, opts: &LlmCallOpts) -> InfraResult<LlmTextResponse>;
    async fn ask_with_tools(
        &self,
        prompt: &str,
        tools: &[ToolDefinition],
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse>;
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

/// CronScheduleOptions — 스케줄링 등록 옵션.
/// pipeline / notify / runWhen / retry / agentPrompt 같은 복합 필드는 Phase B-13 minimum 단계에서
/// `serde_json::Value` 패스스루 — Phase B-14 TaskManager + B-16 AiManager 박힌 후 typed.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
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
    pub pipeline: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "oneShot", default, skip_serializing_if = "Option::is_none")]
    pub one_shot: Option<bool>,
    #[serde(rename = "runWhen", default, skip_serializing_if = "Option::is_none")]
    pub run_when: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify: Option<serde_json::Value>,
    #[serde(rename = "executionMode", default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(rename = "agentPrompt", default, skip_serializing_if = "Option::is_none")]
    pub agent_prompt: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    pub pipeline: Option<serde_json::Value>,
    #[serde(rename = "oneShot", default, skip_serializing_if = "Option::is_none")]
    pub one_shot: Option<bool>,
    #[serde(rename = "runWhen", default, skip_serializing_if = "Option::is_none")]
    pub run_when: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify: Option<serde_json::Value>,
    #[serde(rename = "executionMode", default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(rename = "agentPrompt", default, skip_serializing_if = "Option::is_none")]
    pub agent_prompt: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
pub struct CronNotification {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub url: String,
    #[serde(rename = "triggeredAt")]
    pub triggered_at: String,
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
    async fn cancel(&self, job_id: &str) -> InfraResult<()>;
    async fn trigger_now(&self, job_id: &str) -> InfraResult<()>;
    fn list(&self) -> Vec<CronJobInfo>;
    fn set_timezone(&self, tz: &str);
    fn get_timezone(&self) -> String;
    fn on_trigger(&self, callback: CronTriggerCallback);
    fn get_logs(&self, limit: Option<usize>) -> Vec<CronLogEntry>;
    fn clear_logs(&self);
    fn consume_notifications(&self) -> Vec<CronNotification>;
    fn append_notify(&self, entry: CronNotification);
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
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MediaVariant {
    pub width: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    pub format: String,
    pub url: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MediaListOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MediaScope>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MediaListResult {
    pub items: Vec<MediaFileRecord>,
    pub total: usize,
}

/// 단일 variant 메타 — `width / height / format / bytes` (URL 은 save_variant 반환).
/// `MediaVariant` 와 같은 타입 (i64) 통일 — variants 배열에 직접 push 가능.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MediaVariantMeta {
    pub width: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    pub format: String,
    pub bytes: i64,
}

/// IMediaPort — 미디어 (이미지) 영속 + 갤러리 + variants + placeholder swap.
///
/// 옛 TS `infra/media/local-adapter.ts` 1:1 port. Phase B-18 Step 2d 박힘:
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
    /// 비동기 image_gen 패턴 — startGenerate 가 placeholder 박고 reserve 한 slug 를 백그라운드에서 finalize.
    /// meta 도 함께 업데이트 (bytes/contentType) — status 는 caller 가 별도 update_meta 로 'done' 설정.
    /// `ext_override` 박혀있으면 새 확장자 (`png` → `webp` 변환 시), 미박음 시 content_type 에서 추론.
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
