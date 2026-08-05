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

/// The sibling that owns this module's accounts.
///
/// A broker split into a quote half and a trading half is one relationship: one set of app keys,
/// one account that answers "who are we, at this broker". Both halves need a credential — these
/// venues want a token even for a chart — so the accounts are registered once, on the trading
/// half where the orders go, and the quote half borrows the list.
///
/// One home, not two lists to keep in step. Registering on either screen writes here, and both
/// screens read it — a shared credential that shows up on one screen and not the other is the
/// same credential twice, which is the thing this avoids.
///
/// Nothing widens. What a caller may *do* is the action list, and the quote half has no order or
/// account action in it. Holding a token issued for an account is not being able to trade in it.
pub fn credential_scope(config: &serde_json::Value) -> Option<String> {
    config
        .get("credentialScope")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// One registered account. The credentials live in the vault under [`secret_key`]; this is the
/// index — what the account is called, whether it is real or mock, and which markets it may trade.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntry {
    /// Alias — the account's name, what the caller passes as `account`, and what scopes the vault
    /// keys. Stable: renaming means re-registering the credentials.
    pub id: String,
    /// `"real"` or `"mock"`. Mock keys are rejected on the live domain and vice versa, so this is
    /// the account's nature rather than a per-call option.
    #[serde(default)]
    pub mode: String,
    /// Markets this account may be used for (e.g. `["kr","us"]`). Brokers differ: one account
    /// covers both at Korea Investment, while Kiwoom issues a separate key per market.
    #[serde(default)]
    pub markets: Vec<String>,
    /// Account number exactly as the broker shows it, hyphens and all (`12345678-01`). It never
    /// authenticates anything — the credential IS the account — so it is stored verbatim and
    /// reshaped at the point of use ([`digits`]), rather than normalised on the way in where the
    /// broker's own formatting would be lost.
    #[serde(default)]
    pub account_no: Option<String>,
}

impl AccountEntry {
    pub fn is_mock(&self) -> bool {
        self.mode.eq_ignore_ascii_case("mock")
    }

    /// The account number as an API wants it — digits only. Brokers print a separator the request
    /// body does not take (KIS splits the same digits into `CANO` + `ACNT_PRDT_CD`).
    pub fn digits(&self) -> String {
        self.account_no
            .as_deref()
            .unwrap_or_default()
            .chars()
            .filter(char::is_ascii_digit)
            .collect()
    }

    /// Whether this account is registered for `market`.
    ///
    /// An account that covers both says so — Korea Investment's registers as `["kr","us"]`, not as
    /// a blank. So an empty list is not "any", it is **nothing recorded**, and the caller decides
    /// what that means ([`market_conflict`] treats it as an incomplete registration).
    pub fn serves(&self, market: &str) -> bool {
        let want = market.trim();
        want.is_empty()
            || self
                .markets
                .iter()
                .any(|m| m.trim().eq_ignore_ascii_case(want))
    }

