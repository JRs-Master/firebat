"""Where symbols come from when they are not typed by hand.

Kiwoom will run a screening condition and stream what enters and leaves it, but it will not let
anything create one: the API lists conditions and requests them, and that is all. So the formula is
written by the model and typed into HTS by a person, once. After that the loop is closed — the
condition streams, this file keeps the list, and the strategy trades what is on it.

Two rules shape the list, and both exist because of the same accident:

  * **Absence is not removal.** A symbol leaves only when a frame says it left. A stream that
    stopped, a socket that dropped, a broker in maintenance — none of those empty the list. An
    emptied list reads as "sell everything", which is the one outcome nobody asked for.
  * **A frame that cannot be read is reported, not dropped.** The field names in a condition frame
    are not documented and are not guessed at here; an unreadable frame is handed back so the
    names can be learned from a real one, exactly as execution rows are.
"""
import json
import sqlite3
import os

import at_store as store

# Condition frames name the symbol and the direction differently across endpoints, and neither is
# documented. Read by name, and say so when nothing matches.
SYMBOL_KEYS = ("9001", "jmcode", "stk_cd", "symbol", "code", "shcode")
ACTION_KEYS = ("843", "sig_type", "signal", "type", "action")
# "I" 편입 / "D" 이탈 is the coding kiwoom uses in the condition stream.
ENTER = ("I", "i", "insert", "in", "편입", "add")
LEAVE = ("D", "d", "delete", "out", "이탈", "remove")

SCHEMA = """
CREATE TABLE IF NOT EXISTS condition_request(
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL,
  name TEXT NOT NULL,
  criteria TEXT NOT NULL,
  rationale TEXT,
  seq TEXT,
  state TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist(
  trade_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  entered_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY(trade_id, symbol)
);
CREATE TABLE IF NOT EXISTS watchlist_event(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL, trade_id TEXT NOT NULL, symbol TEXT, event TEXT NOT NULL,
  detail_json TEXT
);
"""


