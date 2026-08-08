/**
 * function-plot — a safe evaluator and sampler for the `function_plot` component.
 *
 * The model declares a formula ("x^2", "2sin(x)+cos(2x)") and a range; every coordinate is
 * computed here on the client. That is the point of the component: a curve the model would
 * otherwise hand-sample from arithmetic it is not allowed to trust. No eval / new Function —
 * the expression is parsed into a closure tree by a tiny recursive-descent parser, so a hostile
 * or malformed string can only ever produce an error message.
 */

type Fn1 = (x: number) => number;

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
};

const CONSTS: Record<string, number> = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI };

type Tok =
  | { k: 'num'; v: number }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string };

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  const s = src.replace(/\s+/g, ' ');
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(s.slice(i));
      if (!m) return `숫자를 읽을 수 없습니다: "${s.slice(i, i + 8)}"`;
      out.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Zπ_]/.test(c)) {
      const m = /^[a-zA-Zπ_][a-zA-Z0-9_]*/.exec(s.slice(i))!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      out.push({ k: 'op', v: c });
      i++;
      continue;
    }
    // × · ÷ — models write these; read them as what they mean.
    if (c === '×' || c === '·') { out.push({ k: 'op', v: '*' }); i++; continue; }
    if (c === '÷') { out.push({ k: 'op', v: '/' }); i++; continue; }
    return `알 수 없는 문자: "${c}"`;
  }
  // Implicit multiplication: 2x, 2sin(x), x(x+1), (x+1)(x-1), 3π …
  // Inserted between [num | id | )] and [num | id | (], EXCEPT when the left id is a function
  // name directly followed by '(' — that is a call.
  const withMul: Tok[] = [];
  for (let j = 0; j < out.length; j++) {
    const t = out[j];
    if (withMul.length > 0) {
      const prev = withMul[withMul.length - 1];
      const prevEnds = prev.k === 'num' || (prev.k === 'op' && prev.v === ')')
        || (prev.k === 'id' && !(FUNCS[prev.v] && t.k === 'op' && t.v === '('));
      const curStarts = t.k === 'num' || t.k === 'id' || (t.k === 'op' && t.v === '(');
      if (prevEnds && curStarts) withMul.push({ k: 'op', v: '*' });
    }
    withMul.push(t);
  }
  return withMul;
}

/** Parse `src` into a function of x. Returns the closure or an error string. */
export function compileExpression(src: string): { fn?: Fn1; error?: string } {
  const cleaned = String(src ?? '')
    .trim()
    // "y = x^2" / "f(x) = …" — keep the right-hand side.
    .replace(/^[a-zA-Z]\s*\(\s*x\s*\)\s*=/, '')
    .replace(/^y\s*=/, '');
  if (!cleaned) return { error: '식이 비어 있습니다' };
  const toks = tokenize(cleaned);
  if (typeof toks === 'string') return { error: toks };

  let pos = 0;
  const peek = () => toks[pos];
  const eat = (v?: string): Tok | undefined => {
    const t = toks[pos];
    if (!t) return undefined;
    if (v !== undefined && !(t.k === 'op' && t.v === v)) return undefined;
    pos++;
    return t;
  };

  // precedence: expr(+-) > term(*/) > unary(-) > power(^, right-assoc) > atom
  function parseExpr(): Fn1 | string {
    let left = parseTerm();
    if (typeof left === 'string') return left;
    for (;;) {
      const t = peek();
      if (t && t.k === 'op' && (t.v === '+' || t.v === '-')) {
        pos++;
        const right = parseTerm();
        if (typeof right === 'string') return right;
        const l = left, op = t.v;
        left = op === '+' ? (x) => l(x) + right(x) : (x) => l(x) - right(x);
      } else return left;
    }
  }
  function parseTerm(): Fn1 | string {
    let left = parseUnary();
    if (typeof left === 'string') return left;
    for (;;) {
      const t = peek();
      if (t && t.k === 'op' && (t.v === '*' || t.v === '/')) {
        pos++;
        const right = parseUnary();
        if (typeof right === 'string') return right;
        const l = left, op = t.v;
        left = op === '*' ? (x) => l(x) * right(x) : (x) => l(x) / right(x);
      } else return left;
    }
  }
  function parseUnary(): Fn1 | string {
    if (eat('-')) {
      const inner = parseUnary();
      if (typeof inner === 'string') return inner;
      return (x) => -inner(x);
    }
    eat('+');
    return parsePower();
  }
  function parsePower(): Fn1 | string {
    const base = parseAtom();
    if (typeof base === 'string') return base;
    if (eat('^')) {
      // Right-associative, and the exponent may be signed: x^-2, 2^x^2 = 2^(x^2).
      const exp = parseUnary();
      if (typeof exp === 'string') return exp;
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }
  function parseAtom(): Fn1 | string {
    const t = peek();
    if (!t) return '식이 갑자기 끝났습니다';
    if (t.k === 'num') { pos++; const v = t.v; return () => v; }
    if (t.k === 'op' && t.v === '(') {
      pos++;
      const inner = parseExpr();
      if (typeof inner === 'string') return inner;
      if (!eat(')')) return '닫는 괄호가 없습니다';
      return inner;
    }
    if (t.k === 'id') {
      pos++;
      const name = t.v;
      if (name === 'x' || name === 't') return (x) => x;
      if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
      const f = FUNCS[name];
      if (f) {
        if (!eat('(')) return `${name} 은 함수입니다 — ${name}(x) 처럼 괄호가 필요합니다`;
        // min/max/pow take two arguments; everything else one.
        if (name === 'min' || name === 'max') {
          return `아직 지원하지 않는 함수입니다: ${name}`;
        }
        const arg = parseExpr();
        if (typeof arg === 'string') return arg;
        if (!eat(')')) return '닫는 괄호가 없습니다';
        return (x) => f(arg(x));
      }
      return `알 수 없는 이름: "${name}" (변수는 x, 함수는 sin/cos/tan/sqrt/exp/ln/log/abs 등)`;
    }
    return `여기서 "${(t as any).v}" 는 올 수 없습니다`;
  }

  const fn = parseExpr();
  if (typeof fn === 'string') return { error: fn };
  if (pos !== toks.length) {
    const rest = toks.slice(pos).map((t) => (t as any).v).join(' ');
    return { error: `해석 안 된 꼬리: "${rest}"` };
  }
  return { fn };
}

export type SampledSeries = {
  /** Segments of consecutive finite points — a break marks an asymptote or a domain hole. */
  segments: Array<Array<{ x: number; y: number }>>;
  yValues: number[];
};

/** Sample fn over [xMin,xMax]. Breaks at non-finite values and at asymptote-scale jumps. */
export function sampleFunction(fn: Fn1, xMin: number, xMax: number, n = 600): SampledSeries {
  const segments: Array<Array<{ x: number; y: number }>> = [];
  const yValues: number[] = [];
  let cur: Array<{ x: number; y: number }> = [];
  const step = (xMax - xMin) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const x = xMin + step * i;
    let y: number;
    try { y = fn(x); } catch { y = NaN; }
    if (!Number.isFinite(y)) {
      if (cur.length > 1) segments.push(cur);
      cur = [];
      continue;
    }
    yValues.push(y);
    cur.push({ x, y });
  }
  if (cur.length > 1) segments.push(cur);
  return { segments, yValues };
}

