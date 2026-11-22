/**
 * Where a module setting lives — the declaration says, the settings screen obeys.
 *
 * A `settings_fields` row may declare `path` ("layout.header.show") when its value lives inside a
 * nested object instead of at the top level under its `key`. The screen keeps addressing the row by
 * `key` (labels, ids, lang files); only the stored place changes. Without this the screen saved every
 * nested CMS field as a flat key that no page ever read — 62 of 99 CMS fields did nothing (2026-11-23).
 *
 * Saving REPLACES the stored object (Rust `set_settings` = vault write), so `storedFromScreen` starts
 * from what was stored and only touches the declared places: values nobody declares (header rows,
 * sidebar mode, …) survive a save.
 *
 * Numeric path segments index arrays ("layout.footer.widgets.0").
 */

export type FieldFormat = 'label-href-lines';

/** One screen value ↔ one stored place. A field may expand into several (color overrides). */
export interface FieldPlace {
  /** key the screen holds the value under */
  screenKey: string;
  /** dot path of the stored value (top-level key when the field declares no path) */
  path: string;
  /** declared default — a screen value equal to it is not stored (the reader's default applies) */
  defaultValue?: unknown;
  /** declared codec between the screen value and the stored shape */
  format?: FieldFormat;
  /** the field declared a `path` — its old flat copy under `screenKey` is read once and dropped on save */
  movedFrom?: string;
}

type Obj = Record<string, unknown>;

const isIndex = (seg: string) => /^\d+$/.test(seg);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Obj)[seg];
  }
  return cur;
}

export function setPath(obj: Obj, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: Obj = obj;
  segs.forEach((seg, i) => {
    if (i === segs.length - 1) {
      cur[seg] = value;
      return;
    }
    const next = cur[seg];
    if (next === null || typeof next !== 'object') {
      cur[seg] = isIndex(segs[i + 1]) ? [] : {};
    }
    cur = cur[seg] as Obj;
  });
  // arrays grown by index leave holes — store them as null, never as missing slots
  fillHoles(obj, segs);
}

function fillHoles(obj: Obj, segs: string[]): void {
  let cur: unknown = obj;
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) if (cur[i] === undefined) cur[i] = null;
    }
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Obj)[seg];
  }
}

/** Remove the value at `path`. Array slots become null (positions are meaningful); objects lose the key. */
export function deletePath(obj: Obj, path: string): void {
  const segs = path.split('.');
  const parent = getPath(obj, segs.slice(0, -1).join('.')) as unknown;
  const holder = segs.length === 1 ? obj : parent;
  if (holder === null || typeof holder !== 'object') return;
  const last = segs[segs.length - 1];
  if (Array.isArray(holder) && isIndex(last)) {
    if (Number(last) < holder.length) holder[Number(last)] = null;
  } else {
    delete (holder as Obj)[last];
  }
}

/** Declared codecs — the screen edits text, the readers want a shape. */
export const FORMATS: Record<FieldFormat, { toStored(screen: unknown): unknown; toScreen(stored: unknown): unknown }> = {
  /** "label | href" per line ↔ [{label, href}] — the header nav links */
  'label-href-lines': {
    toStored(screen) {
      if (typeof screen !== 'string') return [];
      return screen
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [label, href] = line.split('|').map((s) => s.trim());
          return label && href ? { label, href } : null;
        })
        .filter((x): x is { label: string; href: string } => x !== null);
    },
    toScreen(stored) {
      if (typeof stored === 'string') return stored;
      if (!Array.isArray(stored)) return '';
      return stored
        .filter((x) => x && typeof x === 'object' && 'label' in x && 'href' in x)
        .map((x) => `${(x as { label: string }).label} | ${(x as { href: string }).href}`)
        .join('\n');
    },
  },
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Screen values from the stored object — declared places first, an old flat copy second. */
export function screenFromStored(places: FieldPlace[], stored: Obj): Obj {
  const screen: Obj = {};
  for (const p of places) if (p.defaultValue !== undefined) screen[p.screenKey] = p.defaultValue;
  // undeclared stored keys stay visible to the screen as before (modules that write ad-hoc keys)
  const placedPaths = new Set(places.filter((p) => !p.path.includes('.')).map((p) => p.path));
  const nestedRoots = new Set(places.filter((p) => p.path.includes('.')).map((p) => p.path.split('.')[0]));
  for (const [k, v] of Object.entries(stored)) {
    if (v === null || v === undefined) continue;
    if (placedPaths.has(k) || nestedRoots.has(k)) continue;
    screen[k] = v;
  }
  for (const p of places) {
    // an old flat copy is the user's last choice (the nested copy may only be the seeded default)
    const flat = p.movedFrom !== undefined ? stored[p.movedFrom] : undefined;
    const v = flat !== undefined && flat !== null ? flat : getPath(stored, p.path);
    if (v === undefined || v === null) continue;
    screen[p.screenKey] = p.format ? FORMATS[p.format].toScreen(v) : v;
  }
  return screen;
}

/** The object to store — what was stored, with every declared place set from the screen or cleared. */
export function storedFromScreen(places: FieldPlace[], screen: Obj, stored: Obj): Obj {
  const out = structuredClone(stored) as Obj;
  const placedKeys = new Set(places.map((p) => p.screenKey));
  for (const p of places) {
    if (p.movedFrom) delete out[p.movedFrom];
    const v = screen[p.screenKey];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '' && p.format === undefined && p.path.includes('.'));
    if (empty || (p.defaultValue !== undefined && same(v, p.defaultValue))) {
      deletePath(out, p.path);
    } else {
      setPath(out, p.path, p.format ? FORMATS[p.format].toStored(v) : v);
    }
  }
  // screen values no field declares (ad-hoc keys) keep the old rule: stored as they are
  for (const [k, v] of Object.entries(screen)) {
    if (placedKeys.has(k)) continue;
    if (v === undefined) continue;
    if (k in out && typeof out[k] === 'object' && out[k] !== null && same(out[k], v)) continue;
    out[k] = v;
  }
  return out;
}
