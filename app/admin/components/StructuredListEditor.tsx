'use client';

/**
 * StructuredListEditor — a settings list a person can read, with the JSON one toggle away.
 *
 * The trades and strategies settings were raw JSON textareas: fifty rows of rules nobody could
 * scan, and one missing comma away from silence. This renders the same stored string as cards —
 * dropdowns for the closed vocabularies, a sentence for each rule — while the JSON view stays a
 * first-class citizen for hand editing.
 *
 * One source of truth: the parsed array. Form edits re-serialize immediately; JSON edits parse on
 * every keystroke and propagate only while valid — broken JSON freezes the form at the last valid
 * state and says so, it never reaches the save path.
 *
 * The form only rewrites keys it knows. Anything else on an item — measured records, fields newer
 * than this editor — survives every edit untouched (the reconciler rule: what you cannot see, you
 * do not delete).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Copy, ChevronDown, ChevronRight, Braces, LayoutList } from 'lucide-react';
import { useTranslations } from '../../../lib/i18n';

type Item = Record<string, any>;
type Kind = 'trades' | 'strategies';

/**
 * A config-declared card layout. When a module ships one (`settings_fields[].editorSchema`),
 * the cards render from it and the hardcoded TradeCard/StrategyCard below become the fallback
 * for configs that predate the declaration — adding a field to a module's data shape becomes a
 * config edit, not a frontend build.
 */
export interface EditorFieldDef {
  key: string;                       // dotted (one level) reaches nested objects
  label: string;                     // human-facing, written in the module's config
  type: 'text' | 'textarea' | 'secret' | 'number' | 'toggle' | 'select' | 'ref' | 'json' | 'rules';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;                // empty — or outside `options` — blocks the save path
  placeholder?: string;
  span?: number;                     // grid columns (1..3); `rules` always takes the full row
  showWhen?: { key: string; in: string[] };
  source?: string;                   // ref only: sibling settings field whose item ids feed the dropdown
}
export interface EditorSchema {
  fields: EditorFieldDef[];
  summary?: string[];                // keys whose values compose the collapsed row line
  newItem?: Item;
}

const OPS = ['crossUp', 'crossDown', '>', '<', '>=', '<='];
const OPERAND_HINTS = ['close', 'open', 'high', 'low', 'volume', 'rsi', 'ma5', 'ma10', 'ma20',
  'ma60', 'ema3', 'ema10', 'ema60', 'macd.line', 'macd.signal', 'bollinger.upper',
  'bollinger.lower', 'slope10', 'disp20'];

function parseItems(text: string): Item[] | null {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function ser(items: Item[]): string {
  return JSON.stringify(items, null, 2);
}

/** Set a (possibly dotted) key, dropping it entirely when the value is empty. */
function withKey(item: Item, key: string, value: any): Item {
  const next = { ...item };
  const drop = value === '' || value === undefined || value === null
    || (Array.isArray(value) && value.length === 0);
  if (key.includes('.')) {
    const [head, tail] = key.split('.', 2);
    const sub = { ...(next[head] ?? {}) };
    if (drop) delete sub[tail]; else sub[tail] = value;
    if (Object.keys(sub).length === 0) delete next[head]; else next[head] = sub;
    return next;
  }
  if (drop) delete next[key]; else next[key] = value;
  return next;
}

function getKey(item: Item, key: string): any {
  if (!key.includes('.')) return item[key];
  const [head, tail] = key.split('.', 2);
  return (item[head] ?? {})[tail];
}

// ── small field helpers ──────────────────────────────────────────────────────────────────────

const INPUT_CLS = 'w-full px-2 py-1 bg-white border border-slate-300 rounded text-[12px] '
  + 'focus:outline-none focus:ring-1 focus:ring-blue-500';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-bold text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function TextField({ item, k, label, onSet, placeholder, list }: {
  item: Item; k: string; label: string; onSet: (k: string, v: any) => void;
  placeholder?: string; list?: string;
}) {
  return (
    <Row label={label}>
      <input type="text" value={getKey(item, k) ?? ''} placeholder={placeholder} list={list}
        onChange={e => onSet(k, e.target.value)} className={INPUT_CLS} />
    </Row>
  );
}

/** Multi-line text. A single-line input is the wrong shape for anything written in sentences —
 *  a per-site writing instruction scrolls sideways in one and cannot be read back. */
function AreaField({ item, k, label, onSet, placeholder }: {
  item: Item; k: string; label: string; onSet: (k: string, v: any) => void; placeholder?: string;
}) {
  return (
    <Row label={label}>
      <textarea value={getKey(item, k) ?? ''} placeholder={placeholder} rows={5}
        onChange={e => onSet(k, e.target.value)} className={`${INPUT_CLS} resize-y leading-relaxed`} />
    </Row>
  );
}

/** A stored credential. The value lives in the row like every other setting — the vault holds
 *  them all — so this masks the SCREEN, which is what a password over someone's shoulder needs.
 *  Revealing is one click because an application password is pasted, mistyped and re-checked. */
function SecretField({ item, k, label, onSet, placeholder }: {
  item: Item; k: string; label: string; onSet: (k: string, v: any) => void; placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <Row label={label}>
      <div className="flex items-center gap-1">
        <input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false}
          value={getKey(item, k) ?? ''} placeholder={placeholder}
          onChange={e => onSet(k, e.target.value)} className={`${INPUT_CLS} flex-1 font-mono`} />
        <button type="button" onClick={() => setShow(v => !v)}
          className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs text-slate-600
            hover:bg-slate-50">
          {show ? '가리기' : '보기'}
        </button>
      </div>
    </Row>
  );
}

