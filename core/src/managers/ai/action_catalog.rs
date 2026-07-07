//! ModuleActionCatalog — per-action semantic discovery for big sysmods (#search-tool S2).
//!
//! korea-invest (278 actions) / kiwoom (208) expose only cryptic action-ID enums; dumping
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
//!   "actions": [ { "id", "name", "description", "domain"?, "params"?: {name: desc}, ... } ],
//!   "envelope": "{ \"action\": \"<id>\", \"params\": { ... } }"   // module call-shape hint
//! }
//! ```
//! Any extra per-action fields (method/path/trId/example …) ride along into
//! `get_action_schema` untouched. `requiresApproval` is NOT re-declared here — it is joined
//! from the module config's own declaration at load time (single source, no drift). Modules
//! without a catalog are simply not indexed (small enums are already self-correcting via
//! validation errors).

use std::sync::Arc;
use std::time::Duration;

use crate::managers::ai::semantic_catalog::{CatalogEntry, CatalogSource, RefreshingCatalog};
use crate::managers::module::ModuleManager;
use crate::ports::{IEmbedderCachePort, IEmbedderPort};
use crate::utils::pending_tools::requires_approval_value;

/// Rebuild TTL — config/actions.json changes land via git pull; embeddings are hash-cached so a
/// rebuild only re-reads JSON (re-embeds nothing when unchanged).
const REBUILD_TTL: Duration = Duration::from_secs(300);

struct ModuleActionSource {
    module: Arc<ModuleManager>,
}

impl ModuleActionSource {
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
                // Semantic text = domain + description + param labels — what a user query
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
                    "paramNames": param_names,
                    "requiresApproval": approval,
                });
                // Ride every declared field along (params/example/method/path/trId/domain …) —
                // get_action_schema returns them verbatim, so richer actions.json = richer detail
                // with zero loader changes.
                if let Some(obj) = a.as_object() {
                    for (k, v) in obj {
                        if matches!(k.as_str(), "id" | "name" | "description") {
                            continue;
                        }
                        extra[k] = v.clone();
                    }
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
}

#[async_trait::async_trait]
impl CatalogSource for ModuleActionSource {
    async fn load(&self) -> Vec<CatalogEntry> {
        let mut entries: Vec<CatalogEntry> = Vec::new();
        for m in self.module.list_system_modules().await {
            entries.extend(self.module_entries("system", &m.name).await);
        }
        for m in self.module.list_user_modules().await {
            entries.extend(self.module_entries("user", &m.name).await);
        }
        entries
    }
}

pub struct ModuleActionCatalog {
    catalog: RefreshingCatalog,
}

impl ModuleActionCatalog {
    pub fn new(
        module: Arc<ModuleManager>,
        embedder: Arc<dyn IEmbedderPort>,
        cache_port: Arc<dyn IEmbedderCachePort>,
    ) -> Self {
        Self {
            catalog: RefreshingCatalog::new(
                "module-actions",
                embedder,
                cache_port,
                Arc::new(ModuleActionSource { module }),
                REBUILD_TTL,
            ),
        }
    }

    /// Cross-module (default) or per-module semantic action search. Returns DISCOVERY rows
    /// only — id/name/domain/approval flag, deliberately NO param information: an index line
    /// must be a trigger, never enough to act on, or models guess the call instead of loading
    /// the detail (get_action_schema). Same principle as the skills index (2026-07-08:
    /// "인덱스만 보고 다 봤다고 생각" — 사용자 진단).
    pub async fn search(
        &self,
        query: &str,
        module: Option<&str>,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>, String> {
        let scopes: Option<Vec<String>> = module.map(|m| vec![format!("{}:", m)]);
        let matches = self
            .catalog
            .query(query, limit, scopes.as_deref())
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
                    "score": m.score,
                })
            })
            .collect())
    }

    /// Full detail for one action — params with descriptions + example + call envelope +
    /// any extra declared fields (method/path/trId …).
    pub async fn schema(&self, module: &str, action: &str) -> Option<serde_json::Value> {
        let entry = self.catalog.get(&format!("{}:{}", module, action)).await?;
        let mut out = serde_json::json!({
            "module": module,
            "action": action,
            "name": entry.name,
        });
        if let Some(obj) = entry.extra.as_object() {
            for (k, v) in obj {
                if matches!(k.as_str(), "module" | "action" | "paramNames") {
                    continue;
                }
                out[k] = v.clone();
            }
        }
        // Some source API docs carry no param table (KIS: 41 actions) — silence here sent
        // models on an endless param hunt (search loop). Say it explicitly + point at the
        // definitive next step instead.
        let params_empty = out
            .get("params")
            .map(|p| p.as_object().map(|o| o.is_empty()).unwrap_or(true))
            .unwrap_or(true);
        if params_empty {
            out["paramsNote"] = serde_json::Value::String(
                "Parameter docs are NOT available for this action — searching again will not \
                 reveal them. Construct the call from the envelope hint (+ method/path/trId) and \
                 the module input schema (get_module_config); the module's validation errors will \
                 name any missing field."
                    .to_string(),
            );
        }
        Some(out)
    }

    /// Whether any catalog entries exist for this module — error-hint branching (S3).
    pub async fn has_module(&self, module: &str) -> bool {
        self.catalog.has_prefix(&format!("{}:", module)).await
    }

    /// Distinct cataloged module names — lets search/schema responses say definitively
    /// which modules are indexed (uncataloged module = call it directly, stop searching).
    pub async fn cataloged_modules(&self) -> Vec<String> {
        self.catalog.id_prefixes().await
    }
}
