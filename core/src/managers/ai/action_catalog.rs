//! ModuleActionCatalog — per-action semantic discovery for big sysmods (#search-tool S2).
//!
//! korea-invest (275 actions) / kiwoom (200+) expose only cryptic action-ID enums; dumping
//! the enum steers weak models into wrong picks (observed: an ORDER API chosen for a chart).
//! This catalog gives the missing middle layer of progressive disclosure:
//!   `search_module_actions(query)` → ranked candidates (cross-module by default, so the
//!   "which broker" routing mistake is also softened) → `get_action_schema(module, action)`
//!   → exact params + call envelope → the model writes a correct call (no guessing).
//!
//! Declarative (zero hardcoding): a module opts in via config `actionCatalog`:
//! ```json
//! "actionCatalog": {
//!   "file": "actions.json",           // module-dir relative, OR inline:
//!   "actions": [ { "id", "name", "description", "domain"?, "params"?: {name: desc}, "example"? } ],
//!   "envelope": "{ \"action\": \"<id>\", \"params\": { ... } }"   // module call-shape hint
//! }
//! ```
//! `requiresApproval` is NOT re-declared here — it is joined from the module config's own
//! declaration at load time (single source, no drift). Modules without a catalog are simply
//! not indexed (small enums are already self-correcting via validation errors).

use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::managers::ai::semantic_catalog::{CatalogEntry, SemanticCatalog};
use crate::managers::module::ModuleManager;
use crate::ports::{IEmbedderCachePort, IEmbedderPort};
use crate::utils::pending_tools::requires_approval_value;

/// Rebuild TTL — config/actions.json changes land via git pull; embeddings are hash-cached so a
/// rebuild only re-reads JSON (re-embeds nothing when unchanged). 5 min keeps drift short without
/// per-call file reads.
const REBUILD_TTL: Duration = Duration::from_secs(300);

pub struct ModuleActionCatalog {
    module: Arc<ModuleManager>,
    catalog: SemanticCatalog,
    built_at: Mutex<Option<Instant>>,
}

impl ModuleActionCatalog {
    pub fn new(
        module: Arc<ModuleManager>,
        embedder: Arc<dyn IEmbedderPort>,
        cache_port: Arc<dyn IEmbedderCachePort>,
    ) -> Self {
        Self {
            module,
            catalog: SemanticCatalog::new("module-actions", embedder, cache_port),
            built_at: Mutex::new(None),
        }
    }

    /// Load one module's catalog declaration → entries. Inline `actions` wins; else `file`
    /// (module-dir relative, read through ModuleManager storage).
    async fn module_entries(&self, scope: &str, name: &str) -> Vec<CatalogEntry> {
        let Some(config) = self.module.get_module_config(scope, name).await else {
            return Vec::new();
        };
        let Some(decl) = config.get("actionCatalog") else {
            return Vec::new();
        };
        let approval_decl = config
            .get("requiresApproval")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let envelope = decl.get("envelope").and_then(|v| v.as_str()).unwrap_or("");
        let actions: Vec<serde_json::Value> = if let Some(arr) =
            decl.get("actions").and_then(|v| v.as_array())
        {
            arr.clone()
        } else if let Some(file) = decl.get("file").and_then(|v| v.as_str()) {
            match self.module.read_module_file(scope, name, file).await {
                Some(raw) => serde_json::from_str::<Vec<serde_json::Value>>(&raw).unwrap_or_default(),
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };
        actions
            .into_iter()
            .filter_map(|a| {
                let id = a.get("id").and_then(|v| v.as_str())?.to_string();
                let a_name = a
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string();
                let domain = a.get("domain").and_then(|v| v.as_str()).unwrap_or("");
                let desc = a.get("description").and_then(|v| v.as_str()).unwrap_or("");
                // Semantic text = name + domain + description + param labels — what a user query
                // should land on ("투자자 매매동향", "일봉", "잔고" …).
                let param_names: Vec<String> = a
                    .get("params")
                    .and_then(|v| v.as_object())
                    .map(|o| o.keys().cloned().collect())
                    .unwrap_or_default();
                let sem = format!(
                    "{} {} {}",
                    domain,
                    desc,
                    a.get("params")
                        .and_then(|v| v.as_object())
                        .map(|o| {
                            o.values()
                                .filter_map(|d| d.as_str())
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default()
                );
                let approval = requires_approval_value(&approval_decl, &id);
                let mut extra = serde_json::json!({
                    "module": name,
                    "action": id,
                    "domain": domain,
                    "paramNames": param_names,
                    "requiresApproval": approval,
                });
                if let Some(p) = a.get("params") {
                    extra["params"] = p.clone();
                }
                if let Some(e) = a.get("example") {
                    extra["example"] = e.clone();
                }
                if !envelope.is_empty() {
                    extra["envelope"] = serde_json::Value::String(envelope.to_string());
                }
                Some(CatalogEntry {
                    id: format!("{}:{}", name, id),
                    name: a_name,
                    description: sem.trim().to_string(),
                    extra,
                })
            })
            .collect()
    }

    /// TTL-gated rebuild — scans system + user modules for `actionCatalog` declarations.
    async fn ensure(&self) {
        {
            let built = self.built_at.lock().await;
            if let Some(t) = *built {
                if t.elapsed() < REBUILD_TTL {
                    return;
                }
            }
        }
        let mut entries: Vec<CatalogEntry> = Vec::new();
        for m in self.module.list_system_modules().await {
            entries.extend(self.module_entries("system", &m.name).await);
        }
        for m in self.module.list_user_modules().await {
            entries.extend(self.module_entries("user", &m.name).await);
        }
        self.catalog.set_entries(entries).await;
        *self.built_at.lock().await = Some(Instant::now());
    }

    /// Cross-module (default) or per-module semantic action search. Returns lean rows —
    /// param NAMES only; full param descriptions come from `get_action_schema` (progressive
    /// disclosure: 정확한 정보를 조금씩).
    pub async fn search(
        &self,
        query: &str,
        module: Option<&str>,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>, String> {
        self.ensure().await;
        let prefix = module.map(|m| format!("{}:", m));
        let matches = self
            .catalog
            .query(query, limit, prefix.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        Ok(matches
            .into_iter()
            .map(|m| {
                serde_json::json!({
                    "module": m.extra.get("module").cloned().unwrap_or_default(),
                    "action": m.extra.get("action").cloned().unwrap_or_default(),
                    "name": m.name,
                    "domain": m.extra.get("domain").cloned().unwrap_or_default(),
                    "requiresApproval": m.extra.get("requiresApproval").cloned().unwrap_or(serde_json::Value::Bool(false)),
                    "paramNames": m.extra.get("paramNames").cloned().unwrap_or(serde_json::Value::Array(vec![])),
                    "score": m.score,
                })
            })
            .collect())
    }

    /// Full detail for one action — params with descriptions + example + call envelope.
    pub async fn schema(&self, module: &str, action: &str) -> Option<serde_json::Value> {
        self.ensure().await;
        let entry = self.catalog.get(&format!("{}:{}", module, action)).await?;
        let mut out = serde_json::json!({
            "module": module,
            "action": action,
            "name": entry.name,
        });
        for k in ["domain", "params", "example", "envelope", "requiresApproval"] {
            if let Some(v) = entry.extra.get(k) {
                out[k] = v.clone();
            }
        }
        Some(out)
    }

    /// Whether any catalog entries exist for this module — error-hint branching (S3).
    pub async fn has_module(&self, module: &str) -> bool {
        self.ensure().await;
        self.catalog
            .get_first_with_prefix(&format!("{}:", module))
            .await
    }
}
