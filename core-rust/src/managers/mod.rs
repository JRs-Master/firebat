//! Core 매니저들 — Phase B 진행하며 21 매니저 박힘.
//!
//! 매니저는 ports.rs 의 trait 만 의존. 실 I/O 는 adapters/ 가 담당.

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
pub mod schedule;