function NumField({ item, k, label, onSet }: {
  item: Item; k: string; label: string; onSet: (k: string, v: any) => void;
}) {
  const v = getKey(item, k);
  return (
    <Row label={label}>
      <input type="number" value={v ?? ''} step="any"
        onChange={e => onSet(k, e.target.value === '' ? '' : Number(e.target.value))}
        className={INPUT_CLS} />
    </Row>
  );
}

function BoolField({ item, k, label, onSet }: {
  item: Item; k: string; label: string; onSet: (k: string, v: any) => void;
}) {
  const v = getKey(item, k);
  return (
    <label className="flex items-end gap-1.5 pb-1.5 cursor-pointer">
      <input type="checkbox" checked={v !== false} onChange={e => onSet(k, e.target.checked)}
        className="w-3.5 h-3.5 rounded border-slate-300" />
      <span className="text-[11px] text-slate-600">{label}</span>
    </label>
  );
}

function SelectField({ item, k, label, onSet, options }: {
  item: Item; k: string; label: string; onSet: (k: string, v: any) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const v = String(getKey(item, k) ?? '');
  const known = options.some(o => o.value === v);
  return (
    <Row label={label}>
      <select value={v} onChange={e => onSet(k, e.target.value)} className={INPUT_CLS}>
        {!known && <option value={v}>{v || '—'}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Row>
  );
}

// ── rules ────────────────────────────────────────────────────────────────────────────────────

function ruleSentence(rule: Item, t: (k: string, p?: any) => string): string {
  const conds = (rule.when ?? []).map((c: Item) => {
    const op = String(c.op ?? '?');
    const opText = op === 'crossUp' ? t('structured.op_cross_up')
      : op === 'crossDown' ? t('structured.op_cross_down') : op;
    return `${c.a ?? '?'} ${opText} ${c.b ?? '?'}`;
  }).join(t('structured.and'));
  const side = rule.side === 'buy' ? t('structured.buy') : t('structured.sell');
  return conds ? t('structured.rule_sentence', { conds, side }) : side;
}

function RulesEditor({ rules, onChange, t }: {
  rules: Item[]; onChange: (r: Item[]) => void; t: (k: string, p?: any) => string;
}) {
  const set = (i: number, rule: Item) => onChange(rules.map((r, j) => (j === i ? rule : r)));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-bold text-slate-500">{t('structured.rules')}</span>
      {rules.map((rule, i) => (
        <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-2 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <select value={rule.side ?? 'buy'} className={`${INPUT_CLS} !w-auto`}
              onChange={e => set(i, { ...rule, side: e.target.value })}>
              <option value="buy">{t('structured.buy')}</option>
              <option value="sell">{t('structured.sell')}</option>
            </select>
            <input type="text" value={rule.label ?? ''} placeholder={t('structured.rule_label')}
              onChange={e => set(i, { ...rule, label: e.target.value || undefined })}
              className={`${INPUT_CLS} flex-1`} />
            <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))}
              className="text-slate-400 hover:text-red-500 shrink-0" aria-label={t('structured.remove')}>
              <Trash2 size={13} />
            </button>
          </div>
          {(rule.when ?? []).map((c: Item, ci: number) => (
            <div key={ci} className="flex items-center gap-1.5">
              <input type="text" value={c.a ?? ''} list="sle-operands" placeholder="a"
                onChange={e => set(i, { ...rule, when: rule.when.map((x: Item, xi: number) => (xi === ci ? { ...x, a: e.target.value } : x)) })}
                className={INPUT_CLS} />
              <select value={c.op ?? '>'}
                onChange={e => set(i, { ...rule, when: rule.when.map((x: Item, xi: number) => (xi === ci ? { ...x, op: e.target.value } : x)) })}
                className={`${INPUT_CLS} !w-auto`}>
                {OPS.map(op => <option key={op} value={op}>{op}</option>)}
              </select>
              <input type="text" value={c.b ?? ''} list="sle-operands" placeholder="b"
                onChange={e => set(i, { ...rule, when: rule.when.map((x: Item, xi: number) => (xi === ci ? { ...x, b: e.target.value } : x)) })}
                className={INPUT_CLS} />
              <button type="button"
                onClick={() => set(i, { ...rule, when: rule.when.filter((_: Item, xi: number) => xi !== ci) })}
                className="text-slate-300 hover:text-red-500 shrink-0" aria-label={t('structured.remove')}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button type="button"
            onClick={() => set(i, { ...rule, when: [...(rule.when ?? []), { a: '', op: '>', b: '' }] })}
            className="self-start text-[11px] text-blue-600 hover:text-blue-700 font-bold">
            + {t('structured.add_condition')}
          </button>
          <p className="text-[10px] text-slate-500">{ruleSentence(rule, t)}</p>
        </div>
      ))}
      <button type="button"
        onClick={() => onChange([...rules, { side: 'buy', when: [{ a: '', op: '>', b: '' }] }])}
        className="self-start text-[11px] text-blue-600 hover:text-blue-700 font-bold">
        + {t('structured.add_rule')}
      </button>
    </div>
  );
}

/** A nested value with no dedicated editor yet — editable as compact JSON, never dropped. */
function JsonSubField({ item, k, label, onSet }: {
  item: Item; k: string; label: string; onSet: (k: string, v: any) => void;
}) {
  const current = getKey(item, k);
  const [text, setText] = useState(current === undefined ? '' : JSON.stringify(current));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(current === undefined ? '' : JSON.stringify(current));
    setBad(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(current)]);
  return (
    <Row label={label}>
      <input type="text" value={text}
        onChange={e => {
          setText(e.target.value);
          if (e.target.value.trim() === '') { setBad(false); onSet(k, ''); return; }
          try { onSet(k, JSON.parse(e.target.value)); setBad(false); }
          catch { setBad(true); }
        }}
        className={`${INPUT_CLS} font-mono ${bad ? '!border-red-400' : ''}`} />
    </Row>
  );
}

