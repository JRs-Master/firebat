//! What a module asks to be remembered, and the rules for believing it.
//!
//! A module cannot call the recall store — it is a sandboxed process with one pipe in and one
//! pipe out. So it does not write; it *declares*, in the envelope it already returns, and the
//! framework writes under the module's own owner. The scope cannot be forged, because it is
//! derived from the module that just ran rather than from anything the module said.
//!
//! ```json
//! { "success": true, "data": {...},
//!   "remember": {
//!     "facts":   [{"entity": "AAPL", "content": "rsi30/70 held on 3 of 4 unseen symbols",
//!                  "factType": "measurement"}],
//!     "lessons": [{"name": "cost-sets-frequency",
//!                  "description": "A round trip costs 0.6% here",
//!                  "content": "..."}]
//!   } }
//! ```
//!
//! **The two are believed differently, and that is the point.**
//!
//! A fact is a measurement: "this grid cell was refused, 2 of 4 confirmation symbols". The
//! repeated-observation machinery exists because facts pulled out of conversation are guesses
//! that corroboration turns into knowledge — a number a module computed is not a guess, and
//! making it earn its place by failing the same experiment twice more inverts the entire reason
//! for writing it down. So a declared fact is explicit: recorded once, effective immediately.
//!
//! A lesson is a generalisation — "five-minute bars cannot pay for themselves in this market" —
//! and a generalisation drawn from one observation is exactly what the promotion ladder is for.
//! Those go in staged, and repetition promotes them like anything else.

use crate::ports::{SaveEntityInput, SaveFactInput};

/// Per run, so a looping module cannot fill the store faster than anyone can read it.
pub const MAX_FACTS: usize = 20;
pub const MAX_LESSONS: usize = 5;
/// A generalisation starts unproven, at the same score cron extraction uses.
pub const LESSON_CONFIDENCE: f64 = 0.5;

#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredFact {
    pub entity: String,
    pub entity_type: String,
    pub content: String,
    pub fact_type: Option<String>,
    pub supersede: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeclaredLesson {
    pub name: String,
    pub description: String,
    pub content: String,
    pub category: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Declared {
    pub facts: Vec<DeclaredFact>,
    pub lessons: Vec<DeclaredLesson>,
    /// Entries thrown away, and why — an unreadable declaration that vanishes silently is the
    /// same failure as a tag that was a string when it should have been a list.
    pub rejected: Vec<String>,
}

impl Declared {
    pub fn is_empty(&self) -> bool {
        self.facts.is_empty() && self.lessons.is_empty()
    }
}

fn text(v: Option<&serde_json::Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
}

/// Read the `remember` block off a module's envelope.
///
/// Nothing here trusts a length or a type: a module is a separate program, and the one thing this
/// boundary must never do is take an unreadable entry and store something close to it.
pub fn parse(envelope: &serde_json::Value) -> Declared {
    let mut out = Declared::default();
    let Some(block) = envelope.get("remember").and_then(|v| v.as_object()) else {
        return out;
    };
    for (i, raw) in block
        .get("facts")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .enumerate()
    {
        if out.facts.len() >= MAX_FACTS {
            out.rejected.push(format!("facts[{i}]: over the {MAX_FACTS} per run"));
            continue;
        }
        let (entity, content) = (text(raw.get("entity")), text(raw.get("content")));
        if entity.is_empty() || content.is_empty() {
            out.rejected.push(format!("facts[{i}]: entity and content are both required"));
            continue;
        }
        out.facts.push(DeclaredFact {
            entity,
            entity_type: {
                let t = text(raw.get("entityType"));
                if t.is_empty() { "concept".to_string() } else { t }
            },
            content,
            fact_type: Some(text(raw.get("factType"))).filter(|s| !s.is_empty()),
            supersede: raw.get("supersede").and_then(|v| v.as_bool()).unwrap_or(false),
        });
    }
    for (i, raw) in block
        .get("lessons")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .enumerate()
    {
        if out.lessons.len() >= MAX_LESSONS {
            out.rejected.push(format!("lessons[{i}]: over the {MAX_LESSONS} per run"));
            continue;
        }
        let (name, content) = (text(raw.get("name")), text(raw.get("content")));
        if name.is_empty() || content.is_empty() {
            out.rejected.push(format!("lessons[{i}]: name and content are both required"));
            continue;
        }
        // The name becomes a filename, so it lives under the same restriction as a slug.
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            out.rejected.push(format!("lessons[{i}]: '{name}' is not usable as a name"));
            continue;
        }
        out.lessons.push(DeclaredLesson {
            description: {
                let d = text(raw.get("description"));
                if d.is_empty() { name.clone() } else { d }
            },
            name,
            content,
            category: {
                let c = text(raw.get("category"));
                if ["user", "feedback", "project", "reference", "idea"].contains(&c.as_str()) {
                    c
                } else {
                    "reference".to_string()
                }
            },
        });
    }
    out
}