    /// Does this account match a "which accounts" request? `None` means "do not care".
    ///
    /// The six shapes a person actually asks in are the cross product of these two: every broker's
    /// every account, one broker's every account, every broker's domestic accounts, one broker's
    /// domestic accounts, and the same two for overseas. Filtering answers all six; searching
    /// answers none of them, because `모의국내` and `모의해외` are near-identical short labels and
    /// the thing being chosen between is the market, which is enumerable.
    pub fn matches(&self, mode: Option<&str>, market: Option<&str>) -> bool {
        if let Some(want) = mode {
            if !self.mode.eq_ignore_ascii_case(want.trim()) {
                return false;
            }
        }
        match market {
            Some(m) if !m.trim().is_empty() => self.serves(m),
            _ => true,
        }
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
        format!("{} ({})", self.id, parts.join(", "))
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

    /// This module's accounts, plus whatever it borrows from the sibling it names.
    ///
    /// A broker's accounts are registered on its trading module — that is where an order goes and
    /// where they belong. The quote half declares `credentialScope` pointing at it and borrows
    /// the list, because these venues want a token even for a chart. An alias registered here
    /// wins over a borrowed one of the same name.
    pub fn load_with_base(
        vault: &dyn crate::ports::IVaultPort,
        module: &str,
        base: Option<&str>,
    ) -> Self {
        let mut own = Self::load(vault, module);
        let Some(base) = base.filter(|b| !b.is_empty() && *b != module) else {
            return own;
        };
        let inherited = Self::load(vault, base);
        // Everything, not only the primary. The accounts belong to the trading module — that is
        // where they are registered and where the order goes — and the quote half borrows a
        // credential from them. Which one it borrows is the caller's business: a venue that rate
        // limits per key is a reason to be able to name a spare, not a reason to hide the list.
        for entry in inherited.accounts {
            if !own.accounts.iter().any(|a| a.id == entry.id) {
                own.accounts.push(entry);
            }
        }
        if own.primary.is_none() {
            own.primary = inherited.primary;
        }
        own
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

/// Markets a module says its accounts are scoped by — `accounts.markets` in its config.
///
/// This is what makes an account's own `markets` mean anything. A broker that does not declare it
/// has accounts that are not per-market, and a `market` argument on such a module is about
/// something else entirely (Upbit's `market` is a ticker).
pub fn declared_markets(config: &serde_json::Value) -> Vec<String> {
    config
        .pointer("/accounts/markets")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Why this account may not serve this call — `None` to proceed.
///
/// `declared` gates everything: a broker that never said its accounts are per-market has nothing
/// here to check, which is what keeps a `market` argument that means something else (Upbit's is a
/// ticker) out of it. Under a broker that did declare them, two refusals:
///
/// 1. **The account has no market recorded** — refused on *every* call, whether or not the call
///    names a market. Which market an account is for is part of what the account is: it decides
///    the venue an order reaches and which of a broker's several app keys authenticates. An
///    account missing it is registered but not usable, like one missing its app key, and the
///    settings screen will not produce one — so a blank is hand-written vault data. Attaching it
///    to whatever market happens to be asked for is the one thing that must not happen.
/// 2. **The call names a market the account is not registered for.** Two places decide which
///    account trades — the registry says which markets an alias is for, the caller names an alias
///    — and nothing compared them. Measured 2026-08-04: the domestic schedule named an alias the
///    registry had marked `us`, and every order came back `RC4091 모의투자 종료된 계좌입니다`,
///    because the credential behind that alias was the other market's. It read as a broker outage.
///
/// Refusing rather than resolving: picking whichever account does declare the market would move
/// an order to an account the caller never named — the same accident in the other direction.
pub fn market_refusal(
    entry: &AccountEntry,
    declared: &[String],
    requested: Option<&str>,
) -> Option<String> {
    if declared.is_empty() {
        return None;
    }
    if entry.markets.is_empty() {
        return Some(format!(
            "account '{}' has no market recorded, so it cannot be used at all — set its market in the module settings. An account's market decides which venue an order reaches, so it is not something to guess from the call.",
            entry.id
        ));
    }
    let market = requested.map(str::trim).filter(|m| !m.is_empty())?;
    if entry.serves(market) {
        return None;
    }
    Some(format!(
        "account '{}' is registered for {} — it cannot be used for '{}'. Name an account registered for '{}', or fix that account's markets in the module settings.",
        entry.id,
        entry.markets.join("/"),
        market,
        market
    ))
}

#[cfg(test)]
mod market_tests {
    use super::*;

    fn acct(id: &str, markets: &[&str]) -> AccountEntry {
        AccountEntry {
            id: id.into(),
            markets: markets.iter().map(|m| m.to_string()).collect(),
            ..Default::default()
        }
    }

    fn both() -> Vec<String> {
        vec!["kr".to_string(), "us".to_string()]
    }

    /// Upbit's `market` is a ticker, not a venue. A broker that never said its accounts are
    /// per-market has nothing here to contradict.
    #[test]
    fn a_broker_whose_accounts_are_not_per_market_is_not_checked() {
        let e = acct("main", &[]);
        assert_eq!(market_refusal(&e, &[], Some("KRW-BTC")), None);
        assert_eq!(market_refusal(&e, &[], None), None);
    }

    #[test]
    fn a_market_the_account_declares_passes_whatever_its_case() {
        let e = acct("모의", &["kr", "us"]);
        assert!(e.serves("kr") && e.serves("US"));
        assert_eq!(market_refusal(&e, &both(), Some("KR")), None);
    }

    /// The live shape of the 2026-08-04 outage: the alias named 모의국내 had been registered for
    /// `us`, and the domestic schedule kept naming it.
    #[test]
    fn a_market_the_account_does_not_declare_is_refused_naming_both() {
        let e = acct("모의국내", &["us"]);
        assert!(!e.serves("kr"));
        let msg = market_refusal(&e, &both(), Some("kr")).expect("mismatch must be reported");
        assert!(msg.contains("모의국내"), "{msg}");
        assert!(msg.contains("us"), "{msg}");
        assert!(msg.contains("'kr'"), "{msg}");
    }

    /// The settings screen refuses to save an account without a market, so a blank one under a
    /// per-market broker is hand-written vault data. It is refused on **every** call — a balance
    /// read names no market, and attaching such an account to whichever one the call happens to
    /// mention is exactly what must not happen.
    #[test]
    fn an_account_with_no_market_recorded_cannot_be_used_at_all() {
        let e = acct("손으로적음", &[]);
        for asked in [Some("kr"), Some("us"), None] {
            let msg = market_refusal(&e, &both(), asked).expect("blank must be refused");
            assert!(msg.contains("no market recorded"), "{msg}");
            assert!(msg.contains("손으로적음"), "{msg}");
        }
    }

    #[test]
    fn a_caller_that_names_no_market_makes_no_claim_to_contradict() {
        let e = acct("모의국내", &["us"]);
        assert_eq!(market_refusal(&e, &both(), None), None);
        assert_eq!(market_refusal(&e, &both(), Some("   ")), None);
    }

    #[test]
    fn the_declaration_is_read_off_the_accounts_block() {
        let cfg = serde_json::json!({"accounts": {"modes": ["real"], "markets": ["kr", "us"]}});
        assert_eq!(declared_markets(&cfg), both());
        for none in [
            serde_json::json!({}),
            serde_json::json!({"accounts": {"modes": ["real"]}}),
            serde_json::json!({"accounts": {"markets": []}}),
            serde_json::json!({"accounts": {"markets": "kr"}}),
        ] {
            assert!(declared_markets(&none).is_empty(), "{none}");
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

    /// Which half a credential is entered on must not matter — the two halves are one broker
    /// relationship, and the scope names the single place the list lives. A module that declares
    /// no scope keeps owning its own, which is every module that was never split.
    #[test]
    fn the_scope_names_where_the_accounts_live() {
        let quotes = serde_json::json!({ "credentialScope": "kiwoom-trade" });
        assert_eq!(credential_scope(&quotes).as_deref(), Some("kiwoom-trade"));

        for empty in [
            serde_json::json!({}),
            serde_json::json!({ "credentialScope": "" }),
            serde_json::json!({ "credentialScope": "   " }),
            serde_json::json!({ "credentialScope": 7 }),
        ] {
            assert_eq!(credential_scope(&empty), None, "{empty}");
        }
    }

    /// The credentials themselves are keyed by alias, not by module, so they were always shared —
    /// only the index needed a home. This is what makes the registry move a rename of one key
    /// rather than a migration of every app key.
    #[test]
    fn a_credential_key_does_not_mention_the_module() {
        let quotes_view = secret_key("KIWOOM_APP_KEY", Some("모의국내"), false);
        let trade_view = secret_key("KIWOOM_APP_KEY", Some("모의국내"), false);
        assert_eq!(quotes_view, trade_view);
        assert_eq!(quotes_view, "user:KIWOOM_APP_KEY@모의국내");
        assert!(!quotes_view.contains("kiwoom-trade"));
    }

    #[test]
    fn the_account_number_keeps_its_separator_but_yields_digits_on_demand() {
        let e = AccountEntry { account_no: Some("12345678-01".into()), ..Default::default() };
        assert_eq!(e.account_no.as_deref(), Some("12345678-01"));
        assert_eq!(e.digits(), "1234567801");
        assert_eq!(AccountEntry::default().digits(), "");
    }

    #[test]
    fn describe_reads_as_one_line() {
        let e = AccountEntry {
            id: "모의국내".into(),
            mode: "mock".into(),
            markets: vec!["kr".into()],
            account_no: Some("81012345-01".into()),
        };
        assert_eq!(e.describe(), "모의국내 (81012345-01, mock, kr)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, mode: &str, markets: &[&str]) -> AccountEntry {
        AccountEntry {
            id: id.to_string(),
            mode: mode.to_string(),
            markets: markets.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn account_filter_answers_the_six_shapes_people_ask_in() {
        // Every/one broker × every/domestic/overseas — the cross product, which is why this is a
        // filter and not a search: the alias is a short opaque label, the market is what is chosen.
        let kr = entry("모의국내", "mock", &["kr"]);
        let us = entry("모의해외", "mock", &["us"]);
        let both = entry("키움토스", "real", &["kr", "us"]);
        let all = [&kr, &us, &both];

        let pick = |mode: Option<&str>, market: Option<&str>| -> Vec<String> {
            all.iter()
                .filter(|a| a.matches(mode, market))
                .map(|a| a.id.clone())
                .collect()
        };
        assert_eq!(pick(None, None).len(), 3, "no filter = every account");
        assert_eq!(pick(None, Some("kr")), vec!["모의국내", "키움토스"],
                   "domestic includes the account that serves both");
        assert_eq!(pick(None, Some("us")), vec!["모의해외", "키움토스"]);
        assert_eq!(pick(Some("mock"), None), vec!["모의국내", "모의해외"]);
        assert_eq!(pick(Some("mock"), Some("us")), vec!["모의해외"]);
        assert_eq!(pick(Some("real"), Some("kr")), vec!["키움토스"]);
        // An empty string is not a filter — it is a caller that had nothing to say.
        assert_eq!(pick(None, Some("   ")).len(), 3);
    }


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
    fn an_alias_is_a_name_so_it_may_hold_spaces() {
        // Only `@` is structural. A vault key is an opaque string, so "모의 국내" is a key like
        // any other — refusing spaces would only make the user rename their own account.
        assert_eq!(
            secret_key("KIS_APP_KEY", Some("모의 국내"), false),
            "user:KIS_APP_KEY@모의 국내"
        );
        assert_eq!(account_of("user:KIS_APP_KEY@모의 국내"), Some("모의 국내"));
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
