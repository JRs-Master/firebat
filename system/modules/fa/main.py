"""fa — fundamental-analysis calculator over DART statement rows.

The ta shape, mirrored: ta takes bars (or a cache key) and computes indicators; fa takes DART
financial-statement rows (or a cache key) and computes ratios. Collection belongs to the dart
module, market cap to a quote tool — this module only computes, and what it cannot compute from
what it was given comes back null with a note. No fetching, no guessing, no memorized figures.

Row shape (dart financial / financialAll, i.e. fnlttSinglAcnt/All): account_nm plus
thstrm_amount (당기) / frmtrm_amount (전기) / bfefrmtrm_amount (전전기) as comma-separated
strings, optional fs_div CFS/OFS. CFS (연결) wins when both are present.
"""

import json
import sys

# account_nm synonyms seen across DART filings — the left name is ours, the list is theirs.
ACCOUNTS = {
    "revenue": ["매출액", "수익(매출액)", "영업수익", "매출"],
    "gross_profit": ["매출총이익"],
    "op_income": ["영업이익", "영업이익(손실)"],
    "pretax_income": ["법인세차감전 순이익", "법인세차감전순이익", "법인세비용차감전순이익",
                       "법인세비용차감전순이익(손실)"],
    "net_income": ["당기순이익", "당기순이익(손실)", "당기순손익", "연결당기순이익"],
    "assets": ["자산총계"],
    "liabilities": ["부채총계"],
    "equity": ["자본총계"],
    "current_assets": ["유동자산"],
    "current_liabilities": ["유동부채"],
    "capital_stock": ["자본금"],
    "retained_earnings": ["이익잉여금", "이익잉여금(결손금)"],
    "interest_expense": ["이자비용", "금융비용"],
}

PERIODS = [("thstrm_amount", "current"), ("frmtrm_amount", "prior"),
           ("bfefrmtrm_amount", "prior2")]


def parse_amount(raw):
    s = str(raw or "").strip().replace(",", "")
    if not s or s == "-":
        return None
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def extract_accounts(rows):
    """DART rows -> {our_name: {current, prior, prior2}}, CFS preferred over OFS."""
    by_fs = {"CFS": {}, "OFS": {}, "": {}}
    for row in rows:
        if not isinstance(row, dict):
            continue
        nm = str(row.get("account_nm") or "").strip()
        fs = str(row.get("fs_div") or "").strip().upper()
        bucket = by_fs.setdefault(fs if fs in ("CFS", "OFS") else "", {})
        for ours, theirs in ACCOUNTS.items():
            if nm in theirs and ours not in bucket:
                vals = {}
                for field, label in PERIODS:
                    v = parse_amount(row.get(field))
                    if v is not None:
                        vals[label] = v
                if vals:
                    bucket[ours] = vals
    # CFS wins account-by-account; OFS (or undivided) fills what CFS lacks.
    out = dict(by_fs["CFS"])
    for src in (by_fs["OFS"], by_fs[""]):
        for k, v in src.items():
            out.setdefault(k, v)
    fs_used = "CFS" if by_fs["CFS"] else ("OFS" if by_fs["OFS"] else "")
    return out, fs_used


def ratio(num, den, pct=False):
    if num is None or den is None or den == 0:
        return None
    v = num / den
    return round(v * 100, 2) if pct else round(v, 2)


def growth(cur, prev):
    if cur is None or prev is None or prev == 0:
        return None
    return round((cur - prev) / abs(prev) * 100, 2)


