//! SSRF guard — block AI-driven `network_request` to internal / private / metadata targets.
//!
//! The in-app AI can be steered by untrusted content (scraped pages, hub visitors, library docs)
//! = prompt injection. An unguarded `network_request` lets a hijacked AI reach cloud metadata
//! (169.254.169.254 → instance creds), internal services (localhost:50051 gRPC, :50052 MCP,
//! :3000 frontend), or RFC1918 hosts. This pure check rejects those before the fetch.
//!
//! Scope: applied at the AI-facing `network_request` tool (both MCP and FC paths), NOT in the
//! generic network adapter — internal/legit `fetch` callers stay unaffected.
//!
//! Best-effort: literal IPs + well-known internal hostnames are blocked. DNS-rebinding (a public
//! hostname resolving to a private IP) is a known residual — the adapter could pin the resolved IP
//! later; this catches the realistic metadata/loopback/RFC1918 vectors.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;

/// HTTP client for AI-controlled fetches (`network_request` tool, media referenceImage):
/// re-validates EVERY redirect hop with `is_blocked_fetch_url`. The call-site guard only sees
/// the initial URL — with the shared client's default policy a `302 → http://169.254.169.254/`
/// would be followed blindly (redirect SSRF bypass). Normal external redirects still follow
/// (hop cap 5). The check is pure string/IP-literal work — safe inside the redirect callback.
pub fn guarded_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .pool_max_idle_per_host(8)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() > 5 {
                    return attempt.error("too many redirects");
                }
                if let Some(reason) = is_blocked_fetch_url(attempt.url().as_str()) {
                    return attempt.error(format!("redirect blocked ({reason})"));
                }
                attempt.follow()
            }))
            .build()
            .expect("guarded reqwest client build failed")
    })
}

/// `Some(reason)` = block the request, `None` = allow. Reason is a short English string for the AI.
pub fn is_blocked_fetch_url(url: &str) -> Option<String> {
    let host = extract_host(url)?;
    let host_l = host.to_ascii_lowercase();

    // Well-known internal hostnames.
    if host_l == "localhost"
        || host_l == "metadata"
        || host_l == "metadata.google.internal"
        || host_l.ends_with(".local")
        || host_l.ends_with(".internal")
        || host_l.ends_with(".localhost")
    {
        return Some(format!("blocked internal host: {host}"));
    }

    // IPv4 literal.
    if let Ok(v4) = host_l.parse::<Ipv4Addr>() {
        if is_blocked_v4(v4) {
            return Some(format!("blocked private/reserved IPv4: {v4}"));
        }
        return None;
    }
    // IPv6 literal (brackets already stripped by extract_host).
    if let Ok(v6) = host_l.parse::<Ipv6Addr>() {
        if is_blocked_v6(v6) {
            return Some(format!("blocked private/reserved IPv6: {v6}"));
        }
        return None;
    }
    None
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()        // 127.0.0.0/8
        || ip.is_private()      // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()  // 169.254.0.0/16 (incl. 169.254.169.254 metadata)
        || ip.is_unspecified() // 0.0.0.0
        || ip.is_broadcast()   // 255.255.255.255
        || o[0] == 0           // 0.0.0.0/8
        || (o[0] == 100 && (o[1] & 0xc0) == 0x40) // 100.64/10 CGNAT
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let s = ip.segments();
    // fc00::/7 unique-local
    if (s[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    // fe80::/10 link-local
    if (s[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    false
}

/// Extract the host from a URL (no `url` crate dep). Strips scheme, path, userinfo, port, and
/// IPv6 brackets. Returns `None` for an empty host.
fn extract_host(url: &str) -> Option<String> {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = after.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    if let Some(rest) = authority.strip_prefix('[') {
        // [ipv6]:port → between brackets.
        return rest
            .split_once(']')
            .map(|(h, _)| h.to_string())
            .filter(|h| !h.is_empty());
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_internal_targets() {
        assert!(is_blocked_fetch_url("http://169.254.169.254/latest/meta-data/").is_some());
        assert!(is_blocked_fetch_url("http://localhost:50051/").is_some());
        assert!(is_blocked_fetch_url("http://127.0.0.1:3000").is_some());
        assert!(is_blocked_fetch_url("https://10.0.0.5/x").is_some());
        assert!(is_blocked_fetch_url("http://192.168.1.1").is_some());
        assert!(is_blocked_fetch_url("http://172.16.5.4/").is_some());
        assert!(is_blocked_fetch_url("http://[::1]:8080/").is_some());
        assert!(is_blocked_fetch_url("http://metadata.google.internal/").is_some());
        assert!(is_blocked_fetch_url("http://user:pass@127.0.0.1/").is_some());
        assert!(is_blocked_fetch_url("http://0.0.0.0/").is_some());
        assert!(is_blocked_fetch_url("http://100.100.1.1/").is_some()); // CGNAT
    }

    #[test]
    fn allows_normal_external() {
        assert!(is_blocked_fetch_url("https://api.example.com/v1/data").is_none());
        assert!(is_blocked_fetch_url("https://www.data.go.kr/x").is_none());
        assert!(is_blocked_fetch_url("https://8.8.8.8/").is_none());
        assert!(is_blocked_fetch_url("https://1.1.1.1/").is_none());
        assert!(is_blocked_fetch_url("https://openapi.tossinvest.com/api").is_none());
    }
}
