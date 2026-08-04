"""The owner's clock, for a module that needs a wall clock.

A module is a fresh process per pipeline step, so the zone it would read from the host is the
host's and has nothing to do with whose calendar the answer is for. The framework says which zone
in `FIREBAT_TZ`; this reads it. Nothing here asks the OS what zone it is in.

Two rules, the same two the Rust side holds:

1. **Stored and compared in UTC** — `now_ms()` is epoch milliseconds, which mean the same thing
   everywhere and have no offset to lose.
2. **A calendar concept is resolved in the owner's zone** — "today", "the 5th" are properties of a
   person's calendar, not of an instant. Resolved here, at the edge, back into a UTC instant.

`render()` writes RFC-3339 with the offset spelled out: `2026-08-03T23:41:12+09:00 (Asia/Seoul)`.
A bare `23:41` is the shape that caused the damage — it reads as local to whoever is looking, and
a person and a model will each assume their own. The offset is *rendered*, never stored as the
authority: `UTC+9` is a number and a zone is a rule, so for any zone with daylight saving a stored
offset is wrong half the year.
"""
import datetime as _dt
import os

_DEFAULT = "Asia/Seoul"


def zone_name():
    """The zone the framework said to use."""
    return (os.environ.get("FIREBAT_TZ") or os.environ.get("TZ") or _DEFAULT).strip() or _DEFAULT


def zone():
    """The zone as a tzinfo.

    When the platform has no zone database (a Python without `tzdata`), the requested zone cannot
    be honoured. Two different fallbacks, on purpose:

    - Asia/Seoul → fixed +09:00. Korea has no daylight saving, so the fixed offset is not an
      approximation, it is the same answer.
    - anything else → **UTC, and a line on stderr.** Quietly answering in Seoul time for somebody
      who asked for New York is the failure this whole module exists to stop, and a wrong answer
      that looks right is worse than one that is visibly not local.
    """
    name = zone_name()
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        if name == _DEFAULT:
            return _dt.timezone(_dt.timedelta(hours=9), _DEFAULT)
        import sys
        # Plain ASCII: this goes to a console whose encoding is not ours to assume, and a warning
        # that fails to print is a warning nobody reads.
        print(f"[tz] no zone database for {name!r}; answering in UTC rather than guessing an "
              f"offset. Install tzdata on the host.", file=sys.stderr)
        return _dt.timezone.utc


def has_zone(name):
    """Can this zone actually be honoured on this host?

    For a caller that must refuse rather than accept a fallback. `zone()` and `local_in()` answer in
    UTC with a warning when the database is missing, which is the right default for *rendering* a
    time — but a venue's schedule compared against the wrong clock is not a cosmetic error: it says
    an exchange is open when it is shut. Anything deciding on a session asks this first.
    """
    if name == _DEFAULT:
        return True                    # fixed +09:00 is the same answer, not an approximation
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(name)
        return True
    except Exception:
        return False


def now_ms():
    """Epoch milliseconds. UTC by definition — no zone involved."""
    return int(_dt.datetime.now(_dt.timezone.utc).timestamp() * 1000)


def local_in(name, ms=None):
    """An instant in a **named** zone, for a clock that is not the owner's.

    Three kinds of wall clock, and only the first belongs to the owner:

    - **the owner's calendar** — "today", "the 5th", a daily limit. `local()` and friends.
    - **a venue's schedule** — an exchange opens at 09:00 KST, a weather service publishes at
      02/05/08 KST. That is a fact about the venue, not about whoever is asking: a hub user in New
      York trading Seoul still needs the Seoul session date. This is the only entry point for it,
      and the caller converts from here — one primitive rather than a parallel family of
      zone-taking twins, so the specialness stays visible at the call site.
    - **an instant** — UTC, no zone involved.

    Unifying the first two under "the user's timezone" is the trap: it looks tidy and silently
    picks the wrong session the first time someone is not in Korea.
    """
    at = _dt.datetime.now(_dt.timezone.utc) if ms is None else \
        _dt.datetime.fromtimestamp(float(ms) / 1000.0, _dt.timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return at.astimezone(ZoneInfo(name))
    except Exception:
        if name == _DEFAULT:
            return at.astimezone(_dt.timezone(_dt.timedelta(hours=9), _DEFAULT))
        import sys
        print(f"[tz] no zone database for {name!r}; answering in UTC rather than guessing an "
              f"offset. Install tzdata on the host.", file=sys.stderr)
        return at


def local(ms=None):
    """An instant as a zone-aware datetime in the owner's zone."""
    at = _dt.datetime.now(_dt.timezone.utc) if ms is None else \
        _dt.datetime.fromtimestamp(float(ms) / 1000.0, _dt.timezone.utc)
    return at.astimezone(zone())


def render(ms=None):
    """`2026-08-03T23:41:12+09:00 (Asia/Seoul)` — unmisreadable by construction."""
    at = local(ms)
    off = at.strftime("%z") or "+0000"          # `+0900`
    off = f"{off[:3]}:{off[3:]}"                # `+09:00`, which is what RFC-3339 wants
    return f"{at.strftime('%Y-%m-%dT%H:%M:%S')}{off} ({zone_name()})"


def today_ymd(ms=None):
    """The calendar date in the owner's zone, `YYYY-MM-DD`."""
    return local(ms).strftime("%Y-%m-%d")


def ymd_compact(ms=None):
    """`YYYYMMDD` — what most Korean venue APIs take."""
    return local(ms).strftime("%Y%m%d")


def day_start_ms(ms=None):
    """Midnight of that instant's day in the owner's zone, as epoch ms.

    The function whose absence cost money: a daily loss limit read the *process* zone, so on a UTC
    host "today" began at 09:00 in Seoul — the limit reset at the opening bell instead of at
    midnight, and a trading window ended nine hours late.
    """
    at = local(ms)
    return int(at.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)


def parse_day_ms(text):
    """A date a person typed → midnight where they are, as epoch ms. None if unreadable.

    `activeUntil: 2026-08-05` means midnight in the owner's zone, not on the host.
    """
    try:
        parts = [int(p) for p in str(text).strip().replace("/", "-").split("-")[:3]]
    except (ValueError, TypeError):
        return None
    if len(parts) != 3:
        return None
    try:
        naive = _dt.datetime(parts[0], parts[1], parts[2], 0, 0, 0)
    except (ValueError, OverflowError):
        return None
    return int(naive.replace(tzinfo=zone()).timestamp() * 1000)


def hour(ms=None):
    """The hour of the wall clock in the owner's zone."""
    return local(ms).hour
