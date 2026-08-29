/**
 * carom-physics.js — headless, deterministic carom billiards core.
 *
 * Why this is hand-written instead of cannon-es / rapier: a generic rigid-body engine
 * approximates sphere-sphere friction, so it loses *throw* (the cut angle shifting when you
 * hit thin) and it models the cushion as a plane through the ball's equator, so side spin
 * does not change the rebound angle. Those two are exactly what a carom player feels. Here
 * both fall out of the model instead of being special-cased.
 *
 * Deterministic by construction: fixed timestep, no RNG, no wall clock. The same shot gives
 * the same table every time — which is what makes replays, tests, and the AI search (which
 * runs thousands of these per turn) possible at all.
 *
 * Units: metres, seconds, radians. Every ball has mass 1, so an impulse IS a velocity delta.
 * Frame: the cloth is the XY plane with the origin at a corner and z up. A ball centre rides
 * at height R, so cloth contact is at -R z while the cushion nose is ABOVE the centre — that
 * offset is the entire reason english works.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaromPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var G = 9.81;

  /** Playing surface in metres. Carom tables have no pockets. */
  var TABLES = {
    large: { w: 2.84, h: 1.42 },   // international, three-cushion
    medium: { w: 2.54, h: 1.27 },  // the size Korean four-ball is usually played on
  };

  var DEFAULTS = {
    R: 0.03075,          // carom ball radius (61.5 mm across)
    muSlide: 0.20,       // cloth, while the contact patch is still skidding
    muRoll: 0.010,       // rolling resistance once it grips
    muSpin: 0.044,       // decay of spin about the vertical axis
    eBall: 0.94,         // ball to ball restitution
    muBall: 0.06,        // ball to ball friction — this is what produces throw
    eCushion: 0.80,      // ball to cushion restitution
    muCushion: 0.20,     // ball to cushion friction — this is what makes english bite
    noseHeight: 1.27,    // cushion nose height in units of R (0.635 x diameter, the standard)
    stopV: 0.004,        // m/s under which a ball is parked
    stopW: 0.40,         // rad/s
    dt: 1 / 240,
    maxTime: 25,
    maxTipOffset: 0.5,   // how far from centre the tip may sit, in R, before it miscues
  };

  function len(x, y) { return Math.sqrt(x * x + y * y); }

  /**
   * Velocity of the cloth contact patch. Zero means the ball has stopped skidding and is
   * rolling; every phase decision below keys off this one quantity.
   */
  function contactVel(b, R) {
    return [b.v[0] - R * b.w[1], b.v[1] + R * b.w[0]];
  }

  /** Force the spin that pure rolling implies, so the roll phase stays self-consistent. */
  function snapRoll(b, R) {
    b.w[1] = b.v[0] / R;
    b.w[0] = -b.v[1] / R;
  }

  function integrateRoll(b, k, dt) {
    var s = len(b.v[0], b.v[1]);
    if (s < 1e-9) { b.v[0] = 0; b.v[1] = 0; return; }
    var dec = k.muRoll * G;
    var h = Math.min(dt, s / dec);
    var ux = b.v[0] / s, uy = b.v[1] / s;
    b.p[0] += b.v[0] * h - 0.5 * dec * ux * h * h;
    b.p[1] += b.v[1] * h - 0.5 * dec * uy * h * h;
    b.v[0] -= dec * ux * h;
    b.v[1] -= dec * uy * h;
    snapRoll(b, k.R);
  }

  /**
   * Advance one ball against the cloth for dt.
   *
   * Sliding has a closed form: the contact-patch velocity keeps its direction and shrinks
   * linearly at (7/2)*mu*g, so the moment it becomes a roll is found exactly rather than
   * stumbled past. Vertical spin decays on its own clock — that is why english is still
   * alive when the ball reaches the cushion, and why a ball can sit still and keep spinning.
   */
  function integrateCloth(b, k, dt) {
    var R = k.R;
    var u = contactVel(b, R);
    var us = len(u[0], u[1]);

    if (us > 1e-7) {
      var ux = u[0] / us, uy = u[1] / us;
      var tSlide = 2 * us / (7 * k.muSlide * G);
      var h = Math.min(dt, tSlide);
      var a = k.muSlide * G;
      b.p[0] += b.v[0] * h - 0.5 * a * ux * h * h;
      b.p[1] += b.v[1] * h - 0.5 * a * uy * h * h;
      b.v[0] -= a * ux * h;
      b.v[1] -= a * uy * h;
      var aw = (5 * a) / (2 * R);
      b.w[0] += aw * (-uy) * h;
      b.w[1] += aw * (ux) * h;
      if (h < dt) { snapRoll(b, R); integrateRoll(b, k, dt - h); }
    } else {
      snapRoll(b, R);
      integrateRoll(b, k, dt);
    }

    var az = (5 * k.muSpin * G) / (2 * R) * dt;
    if (Math.abs(b.w[2]) <= az) b.w[2] = 0;
    else b.w[2] -= (b.w[2] > 0 ? 1 : -1) * az;
  }

  function isStopped(b, k) {
    return len(b.v[0], b.v[1]) < k.stopV && Math.abs(b.w[2]) < k.stopW;
  }

  /**
   * Ball on ball. The normal part is ordinary restitution; the tangential part is where
   * carom lives. Relative surface speed along the tangent picks up R*wz from BOTH balls (a
   * vertical-axis spin shows up at the contact point as purely tangential motion), and the
   * Coulomb-capped impulse opposing it is throw and spin transfer in a single term.
   */
  function collideBalls(a, b, k) {
    var nx = b.p[0] - a.p[0], ny = b.p[1] - a.p[1];
    var d = len(nx, ny) || 1e-9;
    var ux = nx / d, uy = ny / d;
    var tx = -uy, ty = ux;

    var vn = (b.v[0] - a.v[0]) * ux + (b.v[1] - a.v[1]) * uy;
    if (vn >= 0) return 0;

    var jn = -(1 + k.eBall) * vn / 2;

    var st = (b.v[0] - a.v[0]) * tx + (b.v[1] - a.v[1]) * ty - k.R * (a.w[2] + b.w[2]);
    var jt = -st / 7;
    var cap = k.muBall * jn;
    if (jt > cap) jt = cap; else if (jt < -cap) jt = -cap;

    var jx = jn * ux + jt * tx, jy = jn * uy + jt * ty;
    a.v[0] -= jx; a.v[1] -= jy;
    b.v[0] += jx; b.v[1] += jy;

    // An in-plane impulse on the equator can only twist a ball about the vertical axis.
    var dwz = -5 * jt / (2 * k.R);
    a.w[2] += dwz; b.w[2] += dwz;
    return -vn;   // closing speed — the renderer scales the click with it
  }

  /**
   * Ball on cushion. The nose sits 0.27R ABOVE the centre, so the impulse has a vertical
   * lever arm: the normal part trades follow/draw against rebound speed, and the tangential
   * part turns wz into a change of angle. Put the nose at the equator instead and english
   * becomes cosmetic — the usual tell of a generic engine.
   */
  function collideCushion(b, k, nx, ny) {
    var vn = b.v[0] * nx + b.v[1] * ny;
    if (vn >= 0) return 0;
    var tx = -ny, ty = nx;

    var cz = (k.noseHeight - 1) * k.R;
    var horiz = Math.sqrt(Math.max(0, k.R * k.R - cz * cz));
    var cx = -nx * horiz, cy = -ny * horiz;

    var jn = -(1 + k.eCushion) * vn;

    // surface velocity at the contact point = v + w x c, projected on the tangent
    var sx = b.v[0] + (b.w[1] * 0 - b.w[2] * cy);
    var sy = b.v[1] + (b.w[2] * cx - b.w[0] * 0);
    var st = sx * tx + sy * ty;
    var jt = -(2 / 7) * st;
    var cap = k.muCushion * jn;
    if (jt > cap) jt = cap; else if (jt < -cap) jt = -cap;

    var jx = jn * nx + jt * tx, jy = jn * ny + jt * ty;
    b.v[0] += jx; b.v[1] += jy;

    var iw = 5 / (2 * k.R * k.R);
    b.w[0] += iw * (-cz * jy);
    b.w[1] += iw * (cz * jx);
    b.w[2] += iw * (cx * jy - cy * jx);
    return -vn;
  }

  /**
   * balls: [{ id, p:[x,y] }] — everything starts at rest.
   * Rails are named so the rule layer can count cushions without knowing any geometry.
   */
  function createWorld(opts) {
    opts = opts || {};
    var k = {};
    for (var key in DEFAULTS) k[key] = DEFAULTS[key];
    if (opts.constants) for (var c in opts.constants) k[c] = opts.constants[c];
    var table = opts.table || TABLES.large;

    return {
      k: k,
      table: { w: table.w, h: table.h },
      balls: (opts.balls || []).map(function (b) {
        return { id: b.id, p: [b.p[0], b.p[1]], v: [0, 0], w: [0, 0, 0] };
      }),
    };
  }

  function ballIndex(world, id) {
    for (var i = 0; i < world.balls.length; i++) if (world.balls[i].id === id) return i;
    return -1;
  }

  function ball(world, id) {
    var i = ballIndex(world, id);
    return i < 0 ? null : world.balls[i];
  }

  /**
   * Put a cue impulse on one ball.
   *
   * side and vert are the tip's offset from centre as a fraction of R: side > 0 is right
   * english, vert > 0 is follow. Past maxTipOffset the tip would slide off the ball, so this
   * reports a miscue rather than quietly delivering spin no cue could produce.
   */
  function shoot(world, ballId, shot) {
    var k = world.k, R = k.R;
    var b = ball(world, ballId);
    if (!b) throw new Error('unknown ball: ' + ballId);

    var a = shot.side || 0, h = shot.vert || 0;
    var off = len(a, h);
    if (off > k.maxTipOffset) return { miscue: true, offset: off };

    var dx = Math.cos(shot.angle), dy = Math.sin(shot.angle);
    var v0 = shot.speed;
    b.v[0] = dx * v0; b.v[1] = dy * v0;

    // t is the horizontal axis to the left of the aim line. The tip offset twists the ball
    // about it (follow/draw) and about the vertical axis (english).
    var tx = -dy, ty = dx;
    var g = (5 * v0) / (2 * R);
    b.w[0] = g * h * tx;
    b.w[1] = g * h * ty;
    b.w[2] = -g * a;
    return { miscue: false };
  }

  /**
   * Run until every ball is at rest (or maxTime). Returns the ordered contact log — the rule
   * layer reads only this, so four-ball and three-cushion share one simulator.
   *
   * trace: optional per-step sampler for the renderer or for debugging.
   */
  function rails(world) {
    var R = world.k.R, W = world.table.w, H = world.table.h;
    return [
      { n: [1, 0], name: 'left', axis: 0, at: R, sign: 1 },
      { n: [-1, 0], name: 'right', axis: 0, at: W - R, sign: -1 },
      { n: [0, 1], name: 'bottom', axis: 1, at: R, sign: 1 },
      { n: [0, -1], name: 'top', axis: 1, at: H - R, sign: -1 },
    ];
  }

  function anyMoving(world) {
    for (var i = 0; i < world.balls.length; i++) {
      if (!isStopped(world.balls[i], world.k)) return true;
    }
    return false;
  }

  /**
   * One integration + collision pass. simulate() is a loop over this, and the renderer and
   * the tests drive it directly — so there is exactly one place where a step is defined.
   * Returns the contacts that happened during this step (t is relative, callers add their own).
   */
  function step(world, dt, out) {
    var k = world.k, R = k.R, bs = world.balls;
    var hits = out || [];

    for (var m = 0; m < bs.length; m++) {
      if (isStopped(bs[m], k)) { bs[m].v[0] = 0; bs[m].v[1] = 0; }
      else integrateCloth(bs[m], k, dt);
    }

    // Resolve after integrating. At 240 Hz a ball covers about 2 cm per step against a 6 cm
    // diameter, so overlap-then-separate is stable; positions are pushed apart before the
    // impulse so a deep overlap cannot latch two balls together.
    var rs = rails(world);
    for (var r = 0; r < rs.length; r++) {
      var ra = rs[r];
      for (var q = 0; q < bs.length; q++) {
        var bb = bs[q];
        var over = ra.sign > 0 ? (ra.at - bb.p[ra.axis]) : (bb.p[ra.axis] - ra.at);
        if (over > 0) {
          bb.p[ra.axis] += ra.sign * over;
          var sp = collideCushion(bb, k, ra.n[0], ra.n[1]);
          if (sp) hits.push({ type: 'cushion', ball: bb.id, rail: ra.name, speed: sp });
        }
      }
    }

    for (var x = 0; x < bs.length; x++) {
      for (var y = x + 1; y < bs.length; y++) {
        var A = bs[x], B = bs[y];
        var ddx = B.p[0] - A.p[0], ddy = B.p[1] - A.p[1];
        var dd = len(ddx, ddy);
        if (dd < 2 * R && dd > 1e-9) {
          var push = (2 * R - dd) / 2;
          var pux = ddx / dd, puy = ddy / dd;
          A.p[0] -= pux * push; A.p[1] -= puy * push;
          B.p[0] += pux * push; B.p[1] += puy * push;
          var sp2 = collideBalls(A, B, k);
          if (sp2) hits.push({ type: 'ball', a: A.id, b: B.id, speed: sp2 });
        }
      }
    }
    return hits;
  }

  function simulate(world, opts) {
    opts = opts || {};
    var k = world.k, bs = world.balls;
    var events = [];
    var t = 0, dt = k.dt;
    var trace = opts.trace ? [] : null;
    var traceEvery = opts.traceEvery || 4;
    var nstep = 0;

    while (t < k.maxTime) {
      if (!anyMoving(world)) break;

      var hits = step(world, dt);
      t += dt; nstep++;
      for (var hi = 0; hi < hits.length; hi++) { hits[hi].t = t; events.push(hits[hi]); }

      if (trace && nstep % traceEvery === 0) {
        var f = [t];
        for (var s2 = 0; s2 < bs.length; s2++) {
          f.push(bs[s2].p[0], bs[s2].p[1], bs[s2].v[0], bs[s2].v[1]);
        }
        trace.push(f);
      }
    }

    for (var z = 0; z < bs.length; z++) { bs[z].v[0] = 0; bs[z].v[1] = 0; bs[z].w = [0, 0, 0]; }
    return { events: events, duration: t, settled: t < k.maxTime, trace: trace };
  }

  return {
    G: G, TABLES: TABLES, DEFAULTS: DEFAULTS,
    createWorld: createWorld, shoot: shoot, simulate: simulate, step: step,
    ball: ball, ballIndex: ballIndex, contactVel: contactVel, anyMoving: anyMoving,
  };
});
