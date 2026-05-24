//! Slug 통합 중복 / reserved 영역 검증 — page / hub 둘 다 사용.
//!
//! 사용자가 page slug "demo" 와 hub slug "demo" 를 동시에 등록할 수 있던 옛 동작 (page 우선
//! 매칭으로 hub 자동 숨김) 차단. 또한 시스템 reserved keyword (api / admin / user / hub 등) 을
//! 사용하지 못하게 가드.

/// 시스템 예약 slug 영역 — Next.js route / API endpoint 영역과 충돌 차단.
/// 새 예약 항목 추가 시 본 리스트에만 추가.
pub const RESERVED_SLUGS: &[&str] = &[
    // Next.js 시스템
    "_next", "static",
    // Firebat 시스템 route
    "api", "admin", "login", "logout",
    "user", "system", "hub", "share",
    // CMS 시스템 route
    "search", "tag", "feed", "feed.xml", "robots.txt", "sitemap.xml",
    "ads.txt", "BingSiteAuth.xml",
    // 흔한 충돌 영역
    "null", "undefined", "true", "false",
];

/// reserved 영역 검사 — slug 가 RESERVED_SLUGS 안에 있으면 Err.
pub fn check_reserved(slug: &str) -> Result<(), String> {
    let normalized = slug.trim().to_lowercase();
    if RESERVED_SLUGS.iter().any(|r| *r == normalized) {
        return Err(format!(
            "slug \"{slug}\" 는 시스템 예약어라 사용할 수 없습니다. (예약어: {})",
            RESERVED_SLUGS.join(", ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_blocks_admin_api_user() {
        assert!(check_reserved("admin").is_err());
        assert!(check_reserved("api").is_err());
        assert!(check_reserved("user").is_err());
        assert!(check_reserved("hub").is_err());
        // 대소문자 무관
        assert!(check_reserved("ADMIN").is_err());
        assert!(check_reserved("Admin").is_err());
    }

    #[test]
    fn reserved_accepts_normal_slug() {
        assert!(check_reserved("lawassistant").is_ok());
        assert!(check_reserved("my-blog").is_ok());
        assert!(check_reserved("demo-2026").is_ok());
    }
}
