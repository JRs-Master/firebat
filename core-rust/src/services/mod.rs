//! gRPC service trait impls — Phase B-2 박힘.
//!
//! 각 service 가 매니저를 wrapping. proto 의 JsonArgs / JsonValue 를 매니저의 typed 인자로
//! 변환 (Phase B 단계). 이후 매니저별 typed message 박힐 때 generated stub 직접 활용.

pub mod template;
pub mod secret;
pub mod auth;
pub mod event;
pub mod capability;
pub mod status;
pub mod tool;
pub mod cost;
pub mod project;
pub mod module;
pub mod page;
pub mod conversation;
pub mod mcp;
pub mod entity;
pub mod episodic;
pub mod consolidation;
