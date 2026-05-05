//! Embedder adapters — IEmbedderPort 의 구현체들.
//!
//! - **stub** (`StubEmbedderAdapter`): FNV-1a 결정론 hash, 384-dim. 빌드/CI 환경 + 단위 테스트용.
//! - **e5_local** (`E5LocalEmbedderAdapter`): candle + multilingual-e5-small (intfloat) safetensors
//!   로컬 추론. 옛 TS `Xenova/multilingual-e5-small` (transformers.js) 1:1 port.
//!
//! main.rs 에서 env `FIREBAT_EMBEDDER` 로 선택:
//!   - `stub` (default) — 가벼움, 의미 검색 X
//!   - `e5` — 진짜 의미 검색. 첫 실행 시 ~470MB 모델 자동 다운로드 (HuggingFace Hub).
//!
//! 향후 provider 추가 (Gemini text-embedding-004 / OpenAI text-embedding-3-small 등) 시
//! 같은 패턴 — 새 파일 + IEmbedderPort impl + main.rs env 매칭.

pub mod stub;
pub mod e5_local;

pub use stub::StubEmbedderAdapter;
pub use e5_local::E5LocalEmbedderAdapter;
