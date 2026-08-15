//! Render an error together with the causes underneath it.
//!
//! `format!("{e}")` prints only the outermost message, and for a wrapped error that outermost
//! message is often the useless half. reqwest says `error sending request for url (…)` and keeps
//! the part that matters — `dns error`, `connection reset by peer`, `invalid peer certificate` —
//! in `source()`, which `{e}` throws away.
//!
//! Measured 2026-08-15: five DART fetches failed with nothing but the outer sentence, and the
//! model, handed a failure with no cause in it, abandoned the web path entirely instead of
//! retrying or routing around. The cause we write ourselves is ours to phrase; a cause that
//! arrives from outside is evidence, and passing evidence through is not our call to make.

use std::error::Error;

/// Depth cap — a chain longer than this is a library detail, not a diagnosis, and the text goes
/// to a model that pays for every token of it.
const MAX_CAUSES: usize = 5;

/// `outer ← cause ← cause …`. A cause already quoted verbatim by its parent is not repeated.
pub fn with_causes(err: &(dyn Error + 'static)) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    for _ in 0..MAX_CAUSES {
        let Some(cause) = source else { break };
        let msg = cause.to_string();
        if !msg.is_empty() && !out.contains(&msg) {
            out.push_str(" ← ");
            out.push_str(&msg);
        }
        source = cause.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    #[derive(Debug)]
    struct Layer(&'static str, Option<Box<Layer>>);

    impl fmt::Display for Layer {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }

    impl Error for Layer {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            self.1.as_deref().map(|l| l as &(dyn Error + 'static))
        }
    }

    fn chain(msgs: &[&'static str]) -> Layer {
        let mut it = msgs.iter().rev();
        let mut cur = Layer(it.next().copied().unwrap_or(""), None);
        for m in it {
            cur = Layer(m, Some(Box::new(cur)));
        }
        cur
    }

    #[test]
    fn the_cause_survives_the_wrapper() {
        let e = chain(&["error sending request", "dns error", "Name or service not known"]);
        assert_eq!(
            with_causes(&e),
            "error sending request ← dns error ← Name or service not known"
        );
    }

    #[test]
    fn a_lone_error_reads_exactly_as_before() {
        let e = chain(&["timed out"]);
        assert_eq!(with_causes(&e), "timed out");
    }

    #[test]
    fn a_cause_the_parent_already_quoted_is_not_said_twice() {
        let e = chain(&["connect error: connection refused", "connection refused"]);
        assert_eq!(with_causes(&e), "connect error: connection refused");
    }

    #[test]
    fn a_chain_longer_than_the_cap_stops_at_the_cap() {
        let e = chain(&["a", "b", "c", "d", "e", "f", "g", "h"]);
        assert_eq!(with_causes(&e), "a ← b ← c ← d ← e ← f");
    }
}