/// The entity a declared fact hangs off, in the module's own scope.
pub fn entity_input(fact: &DeclaredFact, owner: &str) -> SaveEntityInput {
    SaveEntityInput {
        name: fact.entity.clone(),
        entity_type: fact.entity_type.clone(),
        aliases: Vec::new(),
        metadata: None,
        source_conv_id: None,
        owner: Some(owner.to_string()),
        dedup_threshold: None,
    }
}

/// A measurement, recorded once. See the module docs for why this is not staged.
pub fn fact_input(fact: &DeclaredFact, entity_id: i64, owner: &str) -> SaveFactInput {
    SaveFactInput {
        entity_id,
        content: fact.content.clone(),
        fact_type: fact.fact_type.clone(),
        occurred_at: None,
        tags: Vec::new(),
        source_conv_id: None,
        ttl_days: None,
        dedup_threshold: None,
        owner: Some(owner.to_string()),
        supersede: fact.supersede,
        // Not "the user asked for this" but the same standing: a number the module computed is
        // not a guess awaiting corroboration.
        explicit: true,
        confidence: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_module_with_nothing_to_say_says_nothing() {
        assert!(parse(&json!({"success": true, "data": {}})).is_empty());
        assert!(parse(&json!({"remember": {}})).is_empty());
        assert!(parse(&json!({"remember": {"facts": []}})).is_empty());
    }

    #[test]
    fn a_measurement_is_recorded_once_rather_than_staged() {
        // The repeated-observation rule exists for guesses pulled out of prose. Making a computed
        // number earn its place by failing the same experiment twice more inverts the reason for
        // writing it down at all.
        let d = parse(&json!({"remember": {"facts": [
            {"entity": "AAPL", "content": "rsi30/70 held on 3 of 4 unseen symbols",
             "factType": "measurement"}]}}));
        assert_eq!(d.facts.len(), 1);
        let f = fact_input(&d.facts[0], 7, "module:autotrade");
        assert!(f.explicit);
        assert_eq!(f.confidence, None);
        assert_eq!(f.owner.as_deref(), Some("module:autotrade"));
    }

    #[test]
    fn a_generalisation_still_has_to_earn_it() {
        let d = parse(&json!({"remember": {"lessons": [
            {"name": "cost-sets-frequency", "content": "왕복 0.6%"}]}}));
        assert_eq!(d.lessons.len(), 1);
        assert_eq!(d.lessons[0].category, "reference");
        // The description defaults to the name rather than to an empty string, so an index entry
        // never reads as a blank line.
        assert_eq!(d.lessons[0].description, "cost-sets-frequency");
    }

    #[test]
    fn an_unreadable_entry_is_named_rather_than_dropped() {
        let d = parse(&json!({"remember": {
            "facts": [{"entity": "", "content": "x"}, {"entity": "A", "content": "  "}],
            "lessons": [{"name": "../escape", "content": "x"}]}}));
        assert!(d.is_empty());
        assert_eq!(d.rejected.len(), 3);
        assert!(d.rejected[2].contains("escape"));
    }

    #[test]
    fn a_looping_module_cannot_fill_the_store() {
        let facts: Vec<_> = (0..40)
            .map(|i| json!({"entity": format!("E{i}"), "content": "c"}))
            .collect();
        let d = parse(&json!({"remember": {"facts": facts}}));
        assert_eq!(d.facts.len(), MAX_FACTS);
        assert_eq!(d.rejected.len(), 40 - MAX_FACTS);
    }
}
