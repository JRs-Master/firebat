"""Ledger store — the one thing this module owns outright.

The broker knows how many shares an account holds. It does not know that three of those shares
belong to a swing strategy and one to a scalping strategy, and it never will: that split is ours,
so it lives here rather than being re-derived from statements. Everything else the module does
(signals, orders, balances) is borrowed from another module and can be re-fetched; this cannot.

Two rules shape the schema:

  * **The ledger is append-only.** Positions are a fold over it, kept materialised for speed and
    re-checked against a full replay nightly. A cost basis that can be UPDATEd is a cost basis
    nobody can audit, so triggers refuse UPDATE and DELETE outright.
  * **An order row is written before the order is sent.** The broker's acknowledgement is not the
    truth — its schema is not even known yet — so the row exists first with `state='sent'` and is
    only advanced by what a balance or fill query confirms. A crash between send and confirm
    therefore leaves a row that the next cycle can resolve, instead of a silent double buy.

Dry-run and live keep separate database files. Paper fills in the same tables as real ones would
poison the reconciliation invariant, which is the one number that says whether we still know what
we own.
"""
import hashlib
import json
import os
import sqlite3
import time

# The framework runs modules from the workspace root, so `data/` is the right place. The env var
# is what the framework itself uses to move the data directory, and honouring it keeps a test run
# out of the live ledger — without it every local run wrote into the real one.
DATA_DIR = os.path.join(os.environ.get("FIREBAT_DATA_DIR") or os.getcwd(), "autotrade")     if os.environ.get("FIREBAT_DATA_DIR") else os.path.join(os.getcwd(), "data", "autotrade")

# Quantities are whole shares, so equality is exact; prices are derived and compared with a
# tolerance. 1e-6 of a won is far below anything a broker reports.
EPS = 1e-6


def now_ms():
    return int(time.time() * 1000)


def db_path(mode):
    """`dryrun` writes to paper.db, everything else to live.db (mode is a column there too)."""
    name = "paper.db" if mode == "dryrun" else "live.db"
    return os.path.join(DATA_DIR, name)


def connect(mode):
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(db_path(mode), timeout=10)
    conn.row_factory = sqlite3.Row
    # A tick sink and the bar-close cron can arrive at once — WAL lets the reader through and
    # busy_timeout keeps the writer from failing the cycle over a 10ms overlap.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    ensure_schema(conn)
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS strategy_position(
  strategy_id TEXT NOT NULL, broker TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  avg_price REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  realized_pnl_internal REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  updated_ms INTEGER,
  PRIMARY KEY(strategy_id, broker, account, symbol));

CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  strategy_id TEXT NOT NULL, broker TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL, price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  ref_order_key TEXT, ref_transfer_id INTEGER,
  qty_after REAL, avg_after REAL, realized REAL,
  note TEXT);
CREATE INDEX IF NOT EXISTS ledger_strategy ON ledger(strategy_id, symbol, ts_ms);

-- An append-only ledger has to be enforced, not just documented.
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TABLE IF NOT EXISTS orders(
  order_key TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL, cycle_id TEXT NOT NULL, strategy_id TEXT NOT NULL,
  broker TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
  req_qty REAL NOT NULL, req_price REAL, ord_type TEXT, mode TEXT NOT NULL,
  state TEXT NOT NULL,
  broker_order_no TEXT, ack_raw TEXT,
  filled_qty REAL NOT NULL DEFAULT 0, filled_avg REAL NOT NULL DEFAULT 0,
  sent_ms INTEGER, last_checked_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS orders_open ON orders(state, account, symbol);
CREATE INDEX IF NOT EXISTS orders_cycle ON orders(strategy_id, cycle_id);

CREATE TABLE IF NOT EXISTS fills(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_key TEXT, ts_ms INTEGER NOT NULL,
  qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
  broker_exec_id TEXT UNIQUE, raw TEXT);

CREATE TABLE IF NOT EXISTS transfers(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, cycle_id TEXT,
  from_strategy TEXT NOT NULL, to_strategy TEXT NOT NULL,
  broker TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL,
  qty REAL NOT NULL, price REAL NOT NULL, seller_pnl REAL NOT NULL DEFAULT 0);

-- Shares the account holds that no strategy claims. Its existence is what lets the invariant
-- stay true instead of being "mostly true".
CREATE TABLE IF NOT EXISTS unassigned(
  broker TEXT NOT NULL, account TEXT NOT NULL, symbol TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0, avg_price REAL NOT NULL DEFAULT 0,
  first_seen_ms INTEGER, updated_ms INTEGER,
  PRIMARY KEY(broker, account, symbol));

CREATE TABLE IF NOT EXISTS reconcile_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL,
  broker TEXT, account TEXT, symbol TEXT,
  sum_strategy_qty REAL, unassigned_qty REAL, broker_qty REAL, delta REAL,
  action TEXT, note TEXT);

