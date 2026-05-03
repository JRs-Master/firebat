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

use std::path::Path;

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
