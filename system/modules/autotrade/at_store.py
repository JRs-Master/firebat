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


# The only two states a position has. `HEALTHY` is spelled once because it is also the column's
# CREATE TABLE default, and a second word for the same state is a word the screen shows and nobody
# can explain: 2026-08-04 two flat rows on the same symbol read `ok` and `active` — one had been
# degraded that day and restored, the other never had. The engine only ever asks whether it is
# degraded, so they behaved identically. History belongs in `reconcile_log`, which already records
# the restore with its timestamp, not in a state column with more values than there are states.
HEALTHY = "active"
DEGRADED = "degraded"


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
    # A row written before the state vocabulary was settled keeps whatever word it was given, and a
    # position that is flat and healthy never gets rewritten — so without this one installation shows
    # `ok` beside `active` forever for two rows that mean the same thing. Idempotent and cheap, so it
    # runs on every connect rather than needing a migration somebody has to remember to apply.
    conn.execute("UPDATE strategy_position SET state=? WHERE state NOT IN (?, ?)",
                 (HEALTHY, HEALTHY, DEGRADED))
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


def lift_hold(conn, strategy_id, broker, account, symbol):
    """Release a degraded position. True if it was released.

    One place, because a hold ends for two different reasons — the books added up again, or the order
    that caused it turned out never to have existed — and each reason used to clear it its own way.
    The void path cleared **unconditionally**, so voiding an unrelated ghost order lifted a genuine
    shortfall hold and re-opened buying on books that did not add up. Reconciliation put it back the
    next cycle, which is why it was a window rather than a visible wrong, and why nobody saw it.

    A position with an unresolved order of its own is held for that reason and is not released here:
    "the broker has not answered about this order yet" and "the books are short" are different holds,
    and clearing one because the other ended is the class of bug this file keeps finding.
    """
    still = conn.execute(
        "SELECT 1 FROM orders WHERE strategy_id=? AND broker=? AND account=? AND symbol=? "
        "AND state='unknown' LIMIT 1", (strategy_id, broker, account, symbol)).fetchone()
    if still:
        return False
    cur = conn.execute(
        "SELECT state FROM strategy_position WHERE strategy_id=? AND broker=? AND account=? "
        "AND symbol=?", (strategy_id, broker, account, symbol)).fetchone()
    if not cur or cur["state"] != DEGRADED:
        return False                      # nothing to lift; do not write a state nobody asked for
    set_position_state(conn, strategy_id, broker, account, symbol, HEALTHY)
    return True


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


def booked_qty(conn, order_key_):
    """How much of this order the **ledger** has actually absorbed.

    `orders.filled_qty` is not the same thing: it is written after the ledger write and so it is
    only right when that write succeeded. Measured 2026-08-05 — a fill was committed to `fills`,
    the ledger write then raised, and the fill stayed booked-but-unapplied forever because the
    duplicate check on the next pass saw its own orphan row. The ledger is the record of what was
    applied, so it is what "already" has to mean.
    """
    row = conn.execute(
        "SELECT COALESCE(SUM(qty),0) q FROM ledger WHERE ref_order_key=?", (order_key_,)).fetchone()
    return float(row["q"] if row else 0.0)


