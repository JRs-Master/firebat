//! The per-ROUND message: where the turn stands, rendered once, delivered at the tail.
//!
//! # Two clocks
//!
//! The system prompt is assembled once per TURN ([`super::prompt_builder`]) and is the same bytes
//! for every round of that turn — rules, the module index, retrieval, the tool shortlist. What
//! actually changes between rounds is none of that: it is the round index, which schemas the
//! conversation has already fetched, what executed, which tools were withdrawn, and whether tools
//! are still open. That state had no home. It was spliced into the *user prompt* instead, and
//! that placement cost twice:
//!
//! 1. **Distance.** The transports build `system → history → user → (assistant/tool)×N`, so text
//!    appended to the user prompt sits *before* every tool exchange. By round twenty, "tools are
//!    closed, write the answer" is behind twenty blocks of tool JSON. The one notice that measured
//!    as working — the budget warning — is the one that rides in the *last tool result*, at the
//!    tail. That was not luck.
//! 2. **Cache.** Rewriting the user message invalidates the prefix from that message onward, so a
//!    corrective round re-billed the entire accumulated tool history. The round-varying bytes were
//!    in the single worst position for both reading and billing.
//!
//! So the brief renders here and lands *after* the last tool result (`LlmCallOpts::round_brief`,
//! placed by each transport). The prefix — system, history, user, every tool exchange — stays
//! byte-identical across rounds, and the guidance is the last thing read before generation.
//!
//! # One renderer
//!
//! Before this, five branches in `ai.rs` each formatted their own paragraph and the ledger was
//! pasted by four of them separately. Wording drifted, and two facts the model needed (which
//! round this is, which tools were withdrawn) were simply never said. Everything the round has to
//! say is one struct and one `render`, so a new fact is a field rather than a sixth branch.
//!
//! # Phrasing
//!
//! Lines state what is true and what follows from it, not what is forbidden. "Calling without the
//! form returns a refusal and spends a round" tells the model the same thing as a ban while also
//! telling it why — and unlike a ban it stays true when the model is doing nothing wrong.
//!
//! English, like every other instruction the model reads (the answer's language is the user's,
//! and the system prompt sets that separately).

use std::fmt::Write as _;

/// Why this round is being asked for again, when it is not simply the next step.
///
/// Each variant was a prompt-append branch in the round loop. They keep their meaning and move to
/// the tail; what changes is that they no longer each carry their own copy of the ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Correction {
    /// The render tool redirected the model to emit a fence, and the answer arrived without one —
    /// so the visualization the reader was promised is not there.
    MissingFence,
    /// The round produced no answer text at all.
    EmptyAnswer,
    /// Discovery ran but nothing was executed, and the turn was about to end as if it had been.
    NothingExecuted,
    /// Tools are closed for this turn; this round writes the answer.
    ToolsClosed,
}

/// What the model is told at the start of a round, in the order a reader needs it.
///
/// Construction is deliberately dumb — every field is read from state the loop already holds, so
/// the brief cannot claim anything the turn did not actually record.
#[derive(Debug, Clone, Default)]
pub struct RoundBrief {
    /// 1-based, as counted for a reader. The loop counts from 0.
    pub round: usize,
    /// The round budget for this turn.
    pub max_rounds: usize,
    /// False on the closing round, when the tool list is empty.
    pub tools_open: bool,
    /// `(module, actions)` whose schema this conversation holds — callable right now.
    pub schemas_ready: Vec<(String, Vec<String>)>,
    /// How long a fetched schema keeps counting, in minutes. Published so the two surfaces cannot
    /// state different windows (they did: the store slid for the conversation while the prompt
    /// said "this turn").
    pub schema_window_min: u64,
    /// The turn ledger — what actually ran, verbatim from the loop.
    pub executed: Vec<String>,
    /// Tools removed from this round's list, so their absence reads as a decision rather than a
    /// malfunction. Nothing said this before; the model re-called a withdrawn tool instead.
    pub withdrawn: Vec<String>,
    /// Set when the round is a correction rather than the next step.
    pub correction: Option<Correction>,
}

/// Below this many rounds remaining, the brief says so in its own line rather than leaving the
/// reader to subtract. Three is the point at which the *next* round is the last that can still
/// execute anything, so it is the last moment a warning can change what happens.
const CLOSING_SOON: usize = 3;

impl RoundBrief {
    /// Rounds left after this one, floored at zero.
    fn remaining(&self) -> usize {
        self.max_rounds.saturating_sub(self.round)
    }

