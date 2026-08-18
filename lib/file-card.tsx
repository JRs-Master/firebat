'use client';

import { createContext, useContext } from 'react';
import React from 'react';
import { Download, FileText } from 'lucide-react';

// ── The file card, shared by every surface that can be handed a document ──────────────────────
// It started life inside the admin markdown renderer (a bare `[x.xlsx](...)` link read as an
// afterthought — 2026-08-10 사용자: "다운로드가 허접"). It lives here because a second surface
// needs the SAME table: an `Image` render block whose src points at a .xlsx is not an image, and
// judging it by what the address can *do* (a document to download) instead of by what the block
// calls itself is the only way that case stops spinning forever on a loading placeholder.
// Office-format colors are semantics, not decoration (green IS excel to every reader), so they
// stand outside the blue/slate palette rule.
export const FILE_CARD_EXTS: Record<string, string> = {
  pptx: 'text-orange-700 bg-orange-50 border-orange-200',
  xlsx: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  docx: 'text-blue-700 bg-blue-50 border-blue-200',
  pdf: 'text-red-700 bg-red-50 border-red-200',
  hwpx: 'text-sky-700 bg-sky-50 border-sky-200',
  hwp: 'text-sky-700 bg-sky-50 border-sky-200',
  mid: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  // Karaoke lyric timing (sing's LRC lane) — neutral: lrc has no brand colour the way excel is
  // green, and purple-by-default is off the table.
  lrc: 'text-slate-600 bg-slate-100 border-slate-200',
};

/** Badge look for an extension the table above does not name. Slate — the palette's neutral;
 *  the coloured entries are semantics (green IS excel), not decoration, so an unknown type gets
 *  no colour rather than a borrowed one. */
const FILE_CARD_NEUTRAL = 'text-slate-600 bg-slate-100 border-slate-200';

export const AUDIO_PLAYER_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac']);

/** Last path segment of an address, percent-decoded, query/hash dropped. */
function baseNameOf(src: string): string {
  const base = src.split(/[?#]/)[0].split('/').pop() || '';
  try { return decodeURIComponent(base); } catch { return base; }
}

/** `file.tar.gz` → `{ name: 'file.tar', ext: 'gz' }`; no dot → `ext: ''`. */
function splitExt(base: string): { name: string; ext: string } {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return { name: base, ext: '' };
  return { name: base.slice(0, dot), ext: base.slice(dot + 1).toLowerCase() };
}

/** `{ name, ext }` when the address names a known document/file type, else null.
 *  Path-shape agnostic on purpose — the media route is where these come from today, but an
 *  address that ends in `.xlsx` is a document wherever it is hosted. Query/hash are stripped. */
export function documentTarget(src?: string | null): { name: string; ext: string } | null {
  if (typeof src !== 'string' || !src) return null;
  const { name, ext } = splitExt(baseNameOf(src));
  if (!ext || !FILE_CARD_EXTS[ext]) return null;
  return { name, ext };
}

/** Names the backend recorded for the files a turn produced, keyed by `fileAddressKey`.
 *
 *  A markdown link renders as a card too, and that card used to name itself from the URL — so the
 *  label AND the browser's download name were the storage slug (`…-f834.xlsx`) while the real
 *  name sat unused in `producedFiles` (2026-08-13 사용자 보고). The address is the join key; the
 *  provider is the message, so one bubble's files never name another's.
 */
export const ProducedNames = createContext<Map<string, string>>(new Map());

/** The recorded name for an address, or `null` when this turn produced no such file. */
export function useProducedName(href: string): string | null {
  const names = useContext(ProducedNames);
  if (!names.size) return null;
  return names.get(fileAddressKey(href)) ?? null;
}

/** Download card — one look for markdown file links and for document-pointing Image blocks. */
export function FileCard({ href, name, ext, block, flush }: {
  href: string;
  name: string;
  ext: string;
  /** true renders a <div>-free block-level card (fence/page context); the default `span`
   *  layout is safe inside markdown prose, where a <div> inside a <p> is invalid nesting. */
  block?: boolean;
  /** true drops the card's own vertical margin — for a parent that owns the spacing (a
   *  gap-based strip), where `my-1.5` would stack on top of the gap. */
  flush?: boolean;
}) {
  const label = ext ? `${name}.${ext}` : name;
  const margin = block ? 'my-1 mx-auto' : flush ? '' : 'my-1.5';
  return (
    <a
      href={href}
      download={label}
      className={`not-prose flex items-center gap-2.5 max-w-md px-3 py-2.5 rounded-xl border border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow transition-all group no-underline ${margin}`}
    >
      <span className={`shrink-0 w-10 h-10 rounded-lg border flex flex-col items-center justify-center ${FILE_CARD_EXTS[ext] ?? FILE_CARD_NEUTRAL}`}>
        <FileText size={15} />
        <span className="text-[8px] font-black tracking-wide leading-none mt-0.5">{(ext || 'file').toUpperCase()}</span>
      </span>
      <span className="min-w-0 flex-1 text-[13px] font-semibold text-slate-800 truncate">{label}</span>
      <Download size={16} className="shrink-0 text-slate-300 group-hover:text-blue-500 transition-colors" />
    </a>
  );
}

// ── Produced-file strip ───────────────────────────────────────────────────────────────────────
// Artifact truth must not depend on the model's prose. The backend stamps every file a turn
// really produced onto the assistant message, and this strip renders that list verbatim: a file
// that exists gets a card even when the model forgot to link it, and a turn that produced nothing
// shows nothing no matter what the answer claims (four fabricated-artifact turns measured the
// week of 2026-08-12 — a docx renamed to .pdf in prose, cards for files that were never written).
// The dedup below is what keeps the honest case from paying for it: a file the model DID link
// already renders as a card in the body, and must not appear a second time here.

/** One entry of the backend's `producedFiles`. `name`/`contentType` are advisory — the address
 *  is the only field the strip cannot do without. */
export type ProducedFile = { url: string; name?: string; contentType?: string };

/** Comparable identity for a file address: path only, percent-decoded, query/hash dropped. So
 *  `https://host/user/media/보고서.docx` and `/user/media/%EB%B3%B4%EA%B3%A0%EC%84%9C.docx` are
 *  one file — the body link and the backend record rarely spell it the same way. `''` = unusable. */
export function fileAddressKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let path = raw.trim();
  if (!path) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { /* not parseable — compare the raw form */ }
  }
  path = path.split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch { /* already decoded, or a stray % */ }
  return path;
}

