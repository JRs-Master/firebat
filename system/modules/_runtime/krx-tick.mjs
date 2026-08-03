/**
 * KRX quote units — shared by every module that places a Korean stock order.
 *
 * A limit price that is not a multiple of the band's unit is refused outright: the venue answered
 * `모의투자 주문처리가 안되었습니다(호가단위 오류)` and the order sat unconfirmed until it aged out
 * (2026-08-03, 셀트리온 at 187,260.1 — a 0.3% offset applied to a whole-won price). Truncating to
 * an integer is not enough; 187,260 is just as invalid as 187,260.1 in a hundred-won band.
 *
 * The table is the exchange's, effective 2023-01-30, and the same for KOSPI and KOSDAQ. Checked
 * against live quotes on the day this was written: 키이스트 1,255 (unit 1), 셀트리온 186,700
 * (100), 삼성전자 241,500 (500), SK하이닉스 1,588,000 (1,000) — every one a multiple of its band.
 *
 * Kept out of the trading module on purpose: what a venue will accept is the venue's vocabulary,
 * and the caller of a neutral contract must not have to know it. Kept out of each dialect too,
 * because two brokers reaching the same exchange cannot be allowed to disagree about its ticks.
 */

// [under this price, unit]. The last band has no ceiling.
const BANDS = [
  [2000, 1],
  [5000, 5],
  [20000, 10],
  [50000, 50],
  [200000, 100],
  [500000, 500],
];
const TOP_UNIT = 1000;

/** The quote unit that applies at `price`. */
export function krxTick(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 1;
  for (const [ceiling, unit] of BANDS) {
    if (p < ceiling) return unit;
  }
  return TOP_UNIT;
}

/**
 * `price` moved to a valid quote, in the direction that cannot cost more than was intended.
 *
 * A buy rounds down and a sell rounds up: rounding is a correction to something the strategy did
 * not decide, so it must never push the order further across the spread than the strategy asked
 * for. The unit is taken from the rounded result as well as the raw one — a price sitting just
 * above a band edge would otherwise round with the wrong unit and land off-grid again.
 */
export function roundToKrxTick(price, side) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return p;
  const down = String(side).toLowerCase() !== 'sell';
  let unit = krxTick(p);
  let out = down ? Math.floor(p / unit) * unit : Math.ceil(p / unit) * unit;
  const settled = krxTick(out);
  if (settled !== unit) {
    unit = settled;
    out = down ? Math.floor(p / unit) * unit : Math.ceil(p / unit) * unit;
  }
  // Never round a buy to nothing.
  return out > 0 ? out : unit;
}