    /// The brief as the model reads it, or `None` when there is nothing worth a message.
    ///
    /// Round 1 of an ordinary turn with no schemas, no ledger and no correction has nothing to
    /// report, and an empty scaffold every round would train the model to skip the block entirely.
    pub fn render(&self) -> Option<String> {
        let mut sections: Vec<String> = Vec::new();
        for part in [
            self.progress_line(),
            self.procedure_line(),
            self.executed_line(),
            self.withdrawn_line(),
            self.correction_line(),
        ] {
            if let Some(p) = part {
                sections.push(p);
            }
        }
        if sections.is_empty() {
            return None;
        }
        Some(format!("[turn status]\n{}", sections.join("\n\n")))
    }

    /// Where the turn is in its budget — said when the number can change what happens next.
    ///
    /// On the opening round of a turn with the whole budget ahead, it cannot: "round 1 of 25" is
    /// the same sentence every turn, and on a turn that calls no tools at all it appends a tool
    /// budget to a conversation (measured live 2026-08-14: a plain greeting turn carried the line
    /// as its entire brief). The number starts mattering once the turn is actually spending
    /// rounds, once the end is near, or once tools have closed.
    fn progress_line(&self) -> Option<String> {
        if self.max_rounds == 0 || self.round == 0 {
            return None;
        }
        let opening_round_with_room =
            self.round == 1 && self.tools_open && self.remaining() > CLOSING_SOON;
        if opening_round_with_room {
            return None;
        }
        let mut s = format!(
            "This request has {max} tool rounds; this is round {cur}.",
            max = self.max_rounds,
            cur = self.round,
        );
        let left = self.remaining();
        if !self.tools_open {
            // Saying "N rounds left" while the tool list is empty describes a budget the model
            // cannot spend, and a model told it has room looks for something to do with it.
            s.push_str(" This round writes the answer, with no tools.");
        } else if left == 0 {
            s.push_str(" The next round is the answer round.");
        } else if left <= CLOSING_SOON {
            let _ = write!(
                s,
                " {left} tool round(s) remain and then the answer round follows, so whatever runs \
                 now is what the answer can report."
            );
        }
        Some(s)
    }

    /// What the ladder has already handed over — the state, not the rule.
    ///
    /// The rule ("fetch the form, then call") belongs to the system prompt, which is where it is
    /// cached and where it holds for every round. Repeating it here on a round that unlocked
    /// nothing would spend tokens saying what was already said. What the system prompt *cannot*
    /// say is which forms this particular conversation is holding right now, and that is the fact
    /// a model needs in order not to re-fetch a schema it already has — which is what the
    /// measured turns kept doing.
    fn procedure_line(&self) -> Option<String> {
        if !self.tools_open || self.schemas_ready.is_empty() {
            return None;
        }
        // Components ride the same store under a reserved name; they are the other half of the
        // same ladder and belong in the same sentence, worded for what they are — a component is
        // written into the answer, not called.
        let (components, modules): (Vec<_>, Vec<_>) = self
            .schemas_ready
            .iter()
            .partition(|(m, _)| m == crate::utils::conversation_scope::COMPONENT_PSEUDO_MODULE);
        let mut s = String::new();
        if !modules.is_empty() {
            s.push_str(
                "Forms this conversation already holds — these actions are callable right now, \
                 with no further get_action_schema round:",
            );
        }
        for (module, actions) in &modules {
            let _ = write!(s, "\n  {}: {}", module, actions.join(", "));
        }
        for (_, names) in &components {
            if !s.is_empty() {
                s.push('\n');
            }
            let _ = write!(
                s,
                "Component props already fetched — these can go straight into a \
                 ```firebat-render``` fence: {}",
                names.join(", ")
            );
        }
        if self.schema_window_min > 0 {
            let _ = write!(
                s,
                "\n(held for {} minutes across this conversation)",
                self.schema_window_min
            );
        }
        Some(s)
    }

    /// What ran. The ledger is the answer's factual floor — without it the closing round binds
    /// values to the wrong labels and reports unexecuted steps as done.
    fn executed_line(&self) -> Option<String> {
        if self.executed.is_empty() {
            return None;
        }
        Some(format!(
            "Executed this turn — these are the facts the answer can carry:\n{}",
            self.executed.join("\n")
        ))
    }

    /// Why a tool that was in the list is not in it now.
    fn withdrawn_line(&self) -> Option<String> {
        if self.withdrawn.is_empty() || !self.tools_open {
            return None;
        }
        Some(format!(
            "{} was withdrawn for this turn: discovery has gone far enough, and the forms already \
             in hand are what this turn runs on.",
            self.withdrawn.join(", ")
        ))
    }

