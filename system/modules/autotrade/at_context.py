"""Higher-timeframe bars, fetched slowly and kept.

A weekly trend changes once a week. Re-deriving it on every five-minute cycle is the same answer
computed a hundred times, and deriving it by folding the cycle's own bars does not work at all:
three hundred hourly bars make two weekly ones, and two exact bars say nothing about a trend or
a position in a range.

So the slow timeframes are fetched directly — two hundred weekly bars are two hundred weekly
bars — on their own schedule, and kept here. The trading cycle reads them off disk and calls no
broker for them.

Its own file. This is market data, not a ledger: mixing it into `paper.db` or `live.db` would put
something rewritten daily next to rows that are append-only by trigger, and the two have opposite
rules about being overwritten.
"""
import os
import sqlite3

import at_store as store

SCHEMA = """
CREATE TABLE IF NOT EXISTS context_bars(
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY(symbol, interval, date)
);
CREATE TABLE IF NOT EXISTS context_meta(
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL,
  bar_count INTEGER NOT NULL,
  last_date TEXT,
  PRIMARY KEY(symbol, interval)
);
"""


def connect():
    os.makedirs(store.DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(os.path.join(store.DATA_DIR, "context.db"), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(SCHEMA)
    return conn


def _num(v):
    try:
        f = float(v)
        return f if f == f else None          # NaN is not a price
    except (TypeError, ValueError):
        return None


def save(conn, symbol, interval, rows):
    """Merge a fetch into the store. Returns how many bars the series holds afterwards.

    Upsert rather than replace: a fetch that came back short — a rate limit, a partial page —
    must not shorten the history it is supposed to be extending.
    """
    kept = 0
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        date = str(r.get("date") or "").strip()
        close = _num(r.get("close"))
        if not date or close is None:
            continue
        conn.execute(
            "INSERT INTO context_bars(symbol,interval,date,open,high,low,close,volume)"
            " VALUES(?,?,?,?,?,?,?,?)"
            " ON CONFLICT(symbol,interval,date) DO UPDATE SET"
            " open=excluded.open, high=excluded.high, low=excluded.low,"
            " close=excluded.close, volume=excluded.volume",
            (symbol, interval, date, _num(r.get("open")), _num(r.get("high")),
             _num(r.get("low")), close, _num(r.get("volume"))))
        kept += 1
    total = conn.execute(
        "SELECT COUNT(*) n, MAX(date) d FROM context_bars WHERE symbol=? AND interval=?",
        (symbol, interval)).fetchone()
    conn.execute(
        "INSERT INTO context_meta(symbol,interval,fetched_ms,bar_count,last_date)"
        " VALUES(?,?,?,?,?) ON CONFLICT(symbol,interval) DO UPDATE SET"
        " fetched_ms=excluded.fetched_ms, bar_count=excluded.bar_count,"
        " last_date=excluded.last_date",
        (symbol, interval, store.now_ms(), int(total["n"]), total["d"]))
    conn.commit()
    return {"merged": kept, "held": int(total["n"]), "lastDate": total["d"]}


def read(conn, symbol, interval, limit=400, drop_last=True):
    """The series, oldest first, without its newest bar.

    The newest bar of a higher timeframe is usually still forming — this week's weekly bar changes
    every day until Sunday. A rule that reads it gets a different answer each time it runs and a
    backtest that reads it is looking at the future. Dropping it always is the predictable choice:
    when the bar happens to be closed the cost is one bar out of hundreds, and when it is not the
    cost of keeping it is a rule that cannot be trusted.
    """
    rows = conn.execute(
        "SELECT date,open,high,low,close,volume FROM context_bars"
        " WHERE symbol=? AND interval=? ORDER BY date DESC LIMIT ?",
        (symbol, interval, int(limit) + (1 if drop_last else 0))).fetchall()
    out = [dict(r) for r in rows][::-1]
    return out[:-1] if drop_last and out else out


def status(conn, symbols=None):
    """What is held, and how stale — so an empty rule condition can be told from a missing fetch."""
    q = "SELECT symbol, interval, fetched_ms, bar_count, last_date FROM context_meta"
    rows = [dict(r) for r in conn.execute(q)]
    if symbols:
        rows = [r for r in rows if r["symbol"] in set(symbols)]
    now = store.now_ms()
    for r in rows:
        r["ageSec"] = round((now - int(r["fetched_ms"])) / 1000)
    return sorted(rows, key=lambda r: (r["symbol"], r["interval"]))