/** Cut sampled segments against a y window: far-out-of-view points are dropped, and a jump of
 *  asymptote scale (tan crossing ±∞ between two samples reads as one huge finite step) breaks
 *  the stroke — otherwise every branch of tan is joined by a vertical wall. */
export function viewSegments(
  sampled: SampledSeries, lo: number, hi: number,
): Array<Array<{ x: number; y: number }>> {
  const span = hi - lo;
  const jump = span * 1.5;
  const margin = span * 0.5;
  const out: Array<Array<{ x: number; y: number }>> = [];
  for (const seg of sampled.segments) {
    let cur: Array<{ x: number; y: number }> = [];
    let prevY: number | null = null;
    for (const pt of seg) {
      const off = pt.y < lo - margin || pt.y > hi + margin;
      const broke = prevY !== null && Math.abs(pt.y - prevY) > jump;
      if (off || broke) {
        if (cur.length > 1) out.push(cur);
        cur = off ? [] : [pt];
        prevY = off ? null : pt.y;
        continue;
      }
      cur.push(pt);
      prevY = pt.y;
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

/** The y window: declared bounds win; otherwise a percentile fit so tan() cannot flatten
 *  everything else into a line. */
export function fitYRange(
  all: number[], yMin?: number | null, yMax?: number | null,
): { lo: number; hi: number } {
  let lo = typeof yMin === 'number' ? yMin : NaN;
  let hi = typeof yMax === 'number' ? yMax : NaN;
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return { lo, hi };
  const ys = all.filter(Number.isFinite).sort((a, b) => a - b);
  if (ys.length === 0) return { lo: -1, hi: 1 };
  const q = (p: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.floor(p * (ys.length - 1))))];
  let a = q(0.02), b = q(0.98);
  if (!(b > a)) { a = ys[0] - 1; b = ys[ys.length - 1] + 1; }
  const pad = (b - a) * 0.08 || 1;
  if (!Number.isFinite(lo)) lo = a - pad;
  if (!Number.isFinite(hi)) hi = b + pad;
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  return { lo, hi };
}

/** "Nice" tick positions — 1/2/5 stepping, at most ~maxTicks of them. */
export function niceTicks(lo: number, hi: number, maxTicks = 8): number[] {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const rawStep = span / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  }
  return out;
}

/** Short label for a tick — trims float dust. */
export function tickLabel(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 10000 || a < 0.001) return v.toExponential(0);
  return String(Number(v.toPrecision(6)));
}