    /// The corrective paragraph, when the round is one.
    fn correction_line(&self) -> Option<String> {
        let c = self.correction.as_ref()?;
        let s = match c {
            Correction::MissingFence => String::from(
                "Earlier this turn the render tool prepared components and handed them back to be \
                 emitted as a ```firebat-render``` fenced block inside the answer. The last answer \
                 carried no such fence, so the visualization the user asked for is not on screen. \
                 Writing the answer again with the prepared blocks inside the fence renders it \
                 (pointing at cached rows with dataCacheKey draws the same data without retyping \
                 it). This round writes the answer, with no tools.",
            ),
            Correction::EmptyAnswer => {
                // What to write FROM differs with the ledger. Pointing at "the results below" when
                // no tool ran describes results that are not there, and that is the kind of
                // sentence that sends a model looking for them.
                let source = if self.executed.is_empty() {
                    "This conversation and what is already known are enough to answer from. If two \
                     figures in it disagree, saying so in one line and answering with the trusted \
                     one is the accurate response."
                } else {
                    "The results above are already in hand, so the answer can be written from what \
                     they actually show."
                };
                format!(
                    "The last round ended with no answer text. Writing the answer now, in the \
                     user's language, completes the turn. {source}"
                )
            }
            Correction::NothingExecuted => String::from(
                "Information was gathered and nothing was executed. A plan written as text has no \
                 Run button; the one path to an approvable plan is calling the propose_plan tool. \
                 Three things work from here: (1) call the READY/STREAM entries above exactly as \
                 written, (2) call propose_plan with the plan as tool arguments (verified steps as \
                 tool+args, unverified parts as discovery steps), or (3) if the work genuinely \
                 cannot proceed, say plainly that nothing was executed.",
            ),
            Correction::ToolsClosed => String::from(
                "Tool calls are closed for this turn — the tool list is empty, so call syntax \
                 reaches nothing. The results already in hand are what the final answer is written \
                 from, as normal text (render fences work). This seat is the only executor: asking \
                 the user or \"the system\" to run something means it does not happen. Anything \
                 left unfinished is accurately reported in one line.",
            ),
        };
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> RoundBrief {
        RoundBrief {
            round: 7,
            max_rounds: 25,
            tools_open: true,
            schema_window_min: 30,
            ..Default::default()
        }
    }

    #[test]
    fn an_empty_first_round_says_nothing() {
        // The shape the LOOP actually builds on the opening round: 1-based round, real budget,
        // nothing discovered or executed yet. The first version of this test used round 0 /
        // max_rounds 0 — a combination the loop never produces — so it passed while every live
        // turn, including a plain greeting with no tools at all, carried "this is round 1 of 25"
        // as its entire brief (measured on the server, 2026-08-14).
        let b = RoundBrief {
            round: 1,
            max_rounds: 25,
            tools_open: true,
            schema_window_min: 30,
            ..Default::default()
        };
        assert_eq!(b.render(), None);
    }

    #[test]
    fn an_opening_round_of_a_short_budget_still_warns() {
        // The suppression is about a number that cannot change anything, not about round 1: when
        // the whole budget is nearly gone the opening round is also the closing one.
        let b = RoundBrief {
            round: 1,
            max_rounds: 2,
            tools_open: true,
            ..Default::default()
        };
        assert!(b.render().is_some());
    }

    #[test]
    fn the_second_round_starts_reporting_progress() {
        let mut b = base();
        b.round = 2;
        let out = b.render().expect("has content");
        assert!(out.contains("round 2"), "{out}");
    }

    #[test]
    fn progress_names_the_round_and_the_budget() {
        let out = base().render().expect("has content");
        assert!(out.contains("25 tool rounds"), "{out}");
        assert!(out.contains("round 7"), "{out}");
    }

    #[test]
    fn ready_schemas_are_listed_so_they_are_not_refetched() {
        let mut b = base();
        b.schemas_ready = vec![
            ("docs".into(), vec!["make_xlsx".into(), "make_pdf".into()]),
            ("tago".into(), vec!["subway-stations".into()]),
        ];
        let out = b.render().expect("has content");
        assert!(out.contains("docs: make_xlsx, make_pdf"), "{out}");
        assert!(out.contains("tago: subway-stations"), "{out}");
        assert!(out.contains("30 minutes"), "{out}");
    }

    #[test]
    fn component_schemas_are_reported_beside_action_forms() {
        // The two halves of one ladder. Only the tool half used to be reported, so a model that
        // had already fetched a component's props had no way to know it still held them.
        let mut b = base();
        b.schemas_ready = vec![
            (
                crate::utils::conversation_scope::COMPONENT_PSEUDO_MODULE.to_string(),
                vec!["stock_chart".into(), "table".into()],
            ),
            ("docs".into(), vec!["make_xlsx".into()]),
        ];
        let out = b.render().expect("has content");
        assert!(out.contains("docs: make_xlsx"), "{out}");
        assert!(out.contains("stock_chart, table"), "{out}");
        // Worded for what a component is — written into the answer, not called.
        assert!(out.contains("firebat-render"), "{out}");
        // The pseudo-module is bookkeeping; it never reaches the model.
        assert!(!out.contains("render-component:"), "{out}");
    }

    #[test]
    fn components_alone_still_produce_the_line() {
        let mut b = base();
        b.schemas_ready = vec![(
            crate::utils::conversation_scope::COMPONENT_PSEUDO_MODULE.to_string(),
            vec!["quiz".into()],
        )];
        let out = b.render().expect("has content");
        assert!(out.contains("quiz"), "{out}");
        assert!(!out.contains("get_action_schema"), "{out}");
    }

    #[test]
    fn the_ladder_rule_is_left_to_the_system_prompt() {
        // The brief reports state. Restating the cached rule on a round that unlocked nothing
        // spends tokens every round to say what was already said once.
        let out = base().render().expect("has content");
        assert!(!out.contains("get_action_schema"), "{out}");
    }

    #[test]
    fn a_closed_round_does_not_advertise_remaining_budget() {
        // Telling a model it has rounds left while handing it no tools invites it to look for
        // something to spend them on — which is how a closing round became three empty ones.
        let mut b = base();
        b.round = 22;
        b.tools_open = false;
        b.correction = Some(Correction::ToolsClosed);
        let out = b.render().expect("has content");
        assert!(out.contains("no tools"), "{out}");
        assert!(!out.contains("remain and then"), "{out}");
        // The ladder is not restated when there is nothing to call.
        assert!(!out.contains("get_action_schema"), "{out}");
    }

    #[test]
    fn the_budget_warning_lands_while_it_can_still_change_something() {
        let mut b = base();
        b.round = 23; // two rounds left
        let out = b.render().expect("has content");
        assert!(out.contains("2 tool round(s) remain"), "{out}");
    }

    #[test]
    fn withdrawn_tools_are_explained_rather_than_silently_missing() {
        let mut b = base();
        b.withdrawn = vec!["search_module_actions".into()];
        let out = b.render().expect("has content");
        assert!(out.contains("search_module_actions"), "{out}");
        assert!(out.contains("withdrawn"), "{out}");
    }

    #[test]
    fn an_empty_answer_with_no_ledger_is_not_pointed_at_absent_results() {
        let mut b = base();
        b.correction = Some(Correction::EmptyAnswer);
        let out = b.render().expect("has content");
        assert!(out.contains("already known are enough"), "{out}");
        assert!(!out.contains("results above are already in hand"), "{out}");
    }

    #[test]
    fn an_empty_answer_with_a_ledger_is_pointed_at_the_results() {
        let mut b = base();
        b.executed = vec!["tago subway-stations → 2 rows".into()];
        b.correction = Some(Correction::EmptyAnswer);
        let out = b.render().expect("has content");
        assert!(out.contains("results above are already in hand"), "{out}");
    }

    #[test]
    fn the_ledger_is_rendered_once_not_once_per_branch() {
        let mut b = base();
        b.executed = vec!["docs make_xlsx → 1 file".into()];
        b.correction = Some(Correction::EmptyAnswer);
        let out = b.render().expect("has content");
        assert_eq!(out.matches("docs make_xlsx → 1 file").count(), 1, "{out}");
    }

    #[test]
    fn guidance_is_stated_as_consequence_not_prohibition() {
        // The phrasing rule, held by a test so it survives the next edit: the brief says what
        // happens, and a reader who follows it never has to parse a negation.
        let mut b = base();
        b.correction = Some(Correction::ToolsClosed);
        b.tools_open = false;
        b.executed = vec!["x".into()];
        let out = b.render().expect("has content").to_lowercase();
        for banned in ["do not", "don't", "never ", "must not", "forbidden"] {
            assert!(!out.contains(banned), "{banned} in {out}");
        }
    }
}
