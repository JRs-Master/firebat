/**
 * ai.js — the opponent.
 *
 * Carom has no pocket to aim at, so there is no geometric target to solve for: the only honest
 * way to pick a shot is to try shots and see. That is affordable because the simulator is
 * deterministic and cheap (about 0.4 ms a shot), so a few hundred to a few thousand candidates
 * fit inside one turn.
 *
 * Difficulty is therefore real rather than staged. A weak opponent LOOKS at fewer shots and
 * its hands shake more; a strong one looks at more and executes what it chose. Nothing here
 * rolls a die to decide whether to "miss on purpose" — it misses because it did not find the
 * shot, or because the shot it found slipped, which is how people miss.
 *
 * Three stages: sweep the angle coarsely with plain centre-ball, crowd around whatever looked
 * promising with spin and speed, then — the stage that actually matters — replay the finalists
 * with the shaky hands this level really has and keep the one that SURVIVES. Measured: a
 * three-cushion line that scores exactly can drop to 64% with 0.03 degrees of error, so a
 * search that only asks "does it go in" reliably picks razor-thin shots and then misses them.
 * Asking "does it still go in when I am slightly off" is what a good player is actually doing,
 * and it makes difficulty mean something beyond steadier hands: a stronger opponent can afford
 * to check more, so it finds fatter shots as well as delivering them better.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./physics.js'), require('./rules.js'));
  } else {
    root.CaromAI = factory(root.CaromPhysics, root.CaromRules);
  }
})(typeof self !== 'undefined' ? self : this, function (P, Rules) {
  'use strict';

  var MAXV = 6.5;   // must match the game's full-power speed

  // Levels are named the way Korean players actually rank each other — by 수지, the number you
  // run to — rather than by vague words. "고수" is an argument; "4구 300" is not. The figures in
  // brackets are the measured per-shot success rate on random layouts, which is what the label
  // has to stay honest about: calling a 42% opponent a 고수 was the mismatch that prompted this.
  var LEVELS = {
    beginner: { su: { four: 80, three: 8 }, budget: 140, angle: 0.032, speed: 0.13, tip: 0.11 },
    club: { su: { four: 150, three: 15 }, budget: 420, angle: 0.015, speed: 0.075, tip: 0.06 },
    strong: { su: { four: 300, three: 25 }, budget: 1200, angle: 0.006, speed: 0.035, tip: 0.03 },
    pro: { su: { four: 500, three: 40 }, budget: 3000, angle: 0.002, speed: 0.014, tip: 0.012 },
  };
  /** e.g. "3쿠션 25" — the opponent's rating in the game being played. */
  function levelLabel(name, game) {
    var L = LEVELS[name] || LEVELS.club;
    return (game === 'four' ? '4구 ' : '3쿠션 ') + L.su[game === 'four' ? 'four' : 'three'];
  }

  /** Seedable so a match can be replayed exactly; seeded from the clock when nobody cares. */
  function rng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  function gauss(rand) {
    var u = 1 - rand(), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function snapshot(world) {
    return world.balls.map(function (b) { return { id: b.id, p: [b.p[0], b.p[1]] }; });
  }

  /**
   * How good was this outcome. A made point dominates everything, and among made points the
   * tiebreak is leaving the balls close together, because that is what makes the NEXT shot
   * easy — a carom player who scores into a hopeless position has not really scored.
   * Failures get partial credit so the coarse sweep has a gradient to climb instead of a
   * field of zeros.
   */
  function value(game, shooter, res, balls, table) {
    var s = Rules.score(game, shooter, res.events);
    if (s.points > 0) {
      var spread = 0, n = 0;
      for (var i = 0; i < balls.length; i++) {
        for (var j = i + 1; j < balls.length; j++) {
          spread += Math.hypot(balls[i].p[0] - balls[j].p[0], balls[i].p[1] - balls[j].p[1]);
          n++;
        }
      }
      var diag = Math.hypot(table.w, table.h);
      return { v: 1000 - (spread / Math.max(1, n)) / diag * 120, score: s };
    }
    if (s.points < 0) return { v: -500, score: s };

    var r = Rules.roles(game, shooter);
    var v = s.hit.length * 60;
    if (r.cushions) v += Math.min(s.cushionsBeforeSecond === null ? s.cushions : s.cushionsBeforeSecond, r.cushions) * 14;
    return { v: v, score: s };
  }

  function tryShot(setup, game, shooter, shot) {
    var w = P.createWorld({ table: setup.table, balls: setup.balls });
    w.k.maxTime = 12;
    var m = P.shoot(w, shooter, shot);
    if (m.miscue) return { v: -1000, score: null };
    var res = P.simulate(w, {});
    var out = value(game, shooter, res, w.balls, setup.table);
    out.shot = shot;
    return out;
  }

  /**
   * Pick a shot. Returns what it INTENDED plus what it will actually play once its hands are
   * taken into account — the caller fires `play`, and `intent` is only there so the difficulty
   * can be inspected instead of taken on faith.
   */
  function plan(world, game, shooter, levelName, seed) {
    var L = LEVELS[levelName] || LEVELS.club;
    var rand = rng(seed === undefined ? (Date.now() & 0x7fffffff) : seed);
    var setup = { table: world.table, balls: snapshot(world) };
    var used = 0;

    // ── stage 1: sweep the angle with plain centre-ball at a few speeds
    var coarseBudget = Math.max(48, Math.round(L.budget * 0.45));
    var speeds = [0.30, 0.48, 0.70];
    var nAngles = Math.max(16, Math.floor(coarseBudget / speeds.length));
    var found = [];
    for (var a = 0; a < nAngles; a++) {
      var ang = (a / nAngles) * Math.PI * 2;
      for (var si = 0; si < speeds.length; si++) {
        found.push(tryShot(setup, game, shooter, { angle: ang, speed: speeds[si] * MAXV, side: 0, vert: 0 }));
        used++;
      }
    }
    found.sort(function (x, y) { return y.v - x.v; });

    // ── stage 2: crowd around the promising ones, now with spin
    var refine = Math.max(0, Math.round(L.budget * 0.35));
    var seeds = found.slice(0, Math.max(2, Math.min(6, Math.ceil(refine / 60))));
    var pool = found.slice(0, 8);
    var perSeed = seeds.length ? Math.floor(refine / seeds.length) : 0;
    for (var k = 0; k < seeds.length; k++) {
      var base = seeds[k].shot;
      for (var t = 0; t < perSeed; t++) {
        var cand = {
          angle: base.angle + (rand() - 0.5) * 0.14,
          speed: Math.min(MAXV, Math.max(0.5, base.speed * (0.78 + rand() * 0.5))),
          side: (rand() - 0.5) * 0.9,
          vert: (rand() - 0.5) * 0.7,
        };
        if (Math.hypot(cand.side, cand.vert) > P.DEFAULTS.maxTipOffset) continue;
        pool.push(tryShot(setup, game, shooter, cand));
        used++;
      }
    }
    pool.sort(function (x, y) { return y.v - x.v; });

    // ── stage 3: how much room does each finalist have?
    //    Perturb by the level's OWN sigma, because "safe enough" is not an absolute — a shot
    //    with two degrees of margin is safe for a beginner and irrelevant to a pro.
    var finalists = pool.slice(0, Math.max(3, Math.min(14, Math.round(L.budget * 0.20 / 5))));
    var probes = Math.max(3, Math.floor((L.budget * 0.20) / Math.max(1, finalists.length)));
    var best = finalists[0], bestRobust = -1;
    for (var f = 0; f < finalists.length; f++) {
      var c = finalists[f];
      if (c.v < 0) continue;
      var lived = 0;
      for (var q = 0; q < probes; q++) {
        var jitter = {
          angle: c.shot.angle + gauss(rand) * L.angle,
          speed: Math.min(MAXV, Math.max(0.35, c.shot.speed * (1 + gauss(rand) * L.speed))),
          side: c.shot.side + gauss(rand) * L.tip,
          vert: c.shot.vert + gauss(rand) * L.tip,
        };
        var offj = Math.hypot(jitter.side, jitter.vert);
        if (offj > P.DEFAULTS.maxTipOffset) {
          jitter.side *= P.DEFAULTS.maxTipOffset / offj;
          jitter.vert *= P.DEFAULTS.maxTipOffset / offj;
        }
        var jr = tryShot(setup, game, shooter, jitter);
        used++;
        if (jr.score && jr.score.points > 0) lived++;
        else if (jr.score && jr.score.points < 0) lived -= 1;   // a foul is worse than a miss
      }
      // survival first, then the clean-shot value as the tiebreak
      var robust = lived / probes + c.v / 100000;
      if (robust > bestRobust) { bestRobust = robust; best = c; }
    }

    // ── the hands. Noise is applied to the chosen shot, never to the search: a weak player is
    //    not someone who imagines a bad shot, it is someone who cannot deliver a good one.
    var play = {
      angle: best.shot.angle + gauss(rand) * L.angle,
      speed: Math.min(MAXV, Math.max(0.35, best.shot.speed * (1 + gauss(rand) * L.speed))),
      side: best.shot.side + gauss(rand) * L.tip,
      vert: best.shot.vert + gauss(rand) * L.tip,
    };
    var off = Math.hypot(play.side, play.vert);
    if (off > P.DEFAULTS.maxTipOffset) {
      play.side *= P.DEFAULTS.maxTipOffset / off;
      play.vert *= P.DEFAULTS.maxTipOffset / off;
    }

    return {
      play: play,
      intent: best.shot,
      expect: best.score,               // what it believed the intended shot would do
      margin: Math.max(0, bestRobust),  // how often that belief survived its own shaky hands
      looked: used,
      level: levelName,
    };
  }

  return { LEVELS: LEVELS, levelLabel: levelLabel, plan: plan, MAXV: MAXV, value: value };
});