def action_ratios(inp):
    rows = inp.get("statements")
    if not isinstance(rows, list) or not rows:
        return {"success": False, "action": "ratios",
                "error": "statements required — pass the dart financial rows or "
                         "statementsCacheKey from that call"}
    acc, fs_used = extract_accounts(rows)
    if not acc:
        return {"success": False, "action": "ratios",
                "error": "no recognizable accounts in the rows — expected DART "
                         "financial/financialAll shape (account_nm + thstrm_amount)"}

    def g(name, period="current"):
        return acc.get(name, {}).get(period)

    notes = []
    for needed in ("revenue", "net_income", "assets", "equity"):
        if g(needed) is None:
            notes.append(f"{needed} not in the rows — dependent ratios are null")

    profitability = {
        "operatingMarginPct": ratio(g("op_income"), g("revenue"), pct=True),
        "netMarginPct": ratio(g("net_income"), g("revenue"), pct=True),
        "grossMarginPct": ratio(g("gross_profit"), g("revenue"), pct=True),
        "roePct": ratio(g("net_income"), g("equity"), pct=True),
        "roaPct": ratio(g("net_income"), g("assets"), pct=True),
    }
    stability = {
        "debtRatioPct": ratio(g("liabilities"), g("equity"), pct=True),
        "currentRatioPct": ratio(g("current_assets"), g("current_liabilities"), pct=True),
        "equityRatioPct": ratio(g("equity"), g("assets"), pct=True),
        "interestCoverage": ratio(g("op_income"), g("interest_expense")),
    }
    growth_rates = {
        "revenueYoYPct": growth(g("revenue"), g("revenue", "prior")),
        "opIncomeYoYPct": growth(g("op_income"), g("op_income", "prior")),
        "netIncomeYoYPct": growth(g("net_income"), g("net_income", "prior")),
        "assetsYoYPct": growth(g("assets"), g("assets", "prior")),
        "revenuePriorYoYPct": growth(g("revenue", "prior"), g("revenue", "prior2")),
    }

    valuation = None
    market_cap = inp.get("marketCap")
    shares = inp.get("shares")
    if isinstance(market_cap, (int, float)) and market_cap > 0:
        valuation = {
            "per": ratio(market_cap, g("net_income")),
            "pbr": ratio(market_cap, g("equity")),
            "psr": ratio(market_cap, g("revenue")),
            "marketCap": market_cap,
        }
        if valuation["per"] is not None and valuation["per"] < 0:
            notes.append("PER is negative (net loss) — quoted as-is, not meaningful for ranking")
    else:
        notes.append("marketCap not given — PER/PBR/PSR skipped (price is a quote tool's job)")
    per_share = None
    if isinstance(shares, (int, float)) and shares > 0:
        per_share = {
            "eps": ratio(g("net_income"), shares),
            "bps": ratio(g("equity"), shares),
            "sps": ratio(g("revenue"), shares),
            "shares": shares,
        }

    data = {
        "fsUsed": fs_used or "unknown",
        "accounts": {k: v for k, v in acc.items()},
        "profitability": profitability,
        "stability": stability,
        "growth": growth_rates,
    }
    if valuation:
        data["valuation"] = valuation
    if per_share:
        data["perShare"] = per_share
    if notes:
        data["notes"] = notes
    return {"success": True, "action": "ratios", "data": data}


def action_selftest():
    checks = []

    def ck(name, want, got):
        checks.append({"name": name, "want": want, "got": got, "ok": want == got})

    rows = [
        {"account_nm": "매출액", "fs_div": "CFS",
         "thstrm_amount": "1,000", "frmtrm_amount": "800", "bfefrmtrm_amount": "640"},
        {"account_nm": "영업이익", "fs_div": "CFS", "thstrm_amount": "100", "frmtrm_amount": "80"},
        {"account_nm": "당기순이익", "fs_div": "CFS", "thstrm_amount": "50", "frmtrm_amount": "40"},
        {"account_nm": "자산총계", "fs_div": "CFS", "thstrm_amount": "2,000", "frmtrm_amount": "1,900"},
        {"account_nm": "부채총계", "fs_div": "CFS", "thstrm_amount": "1,200"},
        {"account_nm": "자본총계", "fs_div": "CFS", "thstrm_amount": "800"},
        {"account_nm": "유동자산", "fs_div": "CFS", "thstrm_amount": "600"},
        {"account_nm": "유동부채", "fs_div": "CFS", "thstrm_amount": "400"},
        # OFS twin that must LOSE to CFS:
        {"account_nm": "매출액", "fs_div": "OFS", "thstrm_amount": "999"},
    ]
    out = action_ratios({"statements": rows, "marketCap": 1000.0, "shares": 10})
    d = out["data"]
    ck("CFS beats OFS", 1000.0, d["accounts"]["revenue"]["current"])
    ck("operating margin", 10.0, d["profitability"]["operatingMarginPct"])
    ck("ROE", 6.25, d["profitability"]["roePct"])
    ck("debt ratio", 150.0, d["stability"]["debtRatioPct"])
    ck("current ratio", 150.0, d["stability"]["currentRatioPct"])
    ck("revenue YoY", 25.0, d["growth"]["revenueYoYPct"])
    ck("prior-year revenue YoY", 25.0, d["growth"]["revenuePriorYoYPct"])
    ck("PER", 20.0, d["valuation"]["per"])
    ck("PBR", 1.25, d["valuation"]["pbr"])
    ck("EPS", 5.0, d["perShare"]["eps"])
    ck("interest coverage is null, not invented", None,
       d["stability"]["interestCoverage"])
    ck("parenthesis negatives parse", -1234.0, parse_amount("(1,234)"))
    ck("dash means missing, not zero", None, parse_amount("-"))

    failed = [c for c in checks if not c["ok"]]
    return {"success": not failed, "action": "selftest",
            "data": {"checks": checks, "total": len(checks), "failed": len(failed)}}


def main():
    # Bytes, decoded as UTF-8 explicitly — the locale default turns Korean into lone
    # surrogates on some hosts (measured on Windows), and the envelope is UTF-8 by contract.
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        envelope = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        sys.stdout.buffer.write((json.dumps(
            {"success": False, "action": "", "error": f"input JSON: {e}"})).encode("utf-8"))
        return
    inp = envelope.get("data") or envelope
    action = str(inp.get("action") or "").strip()
    if action == "selftest":
        out = action_selftest()
    elif action == "ratios":
        out = action_ratios(inp)
    else:
        out = {"success": False, "action": action,
               "error": f"unknown action {action!r} — one of: ratios, selftest"}
    # UTF-8 bytes out, explicitly — print() writes the console codepage on some hosts.
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