def record_fill(conn, *, order_key_, qty, price, fee=0.0, tax=0.0, broker_exec_id=None, raw=None):
    """Register a broker-confirmed execution. Returns False if this execution id was already seen.

    **Does not commit** — the caller pairs this with `apply_fill`, whose commit closes both. They
    have to land together: a committed fill with no ledger row is invisible to the position and
    permanently suppressed by its own duplicate check.
    """
    try:
        conn.execute(
            "INSERT INTO fills(order_key,ts_ms,qty,price,fee,tax,broker_exec_id,raw) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (order_key_, now_ms(), qty, price, fee, tax, broker_exec_id,
             json.dumps(raw, ensure_ascii=False) if raw is not None else None),
        )
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
def symbol_in_market(conn, broker, account, symbol, market, market_of):
    """Does this holding belong to the market the balance just answered for?

    Answered from the strategies that hold it — they declared their market, and that declaration is
    what routed the order in the first place. An unassigned-only holding, or one held by a strategy
    that declared nothing, returns True: leaving it out of every pass would be worse than checking
    it against a balance that may not cover it. Only a positive mismatch skips.
    """
    rows = conn.execute(
        "SELECT DISTINCT strategy_id FROM strategy_position "
        "WHERE broker=? AND account=? AND symbol=? AND qty > 0", (broker, account, symbol))
    known = [str(market_of.get(r["strategy_id"]) or "").strip().lower() for r in rows]
    declared = [m for m in known if m]
    if not declared:
        return True
    return market in declared


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
    # A held position has to be walked even when it holds nothing. `qty > 0` cannot see it, and a
    # flat hold is the one that never lifts on its own: nothing to sell, and no balance row to be
    # found under either, so nothing ever comes back to look at it. Measured 2026-08-04 — three
    # separate queries here and in `reconcile_symbol` all asked "does it have shares" when the
    # question was "is it held", and the only thing releasing these was the void sweep writing the
    # state as a side effect. Removing that side effect is what made them visible.
    held = [r["symbol"] for r in conn.execute(
        "SELECT DISTINCT symbol FROM strategy_position WHERE broker=? AND account=? AND state=?",
        (broker, account, DEGRADED)) if r["symbol"] and r["symbol"] not in seen]
    seen |= set(held)
    extra = [r["symbol"] for r in conn.execute(
        "SELECT symbol FROM unassigned WHERE broker=? AND account=? AND qty > 0",
        (broker, account)) if r["symbol"] and r["symbol"] not in seen]
    return [s for s in named + held + extra if s]


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
                set_position_state(conn, r["strategy_id"], broker, account, symbol, DEGRADED)
            action = "degraded"
            note = "the broker reports fewer shares than the strategies claim"
        else:
            action = "absorbed_from_unassigned"

    else:
        # The books add up, so whatever is still held on this symbol can be released. Reconciliation
        # used to only ever apply a hold, so a strategy stayed stopped for good once the numbers
        # agreed again (2026-08-04).
        #
        # The rows to release cannot be taken from `rows` above: that query counts shares (`qty > 0`)
        # and so **cannot see a flat position** — which is the most stuck state there is, "selling
        # only" with nothing to sell. Ask for what is held instead of for what holds shares. The
        # earlier version leaned on the void sweep clearing the state as a side effect, which hid
        # this and cleared shortfall holds it had no business clearing.
        for r in conn.execute(
                "SELECT strategy_id FROM strategy_position WHERE broker=? AND account=? "
                "AND symbol=? AND state=?", (broker, account, symbol, DEGRADED)).fetchall():
            if lift_hold(conn, r["strategy_id"], broker, account, symbol):
                action, note = "restored", "the books agree again — the hold is lifted"

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
def read_positions(conn, markets=None):
    """포지션 행 + `realized_open`(이번 구간 실현) + `currency`.

    `realized_open` = 지금 들고 있는 이 포지션에 들어온 뒤 실현한 것만.

    `realized_pnl` 은 (전략·브로커·계좌·종목) 의 **생애 누적**이라 리셋되지 않는다. 그건 전략의
    성적으로서 맞는 숫자지만, 보유 행 옆에 있으면 **지금 들고 있는 물건의 손익처럼 읽힌다** — 끝난
    왕복에서 난 손실이 그 다음에 새로 산 주식에 붙어 보인다(측정 2026-08-05: META 가 3주 왕복으로
    −3.57 을 내고 끝난 뒤, 35분 뒤 새로 산 3주 옆에 그 −3.57 이 그대로 앉아 있었다).

    그래서 "마지막으로 수량이 0 이 된 뒤부터"를 따로 센다. 사다리 전략은 한 포지션 안에서도 쿼터매도로
    실현이 생기므로 이 값은 0 이 아닐 수 있고, 그때야말로 필요한 숫자다. 원장에서 파생하므로 저장하지
    않는다 — `qty_after == 0` 인 행이 곧 그 경계다.
    """
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM strategy_position WHERE qty > 0 OR realized_pnl <> 0 "
        "ORDER BY symbol, strategy_id")]
    for row in rows:
        # 통화는 화면이 아니라 여기서 붙인다 — 판정이 두 곳에 있으면 두 곳이 갈린다.
        row["currency"] = currency_of(row["broker"], row["symbol"], markets, row["strategy_id"]) \
            or UNKNOWN_CURRENCY
        if float(row.get("qty") or 0) <= EPS:
            row["realized_open"] = None          # 보유가 없으면 '이번 구간' 이라는 것이 없다
            continue
        flat = conn.execute(
            "SELECT COALESCE(MAX(id),0) AS id FROM ledger WHERE strategy_id=? AND broker=? "
            "AND account=? AND symbol=? AND qty_after <= ?",
            (row["strategy_id"], row["broker"], row["account"], row["symbol"], EPS)).fetchone()
        got = conn.execute(
            "SELECT COALESCE(SUM(realized),0) AS s FROM ledger WHERE strategy_id=? AND broker=? "
            "AND account=? AND symbol=? AND id > ?",
            (row["strategy_id"], row["broker"], row["account"], row["symbol"],
             int(flat["id"]))).fetchone()
        row["realized_open"] = float(got["s"])
    return rows


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


