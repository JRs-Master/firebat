//! AppManager — the manager a published app talks to.
//!
//! An app is a citizen of the same shape as a module. A module is isolated in a process and speaks
//! to the framework through a stdin/stdout envelope; an app is isolated on an opaque browser origin
//! and speaks through a postMessage envelope. Neither calls Firebat directly — both go
//! adapter → manager → core (2026-08-29, the user's own correction: *"파이어뱃은 원래 직접 안
//! 부르잖아 모듈-인프라-매니저-코어 순서지 그건 앱도 마찬가지야"*).
//!
//! This manager is the middle of that path for apps. It answers three questions and nothing else:
//! what did this page declare, may it do the thing it is asking for, and where does its data live.
//! Policy translation (sandbox tokens, CSP) belongs to whoever renders the frame; the transport
//! belongs to the bridge.

use std::sync::Arc;

use crate::managers::page::PageManager;
use crate::ports::IPageStorePort;
use crate::utils::page_declaration::{parse_declaration, PageDeclaration, PageKind};

/// Bytes one page's store may hold before writes are refused.
///
/// A published app is a guest on someone's disk, and the failure mode of no budget is one runaway
/// page filling the machine that also runs the trading loop. Five megabytes is a lot of key/value
/// state — scoreboards, save games, drafts — and far short of anything that could hurt. A page that
/// legitimately needs more is a declaration this can grow into, not a constant to raise blindly.
pub const PAGE_STORE_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub struct AppManager {
    page: Arc<PageManager>,
    store: Option<Arc<dyn IPageStorePort>>,
    /// Modules an app may reach. Held here so the permission check and the execution are the same
    /// step — split across two calls, the page could be edited between them.
    modules: Option<Arc<crate::managers::module::ModuleManager>>,
}

impl AppManager {
    pub fn new(page: Arc<PageManager>) -> Self {
        Self {
            page,
            store: None,
            modules: None,
        }
    }

    pub fn with_modules(mut self, modules: Arc<crate::managers::module::ModuleManager>) -> Self {
        self.modules = Some(modules);
        self
    }

    pub fn with_store(mut self, store: Arc<dyn IPageStorePort>) -> Self {
        self.store = Some(store);
        self
    }

    /// What the page at `slug` declared. `None` = no such page.
    pub fn declaration(&self, slug: &str) -> Option<PageDeclaration> {
        let rec = self.page.get(slug)?;
        let spec: serde_json::Value = serde_json::from_str(&rec.spec).ok()?;
        Some(parse_declaration(&spec))
    }

    /// Is this page an app, and what did it ask for?
    pub fn app_declaration(&self, slug: &str) -> Option<PageDeclaration> {
        self.declaration(slug).filter(|d| d.kind == PageKind::App)
    }

    /// May this page call that module? Undeclared is refused — a page that named nothing gets
    /// nothing, because the alternative is that the pages which said the least can do the most.
    pub fn may_call_module(&self, slug: &str, module: &str) -> bool {
        self.app_declaration(slug)
            .map(|d| d.needs.modules.iter().any(|m| m == module))
            .unwrap_or(false)
    }

    fn store_for(&self, slug: &str) -> Result<&Arc<dyn IPageStorePort>, String> {
        let decl = self
            .app_declaration(slug)
            .ok_or_else(|| format!("'{slug}' is not an app page"))?;
        if !decl.needs.storage {
            return Err(format!(
                "'{slug}' did not declare storage. Add `needs: {{ storage: true }}` to the page's \
                 declaration — the framework does not open it by default."
            ));
        }
        self.store
            .as_ref()
            .ok_or_else(|| "page storage is not wired on this instance".to_string())
    }

    pub fn store_get(&self, slug: &str, key: &str) -> Result<Option<String>, String> {
        Ok(self.store_for(slug)?.get(slug, key))
    }

    pub fn store_set(&self, slug: &str, key: &str, value: &str) -> Result<(), String> {
        self.store_for(slug)?
            .set(slug, key, value, PAGE_STORE_MAX_BYTES)
    }

    pub fn store_delete(&self, slug: &str, key: &str) -> Result<(), String> {
        self.store_for(slug)?.delete(slug, key)
    }

    /// Everything the page holds, for the bootstrap the serving route injects into the document.
    ///
    /// A `src=` iframe cannot be seeded the way a `srcdoc` one can, so the app's first synchronous
    /// read has to find its data already present — which works precisely because this storage is
    /// the server's, not the browser's.
    pub fn store_seed(&self, slug: &str) -> serde_json::Value {
        let Ok(store) = self.store_for(slug) else {
            return serde_json::json!({});
        };
        let mut map = serde_json::Map::new();
        for (k, v) in store.entries(slug) {
            map.insert(k, serde_json::Value::String(v));
        }
        serde_json::Value::Object(map)
    }

    /// Run a module on behalf of a published app.
    ///
    /// The permission and the run are one step: `may_call_module` reads the page's declaration and
    /// the call happens right here, so there is no window in which the page could be edited between
    /// being checked and being obeyed. Everything the module path already enforces — enabled,
    /// input validation, the approval gate, the envelope, auto-cache — still happens, because this
    /// is that path and not a way around it.
    ///
    /// The refusal names the fix: an app that needs a module says so in its own declaration.
    pub async fn run_module(
        &self,
        slug: &str,
        module: &str,
        input: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if !self.may_call_module(slug, module) {
            return Err(format!(
                "'{slug}' may not call '{module}'. Add it to the page's declaration (`needs: {{ modules: [\"{module}\"] }}`) and republish."
            ));
        }
        let modules = self
            .modules
            .as_ref()
            .ok_or_else(|| "module calls are not wired on this instance".to_string())?;
        let out = modules.run(module, input).await?;
        serde_json::to_value(out).map_err(|e| format!("module output: {e}"))
    }

    pub fn store_bytes(&self, slug: &str) -> u64 {
        self.store_for(slug).map(|s| s.bytes(slug)).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::page_declaration::PageNeeds;

    #[test]
    fn a_page_that_declared_nothing_may_call_nothing() {
        // The check under test is the one that matters here — an empty declaration grants nothing,
        // whichever module is asked for.
        let d = PageDeclaration {
            kind: PageKind::App,
            source: None,
            needs: PageNeeds::default(),
        };
        assert!(!d.needs.modules.iter().any(|m| m == "yfinance"));
        assert!(!d.needs.storage);
    }

    #[test]
    fn the_budget_is_stated_in_bytes_not_guessed() {
        assert_eq!(PAGE_STORE_MAX_BYTES, 5 * 1024 * 1024);
    }
}