// ── item cards ───────────────────────────────────────────────────────────────────────────────

// The two words a trade may use for its book. A trade carrying anything else — including nothing
// — is stopped by the engine, so the editor refuses to write one.
const MODES = ['ledger', 'live'];

/** Trades that cannot be saved, by id (or position when unnamed). */
function missingMode(items: Item[], kind: Kind): string[] {
  if (kind !== 'trades') return [];
  return items.flatMap((it, i) =>
    MODES.includes(String(it.mode ?? '')) ? [] : [String(it.id || `#${i + 1}`)]);
}

/**
 * Rows the save path must refuse, named with the fields that block them. The generalisation of
 * `missingMode`: a schema field marked `required` blocks when empty, and when it declares a
 * closed vocabulary, a value outside it blocks too — the same gate that kept a blank trade mode
 * from quietly meaning live, now available to any declared field.
 */
function blockedByRequired(items: Item[], schema: EditorSchema): string[] {
  const required = (schema.fields ?? []).filter(f => f.required);
  if (required.length === 0) return [];
  return items.flatMap((it, i) => {
    const bad = required.filter(f => {
      const v = getKey(it, f.key);
      const s = v === undefined || v === null ? '' : String(v);
      if (s === '') return true;
      return Array.isArray(f.options) && f.options.length > 0
        && !f.options.some(o => o.value === s);
    });
    return bad.length
      ? [`${String(it.id || `#${i + 1}`)} (${bad.map(f => f.label).join(', ')})`]
      : [];
  });
}

/** The one save gate, schema-aware: declared `required` fields when a schema exists,
 *  the legacy mode check otherwise. */
function blockedItems(items: Item[], kind: Kind, schema?: EditorSchema | null): string[] {
  if (schema?.fields?.length) return blockedByRequired(items, schema);
  return missingMode(items, kind);
}

function MeasuredNote({ item, t }: { item: Item; t: (k: string, p?: any) => string }) {
  if (item._measured == null) return null;
  return (
    <div className="rounded-md bg-slate-50 px-2 py-1.5 text-[10px] text-slate-500">
      <span className="font-bold">{t('structured.measured')}</span>{' '}
      {String((item._measured as any)?.note ?? JSON.stringify(item._measured)).slice(0, 300)}
    </div>
  );
}

function SchemaCard({ item, onSet, schema, refIds, t }: {
  item: Item; onSet: (k: string, v: any) => void; schema: EditorSchema;
  refIds: (source: string) => string[]; t: (k: string, p?: any) => string;
}) {
  const visible = (schema.fields ?? []).filter(f =>
    !f.showWhen || f.showWhen.in.includes(String(getKey(item, f.showWhen.key) ?? '')));
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {visible.map(f => {
          const span = f.type === 'rules' || f.span === 3 ? 'col-span-2 sm:col-span-3'
            : f.span === 2 ? 'col-span-2' : '';
          if (f.type === 'rules') {
            return (
              <div key={f.key} className="col-span-2 sm:col-span-3">
                <RulesEditor rules={getKey(item, f.key) ?? []}
                  onChange={r => onSet(f.key, r)} t={t} />
              </div>
            );
          }
          if (f.type === 'json') {
            return (
              <div key={f.key} className={span}>
                <JsonSubField item={item} k={f.key} label={f.label} onSet={onSet} />
              </div>
            );
          }
          if (f.type === 'toggle') {
            return (
              <div key={f.key} className={span}>
                <BoolField item={item} k={f.key} label={f.label} onSet={onSet} />
              </div>
            );
          }
          if (f.type === 'number') {
            return (
              <div key={f.key} className={span}>
                <NumField item={item} k={f.key} label={f.label} onSet={onSet} />
              </div>
            );
          }
          if (f.type === 'textarea') {
            return (
              <div key={f.key} className={span}>
                <AreaField item={item} k={f.key} label={f.label} onSet={onSet}
                  placeholder={f.placeholder} />
              </div>
            );
          }
          if (f.type === 'secret') {
            return (
              <div key={f.key} className={span}>
                <SecretField item={item} k={f.key} label={f.label} onSet={onSet}
                  placeholder={f.placeholder} />
              </div>
            );
          }
          if (f.type === 'select' || f.type === 'ref') {
            const options = f.type === 'ref'
              ? [{ value: '', label: '—' },
                 ...refIds(f.source ?? '').map(id => ({ value: id, label: id }))]
              : (f.options ?? []);
            return (
              <div key={f.key} className={span}>
                <SelectField item={item} k={f.key} label={f.label} onSet={onSet}
                  options={options} />
              </div>
            );
          }
          return (
            <div key={f.key} className={span}>
              <TextField item={item} k={f.key} label={f.label} onSet={onSet}
                placeholder={f.placeholder} />
            </div>
          );
        })}
      </div>
      <MeasuredNote item={item} t={t} />
    </div>
  );
}

