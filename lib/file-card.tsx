'use client';

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
};

export const AUDIO_PLAYER_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac']);

/** `{ name, ext }` when the address names a known document/file type, else null.
 *  Path-shape agnostic on purpose — the media route is where these come from today, but an
 *  address that ends in `.xlsx` is a document wherever it is hosted. Query/hash are stripped. */
export function documentTarget(src?: string | null): { name: string; ext: string } | null {
  if (typeof src !== 'string' || !src) return null;
  const path = src.split(/[?#]/)[0];
  const base = path.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!FILE_CARD_EXTS[ext]) return null;
  const stem = base.slice(0, dot);
  let name = stem;
  try { name = decodeURIComponent(stem); } catch { /* keep the raw stem */ }
  return { name, ext };
}

/** Download card — one look for markdown file links and for document-pointing Image blocks. */
export function FileCard({ href, name, ext, block }: {
  href: string;
  name: string;
  ext: string;
  /** true renders a <div>-free block-level card (fence/page context); the default `span`
   *  layout is safe inside markdown prose, where a <div> inside a <p> is invalid nesting. */
  block?: boolean;
}) {
  return (
    <a
      href={href}
      download={`${name}.${ext}`}
      className={`not-prose flex items-center gap-2.5 max-w-md px-3 py-2.5 rounded-xl border border-slate-200 bg-white shadow-sm hover:border-blue-300 hover:shadow transition-all group no-underline ${block ? 'my-1 mx-auto' : 'my-1.5'}`}
    >
      <span className={`shrink-0 w-10 h-10 rounded-lg border flex flex-col items-center justify-center ${FILE_CARD_EXTS[ext]}`}>
        <FileText size={15} />
        <span className="text-[8px] font-black tracking-wide leading-none mt-0.5">{ext.toUpperCase()}</span>
      </span>
      <span className="min-w-0 flex-1 text-[13px] font-semibold text-slate-800 truncate">{name}.{ext}</span>
      <Download size={16} className="shrink-0 text-slate-300 group-hover:text-blue-500 transition-colors" />
    </a>
  );
}
