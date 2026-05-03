//! Image generation adapters — IImageGenPort 구현체.
//!
//! - **stub** (`StubImageGenAdapter`): 1x1 PNG + 고정 reply. wiring 검증 + 단위 테스트.
//! - **config_driven** (`ConfigDrivenImageGenAdapter`): LLM 의 ConfigDrivenAdapter 와 대칭 구조.
//!   format handler 3종 + JSON config carousel. Step 2c 박힐 예정.
//!
//! 옛 TS `infra/image/` 1:1 port. ConfigDrivenAdapter 패턴 — 새 모델 = JSON 1개 추가만 (코드 변경 0).
//!
//! Format handlers (Step 2c):
//!   - `openai-image` — `/v1/images/generations` + `/v1/images/edits` (gpt-image-1, gpt-image-2)
//!   - `gemini-native-image` — `gemini-3.1-flash-image:generateContent` (multimodal)
//!   - `cli-codex-image` — `codex` CLI subprocess (구독 기반, 비용 0)

pub mod stub;

pub use stub::StubImageGenAdapter;