// Only the forms the markdown pipeline actually turns into an anchor/image count as "already
// shown". A bare `/user/media/x.xlsx` typed into prose stays plain text (remark-gfm autolinks
// http(s)/www, not root-relative paths), so counting it would hide a file that really exists —
// the exact failure this feature was built to end. Code spans are stripped for the same reason.
const LINK_PATTERNS: RegExp[] = [
  /!?\]\(\s*<?([^)\s<>]+)/g,                 // [x](url) and ![x](url)
  /<((?:https?:\/\/|\/)[^>\s]+)>/g,          // <url> autolink
  /https?:\/\/[^\s<>()[\]"'`]+/g,            // bare autolinked url (whole match)
  /(?:href|src)\s*=\s*["']([^"']+)["']/gi,   // inline HTML — rehypeRaw renders these
];

/** Address keys the given markdown already renders as a link, image or card. */
export function renderedFileAddresses(text: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof text !== 'string' || !text) return out;
  const body = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const re of LINK_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const key = fileAddressKey(m[1] ?? m[0]);
      if (key) out.add(key);
    }
  }
  return out;
}

/** Deterministic card strip for the files a turn produced. Renders nothing when `files` is
 *  absent/empty or when every entry is already linked in the body — so a message without the
 *  field (every message written before this shipped) renders exactly as it did. */
export function ProducedFileStrip({ files, bodyText, shownAddresses }: {
  files: unknown;
  /** The message's own markdown (answer text + text blocks) — its links are deduped away. */
  bodyText?: string;
  /** Extra addresses the bubble already shows outside markdown (e.g. an Image block whose src
   *  is a .xlsx, which degrades to this very card). */
  shownAddresses?: Array<string | undefined>;
}) {
  const seen = renderedFileAddresses(bodyText);
  for (const a of shownAddresses ?? []) {
    const key = fileAddressKey(a);
    if (key) seen.add(key);
  }
  const cards: Array<{ key: string; href: string; name: string; ext: string }> = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const entry = raw as ProducedFile | null;
    const href = typeof entry?.url === 'string' ? entry.url.trim() : '';
    const key = fileAddressKey(href);
    // `seen` grows as we go, so a list that names the same file twice still yields one card.
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const fromUrl = splitExt(baseNameOf(href));
    const declared = typeof entry?.name === 'string' && entry.name.trim()
      ? splitExt(entry.name.trim())
      : null;
    const name = declared?.name || fromUrl.name || key;
    const ext = declared?.ext || fromUrl.ext || '';
    cards.push({ key, href, name, ext });
  }
  if (cards.length === 0) return null;
  return (
    <div className="not-prose flex flex-wrap gap-2">
      {cards.map(c => <FileCard key={c.key} href={c.href} name={c.name} ext={c.ext} flush />)}
    </div>
  );
}