def connect():
    os.makedirs(store.DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(os.path.join(store.DATA_DIR, "universe.db"), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(SCHEMA)
    return conn


def _first(row, names):
    for k in names:
        v = row.get(k)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return None


def read_frame(frame, frame_map=None):
    """One condition frame → (symbol, "enter"|"leave"), or (None, None) when it cannot be read.

    A declared `frameMap` wins over the candidate names: once a real frame shows what the fields
    are called, the answer belongs in a declaration rather than in a longer guess list.
    """
    if not isinstance(frame, dict):
        return None, None
    fm = frame_map or {}
    sym = _first(frame, [fm["symbol"]] if fm.get("symbol") else SYMBOL_KEYS)
    if not sym:
        return None, None
    raw = _first(frame, [fm["action"]] if fm.get("action") else ACTION_KEYS)
    if raw is None:
        # A condition frame with no direction is an entry: the stream reports the set as it stands
        # when a subscription starts, and those arrive without a signal type.
        return sym, "enter"
    if raw in ENTER:
        return sym, "enter"
    if raw in LEAVE:
        return sym, "leave"
    return sym, None


def apply_frames(conn, trade_id, frames, frame_map=None):
    """Fold condition frames into the list. Returns what changed and what could not be read."""
    now = store.now_ms()
    added, removed, unread = [], [], []
    for f in frames or []:
        sym, act = read_frame(f, frame_map)
        if not sym or act is None:
            unread.append(f)
            continue
        if act == "enter":
            cur = conn.execute("SELECT 1 FROM watchlist WHERE trade_id=? AND symbol=?",
                               (trade_id, sym)).fetchone()
            conn.execute(
                "INSERT INTO watchlist(trade_id, symbol, entered_ms, last_seen_ms)"
                " VALUES(?,?,?,?) ON CONFLICT(trade_id, symbol) DO UPDATE SET last_seen_ms=?",
                (trade_id, sym, now, now, now))
            if cur is None:
                added.append(sym)
                _log(conn, trade_id, sym, "entered", f)
        else:
            cur = conn.execute("DELETE FROM watchlist WHERE trade_id=? AND symbol=?",
                               (trade_id, sym))
            if cur.rowcount:
                removed.append(sym)
                _log(conn, trade_id, sym, "left", f)
    if unread:
        _log(conn, trade_id, None, "unreadable", {"frames": unread[:5], "count": len(unread)})
    conn.commit()
    return {"added": added, "removed": removed, "unreadableFrames": unread}


def apply_ranking(conn, trade_id, symbols, source=None):
    """Fold a ranking snapshot into the list. Returns what changed.

    A ranking is a snapshot where a condition stream is a series of events, so the arithmetic is
    different: whatever the snapshot holds is present, and whatever it does not is gone. The
    arrivals are written the same way the stream writes them, which is what lets a `screen-entry`
    rule treat "entered the top of the book" exactly as it treats "entered the condition".

    An empty snapshot changes nothing. A ranking call that failed, was throttled, or came back
    before the market opened returns no rows, and reading that as "every symbol left" is the same
    mistake as reading a dropped socket as a liquidation — the list is emptied and the strategy is
    told to abandon everything it holds.
    """
    now = store.now_ms()
    wanted = [s for s in dict.fromkeys(str(x).strip() for x in (symbols or [])) if s]
    if not wanted:
        _log(conn, trade_id, None, "empty-ranking", {"source": source})
        conn.commit()
        return {"added": [], "removed": [], "kept": symbols_of(conn, trade_id), "empty": True}

    before = set(symbols_of(conn, trade_id))
    added = []
    for sym in wanted:
        conn.execute(
            "INSERT INTO watchlist(trade_id, symbol, entered_ms, last_seen_ms)"
            " VALUES(?,?,?,?) ON CONFLICT(trade_id, symbol) DO UPDATE SET last_seen_ms=?",
            (trade_id, sym, now, now, now))
        if sym not in before:
            added.append(sym)
            _log(conn, trade_id, sym, "entered", {"source": source or "ranking"})
    removed = sorted(before - set(wanted))
    for sym in removed:
        conn.execute("DELETE FROM watchlist WHERE trade_id=? AND symbol=?", (trade_id, sym))
        _log(conn, trade_id, sym, "left", {"source": source or "ranking"})
    conn.commit()
    return {"added": added, "removed": removed, "kept": wanted, "empty": False}


def _log(conn, trade_id, symbol, event, detail):
    conn.execute("INSERT INTO watchlist_event(ts_ms, trade_id, symbol, event, detail_json)"
                 " VALUES(?,?,?,?,?)",
                 (store.now_ms(), trade_id, symbol, event,
                  json.dumps(detail, ensure_ascii=False)[:2000]))


def symbols_of(conn, trade_id):
    """The current list. Never filtered by age — staleness is not the same as departure."""
    return [r["symbol"] for r in conn.execute(
        "SELECT symbol FROM watchlist WHERE trade_id=? ORDER BY entered_ms", (trade_id,))]


def request_condition(conn, trade_id, name, criteria, rationale=None):
    """Record the screening formula the model wants a person to create in HTS.

    The broker has no API for this — it lists conditions and runs them, it does not accept one. So
    the formula is written here in words a person can type, and the request stays open until the
    sequence number it was given comes back.
    """
    now = store.now_ms()
    rid = f"{trade_id}:{name}"
    existing = conn.execute("SELECT seq, state FROM condition_request WHERE id=?", (rid,)).fetchone()
    conn.execute(
        "INSERT INTO condition_request(id, trade_id, name, criteria, rationale, seq, state,"
        " created_ms, updated_ms) VALUES(?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(id) DO UPDATE SET criteria=excluded.criteria,"
        " rationale=excluded.rationale, updated_ms=excluded.updated_ms",
        (rid, trade_id, name, criteria, rationale, None, "awaiting-registration", now, now))
    conn.commit()
    return {"requestId": rid, "state": existing["state"] if existing else "awaiting-registration",
            "seq": existing["seq"] if existing else None,
            "note": ("키움은 조건식을 API 로 만들 수 없습니다 — HTS 에서 이 이름으로 한 번 만들어 "
                     "주시면, 그 뒤로는 목록에 잡혀 자동으로 돕니다.")}


def bind_seq(conn, request_id, seq):
    """The person made it; this is the number it came back as."""
    cur = conn.execute(
        "UPDATE condition_request SET seq=?, state='registered', updated_ms=? WHERE id=?",
        (str(seq), store.now_ms(), request_id))
    conn.commit()
    return cur.rowcount > 0


def read_requests(conn, limit=50):
    return [{"id": r["id"], "tradeId": r["trade_id"], "name": r["name"],
             "criteria": r["criteria"], "rationale": r["rationale"], "seq": r["seq"],
             "state": r["state"], "updatedMs": r["updated_ms"]}
            for r in conn.execute(
                "SELECT * FROM condition_request ORDER BY updated_ms DESC LIMIT ?", (limit,))]


# The condition list comes back as rows of (sequence number, name) — the names being the ones a
# person typed in HTS. Neither field name is documented, so read by candidates and report a row
# that cannot be read rather than dropping it.
SEQ_KEYS = ("seq", "cnsr_seq", "condition_seq", "idx", "no")
NAME_KEYS = ("name", "cnsr_nm", "condition_name", "nm", "title")


def match_conditions(conn, rows):
    """Bind open requests to the conditions a person actually created, by name.

    Matching on the name is what makes the loop close by itself: the model asked for a condition
    called X, someone created X in HTS, and the list now says X is sequence 7. Nothing has to be
    copied by hand, and a second condition cannot be mistaken for the first.
    """
    listed, unread = {}, []
    for r in rows or []:
        if isinstance(r, (list, tuple)) and len(r) >= 2:
            # Some endpoints answer with positional pairs rather than objects.
            listed[str(r[1]).strip()] = str(r[0]).strip()
            continue
        if not isinstance(r, dict):
            unread.append(r)
            continue
        seq, name = _first(r, SEQ_KEYS), _first(r, NAME_KEYS)
        if seq is None or name is None:
            unread.append(r)
            continue
        listed[name] = seq
    bound, waiting = [], []
    for req in conn.execute("SELECT id, name, seq, state FROM condition_request").fetchall():
        found = listed.get(req["name"])
        if found is None:
            if req["state"] != "registered":
                waiting.append({"requestId": req["id"], "name": req["name"]})
            continue
        if req["seq"] == found and req["state"] == "registered":
            continue
        conn.execute("UPDATE condition_request SET seq=?, state='registered', updated_ms=?"
                     " WHERE id=?", (found, store.now_ms(), req["id"]))
        bound.append({"requestId": req["id"], "name": req["name"], "seq": found})
    conn.commit()
    return {"bound": bound, "awaitingRegistration": waiting,
            "listed": len(listed), "unreadableRows": unread}


def bind_watch(conn, request_id, watch_id):
    """Remember which live watch carries this condition's frames.

    Routing by the watch rather than by something inside the frame is deliberate: a watch is
    started for one condition, so the watch already identifies it. Depending on the frame to carry
    a sequence number would mean guessing a field name we have never seen, and getting it wrong
    would mix two screens into one list.
    """
    conn.execute("UPDATE condition_request SET state='streaming', updated_ms=? WHERE id=?",
                 (store.now_ms(), request_id))
    conn.execute("INSERT INTO watchlist_event(ts_ms, trade_id, symbol, event, detail_json)"
                 " VALUES(?,?,?,?,?)",
                 (store.now_ms(), request_id.split(":")[0], None, "watch-bound",
                  json.dumps({"watchId": watch_id, "requestId": request_id}, ensure_ascii=False)))
    conn.commit()
    return True


def trade_for_watch(conn, watch_id):
    """Which trade's list a frame belongs to, from the watch it arrived on."""
    row = conn.execute(
        "SELECT trade_id, detail_json FROM watchlist_event WHERE event='watch-bound'"
        " ORDER BY seq DESC").fetchall()
    for r in row:
        try:
            d = json.loads(r["detail_json"] or "{}")
        except (ValueError, TypeError):
            continue
        if d.get("watchId") == watch_id:
            return r["trade_id"]
    return None


def recent_entries(conn, trade_id, within_ms):
    """Symbols that entered the screen recently — the entry itself being the signal.

    A scalping rule does not wait for the next bar: the thing it reacts to is a symbol showing up
    on the screen. `entered_ms` is returned with each one so the caller can key its idempotency on
    the entry rather than on a clock, which is what makes draining this twice harmless.
    """
    cutoff = store.now_ms() - int(within_ms)
    return [{"symbol": r["symbol"], "enteredMs": r["entered_ms"]}
            for r in conn.execute(
                "SELECT symbol, entered_ms FROM watchlist WHERE trade_id=? AND entered_ms>=?"
                " ORDER BY entered_ms", (trade_id, cutoff))]