function TradeCard({ item, onSet, t }: {
  item: Item; onSet: (k: string, v: any) => void; t: (k: string, p?: any) => string;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      <TextField item={item} k="id" label="id" onSet={onSet} />
      <TextField item={item} k="strategy" label={t('structured.strategy_ref')} onSet={onSet} />
      <TextField item={item} k="symbol" label={t('structured.symbol')} onSet={onSet} />
      <TextField item={item} k="broker" label={t('structured.broker')} onSet={onSet} />
      <TextField item={item} k="account" label={t('structured.account')} onSet={onSet} />
      <TextField item={item} k="interval" label={t('structured.interval')} onSet={onSet} placeholder="5m / 1h / 1d" />
      {/* No blank option: this is the field that decides whether real money moves, so "unset" is
          not one of the answers. A row that arrives without one is caught by `missingMode` below
          and cannot be saved. */}
      <SelectField item={item} k="mode" label={t('structured.mode')} onSet={onSet}
        options={[...(MODES.includes(String(item.mode ?? '')) ? [] : [{ value: '', label: '—' }]),
          { value: 'ledger', label: t('structured.mode_ledger') },
          { value: 'live', label: t('structured.mode_live') }]} />
      <SelectField item={item} k="state" label={t('structured.state')} onSet={onSet}
        options={[{ value: '', label: t('structured.state_on') },
          { value: 'pauseEntries', label: t('structured.state_pause') },
          { value: 'off', label: t('structured.state_off') }]} />
      <SelectField item={item} k="market" label={t('structured.market')} onSet={onSet}
        options={[{ value: '', label: '—' }, { value: 'kr', label: 'kr' },
          { value: 'us', label: 'us' }, { value: 'crypto', label: 'crypto' }]} />
      <NumField item={item} k="maxSymbols" label={t('structured.max_symbols')} onSet={onSet} />
      <NumField item={item} k="money.perOrderKrw" label={t('structured.per_order')} onSet={onSet} />
      <NumField item={item} k="limits.maxPositionKrw" label={t('structured.max_position')} onSet={onSet} />
      <div className="col-span-2 sm:col-span-3">
        <JsonSubField item={item} k="symbols" label={t('structured.symbols_list')} onSet={onSet} />
      </div>
    </div>
  );
}

