//! Principal — who is making the current request.
//!
//! Resolved from auth at the edge (admin session vs hub api-token + origin) and threaded
//! through the Core Mediator pipeline, so owner-scoping / auth gating apply in ONE place
//! instead of being re-derived per route. This is the keystone of the Hexagonal + DDD +
//! Mediator design (2026-06-26):
//!   - `owner` parameterizes every owner-scoped store (same value the managers already use).
//!   - `is_admin` gates the few admin-only capabilities.
//!   - `kind` distinguishes the two products sharing the core: a full-capability Tenant
//!     (admin / future logged-in tenant) vs an anonymous, allowlist-restricted hub Widget.
//!
//! Unifies the previously-separate concerns: manager decoupling (#1a), the Principal
//! resolver (#2), and admin·hub common logic (#4) — all ride this one type.

/// Which product surface the caller belongs to. Both share the core; capability differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalKind {
    /// Full-capability workspace owner — admin today, a logged-in tenant under multi-tenancy.
    Tenant,
    /// Anonymous embedded chatbot visitor — allowlist-restricted, per-device session.
    Widget,
}

/// The authenticated identity + capability of the current request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    /// Owner scope key used by every owner-scoped store. `"admin"` or `"hub:<instance>:<session>"`.
    pub owner: String,
    /// Whether admin-only capabilities (settings, system admin, logout) are permitted.
    pub is_admin: bool,
    pub kind: PrincipalKind,
}

impl Principal {
    /// The admin principal — full capability, single owner scope `"admin"`.
    pub fn admin() -> Self {
        Self { owner: "admin".to_string(), is_admin: true, kind: PrincipalKind::Tenant }
    }

    /// An anonymous hub widget visitor, scoped per instance + device session.
    /// Owner = `"hub:<instance>:<session>"` — the exact format the hub managers already use.
    pub fn hub_widget(instance_id: &str, session_id: &str) -> Self {
        Self {
            owner: format!("hub:{instance_id}:{session_id}"),
            is_admin: false,
            kind: PrincipalKind::Widget,
        }
    }

    /// owner scope key — what owner-scoped stores key on.
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// Parse an owner scope key back into a typed Principal. Centralizes the ad-hoc
    /// `owner == "admin"` / `owner.starts_with("hub:")` checks scattered across the code,
    /// and is the simplest form of the auth→Principal resolver. Unknown owners are treated
    /// conservatively as non-admin. Preserves the owner string verbatim (no reconstruction).
    pub fn from_owner(owner: &str) -> Self {
        if owner == "admin" {
            Self::admin()
        } else if owner.starts_with("hub:") {
            Self { owner: owner.to_string(), is_admin: false, kind: PrincipalKind::Widget }
        } else {
            Self { owner: owner.to_string(), is_admin: false, kind: PrincipalKind::Tenant }
        }
    }

    /// True for anonymous hub widget visitors.
    pub fn is_hub(&self) -> bool {
        matches!(self.kind, PrincipalKind::Widget)
    }
}
