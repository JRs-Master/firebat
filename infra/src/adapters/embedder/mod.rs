//! Embedder adapters — IEmbedderPort 의 구현체들.
//!
//! - **stub** (`StubEmbedderAdapter`): FNV-1a 결정론 hash, 384-dim. 빌드/CI 환경 + 단위 테스트용.
//! - **e5_local** (`E5LocalEmbedderAdapter`): candle + multilingual-e5-small (intfloat) safetensors
//!   로컬 추론. 384-dim, max_length 512. 옛 영역 — 가벼운 fallback.
//! - **arctic_local** (`ArcticLocalEmbedderAdapter`): candle + Snowflake/snowflake-arctic-embed-l-v2.0
//!   safetensors 로컬 추론. 1024-dim, max_length 8192. 다국어 영역 매우 우수 (MTEB 65.8).
//!   **운영 default 권장** — Library 영역 의 긴 자료 영역 자연 (max_length 8192).
//!
//! main.rs 에서 env `FIREBAT_EMBEDDER` 로 선택:
//!   - `arctic` (default 권장) — Library + 메모리 검색 영역 최상위
//!   - `e5` — 옛 영역 (가벼움, 384-dim, max_length 512)
//!   - `stub` — CI / dev 영역
//!
//! 향후 provider 추가 (Gemini text-embedding-004 / OpenAI text-embedding-3-small 등) 시
//! 같은 패턴 — 새 파일 + IEmbedderPort impl + main.rs env 매칭.

pub mod stub;
pub mod e5_local;
pub mod arctic_local;

pub use stub::StubEmbedderAdapter;
pub use e5_local::E5LocalEmbedderAdapter;
pub use arctic_local::ArcticLocalEmbedderAdapter;