function StrategyCard({ item, onSet, t }: {
  item: Item; onSet: (k: string, v: any) => void; t: (k: string, p?: any) => string;
}) {
  const uni = item.universe ?? {};
  const uniType = String(uni.type ?? '');
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <TextField item={item} k="id" label="id" onSet={onSet} />
        <BoolField item={item} k="enabled" label={t('structured.enabled')} onSet={onSet} />
        {/* The timeframe these rules were measured on. The trade still decides what runs — but a
            trade that names none inherits this, and one that names a different bar gets a gate
            warning, because rules measured on 4h bars and traded on 5m bars were measured on
            something else. */}
        <TextField item={item} k="interval" label={t('structured.interval_measured')} onSet={onSet}
          placeholder="5m / 1h / 4h / 1d" />
        <TextField item={item} k="symbol" label={t('structured.symbol')} onSet={onSet} />
        <TextField item={item} k="broker" label={t('structured.broker')} onSet={onSet} />
        <TextField item={item} k="account" label={t('structured.account')} onSet={onSet} />
        <NumField item={item} k="money.perOrderKrw" label={t('structured.per_order')} onSet={onSet} />
        <NumField item={item} k="limits.maxPositionKrw" label={t('structured.max_position')} onSet={onSet} />
        <NumField item={item} k="money.lotSize" label={t('structured.lot_size')} onSet={onSet} />
        <TextField item={item} k="note" label={t('structured.note')} onSet={onSet} />
        <NumField item={item} k="exits.stopLossPct" label={t('structured.stop_loss')} onSet={onSet} />
        <NumField item={item} k="exits.takeProfitPct" label={t('structured.take_profit')} onSet={onSet} />
        <SelectField item={item} k="orders.type" label={t('structured.order_type')} onSet={onSet}
          options={[{ value: '', label: '—' }, { value: 'limit', label: 'limit' },
            { value: 'market', label: 'market' }]} />
        <NumField item={item} k="orders.limitOffsetPct" label={t('structured.limit_offset')} onSet={onSet} />
        <NumField item={item} k="holding.maxHoldMinutes" label={t('structured.max_hold')} onSet={onSet} />
        <NumField item={item} k="holding.closeBeforeEndMin" label={t('structured.close_before_end')} onSet={onSet} />
        <SelectField item={item} k="universe.type" label={t('structured.universe')} onSet={onSet}
          options={[{ value: '', label: t('structured.universe_none') },
            { value: 'fixed', label: t('structured.universe_fixed') },
            { value: 'rank', label: t('structured.universe_rank') },
            { value: 'condition', label: t('structured.universe_condition') }]} />
        {uniType === 'fixed' && (
          <div className="col-span-2">
            <JsonSubField item={item} k="universe.symbols" label={t('structured.universe_symbols')} onSet={onSet} />
          </div>
        )}
        {uniType === 'rank' && (
          <NumField item={item} k="universe.top" label={t('structured.universe_top')} onSet={onSet} />
        )}
        {uniType === 'condition' && (
          <TextField item={item} k="universe.name" label={t('structured.universe_name')} onSet={onSet} />
        )}
      </div>
      <RulesEditor rules={item.rules ?? []} onChange={r => onSet('rules', r)} t={t} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <JsonSubField item={item} k="orders.marketWhen" label={t('structured.market_when')} onSet={onSet} />
        <JsonSubField item={item} k="exits.scaleOut" label="scaleOut" onSet={onSet} />
        <JsonSubField item={item} k="exits.scaleIn" label="scaleIn" onSet={onSet} />
      </div>
      <MeasuredNote item={item} t={t} />
    </div>
  );
}

