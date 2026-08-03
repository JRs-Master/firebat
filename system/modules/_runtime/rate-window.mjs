/**
 * A request window that survives the process, shared by every broker dialect.
 *
 * The limit belongs to the credential, and every step of a scheduled cycle is its own process, so
 * an in-memory counter counts to one while a dozen siblings call at the same moment. Korea
 * Investment learned this on 2026-08-02 and got a file window; Kiwoom kept the array and therefore
 * had no limiter at all — thirty candle fetches in a cycle went out as fast as they could spawn,
 * and the venue answered 허용된 요청 개수를 초과하였습니다 (2026-08-03). Two copies of one idea,
 * only one of them fixed, which is the reason this now lives in one file.
 *
 * The window is a file of timestamps, one per line, beside the data. Appends of a few bytes do not
 * interleave, so the count stays honest without a lock — good enough for a speed limit, and a lock
 * across processes would be a worse trade than an occasional extra call.
 */
import fs from 'node:fs';
import path from 'node:path';

const WINDOW_MS = 1000;
// Never wedge a cycle on the limiter: past this many waits, go and let the venue decide.
const MAX_WAITS = 40;

function slotFile(name) {
  const dir = path.join(process.env['FIREBAT_DATA_DIR'] || 'data', 'ratelimit');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.log`);
}

/**
 * Wait until this credential is allowed another call within the window.
 *
 * `name` identifies the bucket — the venue plus whichever account the limit is counted against,
 * since a practice account and a live one are separate allowances.
 */
export async function acquireSlot(name, limit, windowMs = WINDOW_MS) {
  const file = slotFile(name);
  const cap = Math.max(1, Number(limit) || 1);
  for (let waits = 0; ; waits += 1) {
    const now = Date.now();
    let recent = [];
    try {
      recent = fs.readFileSync(file, 'utf-8').split('\n')
        .map(Number).filter(t => t > 0 && now - t < windowMs);
    } catch { /* first call — no file yet */ }
    if (recent.length < cap) {
      fs.appendFileSync(file, now + '\n');
      // Keep it from growing without bound; only the tail is ever read.
      if (Math.random() < 0.02) {
        try { fs.writeFileSync(file, recent.concat(now).join('\n') + '\n'); } catch { /* fine */ }
      }
      return;
    }
    // Jittered, so siblings woken by the same expiry do not all fire on the same tick.
    const wait = windowMs - (now - Math.min(...recent)) + 20 + Math.floor(Math.random() * 120);
    await new Promise(r => setTimeout(r, Math.min(wait, windowMs + 200)));
    if (waits > MAX_WAITS) return;
  }
}