CREATE TABLE IF NOT EXISTS universe(
  strategy_id TEXT NOT NULL, symbol TEXT NOT NULL, source TEXT,
  state TEXT NOT NULL, entered_ms INTEGER, exited_ms INTEGER, last_change_ms INTEGER,
  PRIMARY KEY(strategy_id, symbol));

CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL, strategy_id TEXT, symbol TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts_ms);

-- Request/response pairs kept verbatim so the order acknowledgement schema can be read off real
-- traffic later instead of guessed at now.
CREATE TABLE IF NOT EXISTS api_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL,
  broker TEXT, action TEXT, ok INTEGER, latency_ms INTEGER, req TEXT, resp TEXT);

CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT, updated_ms INTEGER);
"""


def ensure_schema(conn):
    conn.executescript(SCHEMA)
    conn.commit()


# ── kv ───────────────────────────────────────────────────────────────────────────────────────
def kv_get(conn, key, default=None):
    row = conn.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
    return row["v"] if row else default


def kv_set(conn, key, value):
    conn.execute(
        "INSERT INTO kv(k,v,updated_ms) VALUES(?,?,?) "
        "ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_ms=excluded.updated_ms",
        (key, str(value), now_ms()),
    )
    conn.commit()


def log_event(conn, kind, detail=None, strategy_id=None, symbol=None):
    conn.execute(
        "INSERT INTO events(ts_ms,kind,strategy_id,symbol,detail) VALUES(?,?,?,?,?)",
        (now_ms(), kind, strategy_id, symbol,
         detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)),
    )
    conn.commit()


def log_api(conn, broker, action, ok, latency_ms, req, resp):
    conn.execute(
        "INSERT INTO api_log(ts_ms,broker,action,ok,latency_ms,req,resp) VALUES(?,?,?,?,?,?,?)",
        (now_ms(), broker, action, 1 if ok else 0, latency_ms,
         json.dumps(req, ensure_ascii=False)[:4000],
         json.dumps(resp, ensure_ascii=False)[:8000]),
    )
    conn.commit()


# ── positions ────────────────────────────────────────────────────────────────────────────────
def position_of(conn, strategy_id, broker, account, symbol):
    row = conn.execute(
        "SELECT * FROM strategy_position WHERE strategy_id=? AND broker=? AND account=? AND symbol=?",
        (strategy_id, broker, account, symbol),
    ).fetchone()
    if row:
        return dict(row)
    return {
        "strategy_id": strategy_id, "broker": broker, "account": account, "symbol": symbol,
        "qty": 0.0, "avg_price": 0.0, "realized_pnl": 0.0, "realized_pnl_internal": 0.0,
        "state": "active", "updated_ms": None,
    }


def position_anchor(conn, strategy_id, broker, account, symbol):
    """What the ladders measure themselves against, folded out of the ledger.

    Three facts about the position as it stands, all of them about the *current* run of it:

    - `peakQty` — how large it grew. A scale-out rung says "be half out by +5%", and half of
      *what* is the size it reached, not what is left after an earlier rung already sold some.
    - `firstPrice` — what the first share cost. A scale-in rung says "add if it drops 3%", and
      below *what*: the average moves every time you add, so anchoring on it makes the rungs
      chase themselves down.
    - `firstMs` — when the position opened, so a rung can be timed as well as priced.

    Derived rather than stored. A column holding any of these is a second source of truth that
    can drift from the append-only rows the quantities came from.
    """
    peak = running = 0.0
    first_price, first_ms = None, None
    for row in conn.execute(
            "SELECT side, qty, price, ts_ms FROM ledger WHERE strategy_id=? AND broker=? "
            "AND account=? AND symbol=? ORDER BY id", (strategy_id, broker, account, symbol)):
        buying = row["side"] == "buy"
        if running <= 1e-12 and buying:
            first_price, first_ms = float(row["price"] or 0), int(row["ts_ms"] or 0)
        running += float(row["qty"] or 0) * (1 if buying else -1)
        if running <= 1e-12:
            # Flat — the next buy starts a new position, and a new ladder with it.
            running, peak = 0.0, 0.0
            first_price, first_ms = None, None
        else:
            peak = max(peak, running)
    return {"peakQty": peak, "firstPrice": first_price, "firstMs": first_ms}


def peak_qty_since_flat(conn, strategy_id, broker, account, symbol):
    """How large this position grew since it was last empty."""
    return position_anchor(conn, strategy_id, broker, account, symbol)["peakQty"]


def set_position_state(conn, strategy_id, broker, account, symbol, state):
    pos = position_of(conn, strategy_id, broker, account, symbol)
    _write_position(conn, {**pos, "state": state})
    conn.commit()


def _write_position(conn, pos):
    conn.execute(
        "INSERT INTO strategy_position"
        "(strategy_id,broker,account,symbol,qty,avg_price,realized_pnl,realized_pnl_internal,state,updated_ms) "
        "VALUES(?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(strategy_id,broker,account,symbol) DO UPDATE SET "
        "qty=excluded.qty, avg_price=excluded.avg_price, realized_pnl=excluded.realized_pnl, "
        "realized_pnl_internal=excluded.realized_pnl_internal, state=excluded.state, "
        "updated_ms=excluded.updated_ms",
        (pos["strategy_id"], pos["broker"], pos["account"], pos["symbol"],
         pos["qty"], pos["avg_price"], pos["realized_pnl"], pos["realized_pnl_internal"],
         pos.get("state", "active"), now_ms()),
    )


def apply_fill(conn, *, strategy_id, broker, account, symbol, side, qty, price,
               fee=0.0, tax=0.0, source="order", ref_order_key=None, ref_transfer_id=None,
               fee_in_cost=True, note=None, ts_ms=None):
    """Append one ledger row and fold it into the position. Returns the position afterwards.

    Cost basis is a moving average: a buy moves it, a sell never does. Selling below the average
    realises the loss right then rather than quietly lifting the average of what is left — which
    is the trick that makes a losing strategy look flat.
    """
    if qty <= 0:
        raise ValueError("fill qty must be positive")
    pos = position_of(conn, strategy_id, broker, account, symbol)
    q, avg = float(pos["qty"]), float(pos["avg_price"])
    realized = 0.0

    if side in ("buy", "transfer_in"):
        cost = price * qty + (fee if fee_in_cost else 0.0)
        new_q = q + qty
        avg = (avg * q + cost) / new_q if new_q > EPS else 0.0
        q = new_q
    elif side in ("sell", "transfer_out"):
        sold = min(qty, q)
        if sold + EPS < qty:
            # Never let a strategy sell shares it does not hold — someone else's position in the
            # same account is not ours to touch.
            raise ValueError(f"sell {qty} exceeds held {q} for {strategy_id}/{symbol}")
        realized = (price - avg) * sold - fee - tax
        q = q - sold
        if q <= EPS:
            q, avg = 0.0, 0.0
    else:
        raise ValueError(f"unknown side {side}")

    if side == "transfer_out":
        pos["realized_pnl_internal"] = float(pos["realized_pnl_internal"]) + realized
    elif side == "sell":
        pos["realized_pnl"] = float(pos["realized_pnl"]) + realized

    pos["qty"], pos["avg_price"] = q, avg
    _write_position(conn, pos)
    conn.execute(
        "INSERT INTO ledger(ts_ms,strategy_id,broker,account,symbol,side,qty,price,fee,tax,"
        "source,ref_order_key,ref_transfer_id,qty_after,avg_after,realized,note) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (ts_ms or now_ms(), strategy_id, broker, account, symbol, side, qty, price, fee, tax,
         source, ref_order_key, ref_transfer_id, q, avg, realized, note),
    )
    conn.commit()
    return position_of(conn, strategy_id, broker, account, symbol)


def replay_positions(conn):
    """Fold the whole ledger and report where it disagrees with the materialised positions.

    A mismatch is not a data problem to paper over — it means the incremental path has a bug, so
    the caller trips the kill switch rather than trusting either number.
    """
    folded = {}
    for row in conn.execute("SELECT * FROM ledger ORDER BY id"):
        key = (row["strategy_id"], row["broker"], row["account"], row["symbol"])
        q, avg = folded.get(key, (0.0, 0.0))
        if row["side"] in ("buy", "transfer_in"):
            new_q = q + row["qty"]
            avg = (avg * q + row["price"] * row["qty"] + row["fee"]) / new_q if new_q > EPS else 0.0
            q = new_q
        else:
            q = max(0.0, q - row["qty"])
            if q <= EPS:
                q, avg = 0.0, 0.0
        folded[key] = (q, avg)

    diffs = []
    for row in conn.execute("SELECT * FROM strategy_position"):
        key = (row["strategy_id"], row["broker"], row["account"], row["symbol"])
        q, _ = folded.get(key, (0.0, 0.0))
        if abs(q - float(row["qty"])) > EPS:
            diffs.append({"key": list(key), "ledger": q, "position": float(row["qty"])})
    return diffs


# ── orders ───────────────────────────────────────────────────────────────────────────────────
def order_key(strategy_id, symbol, side, cycle_id, seq=0, broker="", account=""):
    """One order per trade, symbol, side and window — a trade being a strategy in one account.

    The key is the primary key, so a duplicate cycle — a re-run, an overlapping cron, a restart
    mid-flight — collides at INSERT instead of reaching the broker twice. Where it runs belongs in
    the key for the same reason it belongs in the position key: the same rule in two accounts is
    two positions and two orders, not one placed twice.
    """
    raw = f"{strategy_id}|{broker}|{account}|{symbol}|{side}|{cycle_id}|{seq}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def insert_order(conn, order):
    """Write-ahead the order. Returns False when this window already produced it."""
    try:
        conn.execute(
            "INSERT INTO orders(order_key,ts_ms,cycle_id,strategy_id,broker,account,symbol,side,"
            "req_qty,req_price,ord_type,mode,state,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (order["order_key"], now_ms(), order["cycle_id"], order["strategy_id"],
             order["broker"], order["account"], order["symbol"], order["side"],
             order["req_qty"], order.get("req_price"), order.get("ord_type"),
             order["mode"], order.get("state", "intent"), order.get("reason")),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False


def update_order(conn, key, **fields):
    if not fields:
        return
    sets = ", ".join(f"{k}=?" for k in fields)
    conn.execute(f"UPDATE orders SET {sets} WHERE order_key=?", (*fields.values(), key))
    conn.commit()


def cycle_already_ran(conn, strategy_id, cycle_id, broker="", account="", symbol=""):
    """Has this trade already acted in this window?

    A trade is the strategy *and* where it runs — the position table has always been keyed that
    way. This check was not, so the same rule running in a second account was read as a repeat of
    the first and skipped, reporting "already ran": an order that never left, wearing the log line
    of correct idempotency.
    """
    q = ("SELECT 1 FROM orders WHERE strategy_id=? AND cycle_id=? AND broker=? AND account=?")
    args = [strategy_id, cycle_id, broker or "", account or ""]
    if symbol:
        # A rule running over a screened list places one order per symbol in the same window.
        # Without this the first symbol would look like the whole cycle and silence the rest.
        q += " AND symbol=?"
        args.append(symbol)
    return conn.execute(q + " LIMIT 1", args).fetchone() is not None


def open_orders(conn, account=None):
    q = "SELECT * FROM orders WHERE state IN ('sent','acked','open','partial')"
    args = []
    if account:
        q += " AND account=?"
        args.append(account)
    return [dict(r) for r in conn.execute(q + " ORDER BY ts_ms", args)]


def orders_awaiting_fills(conn, since_ms):
    """Rows a late fill may still belong to — the open ones, plus recently closed-out ones.

    A fill can arrive after we have already written the order off. Matching only against open rows
    means the execution lands in `unattributed` and the trade never reaches the strategy that made
    it, which is how a real Bitcoin buy ended up as nobody's (2026-08-04). Terminal states are
    conclusions we drew, not facts the exchange sent, so they stay eligible for a while.
    """
    return [dict(r) for r in conn.execute(
        "SELECT * FROM orders WHERE state IN ('sent','acked','open','partial') "
        "   OR (state IN ('canceled','void','unknown') AND COALESCE(sent_ms, ts_ms) >= ?) "
        "ORDER BY ts_ms", (since_ms,))]


def record_fill(conn, *, order_key_, qty, price, fee=0.0, tax=0.0, broker_exec_id=None, raw=None):
    """Register a broker-confirmed execution. Returns False if this execution id was already seen."""
    try:
        conn.execute(
            "INSERT INTO fills(order_key,ts_ms,qty,price,fee,tax,broker_exec_id,raw) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (order_key_, now_ms(), qty, price, fee, tax, broker_exec_id,
             json.dumps(raw, ensure_ascii=False) if raw is not None else None),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False


# ── internal transfer ────────────────────────────────────────────────────────────────────────
def record_transfer(conn, *, cycle_id, from_strategy, to_strategy, broker, account, symbol,
                    qty, price, fee_in_cost=True):
    """Move shares between two strategies at one price — no order, no fee, no tax.

    Only ever called when a sell trigger and a buy trigger in the same account fire on the same
    symbol at the same price: then the market leg would be two trades that cancel out, and the
    only real difference is the fee and tax we would have paid to stand still. The seller's gain
    is booked separately from market P&L so it cannot be mistaken for trading performance.
    """
    cur = conn.execute(
        "INSERT INTO transfers(ts_ms,cycle_id,from_strategy,to_strategy,broker,account,symbol,qty,price) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (now_ms(), cycle_id, from_strategy, to_strategy, broker, account, symbol, qty, price),
    )
    tid = cur.lastrowid
    out = apply_fill(conn, strategy_id=from_strategy, broker=broker, account=account, symbol=symbol,
                     side="transfer_out", qty=qty, price=price, source="internal_transfer",
                     ref_transfer_id=tid, fee_in_cost=fee_in_cost)
    apply_fill(conn, strategy_id=to_strategy, broker=broker, account=account, symbol=symbol,
               side="transfer_in", qty=qty, price=price, source="internal_transfer",
               ref_transfer_id=tid, fee_in_cost=fee_in_cost)
    seller_pnl = float(out["realized_pnl_internal"])
    conn.execute("UPDATE transfers SET seller_pnl=? WHERE id=?", (seller_pnl, tid))
    conn.commit()
    return tid


# ── reconciliation ───────────────────────────────────────────────────────────────────────────
def claimed_symbols(conn, broker, account):
    """Every instrument this account's ledger says it is holding — strategies and the unassigned
    bucket alike.

    The other half of what reconciliation has to walk. The balance says what is there; this says
    what we believe is there, and a holding that vanished from the account only shows up as the
    difference between the two.
    """
    # 전략이 claim 하는 이름을 먼저 — 같은 보유가 두 이름으로 적혀 있을 때(브로커가 부르는 이름과
    # 우리 이름) 어느 쪽으로 정산하느냐가 갈리는데, 전략이 실제로 들고 있다고 말하는 쪽이 진짜다.
    named = [r["symbol"] for r in conn.execute(
        "SELECT DISTINCT symbol FROM strategy_position WHERE broker=? AND account=? AND qty > 0",
        (broker, account))]
    seen = set(named)
    extra = [r["symbol"] for r in conn.execute(
        "SELECT symbol FROM unassigned WHERE broker=? AND account=? AND qty > 0",
        (broker, account)) if r["symbol"] and r["symbol"] not in seen]
    return [s for s in named + extra if s]


def accounted_qty(conn, broker, account, symbol):
    """How much of this symbol the ledger already explains — strategies plus the unassigned bucket.

    What a balance has to exceed before a surplus means "something filled that we have not booked".
    """
    row = conn.execute(
        "SELECT (SELECT COALESCE(SUM(qty),0) FROM strategy_position WHERE broker=? AND account=? "
        "AND symbol=? AND qty>0) + (SELECT COALESCE(SUM(qty),0) FROM unassigned WHERE broker=? "
        "AND account=? AND symbol=?) AS total",
        (broker, account, symbol, broker, account, symbol)).fetchone()
    return float(row["total"] or 0)


def reconcile_symbol(conn, broker, account, symbol, broker_qty, broker_avg=0.0):
    """Compare what the strategies claim against what the broker reports.

    The unassigned bucket absorbs any surplus, which keeps
    `Σ strategy qty + unassigned == broker qty` true at all times rather than approximately true.
    A shortfall is the dangerous direction — a strategy believes it holds shares that are not
    there — so those strategies stop buying and wait for a person.
    """
    rows = conn.execute(
        "SELECT strategy_id, qty FROM strategy_position WHERE broker=? AND account=? AND symbol=? AND qty > 0",
        (broker, account, symbol),
    ).fetchall()
    sum_qty = sum(float(r["qty"]) for r in rows)
    urow = conn.execute(
        "SELECT qty FROM unassigned WHERE broker=? AND account=? AND symbol=?",
        (broker, account, symbol),
    ).fetchone()
    un_qty = float(urow["qty"]) if urow else 0.0
    delta = float(broker_qty) - (sum_qty + un_qty)

    action, note = "ok", None
    if delta > EPS:
        un_qty += delta
        conn.execute(
            "INSERT INTO unassigned(broker,account,symbol,qty,avg_price,first_seen_ms,updated_ms) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(broker,account,symbol) DO UPDATE SET "
            "qty=excluded.qty, avg_price=excluded.avg_price, updated_ms=excluded.updated_ms",
            (broker, account, symbol, un_qty, broker_avg, now_ms(), now_ms()),
        )
        action = "absorbed_to_unassigned"
        note = "shares held at the broker that no strategy claims"
    elif delta < -EPS:
        # Take from the unassigned bucket first — that surplus may simply have been sold outside.
        take = min(un_qty, -delta)
        if take > EPS:
            un_qty -= take
            conn.execute(
                "UPDATE unassigned SET qty=?, updated_ms=? WHERE broker=? AND account=? AND symbol=?",
                (un_qty, now_ms(), broker, account, symbol),
            )
        if -delta - take > EPS:
            for r in rows:
                set_position_state(conn, r["strategy_id"], broker, account, symbol, "degraded")
            action = "degraded"
            note = "the broker reports fewer shares than the strategies claim"
        else:
            action = "absorbed_from_unassigned"

    conn.execute(
        "INSERT INTO reconcile_log(ts_ms,broker,account,symbol,sum_strategy_qty,unassigned_qty,"
        "broker_qty,delta,action,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (now_ms(), broker, account, symbol, sum_qty, un_qty, float(broker_qty), delta, action, note),
    )
    conn.commit()
    if action != "ok":
        log_event(conn, "reconcile", {"symbol": symbol, "delta": delta, "action": action},
                  symbol=symbol)
    return {"symbol": symbol, "sumStrategyQty": sum_qty, "unassignedQty": un_qty,
            "brokerQty": float(broker_qty), "delta": delta, "action": action, "note": note}


# ── reads ────────────────────────────────────────────────────────────────────────────────────
def read_positions(conn):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM strategy_position WHERE qty > 0 OR realized_pnl <> 0 "
        "ORDER BY symbol, strategy_id")]


def read_orders(conn, limit=50):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM orders ORDER BY ts_ms DESC LIMIT ?", (limit,))]


def read_ledger(conn, limit=200):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM ledger ORDER BY id DESC LIMIT ?", (limit,))]


def read_events(conn, limit=50):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))]


def read_transfers(conn, limit=50):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM transfers ORDER BY id DESC LIMIT ?", (limit,))]


def realized_today(conn, day_start_ms):
    row = conn.execute(
        "SELECT COALESCE(SUM(realized),0) AS s FROM ledger WHERE ts_ms >= ? AND side='sell'",
        (day_start_ms,),
    ).fetchone()
    return float(row["s"])