# A ledger row's money is in the price's own currency — the same rule the sizing fields follow
# (`money_of`, at_engine). Nothing was applying it to the totals: won and dollars were added into one
# number, so a US round trip that lost $14 and a domestic one that made 1,300 won came out as 1,286
# of nothing. The daily loss limit read that same number against a won limit, which made a dollar
# loss count for a won and the limit unreachable from the US side.
#
# The rows carry no currency column and do not need one. `broker` and `symbol` are in every row and
# the currency is a property of the pair they name, not an extra fact about the trade. Deriving beats
# storing here for a second reason: a new column could not be filled in for rows already written, and
# the ledger is append-only by trigger.
UNKNOWN_CURRENCY = "?"


def currency_of(broker, symbol, markets=None, strategy_id=None):
    """The currency this row's `price` is quoted in, or None when it cannot be said.

    A pair states its own quote: upbit writes `KRW-BTC`, `BTC-ETH`, `USDT-XRP`, and the part before
    the dash *is* the currency the price is in. A stock does not state it, so the market its strategy
    declared is what answers — `kr` is won, `us` is dollars.

    None rather than a guess. A strategy that has since been undeclared leaves rows nobody can label,
    and a total whose unit is unknown is not a total: it gets reported on its own instead of joining
    one of the others.
    """
    text = str(symbol or "").strip().upper()
    head = text.split("-")[0] if "-" in text else ""
    if head in ("KRW", "BTC", "USDT", "USD"):
        return head
    market = str((markets or {}).get(strategy_id) or "").strip().lower()
    if market in ("kr", "kospi", "kosdaq", "krx"):
        return "KRW"
    if market in ("us", "usa", "nasd", "nyse", "amex"):
        return "USD"
    return None