function summaryOf(
  item: Item, kind: Kind, t: (k: string, p?: any) => string, schema?: EditorSchema | null,
): string {
  if (schema?.summary?.length) {
    return schema.summary.map(k => {
      const v = getKey(item, k);
      if (v === undefined || v === null || v === '') return null;
      const opt = schema.fields?.find(f => f.key === k)?.options
        ?.find(o => o.value === String(v));
      if (opt) return opt.label;
      return Array.isArray(v) ? v.join(',') : String(v);
    }).filter(Boolean).join(' · ');
  }
  if (kind === 'trades') {
    const parts = [item.symbol ?? (Array.isArray(item.symbols) ? item.symbols.join(',') : ''),
      item.broker, item.account || null, item.interval,
      item.mode === 'ledger' ? t('structured.mode_ledger') : item.mode === 'live' ? t('structured.mode_live') : item.mode,
      item.state === 'off' ? t('structured.state_off') : item.state === 'pauseEntries' ? t('structured.state_pause') : null,
      item.strategy ? `→ ${item.strategy}` : null];
    return parts.filter(Boolean).join(' · ');
  }
  const n = (item.rules ?? []).length;
  const first = n ? ruleSentence(item.rules[0], t) : '';
  return [item.interval, n > 1 ? t('structured.rules_count', { n }) : first,
    item.universe?.type ? `${t('structured.universe')}: ${item.universe.type}` : null,
    item.note].filter(Boolean).join(' · ');
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

export function StructuredListEditor({ value, onChange, kind, schema, siblings }: {
  value: string; onChange: (text: string) => void; kind: Kind;
  /** Config-declared card layout (`settings_fields[].editorSchema`) — wins over `kind`. */
  schema?: EditorSchema | null;
  /** The sibling settings values, for `ref` fields that pick from another list's ids. */
  siblings?: Record<string, any>;
}) {
  const t = useTranslations();
  const [view, setView] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState(value ?? '[]');
  const [jsonBad, setJsonBad] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const lastPropagated = useRef(value ?? '[]');

  // The parent's value moved under us (load finished, another field's save round-trip).
  useEffect(() => {
    if ((value ?? '') !== lastPropagated.current) {
      lastPropagated.current = value ?? '[]';
      setJsonText(value ?? '[]');
      setJsonBad(false);
    }
  }, [value]);

  const items = useMemo(() => parseItems(jsonBad ? lastPropagated.current : jsonText) ?? [],
    [jsonText, jsonBad]);

  // Rows the parent must not be told about yet. Same shape as a broken JSON document: the edit
  // stays on screen so it can be finished, and the value the save button writes is the last one
  // that was whole. A trade with no mode used to save fine and then place live orders off the
  // engine's blank default (measured 2026-08-08) — this is the door that should have been shut.
  const blocked = useMemo(() => blockedItems(items, kind, schema), [items, kind, schema]);

  // `ref` fields pick from another settings list's ids — the trade card's strategy dropdown.
  const refIds = (source: string): string[] => {
    const raw = siblings?.[source];
    const arr = typeof raw === 'string' ? parseItems(raw) : Array.isArray(raw) ? raw : null;
    return (arr ?? []).map(x => String((x as Item)?.id ?? '')).filter(Boolean);
  };

  const propagate = (next: Item[]) => {
    const text = ser(next);
    setJsonText(text);
    setJsonBad(false);
    if (blockedItems(next, kind, schema).length > 0) return;
    lastPropagated.current = text;
    onChange(text);
  };

  const setItem = (i: number, next: Item) => propagate(items.map((x, j) => (j === i ? next : x)));

  return (
    <div className="flex flex-col gap-2">
      <datalist id="sle-operands">
        {OPERAND_HINTS.map(o => <option key={o} value={o} />)}
      </datalist>
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          <button type="button" onClick={() => setView('form')}
            className={`flex items-center gap-1 px-2 py-1 text-[11px] font-bold ${view === 'form' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
            <LayoutList size={12} /> {t('structured.view_form')}
          </button>
          <button type="button" onClick={() => setView('json')}
            className={`flex items-center gap-1 px-2 py-1 text-[11px] font-bold ${view === 'json' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
            <Braces size={12} /> JSON
          </button>
        </div>
        <span className="text-[11px] text-slate-400 font-medium">
          {t('structured.count', { n: items.length })}
        </span>
        {jsonBad && (
          <span className="text-[11px] text-red-500 font-bold">{t('structured.json_invalid')}</span>
        )}
        {!jsonBad && blocked.length > 0 && (
          <span className="text-[11px] text-red-500 font-bold">
            {schema?.fields?.length
              ? t('structured.required_missing', { ids: blocked.join(', ') })
              : t('structured.mode_required', { ids: blocked.join(', ') })}
          </span>
        )}
      </div>

      {view === 'json' ? (
        <textarea value={jsonText} rows={14} spellCheck={false}
          onChange={e => {
            setJsonText(e.target.value);
            const parsed = parseItems(e.target.value);
            if (parsed) {
              setJsonBad(false);
              // Hand-edited JSON is the other way a row loses a required field, so it meets the
              // same gate as the form — otherwise the strict card is a door next to an open window.
              if (blockedItems(parsed, kind, schema).length === 0) {
                lastPropagated.current = e.target.value;
                onChange(e.target.value);
              }
            } else {
              setJsonBad(true);
            }
          }}
          className={`w-full px-3 py-2 bg-white border rounded-lg text-[12px] font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 ${jsonBad ? 'border-red-400' : 'border-slate-300'}`} />
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((item, i) => {
            const expanded = open.has(i);
            return (
              <div key={i} className="rounded-xl border border-slate-200 bg-white">
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <button type="button"
                    onClick={() => setOpen(prev => {
                      const next = new Set(prev);
                      next.has(i) ? next.delete(i) : next.add(i);
                      return next;
                    })}
                    className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                    {expanded ? <ChevronDown size={13} className="shrink-0 text-slate-400" />
                      : <ChevronRight size={13} className="shrink-0 text-slate-400" />}
                    <span className="text-[12px] font-bold text-slate-700 shrink-0">
                      {item.id || t('structured.unnamed')}
                    </span>
                    <span className="text-[11px] text-slate-400 truncate">
                      {summaryOf(item, kind, t, schema)}
                    </span>
                  </button>
                  <button type="button" aria-label={t('structured.duplicate')}
                    onClick={() => propagate([...items.slice(0, i + 1),
                      { ...item, id: `${item.id ?? 'item'}-copy` }, ...items.slice(i + 1)])}
                    className="text-slate-300 hover:text-blue-600 shrink-0"><Copy size={13} /></button>
                  <button type="button" aria-label={t('structured.remove')}
                    onClick={() => propagate(items.filter((_, j) => j !== i))}
                    className="text-slate-300 hover:text-red-500 shrink-0"><Trash2 size={13} /></button>
                </div>
                {expanded && (
                  <div className="border-t border-slate-100 p-2.5">
                    {schema?.fields?.length
                      ? <SchemaCard item={item} onSet={(k, v) => setItem(i, withKey(item, k, v))}
                          schema={schema} refIds={refIds} t={t} />
                      : kind === 'trades'
                        ? <TradeCard item={item} onSet={(k, v) => setItem(i, withKey(item, k, v))} t={t} />
                        : <StrategyCard item={item} onSet={(k, v) => setItem(i, withKey(item, k, v))} t={t} />}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button"
            onClick={() => {
              propagate([...items, schema?.newItem
                ? JSON.parse(JSON.stringify(schema.newItem))
                : kind === 'trades'
                  ? { id: '', broker: '', account: '', mode: 'ledger' }
                  : { id: '', kind: 'rules', rules: [] }]);
              setOpen(prev => new Set(prev).add(items.length));
            }}
            className="flex items-center gap-1 self-start px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-[11px] font-bold text-slate-500 hover:border-blue-400 hover:text-blue-600">
            <Plus size={13} /> {t('structured.add_item')}
          </button>
        </div>
      )}
    </div>
  );
}
