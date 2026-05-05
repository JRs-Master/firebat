//! 태그 alias / normalize — CMS Phase 8a 의 tagAliases 파싱 + canonical 매핑.
//!
//! 옛 TS `lib/tag-utils.ts` 1:1 port.
//!
//! 사용자가 CMS settings 의 tagAliases textarea 에 박은 줄별 매핑:
//! ```text
//! AI: ai, 인공지능, artificial-intelligence
//! 주식: stock, equity
//! ```
//!
//! `normalize_tag("ai", aliases)` → `"AI"` / `normalize_tag("인공지능", aliases)` → `"AI"`
//! / `normalize_tag("foo", aliases)` → `"foo"` (alias 없음 → 원본 유지).
//!
//! case-insensitive 매칭 — `"AI"` / `"ai"` / `"Ai"` 모두 같은 canonical.

use std::collections::BTreeMap;

/// canonical → [aliases] 매핑. BTreeMap — 안정 ordering (옛 TS Object.entries 와 등가성).
pub type TagAliases = BTreeMap<String, Vec<String>>;

/// `"canonical: alias1, alias2"` 줄별 → `BTreeMap` 파싱.
/// 잘못된 줄 (콜론 없거나 빈 라인 또는 `#` 주석) 은 skip. 옛 TS parseTagAliases 1:1.
pub fn parse_tag_aliases(raw: Option<&str>) -> TagAliases {
    let mut result: TagAliases = BTreeMap::new();
    let Some(raw) = raw else { return result };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(colon_idx) = trimmed.find(':') else {
            continue;
        };
        if colon_idx == 0 {
            continue;
        }
        let canonical = trimmed[..colon_idx].trim().to_string();
        let alias_str = trimmed[(colon_idx + 1)..].trim();
        if canonical.is_empty() || alias_str.is_empty() {
            continue;
        }
        let aliases: Vec<String> = alias_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !aliases.is_empty() {
            result.insert(canonical, aliases);
        }
    }
    result
}

/// input keyword → canonical 매핑. case-insensitive. 옛 TS normalizeTag 1:1.
/// alias 없으면 원본 (trim) 그대로 반환.
pub fn normalize_tag(raw: &str, aliases: &TagAliases) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    let lower = trimmed.to_lowercase();
    for (canonical, alias_list) in aliases {
        if canonical.to_lowercase() == lower {
            return canonical.clone();
        }
        if alias_list.iter().any(|a| a.to_lowercase() == lower) {
            return canonical.clone();
        }
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic_lines() {
        let raw = "AI: ai, 인공지능, artificial-intelligence\n주식: stock, equity";
        let parsed = parse_tag_aliases(Some(raw));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed["AI"], vec!["ai", "인공지능", "artificial-intelligence"]);
        assert_eq!(parsed["주식"], vec!["stock", "equity"]);
    }

    #[test]
    fn skip_empty_and_comment_lines() {
        let raw = "AI: ai\n\n# comment\n  \n주식: stock";
        let parsed = parse_tag_aliases(Some(raw));
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn skip_invalid_lines() {
        let raw = "no colon line\n: missing canonical\nempty:\nAI: ai";
        let parsed = parse_tag_aliases(Some(raw));
        assert_eq!(parsed.len(), 1);
        assert!(parsed.contains_key("AI"));
    }

    #[test]
    fn parse_none_returns_empty() {
        let parsed = parse_tag_aliases(None);
        assert!(parsed.is_empty());
    }

    #[test]
    fn normalize_canonical_self_match() {
        let aliases: TagAliases = [("AI".to_string(), vec!["ai".to_string()])]
            .into_iter()
            .collect();
        assert_eq!(normalize_tag("AI", &aliases), "AI");
        assert_eq!(normalize_tag("ai", &aliases), "AI");
        assert_eq!(normalize_tag("Ai", &aliases), "AI");
    }

    #[test]
    fn normalize_alias_to_canonical() {
        let aliases: TagAliases = [(
            "AI".to_string(),
            vec!["인공지능".to_string(), "artificial-intelligence".to_string()],
        )]
        .into_iter()
        .collect();
        assert_eq!(normalize_tag("인공지능", &aliases), "AI");
        assert_eq!(normalize_tag("artificial-intelligence", &aliases), "AI");
        assert_eq!(normalize_tag("ARTIFICIAL-INTELLIGENCE", &aliases), "AI");
    }

    #[test]
    fn normalize_no_match_returns_input() {
        let aliases: TagAliases = [("AI".to_string(), vec!["ai".to_string()])]
            .into_iter()
            .collect();
        assert_eq!(normalize_tag("foo", &aliases), "foo");
        assert_eq!(normalize_tag("  bar  ", &aliases), "bar"); // trim
    }

    #[test]
    fn normalize_empty_input() {
        let aliases = TagAliases::new();
        assert_eq!(normalize_tag("", &aliases), "");
        assert_eq!(normalize_tag("   ", &aliases), "");
    }
}
