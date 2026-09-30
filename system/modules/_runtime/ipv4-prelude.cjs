/**
 * Node sysmod prelude — preloaded into every Node module process (`--require`, from infra
 * sandbox.rs, which names this file; the name is older than what it does now).
 *
 * Everything here is about the one thing every module does and none of them should have to think
 * about: opening a connection. It is done once, for all of them, with no module code involved.
 *
 * 1. IPv4 only. Some hosts answer both A and AAAA, and when this server's IPv6 route dropped,
 *    undici tried v6, timed out and said `fetch failed` where curl fell back to v4 at once
 *    (api.telegram.org). `--dns-result-order=ipv4first` does not reach undici's connector;
 *    `family: 4` on the connector does. A v6-only host would be unreachable — none is called.
 *
 * 2. A connection that could not be made is made once more, and every failed attempt says where
 *    it stopped. The three failures on record (Kiwoom 2026-09-10 and 09-29, Toss 09-30) were each
 *    ~10 s and each said only `fetch failed`: undici's connect timeout, which covers the name
 *    lookup, the TCP handshake and the TLS handshake alike, and a message with the reason left in
 *    `cause`, which the dialects drop. Each attempt now records when its lookup, TCP and TLS
 *    finished — or that they did not — and a failure carries those numbers.
 *
 *    Retrying here cannot duplicate a request, an order included: undici writes the request only
 *    after the connector hands it a connected socket, so a failed connect has sent nothing.
 *    A certificate problem or a name that does not exist fails the same way twice and is not
 *    retried.
 *
 *    A retry that works is a symptom, not a cure. Every failed attempt, a connect that needed a
 *    second try, and a connect slower than SLOW_MS are written to stderr, which the sandbox
 *    journals with the call — the cause of an intermittent failure is read from those lines, and
 *    a fault that is really there fails the second attempt too.
 *
 * 3. `fetch` is wrapped for one thing only: its `TypeError('fetch failed')` keeps the reason in
 *    `cause`, and a module that reports `e.message` reported half a sentence. The message now
 *    carries the cause's code and text.
 */
'use strict';

const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { Agent, setGlobalDispatcher, buildConnector } = require('undici');

// Per attempt, where undici's default is 10 s for the one attempt it makes. Two attempts fit inside
// the 15 s the dialects give a whole request, and a lookup that the resolver answers from its
// second server (glibc waits 5 s on the first) still lands inside one.
const CONNECT_TIMEOUT_MS = 7000;
const ATTEMPTS = 2;
// A connect to the venues this server calls takes tens of milliseconds. One over this is written
// down even when it succeeds: the slow ones are what the failures are made of.
const SLOW_MS = 2000;

// Codes that come out the same on a second try.
const FINAL_CODES = new Set([
  'ENOTFOUND',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function retryable(err) {
  const code = String((err && err.code) || '');
  return !FINAL_CODES.has(code) && !code.startsWith('ERR_TLS_') && !code.startsWith('ERR_SSL_');
}

/** One attempt, each phase timed from the moment the socket was asked for. */
function attempt(base, opts) {
  return new Promise((resolve) => {
    const t = {
      start: performance.now(),
      literal: net.isIP(String(opts.hostname || '')) !== 0,
      tls: opts.protocol === 'https:',
    };
    let socket;
    try {
      socket = base(opts, (err, connected) => {
        t.end = performance.now();
        resolve({ err, socket: connected, t });
      });
    } catch (err) {
      t.end = performance.now();
      resolve({ err, socket: null, t });
      return;
    }
    if (!socket || typeof socket.once !== 'function') return;
    socket.once('lookup', (err, address) => {
      t.lookup = performance.now();
      if (err) t.lookupError = err.code || err.message;
      else if (address) t.address = Array.isArray(address) ? address.map((a) => a.address || a).join('|') : address;
    });
    socket.once('connect', () => { t.tcp = performance.now(); });
    socket.once('secureConnect', () => { t.handshake = performance.now(); });
  });
}

/** Where an attempt got to: "dns 3ms 23.192.191.203, tcp 6ms, tls not done". */
function phases(t) {
  const at = (x) => `${Math.round(x - t.start)}ms`;
  const out = [];
  if (t.literal) out.push('dns skipped');
  else if (t.lookup == null) out.push('dns not done');
  else out.push(`dns ${at(t.lookup)} ${t.lookupError || t.address || ''}`.trim());
  if (t.literal || (t.lookup != null && !t.lookupError)) {
    out.push(t.tcp == null ? 'tcp not done' : `tcp ${at(t.tcp)}`);
    if (t.tls && t.tcp != null) out.push(t.handshake == null ? 'tls not done' : `tls ${at(t.handshake)}`);
  }
  return out.join(', ');
}

/** "#1 UND_ERR_CONNECT_TIMEOUT after 7002ms (dns 3ms 23.192.191.203, tcp 6ms, tls not done)" */
function describeAttempt(n, r) {
  const what = r.err ? (r.err.code || r.err.name || 'error') : 'ok';
  return `#${n} ${what} after ${Math.round(r.t.end - r.t.start)}ms (${phases(r.t)})`;
}

/**
 * An undici connector that makes up to `attempts` connections, each with its own `timeout`.
 * `base` and `log` are parameters so the same code can be exercised against local sockets.
 */
function makeConnector({
  timeout = CONNECT_TIMEOUT_MS,
  attempts = ATTEMPTS,
  slowMs = SLOW_MS,
  base = buildConnector({ family: 4, timeout }),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  return function connect(opts, callback) {
    const where = `${opts.hostname}:${opts.port || (opts.protocol === 'https:' ? 443 : 80)}`;
    const failed = [];
    (async () => {
      for (let n = 1; n <= attempts; n += 1) {
        const r = await attempt(base, opts);
        if (!r.err) {
          const took = r.t.end - r.t.start;
          if (failed.length || took > slowMs) {
            log(`[net] ${where} connected on attempt ${n}/${attempts}: ${describeAttempt(n, r)}`
              + (failed.length ? ` — after ${failed.map((f, i) => describeAttempt(i + 1, f)).join(' · ')}` : ''));
          }
          callback(null, r.socket);
          return;
        }
        failed.push(r);
        log(`[net] ${where} attempt ${n}/${attempts} failed: ${describeAttempt(n, r)}`);
        if (!retryable(r.err)) break;
      }
      const last = failed[failed.length - 1].err;
      const summary = failed.map((f, i) => describeAttempt(i + 1, f)).join(' · ');
      try {
        last.message = `${last.message} [connect ${failed.length}/${attempts}: ${summary}]`;
      } catch { /* a frozen error keeps its message; the stderr lines above still say it */ }
      callback(last);
    })().catch((err) => callback(err));
  };
}

/** `fetch failed` with its cause spelled out, so a module that returns `e.message` says why. */
function explain(e) {
  const cause = e && e.cause;
  if (!cause || !e || e.name !== 'TypeError' || e.message !== 'fetch failed') return e;
  const code = cause.code || cause.name;
  try {
    e.message = `fetch failed — ${code ? `${code}: ` : ''}${cause.message || String(cause)}`;
  } catch { /* keep the original */ }
  return e;
}

setGlobalDispatcher(new Agent({ connect: makeConnector() }));

const nativeFetch = globalThis.fetch;
if (typeof nativeFetch === 'function') {
  globalThis.fetch = function fetch(input, init) {
    return nativeFetch.call(globalThis, input, init).catch((e) => { throw explain(e); });
  };
}

module.exports = { makeConnector, explain, retryable, describeAttempt, CONNECT_TIMEOUT_MS, ATTEMPTS, SLOW_MS };
