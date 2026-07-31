//! Vault key shapes for credentials that belong to ONE account.
//!
//! Brokers turned out to issue an app key **per account**, not per user — Kiwoom rejects a real key
//! on the mock domain outright (`8030: 투자구분(실전/모의)이 달라서 Appkey를 사용할수가 없습니다`) and
//! Korea Investment is the same, so one stored pair can serve exactly one account. That is also why
//! a Kiwoom order body carries no account field: the credential IS the account.
//!
//! So a secret name may exist once per account, and the module never learns about any of it — the
//! sandbox decides which account's value goes into the env var the module already reads. Adding an
//! account is a vault write, not a code change.
//!
//! Key shapes, all under the existing `user:` prefix:
//!
//! ```text
//! user:KIWOOM_APP_KEY              — no account (the single-credential form that predates this)
//! user:KIWOOM_APP_KEY@main         — the account whose id is `main`
//! user:KIWOOM_ACCESS_TOKEN@main    — that account's token slot
//! ```
//!
//! `@` cannot appear in a secret name, so the two forms can never collide, and a caller that names
//! no account keeps the old behaviour exactly.

/// Vault key for `name`, scoped to `account` when one is given.
///
/// `mock` only applies to the un-scoped form, where it selects the legacy `__mock` token slot. An
/// account already IS real or mock — its credentials were issued that way — so scoping and the mock
/// suffix never combine.
pub fn secret_key(name: &str, account: Option<&str>, mock: bool) -> String {
    match account.map(str::trim).filter(|a| !a.is_empty()) {
        Some(id) => format!("user:{name}@{id}"),
        None if mock => format!("user:{name}__mock"),
        None => format!("user:{name}"),
    }
}

/// Account id embedded in a key, if any. For listing what accounts a secret has been stored for.
pub fn account_of(key: &str) -> Option<&str> {
    key.rsplit_once('@').map(|(_, id)| id).filter(|id| !id.is_empty())
}

/// Vault key holding a module's account registry (the list, not the credentials).
pub fn registry_key(module: &str) -> String {
    format!("module-accounts:{module}")
}

/// One registered account. The credentials live in the vault under [`secret_key`]; this is the
/// index — what the account is called, whether it is real or mock, and which markets it may trade.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntry {
    /// Alias — what the user types and what scopes the vault keys. Stable; renaming means
    /// re-registering the credentials.
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// `"real"` or `"mock"`. Mock keys are rejected on the live domain and vice versa, so this is
    /// the account's nature rather than a per-call option.
    #[serde(default)]
    pub mode: String,
    /// Markets this account may be used for (e.g. `["kr","us"]`). Brokers differ: one account
    /// covers both at Korea Investment, while Kiwoom issues a separate key per market.
    #[serde(default)]
    pub markets: Vec<String>,
    /// Account number as the broker reports it — filled from the module's `listAction`, shown
    /// beside the alias. Never used to authenticate (the credential IS the account).
    #[serde(default)]
    pub account_no: Option<String>,
}

impl AccountEntry {
    pub fn is_mock(&self) -> bool {
        self.mode.eq_ignore_ascii_case("mock")
    }

    /// `별칭 (계좌번호, 모의, kr/us)` — the one-line form the settings UI and the model both read.
    pub fn describe(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(no) = self.account_no.as_deref().filter(|s| !s.is_empty()) {
            parts.push(no.to_string());
        }
        parts.push(if self.is_mock() { "mock" } else { "real" }.to_string());
        if !self.markets.is_empty() {
            parts.push(self.markets.join("/"));
        }
        let name = if self.label.is_empty() { &self.id } else { &self.label };
        format!("{name} ({})", parts.join(", "))
    }
}

/// A module's registered accounts, plus which one unnamed calls run as.
///
/// `primary` is a pointer into `accounts`, not a separate slot: the account used for quotes and
/// charts is a registered account like any other, so it carries an alias, a mode and markets too.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRegistry {
    #[serde(default)]
    pub primary: Option<String>,
    #[serde(default)]
    pub accounts: Vec<AccountEntry>,
}

