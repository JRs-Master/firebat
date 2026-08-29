/**
 * rules.js — carom scoring, read entirely off the contact log.
 *
 * The simulator does not know what game is being played; it emits an ordered list of contacts
 * and nothing else. Everything here is a pure function of that list, which is why four-ball
 * and three-cushion can share one engine, why the browser and the server reach the same
 * verdict from the same shot, and why a rule can be argued about without touching physics.
 *
 * Shared with the browser build and with the module that verifies submitted scores — one file,
 * two readers, so a rule cannot drift between what you played and what got ranked.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaromRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Which balls are what, for a given shooter. The two cue balls swap roles every turn, so
   * this is derived rather than stored — storing it is how a "whose ball is this" bug starts.
   */
  function roles(game, shooter) {
    if (game === 'four') {
      const other = shooter === 'white' ? 'yellow' : 'white';
      return { cue: shooter, opponent: other, objects: ['red1', 'red2'], needed: 2, cushions: 0 };
    }
    const other = shooter === 'white' ? 'yellow' : 'white';
    return { cue: shooter, opponent: other, objects: [other, 'red'], needed: 2, cushions: 3 };
  }

  /** Contacts made BY the cue ball, in order, as {kind, other|rail}. */
  function cueContacts(events, cue) {
    const out = [];
    for (const e of events) {
      if (e.type === 'ball' && (e.a === cue || e.b === cue)) {
        out.push({ kind: 'ball', other: e.a === cue ? e.b : e.a, t: e.t });
      } else if (e.type === 'cushion' && e.ball === cue) {
        out.push({ kind: 'cushion', rail: e.rail, t: e.t });
      }
    }
    return out;
  }

  /**
   * Score one shot.
   *
   * four-ball: hit both reds and it is a point, and you keep shooting. Touching the other
   *   cue ball at any time is a foul worth minus one and ends the turn — a rule people
   *   actually feel, so it is checked over the whole shot rather than only before the reds.
   *
   * three-cushion: hit both object balls with at least three cushions by the cue ball BEFORE
   *   it reaches the SECOND of them. The "before the second" part is the whole game; counting
   *   cushions over the entire shot is the classic way to write this wrong.
   */
  function score(game, shooter, events) {
    const r = roles(game, shooter);
    const seq = cueContacts(events, r.cue);

    const hit = [];
    let cushions = 0, cushionsBeforeSecond = null, touchedOpponent = false;
    for (const c of seq) {
      if (c.kind === 'cushion') { cushions++; continue; }
      if (game === 'four' && c.other === r.opponent) { touchedOpponent = true; continue; }
      if (!r.objects.includes(c.other)) continue;
      if (!hit.includes(c.other)) {
        hit.push(c.other);
        if (hit.length === 2 && cushionsBeforeSecond === null) cushionsBeforeSecond = cushions;
      }
    }

    const allHit = hit.length >= r.needed;
    const enough = r.cushions === 0 || (cushionsBeforeSecond !== null && cushionsBeforeSecond >= r.cushions);
    const foul = game === 'four' && touchedOpponent;

    let points = 0, reason;
    if (foul) { points = -1; reason = 'foul_opponent'; }
    else if (allHit && enough) { points = 1; reason = 'score'; }
    else if (!hit.length) reason = 'miss_nothing';
    else if (!allHit) reason = 'miss_one_ball';
    else reason = 'not_enough_cushions';

    return {
      points, reason,
      scored: points > 0,
      foul,
      hit,
      cushions,
      cushionsBeforeSecond,
      // what the shot still needed, so the UI can say it in one line instead of guessing
      shortBy: points > 0 ? 0 :
        !allHit ? r.needed - hit.length :
        Math.max(0, r.cushions - (cushionsBeforeSecond || 0)),
    };
  }

  /** A fresh match. `target` is the run-to score each player is chasing. */
  function newMatch(game, target, players) {
    return {
      game, target: target || (game === 'four' ? 20 : 10),
      players: players || [{ id: 'white', name: '나' }, { id: 'yellow', name: '상대' }],
      scores: { white: 0, yellow: 0 },
      turn: 0,            // index into players
      inning: 1,
      runs: { white: 0, yellow: 0 },   // balls made in the current visit
      best: { white: 0, yellow: 0 },   // longest run, the number carom players actually quote
      history: [],
      over: false,
      winner: null,
    };
  }

  function shooterOf(m) { return m.players[m.turn].id; }

  /**
   * Fold one shot into the match. Returns the same object, mutated — the caller owns it, and
   * the browser and the module both drive it through this one entry point so a replay lands
   * on exactly the score the player saw.
   */
  function applyShot(m, events) {
    if (m.over) return m;
    const who = shooterOf(m);
    const s = score(m.game, who, events);

    m.scores[who] = Math.max(0, m.scores[who] + s.points);
    m.history.push({ inning: m.inning, who, points: s.points, reason: s.reason, hit: s.hit, cushions: s.cushions });

    if (s.points > 0) {
      m.runs[who] += 1;
      if (m.runs[who] > m.best[who]) m.best[who] = m.runs[who];
    } else {
      m.runs[who] = 0;
    }

    if (m.scores[who] >= m.target) { m.over = true; m.winner = who; return m; }

    // Keep shooting on a score; anything else hands the table over.
    if (!s.points || s.points < 0) {
      m.turn = (m.turn + 1) % m.players.length;
      if (m.turn === 0) m.inning += 1;
    }
    return m;
  }

  return { roles, cueContacts, score, newMatch, shooterOf, applyShot };
});
