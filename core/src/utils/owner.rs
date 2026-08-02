//! Who a stored thing belongs to — one grammar, used by every store that keeps anything.
//!
//! Recall, memory, the library and the conversation history all carry an owner already, and each
//! of them filters on it. What they did not share was the *reading* of it, and that is where the
//! isolation leaked: absent meant "the admin scope" to the store and "no scope at all" to the
//! layer above, so an operator addressing a row by id read across every visitor's data.
//!
//! Absent is a scope. There is no unscoped read.
//!
//! ```text
//! admin                                the operator
//! hub:<instance>:<session>             a hub visitor
//! module:<name>                        a module running for the operator
//! hub:<instance>:<session>:module:<n>  a module running for that visitor
//! ```
//!
//! A module gets its own owner rather than borrowing the person's for one reason: what a module
//! learns is not what a person told us. A strategy module remembering "this grid was refused for
//! too few trades" must not surface while the operator is talking about their holidays, and the
//! operator's notes must not steer a nightly parameter search.

pub const ADMIN: &str = "admin";
const MODULE_PREFIX: &str = "module:";
const HUB_PREFIX: &str = "hub:";

/// The owner this request runs as. Absent or empty is the operator, never "everyone".
pub fn resolve(owner: Option<&str>) -> String {
    match owner {
        Some(o) if !o.trim().is_empty() => o.trim().to_string(),
        _ => ADMIN.to_string(),
    }
}

/// The owner a module runs as, under whichever principal invoked it.
pub fn for_module(principal: Option<&str>, module: &str) -> String {
    let base = resolve(principal);
    if base == ADMIN {
        format!("{MODULE_PREFIX}{module}")
    } else {
        format!("{base}:{MODULE_PREFIX}{module}")
    }
}

/// The module this owner is, if it is one.
pub fn module_of(owner: &str) -> Option<&str> {
    owner.rsplit_once(MODULE_PREFIX).map(|(_, name)| name)
}

/// Whether this owner is a person rather than something running on their behalf.
pub fn is_person(owner: &str) -> bool {
    module_of(owner).is_none()
}

/// The principal a module belongs to — itself, for a person.
pub fn principal_of(owner: &str) -> &str {
    match owner.find(MODULE_PREFIX) {
        Some(0) => ADMIN,
        Some(i) => owner[..i].trim_end_matches(':'),
        None => owner,
    }
}

/// Path segments for a store that keeps one directory per owner.
///
/// Rejects anything that could climb out of the base directory. The check is on the segments
/// rather than on the joined path, because a separator that arrives inside a segment is exactly
/// what a traversal looks like.
pub fn path_segments(owner: Option<&str>) -> Result<Vec<String>, String> {
    let owner = resolve(owner);
    if owner == ADMIN {
        return Ok(vec![]);
    }
    let (base, module) = match owner.find(MODULE_PREFIX) {
        Some(i) => (owner[..i].trim_end_matches(':').to_string(),
                    Some(owner[i + MODULE_PREFIX.len()..].to_string())),
        None => (owner.clone(), None),
    };
    let mut out: Vec<String> = Vec::new();
    if !base.is_empty() {
        let rest = base
            .strip_prefix(HUB_PREFIX)
            .ok_or_else(|| format!("invalid owner: {owner}"))?;
        out.push("hub".to_string());
        out.extend(rest.split(':').map(str::to_string));
    }
    if let Some(name) = module {
        out.push("module".to_string());
        out.push(name);
    }
    for part in &out {
        if part.is_empty() || part.contains("..") || part.contains('/') || part.contains('\\') {
            return Err(format!("invalid owner segment: {owner}"));
        }
    }
    Ok(out)
}

/// Whether this owner is one the system will store anything under.
pub fn is_valid(owner: &str) -> bool {
    path_segments(Some(owner)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_is_the_operator_not_everyone() {
        // The whole leak in one line: a missing owner used to mean "do not filter".
        assert_eq!(resolve(None), ADMIN);
        assert_eq!(resolve(Some("")), ADMIN);
        assert_eq!(resolve(Some("  ")), ADMIN);
        assert_eq!(resolve(Some("hub:a:b")), "hub:a:b");
    }

    #[test]
    fn a_module_runs_under_whoever_invoked_it() {
        assert_eq!(for_module(None, "autotrade"), "module:autotrade");
        assert_eq!(for_module(Some("admin"), "autotrade"), "module:autotrade");
        assert_eq!(for_module(Some("hub:x:y"), "autotrade"), "hub:x:y:module:autotrade");
    }

    #[test]
    fn a_module_and_its_principal_are_both_readable_from_the_owner() {
        assert_eq!(module_of("module:autotrade"), Some("autotrade"));
        assert_eq!(module_of("hub:x:y:module:ta"), Some("ta"));
        assert_eq!(module_of("hub:x:y"), None);
        assert_eq!(principal_of("module:autotrade"), ADMIN);
        assert_eq!(principal_of("hub:x:y:module:ta"), "hub:x:y");
        assert_eq!(principal_of("admin"), ADMIN);
        assert!(is_person("hub:x:y"));
        assert!(!is_person("hub:x:y:module:ta"));
    }

    #[test]
    fn directories_mirror_the_grammar() {
        assert_eq!(path_segments(None).unwrap(), Vec::<String>::new());
        assert_eq!(path_segments(Some("hub:abc:s1")).unwrap(), ["hub", "abc", "s1"]);
        assert_eq!(path_segments(Some("module:autotrade")).unwrap(), ["module", "autotrade"]);
        assert_eq!(
            path_segments(Some("hub:abc:s1:module:autotrade")).unwrap(),
            ["hub", "abc", "s1", "module", "autotrade"]
        );
    }

    #[test]
    fn a_module_never_shares_a_scope_with_its_person() {
        // The point of the whole grammar: what a strategy module learned must not surface while
        // its operator is talking about something else, and vice versa. Different owner strings
        // are what every store filters on, so different strings is the guarantee.
        let person = resolve(None);
        let its_module = for_module(None, "autotrade");
        assert_ne!(person, its_module);
        let visitor = "hub:inst:sess";
        let their_module = for_module(Some(visitor), "autotrade");
        assert_ne!(visitor, their_module);
        // And two people's modules of the same name are still two scopes.
        assert_ne!(its_module, their_module);
        // Each resolves back to who it runs for.
        assert_eq!(principal_of(&its_module), ADMIN);
        assert_eq!(principal_of(&their_module), visitor);
    }

    #[test]
    fn nothing_climbs_out_of_the_base_directory() {
        assert!(path_segments(Some("hub:../etc:x")).is_err());
        assert!(path_segments(Some("module:../../etc")).is_err());
        assert!(path_segments(Some("module:a/b")).is_err());
        assert!(path_segments(Some("garbage")).is_err());
        assert!(path_segments(Some("hub:a:")).is_err());
        assert!(!is_valid("garbage"));
        assert!(is_valid("module:autotrade"));
    }
}
