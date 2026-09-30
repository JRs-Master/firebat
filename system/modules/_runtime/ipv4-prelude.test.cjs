/**
 * The Node prelude against local sockets — no network, run by CI Modules (`node <this file>`,
 * with `undici` at the version package-lock pins).
 *
 * What it holds the prelude to: a connection that cannot be made is tried once more and the
 * failure names the phase it stopped in; a retry that works is still written down; a failure that
 * would repeat is not retried; `fetch failed` carries its cause.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { Agent, buildConnector, fetch: undiciFetch } = require('undici');
const prelude = require('./ipv4-prelude.cjs');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function closedPort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((resolve) => s.close(resolve));
  return port;
}

test('which failures get a second attempt', () => {
  const code = (c) => Object.assign(new Error(c), { code: c });
  assert.equal(prelude.retryable(code('UND_ERR_CONNECT_TIMEOUT')), true);
  assert.equal(prelude.retryable(code('ECONNREFUSED')), true);
  assert.equal(prelude.retryable(code('ECONNRESET')), true);
  assert.equal(prelude.retryable(code('EAI_AGAIN')), true);
  assert.equal(prelude.retryable(code('ENOTFOUND')), false);
  assert.equal(prelude.retryable(code('ERR_TLS_CERT_ALTNAME_INVALID')), false);
  assert.equal(prelude.retryable(code('CERT_HAS_EXPIRED')), false);
});

test('a refused connection is tried twice and the module sees why, through the global fetch', async () => {
  const port = await closedPort();
  const err = await fetch(`http://localhost:${port}/`).then(() => null, (e) => e);
  assert.ok(err, 'the fetch should fail');
  assert.match(err.message, /^fetch failed — ECONNREFUSED: /);
  assert.match(err.message, /\[connect 2\/2: #1 ECONNREFUSED after \d+ms \(dns \d+ms 127\.0\.0\.1, tcp not done\) · #2 ECONNREFUSED/);
});

test('a TLS handshake that never finishes is named as the phase that ran out', async () => {
  const held = [];
  const server = net.createServer((s) => held.push(s)); // accepts, never answers
  const port = await listen(server);
  const lines = [];
  const agent = new Agent({ connect: prelude.makeConnector({ timeout: 300, log: (l) => lines.push(l) }) });
  try {
    const err = await undiciFetch(`https://localhost:${port}/`, { dispatcher: agent }).then(() => null, (e) => e);
    assert.ok(err && err.cause, 'the fetch should fail with a cause');
    assert.equal(err.cause.code, 'UND_ERR_CONNECT_TIMEOUT');
    assert.match(err.cause.message, /\[connect 2\/2: #1 UND_ERR_CONNECT_TIMEOUT after \d+ms \(dns \d+ms 127\.0\.0\.1, tcp \d+ms, tls not done\) · #2 UND_ERR_CONNECT_TIMEOUT/);
    assert.equal(lines.filter((l) => l.includes('failed:')).length, 2, lines.join('\n'));
    assert.match(prelude.explain(err).message, /^fetch failed — UND_ERR_CONNECT_TIMEOUT: /);
  } finally {
    held.forEach((s) => s.destroy());
    await agent.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a second attempt that connects still leaves the first one in the log', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const port = await listen(server);
  const real = buildConnector({ family: 4, timeout: 1000 });
  let calls = 0;
  const flaky = (opts, cb) => {
    calls += 1;
    if (calls > 1) return real(opts, cb);
    const socket = new EventEmitter();
    setImmediate(() => cb(Object.assign(new Error('Connect Timeout Error (test)'), { code: 'UND_ERR_CONNECT_TIMEOUT' })));
    return socket;
  };
  const lines = [];
  const agent = new Agent({ connect: prelude.makeConnector({ base: flaky, log: (l) => lines.push(l) }) });
  try {
    const res = await undiciFetch(`http://localhost:${port}/`, { dispatcher: agent });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(calls, 2);
    assert.match(lines[0], /attempt 1\/2 failed: #1 UND_ERR_CONNECT_TIMEOUT/);
    assert.match(lines[1], /connected on attempt 2\/2: #2 ok after \d+ms \(dns \d+ms 127\.0\.0\.1, tcp \d+ms\) — after #1 UND_ERR_CONNECT_TIMEOUT/);
  } finally {
    await agent.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a quick clean connect writes nothing', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const port = await listen(server);
  const lines = [];
  const agent = new Agent({ connect: prelude.makeConnector({ log: (l) => lines.push(l) }) });
  try {
    const res = await undiciFetch(`http://localhost:${port}/`, { dispatcher: agent });
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(lines, []);
  } finally {
    await agent.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a failure that would repeat is not tried again', async () => {
  let calls = 0;
  const bad = (opts, cb) => {
    calls += 1;
    setImmediate(() => cb(Object.assign(new Error('Hostname/IP does not match certificate'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })));
    return new EventEmitter();
  };
  const connect = prelude.makeConnector({ base: bad, log: () => {} });
  const err = await new Promise((resolve) => connect({ hostname: 'example.test', protocol: 'https:', port: 443 }, (e) => resolve(e)));
  assert.equal(calls, 1);
  assert.match(err.message, /\[connect 1\/2: #1 ERR_TLS_CERT_ALTNAME_INVALID/);
});

test('only "fetch failed" is rewritten, and only with its cause', () => {
  const failed = new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(prelude.explain(failed).message, 'fetch failed — UND_ERR_SOCKET: other side closed');
  const aborted = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(prelude.explain(aborted).message, 'The operation was aborted due to timeout');
  const bare = new TypeError('fetch failed');
  assert.equal(prelude.explain(bare).message, 'fetch failed');
});
