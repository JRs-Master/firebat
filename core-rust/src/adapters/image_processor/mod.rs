//! Image processor adapters — IImageProcessorPort 구현체.
//!
//! - **stub** (`StubImageProcessorAdapter`): no-op (메타 0/0 + binary 그대로 반환). wiring 용.
//! - **image_rs** (`ImageRsProcessorAdapter`): image-rs + fast_image_resize + blurhash crate.
//!   옛 TS `infra/image-processor/sharp-adapter.ts` 1:1 port. Step 2b 박힐 예정.
//!
//! main.rs 에서 env `FIREBAT_IMAGE_PROCESSOR` 로 swap (기본 stub).
//!
//! 향후 어댑터 추가 시 같은 패턴 — 파일 추가 + IImageProcessorPort impl + main.rs env 매칭.

pub mod stub;
pub mod image_rs;

pub use stub::StubImageProcessorAdapter;
pub use image_rs::ImageRsProcessorAdapter;
