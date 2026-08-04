/**
 * US order price units — shared by every module that places a US stock order.
 *
 * The venue states the rule in its own refusal: "미국주식 주문/정정/STOP 단가는 $1 미만은 소수점
 * 4자리, $1 이상은 소수점 2자리까지 입력 가능합니다" — kiwoom, 2026-08-05, on `ord_uv 497.041665`.
 * The price was not wrong, it was written with too many decimals: a 0.6% offset applied to 497.04
 * produces six of them, and nothing on the way out was cutting them off. KRX prices went through
 * `roundToKrxTick`; the overseas path had no equivalent and sent `String(price)` raw.
 *
 * Kept out of both dialects for the same reason the KRX table is: two brokers reaching the same
 * exchange cannot be allowed to disagree about its units, and a caller of the neutral contract must
 * not have to know them at all.
 */

/** The price step at `price`: a cent at a dollar or more, a hundredth of a cent below. */
export function usTick(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 0.01;
  return p >= 1 ? 0.01 : 0.0001;
}

/**
 * `price` written to a legal number of decimals, in the direction that cannot cost more than the
 * strategy asked for — a buy rounds down, a sell rounds up. Same rule as the KRX helper: rounding
 * corrects something the strategy did not decide, so it must not push the order further across the
 * spread than it intended.
 *
 * Returns a string, because that is what the venues take and because a rounded float carries its
 * own noise: 497.041665 floored to a cent is 497.04000000000005 as a number, which puts the extra
 * decimals straight back.
 */
export function usOrderPrice(price, side) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return String(price);
  const tick = usTick(p);
  const places = tick === 0.01 ? 2 : 4;
  const scale = Math.round(1 / tick);
  const down = String(side).toLowerCase() !== 'sell';
  let out = (down ? Math.floor(p * scale) : Math.ceil(p * scale)) / scale;
  // Rounding a sub-dollar price up can cross into the dollar band, where fewer decimals are legal.
  if (out >= 1 && places === 4) return out.toFixed(2);
  if (out <= 0) out = tick;                       // never round a buy to nothing
  return out.toFixed(places);
}
