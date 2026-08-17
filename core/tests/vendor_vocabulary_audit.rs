//! v3-R6 — the net for "core vocabulary zero".
//!
//! Module names are DERIVED from `system/modules/` (never hand-listed), and every string
//! literal in core/infra runtime code is checked for a dispatch-shaped reference to one:
//! the literal IS the name, or carries `sysmod_<name>` / `module:<name>` / `modules/<name>`.
//! A new vendor word in runtime code = CI red, with the three disposals in the message.
//!
//! What this deliberately does NOT police (measured 2026-08-17, prototype over 11k literals):
//! - identifiers and prose — module names that are English words (notes, docs, news, fa,
//!   calendar) drown a substring net in false positives; a module reference that can actually
//!   dispatch materializes as a string, so strings are the surface with signal.
//! - comments — stripped by the tokenizer (a regex stripper got eaten by `/*` inside cron
//!   strings like "*/5"; this is a real state machine).
//! - `infra/src/adapters/` — the sanctioned vendor layer of the hexagon.
//!
//! STANDING is the acknowledged-debt ledger, not an escape hatch: every entry carries the
//! reason it may stay, and an entry that stops matching FAILS the test ("stale — remove it"),
//! which doubles as the scanner's own canary: a broken tokenizer that finds nothing turns the
//! whole ledger stale and goes red instead of printing "all clear over nothing".

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Module names derived from the directory — the single origin (never a hand copy).
fn module_names() -> Vec<String> {
    let dir = repo_root().join("system/modules");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("system/modules unreadable: {e}"))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(String::from))
        .collect();
    names.sort();
    names
}

/// (repo-relative file, module name, why it may stay). An entry here is a decision on
/// record, not an exemption by silence — and it must still match, or the test fails stale.
const STANDING: &[(&str, &str, &str)] = &[
    (
        "core/src/grpc/telegram.rs",
        "telegram",
        "telegram webhook gRPC service — pending v3-R4 (vendor services mechanized)",
    ),
    (
        "core/src/managers/ai/tool_search_index.rs",
        "law-search",
        "capability label that happens to spell like the module name — declared vocabulary, not a module reference",
    ),
    (
        "core/src/tool_registry.rs",
        "calendar",
        "schedule_task desc steers date-recording to sysmod_calendar — routing-disambiguation policy line, revisit with R4",
    ),
    (
        "core/src/tool_registry.rs",
        "notes",
        "the sing tool's score parameter — musical notes, same spelling as the module",
    ),
    (
        "core/src/tool_registry.rs",
        "sing",
        "platform-service tool name (same class as tts/image_gen — chapter 10 keeps these)",
    ),
    (
        "core/src/utils/hub_context.rs",
        "calendar",
        "DEFAULT_CORE_SYSMODS — the built-in fallback of the vault setting (system:hub:core-sysmods)",
    ),
    (
        "core/src/utils/hub_context.rs",
        "notes",
        "DEFAULT_CORE_SYSMODS — the built-in fallback of the vault setting (system:hub:core-sysmods)",
    ),
    (
        "infra/src/main.rs",
        "calendar",
        "built-in default of the system:cron:record-module setting — the run sites read the vault",
    ),
    (
        "infra/src/main.rs",
        "telegram",
        "legacy alias normalization: stored notify:\"telegram\" is read as module:telegram (external compatibility)",
    ),
    (
        "infra/src/mcp_server.rs",
        "calendar",
        "MCP mirror of the schedule_task calendar steer — same policy line as tool_registry",
    ),
];