def pnl_summary(conn, day_start_ms, marks=None, markets=None):
    """What the ledger says was earned — today, all time, and broken down by strategy and symbol.

    Reads nothing but the ledger, so it costs no broker call and cannot disagree with the rows it is
    summing. Until this existed the only consumer of a realised number was the daily loss limit,
    which asks whether the day is bad enough to stop: profit was computed nowhere and reported
    nowhere, and the flat rows carrying it sat in the position table claiming to be positions.

    Market sells and internal transfers are kept apart. A transfer books a gain with no fee and no
    tax because no order was ever placed, so adding the two produces a number that no broker
    statement will ever match — the same reason the position row keeps them in two columns.

    Unrealised profit needs a current price, which is a broker call, and a screen reading the ledger
    should not have to make one. `marks` is where a caller that already holds prices puts them; a
    symbol with no mark is **named** rather than counted as zero, because an unpriced holding and a
    worthless one are opposite statements.

    Every money figure here is per currency, and there is deliberately no grand total across them:
    adding won to dollars needs a rate this module does not have and must not invent. `markets` maps
    a strategy id to the market it declared, which is what tells a stock row its currency.
    """
    day = int(day_start_ms or 0)

    def blank():
        return {"pnl": 0.0, "fee": 0.0, "tax": 0.0, "count": 0}

    def add(bucket, row):
        bucket["pnl"] += float(row["realized"] or 0.0)
        bucket["fee"] += float(row["fee"] or 0.0)
        bucket["tax"] += float(row["tax"] or 0.0)
        bucket["count"] += 1

    # Grouping is done here rather than in SQL because the currency is derived, not a column.
    by_cur, by_strategy, by_symbol = {}, {}, {}
    for row in conn.execute("SELECT strategy_id, broker, account, symbol, side, fee, tax, realized, "
                            "ts_ms FROM ledger ORDER BY ts_ms"):
        cur = currency_of(row["broker"], row["symbol"], markets, row["strategy_id"]) \
            or UNKNOWN_CURRENCY
        slot = by_cur.setdefault(cur, {
            "sold": {"today": blank(), "total": blank()},
            "transferred": {"today": blank(), "total": blank()},
            "bought": {"today": blank(), "total": blank()},
        })
        leg = {"sell": "sold", "transfer_out": "transferred", "buy": "bought"}.get(row["side"])
        if leg:
            add(slot[leg]["total"], row)
            if int(row["ts_ms"] or 0) >= day:
                add(slot[leg]["today"], row)
        if row["side"] == "sell":
            for group, key in ((by_strategy, (row["strategy_id"], row["symbol"])),
                               (by_symbol, (row["symbol"],))):
                agg = group.setdefault(key, {"currency": cur, "sells": 0, "realized": 0.0,
                                             "fee": 0.0, "tax": 0.0, "last_ms": 0})
                agg["sells"] += 1
                agg["realized"] += float(row["realized"] or 0.0)
                agg["fee"] += float(row["fee"] or 0.0)
                agg["tax"] += float(row["tax"] or 0.0)
                agg["last_ms"] = max(agg["last_ms"], int(row["ts_ms"] or 0))

    for cur, slot in by_cur.items():
        # The two numbers a person actually asks for, spelled out so nothing downstream has to add up
        # the wrong pair. Transfers are excluded: a bookkeeping move is not money the account made.
        slot["realizedToday"] = slot["sold"]["today"]["pnl"]
        slot["realizedTotal"] = slot["sold"]["total"]["pnl"]

    out = {"dayStartMs": day, "byCurrency": by_cur,
           "currencies": sorted(by_cur.keys()),
           "byStrategy": sorted(({"strategy_id": k[0], "symbol": k[1], **v}
                                 for k, v in by_strategy.items()),
                                key=lambda r: r["realized"], reverse=True),
           "bySymbol": sorted(({"symbol": k[0], **v} for k, v in by_symbol.items()),
                              key=lambda r: r["realized"], reverse=True)}

    held = [dict(r) for r in conn.execute(
        "SELECT strategy_id, broker, account, symbol, qty, avg_price, state "
        "FROM strategy_position WHERE qty > ? ORDER BY symbol, strategy_id", (EPS,))]
    priced, unreal = [], {}
    for h in held:
        cur = currency_of(h["broker"], h["symbol"], markets, h["strategy_id"]) or UNKNOWN_CURRENCY
        seen = unreal.setdefault(cur, {"total": 0.0, "priced": 0, "unpriced": []})
        mark = None
        if isinstance(marks, dict):
            for key in (h["symbol"], str(h["symbol"] or "").upper()):
                if key in marks:
                    try:
                        mark = float(marks[key])
                    except (TypeError, ValueError):
                        mark = None
                    break
        if mark and mark > 0:
            gain = (mark - float(h["avg_price"])) * float(h["qty"])
            priced.append({**h, "currency": cur, "mark": mark, "unrealized": gain})
            seen["total"] += gain
            seen["priced"] += 1
        else:
            seen["unpriced"].append(h["symbol"])
            priced.append({**h, "currency": cur, "mark": None, "unrealized": None})
    for cur, seen in unreal.items():
        # A partial sum reads as the whole, so the total refuses to be a number until every holding
        # in that currency has a mark.
        if seen["unpriced"]:
            seen["total"] = None
    out["held"] = priced
    out["unrealized"] = unreal
    return out


def realized_today(conn, day_start_ms, markets=None):
    """Today's realised result per currency — `{"KRW": -1200.0, "USD": -14.84}`.

    One number across currencies is what the daily loss limit used to read, and it made a dollar
    count for a won: fourteen dollars lost registered as fourteen won against a fifty-thousand-won
    limit, so no US loss could ever trip it. A limit is compared against its own currency or not at
    all.
    """
    out = {}
    for row in conn.execute(
            "SELECT strategy_id, broker, symbol, realized FROM ledger "
            "WHERE ts_ms >= ? AND side='sell'", (day_start_ms,)):
        cur = currency_of(row["broker"], row["symbol"], markets, row["strategy_id"]) \
            or UNKNOWN_CURRENCY
        out[cur] = out.get(cur, 0.0) + float(row["realized"] or 0.0)
    return out