impl AccountRegistry {
    /// Unreadable JSON yields an empty registry: a corrupt index must not take the module's
    /// pre-account credentials down with it.
    pub fn parse(raw: &str) -> Self {
        match serde_json::from_str::<Self>(raw) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(target: "module", error = %e, "account registry is not readable — treating the module as having no registered accounts");
                Self::default()
            }
        }
    }

    pub fn load(vault: &dyn crate::ports::IVaultPort, module: &str) -> Self {
        vault
            .get_secret(&registry_key(module))
            .map(|raw| Self::parse(&raw))
            .unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }

    pub fn find(&self, id: &str) -> Option<&AccountEntry> {
        self.accounts.iter().find(|a| a.id == id)
    }

    /// The account unnamed calls run as: the designated primary, or the only registered account
    /// when there is exactly one (a single account needs no designation to be unambiguous).
    pub fn primary_entry(&self) -> Option<&AccountEntry> {
        match self.primary.as_deref().filter(|p| !p.is_empty()) {
            Some(id) => self.find(id),
            None if self.accounts.len() == 1 => self.accounts.first(),
            None => None,
        }
    }

    /// Which account a call runs as. An unknown alias is an error naming the registered ones —
    /// falling back to the primary would place an order on the wrong account.
    pub fn resolve(&self, requested: Option<&str>) -> Result<Option<&AccountEntry>, String> {
        match requested.map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => self.find(id).map(Some).ok_or_else(|| {
                let known: Vec<&str> = self.accounts.iter().map(|a| a.id.as_str()).collect();
                if known.is_empty() {
                    format!("account '{id}' is not registered — this module has no accounts registered yet.")
                } else {
                    format!(
                        "account '{id}' is not registered. Registered: {}",
                        known.join(", ")
                    )
                }
            }),
            None => Ok(self.primary_entry()),
        }
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    fn reg(json: serde_json::Value) -> AccountRegistry {
        AccountRegistry::parse(&json.to_string())
    }

    #[test]
    fn corrupt_json_reads_as_no_accounts() {
        assert!(AccountRegistry::parse("{{not json").is_empty());
    }

    #[test]
    fn a_lone_account_is_the_primary_without_being_designated() {
        let r = reg(serde_json::json!({"accounts": [{"id": "main"}]}));
        assert_eq!(r.primary_entry().unwrap().id, "main");
        assert_eq!(r.resolve(None).unwrap().unwrap().id, "main");
    }

    #[test]
    fn several_accounts_need_a_designation() {
        let r = reg(serde_json::json!({"accounts": [{"id": "a"}, {"id": "b"}]}));
        assert!(r.primary_entry().is_none());
        let r = reg(serde_json::json!({"primary": "b", "accounts": [{"id": "a"}, {"id": "b"}]}));
        assert_eq!(r.resolve(None).unwrap().unwrap().id, "b");
    }

    #[test]
    fn an_unregistered_alias_errors_with_the_registered_ones() {
        let r = reg(serde_json::json!({"accounts": [{"id": "real-kr"}, {"id": "mock-kr"}]}));
        let err = r.resolve(Some("real-us")).unwrap_err();
        assert!(err.contains("real-kr, mock-kr"), "{err}");
    }

    #[test]
    fn no_accounts_at_all_resolves_to_the_shared_credentials() {
        assert!(AccountRegistry::default().resolve(None).unwrap().is_none());
    }

    #[test]
    fn describe_reads_as_one_line() {
        let e = AccountEntry {
            id: "mock-kr".into(),
            label: "모의 국내".into(),
            mode: "mock".into(),
            markets: vec!["kr".into()],
            account_no: Some("81012345-01".into()),
        };
        assert_eq!(e.describe(), "모의 국내 (81012345-01, mock, kr)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unscoped_keys_are_unchanged() {
        assert_eq!(secret_key("KIWOOM_APP_KEY", None, false), "user:KIWOOM_APP_KEY");
        assert_eq!(
            secret_key("KIWOOM_ACCESS_TOKEN", None, true),
            "user:KIWOOM_ACCESS_TOKEN__mock"
        );
    }

    #[test]
    fn an_account_scopes_the_key_and_ignores_the_mock_suffix() {
        // The account was issued as real or mock; the suffix would be a second, contradictable
        // source of truth for the same thing.
        assert_eq!(
            secret_key("KIWOOM_APP_KEY", Some("mock-kr"), true),
            "user:KIWOOM_APP_KEY@mock-kr"
        );
        assert_eq!(
            secret_key("KIWOOM_APP_KEY", Some("mock-kr"), false),
            "user:KIWOOM_APP_KEY@mock-kr"
        );
    }

    #[test]
    fn blank_account_falls_back_to_the_unscoped_key() {
        assert_eq!(secret_key("K", Some(""), false), "user:K");
        assert_eq!(secret_key("K", Some("   "), false), "user:K");
    }

    #[test]
    fn account_is_readable_back_out_of_a_key() {
        assert_eq!(account_of("user:KIWOOM_APP_KEY@main"), Some("main"));
        assert_eq!(account_of("user:KIWOOM_APP_KEY"), None);
    }
}