/// String literals of one file, comments removed, cut at the first top-of-line
/// `#[cfg(...test...)]` (test mods sit at the bottom of files in this codebase).
fn string_literals(src: &str) -> Vec<(usize, String)> {
    let cut_line = src
        .lines()
        .position(|l| {
            let s = l.trim_start();
            s.starts_with("#[cfg(") && s.split(')').next().unwrap_or("").contains("test")
        })
        .unwrap_or(usize::MAX);
    let text: String = src
        .lines()
        .take(cut_line)
        .collect::<Vec<_>>()
        .join("\n");
    let b = text.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut line = 1usize;
    while i < n {
        match b[i] {
            b'\n' => {
                line += 1;
                i += 1;
            }
            b'/' if i + 1 < n && b[i + 1] == b'/' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                let mut depth = 1usize;
                i += 2;
                while i < n && depth > 0 {
                    if b[i] == b'\n' {
                        line += 1;
                        i += 1;
                    } else if b[i] == b'/' && i + 1 < n && b[i + 1] == b'*' {
                        depth += 1;
                        i += 2;
                    } else if b[i] == b'*' && i + 1 < n && b[i + 1] == b'/' {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            b'r' if i + 1 < n && (b[i + 1] == b'#' || b[i + 1] == b'"') => {
                let mut j = i + 1;
                let mut hashes = 0usize;
                while j < n && b[j] == b'#' {
                    hashes += 1;
                    j += 1;
                }
                if j < n && b[j] == b'"' {
                    j += 1;
                    let close: Vec<u8> = std::iter::once(b'"').chain(std::iter::repeat(b'#').take(hashes)).collect();
                    let start = j;
                    let start_line = line;
                    let mut k = j;
                    let mut found = None;
                    while k + close.len() <= n {
                        if &b[k..k + close.len()] == close.as_slice() {
                            found = Some(k);
                            break;
                        }
                        if b[k] == b'\n' {
                            line += 1;
                        }
                        k += 1;
                    }
                    let Some(end) = found else { break };
                    out.push((start_line, String::from_utf8_lossy(&b[start..end]).into_owned()));
                    i = end + close.len();
                } else {
                    i += 1;
                }
            }
            b'"' => {
                let start_line = line;
                let mut j = i + 1;
                let mut lit: Vec<u8> = Vec::new();
                while j < n {
                    match b[j] {
                        b'\\' if j + 1 < n => {
                            lit.push(b[j]);
                            lit.push(b[j + 1]);
                            j += 2;
                        }
                        b'"' => break,
                        b'\n' => {
                            line += 1;
                            lit.push(b'\n');
                            j += 1;
                        }
                        c => {
                            lit.push(c);
                            j += 1;
                        }
                    }
                }
                out.push((start_line, String::from_utf8_lossy(&lit).into_owned()));
                i = j + 1;
            }
            // char literal — only matters when it holds a quote ('"') or an escape ('\'')
            b'\'' if i + 2 < n && b[i + 2] == b'\'' && b[i + 1] != b'\\' => i += 3,
            b'\'' if i + 3 < n && b[i + 1] == b'\\' && b[i + 3] == b'\'' => i += 4,
            _ => i += 1,
        }
    }
    out
}

/// Dispatch-shaped reference: the literal IS the module name, or carries a
/// sysmod_/module:/modules/ form of it.
fn literal_hits(name: &str, lit: &str) -> bool {
    let under = name.replace('-', "_");
    if lit == name || lit == under {
        return true;
    }
    [
        format!("sysmod_{under}"),
        format!("sysmod_{name}"),
        format!("module:{name}"),
        format!("modules/{name}"),
    ]
    .iter()
    .any(|needle| lit.contains(needle.as_str()))
}

fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.is_dir() {
            rs_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn runtime_code_names_no_module_the_directory_did_not_sanction() {
    let root = repo_root();
    let names = module_names();
    assert!(
        names.len() >= 30,
        "system/modules yielded only {} names — the derivation broke, the audit is checking nothing",
        names.len()
    );

    let mut files: Vec<PathBuf> = Vec::new();
    rs_files(&root.join("core/src"), &mut files);
    rs_files(&root.join("infra/src"), &mut files);
    let adapters = root.join("infra/src/adapters");
    files.retain(|p| !p.starts_with(&adapters));
    assert!(
        files.len() >= 120,
        "only {} runtime files scanned — the walk broke, the audit is checking nothing",
        files.len()
    );

    let mut literal_count = 0usize;
    let mut hits: Vec<(String, String, usize, String)> = Vec::new(); // (file, module, line, literal)
    for path in &files {
        let src = fs::read_to_string(path).unwrap_or_default();
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        for (line, lit) in string_literals(&src) {
            literal_count += 1;
            for name in &names {
                if literal_hits(name, &lit) {
                    let preview: String = lit.chars().take(90).collect();
                    hits.push((rel.clone(), name.clone(), line, preview));
                }
            }
        }
    }
    assert!(
        literal_count >= 5_000,
        "only {literal_count} string literals scanned — the tokenizer broke, the audit is checking nothing"
    );
    println!(
        "vendor-vocabulary audit: {} modules × {} files × {} literals",
        names.len(),
        files.len(),
        literal_count
    );

    let standing: BTreeSet<(&str, &str)> = STANDING.iter().map(|(f, m, _)| (*f, *m)).collect();
    let hit_pairs: BTreeSet<(String, String)> =
        hits.iter().map(|(f, m, _, _)| (f.clone(), m.clone())).collect();

    let new_words: Vec<String> = hits
        .iter()
        .filter(|(f, m, _, _)| !standing.contains(&(f.as_str(), m.as_str())))
        .map(|(f, m, line, lit)| format!("  {f}:{line} names `{m}` in {lit:?}"))
        .collect();
    assert!(
        new_words.is_empty(),
        "a module name entered runtime code — core/infra must not know vendors.\n\
         Disposals: parameterize the mechanism / pass through without interpreting / move policy to a setting.\n\
         If it genuinely must stand, add it to STANDING with its reason.\n{}",
        new_words.join("\n")
    );

    let stale: Vec<String> = STANDING
        .iter()
        .filter(|(f, m, _)| !hit_pairs.contains(&((*f).to_string(), (*m).to_string())))
        .map(|(f, m, why)| format!("  {f} :: {m} ({why})"))
        .collect();
    assert!(
        stale.is_empty(),
        "stale STANDING entries — the debt they recorded is gone (or the scanner broke); remove them:\n{}",
        stale.join("\n")
    );
}
