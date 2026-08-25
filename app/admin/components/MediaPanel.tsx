'use client';

import { useId, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Modal } from './Modal';
import { useQuery } from '@tanstack/react-query';
import { Search, Loader2, X, Copy, Trash2, Image as ImageIcon, Sparkles, Calendar, Ruler, Crop, ChevronLeft, ChevronRight, AlertTriangle, RefreshCw, Upload, Music, FileText, File as FileIcon, Film, FolderOpen, Download } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { useTranslations } from '../../../lib/i18n';
import { AudioTransport } from '../../../lib/audio-transport';
import { FeedbackBadge } from './FeedbackBadge';
import { confirmDialog, alertDialog } from './Dialog';
import { useEvents } from '../hooks/events-manager';
import { useViewportSize } from '../../../lib/use-viewport-size';
import { apiGet, apiPost, apiDelete } from '../../../lib/api-fetch';
import { copyText } from '../../../lib/clipboard';

interface MediaItem {
  slug: string;
  ext: string;
  contentType: string;
  bytes: number;
  width?: number;
  height?: number;
  createdAt: number;
  scope?: 'user' | 'system';
  filenameHint?: string;
  prompt?: string;
  revisedPrompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  variants?: Array<{ width: number; height?: number; format: string; url: string; bytes: number }>;
  thumbnailUrl?: string;
  blurhash?: string;
  aspectRatio?: string;
  focusPoint?: 'attention' | 'entropy' | 'center' | { x: number; y: number };
  /** Unset (legacy) is treated as 'done'. */
  status?: 'rendering' | 'done' | 'error';
  errorMsg?: string;
}

const PAGE_SIZE = 48;

/** Content type + extension → panel kind. Same vocabulary as the Rust list filter
 *  (`media_kind_of` in infra/src/adapters/media.rs) — **두 벌이니 한쪽만 고치지 말 것.**
 *  `music` 은 종류가 아니라 묶음(음원 ∪ 악보 ∪ 가사)이라 아이콘 표에는 없다. */
type MediaKind = 'image' | 'video' | 'audio' | 'score' | 'lyrics' | 'document' | 'other';
type KindChip = MediaKind | 'music' | 'all' | 'generated' | 'clipart' | 'photo';
const DOC_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.hancom.hwpx',
  'application/haansofthwpx',
  'application/hwp+zip',
]);
// 우리 포맷은 **확장자가 정한다** — 주장된 타입이 못 미덥다(실측: .mxl 하나가
// application/octet-stream 으로, .mid 는 audio/mid 와 audio/midi 로 갈려 들어와 있었다).
const SCORE_EXTS = new Set(['mid', 'midi', 'mxl', 'musicxml']);
function kindOf(contentType: string, ext?: string): MediaKind {
  const e = (ext || '').toLowerCase();
  if (SCORE_EXTS.has(e)) return 'score';
  if (e === 'lrc') return 'lyrics';
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/') || e === 'mp4' || e === 'm4v' || e === 'mov') return 'video';
  if (ct.startsWith('audio/') || ct === 'application/ogg') return 'audio';
  if (DOC_CONTENT_TYPES.has(ct)) return 'document';
  return 'other';
}
const MUSIC_KINDS: KindChip[] = ['music', 'audio', 'score', 'lyrics'];
const IMAGE_KINDS: KindChip[] = ['image', 'generated', 'clipart', 'photo'];

/** 악보 미리듣기 — 브라우저엔 MIDI 신디사이저가 없어서, 소리는 이쪽에서 만들어야 한다.
 *  굽는 엔진은 sing 이 렌더에 쓰는 바로 그것이라 **여기서 들리는 것이 곧 렌더 결과**다.
 *  같은 파일은 한 번만 굽는다(모듈이 해시로 이름 붙여 두고 다음엔 그것을 찾는다). */
function ScorePreview({ path, t }: { path: string; t: (k: string) => string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'ready' | 'error'>('idle');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { setState('idle'); setUrl(''); setErr(''); }, [path]);
  const listen = async () => {
    setState('busy'); setErr('');
    try {
      const res = await fetch('/api/module/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: 'sing', data: { action: 'preview', path } }),
      });
      const j = await res.json();
      // 구운 파일은 media 로 들어오고(첫 번째), 이미 있던 것이면 url 이 바로 온다.
      const got = j?.data?.url
        || (Array.isArray(j?.data?.media) ? j.data.media[0]?.url : j?.data?.media?.url);
      if (!j?.success || !got) throw new Error(j?.error || 'preview failed');
      setUrl(got); setState('ready');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  };
  if (state === 'ready') return <div className="w-full max-w-sm"><AudioTransport src={url} study /></div>;
  return (
    <div className="flex flex-col items-center gap-2 w-full max-w-sm">
      <button
        type="button" onClick={listen} disabled={state === 'busy'}
        className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        {state === 'busy' ? t('media.score_rendering') : t('media.score_listen')}
      </button>
      <p className="text-[11px] text-slate-400 text-center">
        {state === 'error' ? err : t('media.score_no_browser')}
      </p>
    </div>
  );
}
const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon, video: Film, audio: Music, score: Music, lyrics: FileText,
  document: FileText, other: FileIcon,
};

/** Format badge colors — the same vocabulary as the chat file cards (format colors are
 *  semantics: green IS excel to every reader). Unknown extensions fall back to slate. */
const EXT_BADGE: Record<string, string> = {
  pptx: 'text-orange-700 bg-orange-50 border-orange-200',
  xlsx: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  docx: 'text-blue-700 bg-blue-50 border-blue-200',
  pdf: 'text-red-700 bg-red-50 border-red-200',
  hwpx: 'text-sky-700 bg-sky-50 border-sky-200',
  hwp: 'text-sky-700 bg-sky-50 border-sky-200',
  mid: 'text-indigo-700 bg-indigo-50 border-indigo-200',
};
const EXT_BADGE_DEFAULT = 'text-slate-700 bg-slate-100 border-slate-300';

/** A filename is one unbroken token, so CSS line breaking is the wrong ruler for it: it
 *  breaks greedily at the hyphens, and a first token too wide for the card leaves the line
 *  holding nothing but the prefix ("최종-" on ten cards, 2026-08-23 실측). Cut by character
 *  count instead, and let the lines fill character by character (`break-all` on the span).
 *  Budget is columns, not chars — 한글·가나·한자 take two. */
const CARD_LABEL_COLS = 40;

// East Asian Wide/Fullwidth blocks — the ranges a monospace terminal also draws double-width.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
];

function clampToColumns(name: string, cols: number): string {
  const chars = Array.from(name);
  let used = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0) ?? 0;
    used += WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
    if (used > cols) return chars.slice(0, Math.max(1, i)).join('') + '…';
  }
  return name;
}

/** Card label: the badge already names the format, so a trailing ".pptx" / "-pptx" (media
 *  slugs turn dots into dashes) is noise on the second line — strip it when it matches the
 *  item's ext. Never strips down to an empty label. */
function cardLabel(name: string, ext: string): string {
  const stripped = ext ? (name.replace(new RegExp(`[._-]${ext}$`, 'i'), '') || name) : name;
  return clampToColumns(stripped, CARD_LABEL_COLS);
}

// Browsers leave file.type empty for extensions the OS never registered (hwpx above all) —
// the picker fills the claim from the extension so the server gate has something to verify.
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwpx: 'application/vnd.hancom.hwpx',
  hwp: 'application/x-hwp',
  mid: 'audio/midi', midi: 'audio/midi',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
};
const UPLOAD_ACCEPT = 'image/*,audio/*,video/mp4,video/webm,.mp4,.mov,.mid,.midi,.pdf,.docx,.xlsx,.pptx,.hwpx,.hwp';
const UPLOAD_MAX_MB = 25;

// 윗줄은 큰 갈래, 음악을 고르면 아랫줄에 그 안의 셋이 선다 — 한 곡을 찾을 때 소리·악보·가사가
// 서로 옆에 있어야 한다(전엔 .mid 는 오디오, .mxl 은 기타로 같은 곡이 두 탭에 흩어졌다).
const KINDS: KindChip[] = ['all', 'image', 'video', 'music', 'document', 'other'];
const MUSIC_SUB: KindChip[] = ['music', 'audio', 'score', 'lyrics'];
// 이미지도 같은 문법 — 첫 칩이 전체, 나머지는 출처(source)로 갈린다: 생성·클립아트·그 외.
const IMAGE_SUB: KindChip[] = ['image', 'generated', 'clipart', 'photo'];
const SORTS = ['newest', 'oldest', 'name', 'size'] as const;
type SortKey = typeof SORTS[number];

export type MediaHubContext = { slug: string; apiToken: string; sessionId: string };

export function MediaPanel({
  hubContext,
}: {
  hubMode?: boolean;   // accepted for caller compat; owner derived from hubContext (backend object).
  hubContext?: MediaHubContext;
} = {}) {
  const searchId = useId();
  const t = useTranslations();
  const [items, setItems] = useState<MediaItem[]>([]);
  // 안정적인 콜백(SSE 핸들러)이 지금 길이를 보려면 ref 여야 한다 — 의존성에 넣으면
  // 목록이 바뀔 때마다 구독이 다시 걸린다.
  const itemsRef = useRef<MediaItem[]>([]);
  itemsRef.current = items;
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<'all' | 'user' | 'system'>('user');
  const [kind, setKind] = useState<KindChip>('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track the selection by index so prev/next navigation works.
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selected = selectedIndex !== null && selectedIndex < items.length ? items[selectedIndex] : null;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Owner-injected backend — admin REST (/api/media/*) vs hub op (GET/DELETE/POST{op}) diverge inside each method only.
  const backend = useMemo(() => ({
    async list(opts: { offset: number; search: string; scope: string; kind: string; sort: string; limit?: number }): Promise<{ success: boolean; items: MediaItem[]; total?: number } | null> {
      const params = new URLSearchParams();
      params.set('limit', String(opts.limit ?? PAGE_SIZE));
      params.set('offset', String(opts.offset));
      if (opts.search) params.set('search', opts.search);
      if (opts.kind !== 'all') params.set('kind', opts.kind);
      if (opts.sort !== 'newest') params.set('sort', opts.sort);
      if (hubContext) {
        const res = await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/media?${params.toString()}`, {
          headers: { 'X-Api-Token': hubContext.apiToken, 'X-Session-Id': hubContext.sessionId },
        });
        return res.json().catch(() => null);
      }
      params.set('scope', opts.scope);
      return apiGet<{ success: boolean; items: MediaItem[]; total?: number }>(`/api/media/list?${params.toString()}`, { category: 'media' }).catch(() => null);
    },
    async upload(dataUrl: string, filenameHint: string): Promise<{ success?: boolean; error?: string }> {
      // Owner-injected door — same shape as the chat record button: admin REST vs hub op.
      if (hubContext) {
        return fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubContext.apiToken, 'X-Session-Id': hubContext.sessionId },
          body: JSON.stringify({ op: 'upload', dataUrl, filenameHint }),
        }).then(r => r.json()).catch(() => ({ success: false, error: t('media.network_error') }));
      }
      return apiPost<{ success: boolean; error?: string }>('/api/media/upload', { dataUrl, filenameHint }, { category: 'media' });
    },
    async remove(slug: string): Promise<{ success: boolean; error?: string }> {
      if (hubContext) {
        return fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/media?slug=${encodeURIComponent(slug)}`, {
          method: 'DELETE', headers: { 'X-Api-Token': hubContext.apiToken, 'X-Session-Id': hubContext.sessionId },
        }).then(r => r.json()).catch(() => ({ success: false, error: t('media.network_error') }));
      }
      return apiDelete<{ success: boolean; error?: string }>(`/api/media/list?slug=${encodeURIComponent(slug)}`, { category: 'media' });
    },
    async regenerate(slug: string): Promise<{ success: boolean; error?: string }> {
      if (hubContext) {
        return fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubContext.apiToken, 'X-Session-Id': hubContext.sessionId },
          body: JSON.stringify({ op: 'regenerate', slug }),
        }).then(r => r.json()).catch(() => ({ success: false, error: t('media.network_error') }));
      }
      return apiPost<{ success: boolean; error?: string }>(`/api/media/regenerate?slug=${encodeURIComponent(slug)}`, undefined, { category: 'media' });
    },
  }), [hubContext, t]);

  // offset 은 **인자**다. 상태에서 읽으면 setOffset 직후의 호출이 옛 값을 들고 가서 같은
  // 페이지를 또 가져온다 — 더보기가 첫 페이지를 두 벌 만들던 뿌리가 그것이고, 키가 겹치니
  // 새로 붙은 카드가 안 눌렸다.
  //
  // 그리고 응답에는 순번을 단다. 필터를 바꾸는 순간에도 앞 요청이 날아가고 있고, 그게 나중에
  // 도착하면 `[...prev, ...]` 로 **다른 필터의 결과가 지금 목록에 붙는다** — 음악만 보고 있는데
  // 이미지가 딸려 나온 것이 이것이다. 늦게 온 것은 조용히 버린다.
  const reqSeq = useRef(0);
  const fetchList = useCallback(async (opts: { offset: number; append?: boolean; limit?: number }) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const data = await backend.list({ offset: opts.offset, limit: opts.limit, search, scope, kind, sort });
      if (seq !== reqSeq.current) return;      // 지나간 요청 — 지금 화면의 필터가 아니다
      if (data?.success) {
        setItems(prev => opts.append ? [...prev, ...data!.items] : data!.items);
        setTotal(data.total || 0);
      } else if (!opts.append) {
        setItems([]); setTotal(0);
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [backend, search, scope, kind, sort]);

  /** 지금 보고 있는 만큼 그대로 다시 — 새로고침이 더보기로 쌓은 페이지를 걷어가지 않는다. */
  const refetchAll = useCallback(() => {
    fetchList({ offset: 0, limit: Math.max(PAGE_SIZE, itemsRef.current.length) });
  }, [fetchList]);

  // Reset on filter change — debounced for search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchList({ offset: 0 });
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, search, kind, sort]);

  // Upload — dataUrl through the owner-injected door; the server gate (magic bytes) is the
  // real validator, this side only fills a missing MIME claim from the extension.
  const handleUploadFile = useCallback(async (file: File) => {
    if (file.size > UPLOAD_MAX_MB * 1024 * 1024) {
      await alertDialog({ title: t('media.upload_failed'), message: t('media.upload_too_large', { max: UPLOAD_MAX_MB }), danger: true });
      return;
    }
    setUploading(true);
    try {
      let dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      if (!file.type) {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        const mime = EXT_MIME[ext];
        if (mime) dataUrl = dataUrl.replace(/^data:[^;]*;/, `data:${mime};`);
      }
      const hint = file.name.replace(/\.[^.]+$/, '');
      const res = await backend.upload(dataUrl, hint);
      if (!res?.success) {
        await alertDialog({ title: t('media.upload_failed'), message: res?.error || 'unknown', danger: true });
        return;
      }
      // Hub has no SSE media:refresh — refetch directly (harmless double on admin).
      refetchAll();
    } finally {
      setUploading(false);
    }
  }, [backend, fetchList, t]);

  // SSE `media:refresh` subscription — auto-refresh on image_gen completion, media delete, regenerate.
  // Keeps the current scope/search and resets to page one so a new image shows immediately.
  useEvents(['media:refresh'], () => { refetchAll(); });

  // 다음 offset = **이미 받은 개수**. 따로 세는 상태를 두면 그 상태와 목록이 어긋나고, 어긋난
  // 쪽이 이기면 같은 페이지가 두 번 붙는다 (파생이지 손유지가 아니다).
  const handleLoadMore = () => { fetchList({ offset: items.length, append: true }); };

  // Where the selected media is used — cached + auto-refetched via React Query.
  const { data: usageData } = useQuery({
    queryKey: ['media-usage', selected?.slug],
    queryFn: () =>
      apiGet<{ success: boolean; data?: Array<{ pageSlug: string; usedAt: number }> }>(
        `/api/media/usage?slug=${encodeURIComponent(selected!.slug)}`,
        { category: 'media' },
      ),
    enabled: !!selected && !hubContext, // usage = admin analytics (no hub backend op) — skipped on hub to avoid a 401
  });
  const selectedUsage = usageData?.success ? (usageData.data ?? []) : [];

  const handleDelete = async (slug: string) => {
    // Usage-aware confirm — an image set on pages gets the red warning plus the page list.
    const usage = selectedUsage;
    const msg = usage.length > 0
      ? t('media.delete_in_use', { count: usage.length, pages: usage.map(u => `  • /${u.pageSlug}`).join('\n') })
      : t('media.delete_confirm');
    if (!await confirmDialog({ title: t('media.delete_title'), message: msg, danger: true, okLabel: t('media.delete_ok') })) return;
    try {
      const data = await backend.remove(slug);
      if (data.success) {
        // 지운 자리로 다음 파일이 당겨진다 — 인덱스를 그대로 두면 상세가 그 다음 것을
        // 보여주므로 연속 삭제가 된다. 닫는 것은 **마지막 한 장을 지웠을 때뿐**.
        const left = items.length - 1;
        setItems(prev => prev.filter(i => i.slug !== slug));
        setTotal(prev => Math.max(0, prev - 1));
        setSelectedIndex(cur => (cur === null || left <= 0) ? null : Math.min(cur, left - 1));
      } else {
        await alertDialog({ title: t('media.delete_failed'), message: data.error || 'unknown', danger: true });
      }
    } catch (err: any) {
      await alertDialog({ title: t('media.delete_failed'), message: err.message, danger: true });
    }
  };

  const [regenerating, setRegenerating] = useState(false);
  const handleRegenerate = async (slug: string) => {
    setRegenerating(true);
    try {
      const data = await backend.regenerate(slug);
      if (!data.success) {
        await alertDialog({ title: t('media.regen_failed'), message: data.error || 'unknown', danger: true });
      }
      // Success or failure, SSE media:refresh refreshes the grid. Close the modal either way.
      setSelectedIndex(null);
    } catch (err: any) {
      await alertDialog({ title: t('media.regen_failed'), message: err.message, danger: true });
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* filter bar */}
      <div className="shrink-0 flex flex-col gap-2 px-3 py-3 border-b border-slate-100 bg-slate-50/50">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <label htmlFor={searchId} className="sr-only">{t('media.search_label')}</label>
          <input
            type="text"
            placeholder={t('media.search_placeholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label={t('media.search_label')}
            className="w-full pl-7 pr-2 py-1.5 text-[12px] bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500" name="mediaSearch" autoComplete="off" id={searchId}
          />
        </div>
        <div className="flex gap-1">
          {(['user', 'system', 'all'] as const).map(s => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`flex-1 px-2 py-1 text-[10px] font-bold rounded-md transition-colors ${
                scope === s ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {s === 'user' ? t('media.scope_user') : s === 'system' ? t('media.scope_system') : t('media.scope_all')}
            </button>
          ))}
        </div>
        {/* kind chips — same vocabulary as the server filter, so pagination stays honest */}
        <div className="flex gap-1">
          {KINDS.map(k => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`flex-1 px-1 py-1 text-[10px] font-bold rounded-md transition-colors ${
                (k === 'music' ? MUSIC_KINDS.includes(kind)
                  : k === 'image' ? IMAGE_KINDS.includes(kind) : kind === k)
                  ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              {t(`media.kind_${k}`)}
            </button>
          ))}
        </div>
        {(MUSIC_KINDS.includes(kind) || IMAGE_KINDS.includes(kind)) && (
          <div className="flex gap-1 pl-2">
            {(MUSIC_KINDS.includes(kind) ? MUSIC_SUB : IMAGE_SUB).map(k => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`flex-1 px-1 py-1 text-[10px] font-semibold rounded-md transition-colors ${
                  kind === k ? 'bg-slate-200 text-slate-800' : 'text-slate-400 hover:bg-slate-100'
                }`}
              >
                {k === 'music' || k === 'image' ? t('media.kind_all') : t(`media.kind_${k}`)}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            aria-label={t('media.sort_label')}
            className="flex-1 px-1.5 py-1 text-[11px] bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 text-slate-600"
          >
            {SORTS.map(s => <option key={s} value={s}>{t(`media.sort_${s}`)}</option>)}
          </select>
          <input
            ref={fileInputRef}
            type="file"
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = ''; // allow re-picking the same file
              if (f) void handleUploadFile(f);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold rounded-md bg-slate-800 hover:bg-slate-900 text-white transition-colors disabled:opacity-50"
          >
            {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            {uploading ? t('media.uploading') : t('media.upload')}
          </button>
        </div>
        <div className="text-[10px] text-slate-400">
          {total > 0
            ? `${t('media.total_count', { total })}${items.length < total ? t('media.loaded_suffix', { loaded: items.length }) : ''}`
            : loading ? t('media.loading') : t('media.empty')}
        </div>
      </div>

      {/* grid */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-2">
        {items.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
            <FolderOpen size={32} strokeWidth={1.5} />
            <p className="text-[12px]">{t('media.empty_title')}</p>
            <p className="text-[10px] text-slate-300">{t('media.empty_hint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {items.map((item, idx) => {
              const isError = item.status === 'error';
              const isRendering = item.status === 'rendering';
              const itemKind = kindOf(item.contentType, item.ext);
              const KindIcon = KIND_ICON[itemKind];
              const thumbSrc = item.thumbnailUrl || `/${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`;
              const tooltipLabel = isError
                ? t('media.failed_tooltip', { msg: item.errorMsg?.slice(0, 80) ?? 'unknown' })
                : (item.filenameHint || item.slug);
              return (
                <Tooltip key={`${item.scope}-${item.slug}`} label={tooltipLabel}>
                <button
                  onClick={() => setSelectedIndex(idx)}
                  className={`group relative aspect-square rounded-md overflow-hidden transition-all ${
                    isError
                      ? 'bg-red-50 ring-2 ring-red-300 hover:ring-red-500'
                      : isRendering
                        ? 'bg-blue-50 ring-2 ring-blue-200 hover:ring-blue-400'
                        : 'bg-slate-100 hover:ring-2 hover:ring-blue-400'
                  }`}
                >
                  {isError ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-red-500">
                      <AlertTriangle size={20} />
                      <span className="text-[9px] font-bold">{t('media.failed_badge')}</span>
                    </div>
                  ) : isRendering ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-blue-500">
                      <Loader2 size={20} className="animate-spin" />
                      <span className="text-[9px] font-bold">{t('media.generating_badge')}</span>
                    </div>
                  ) : itemKind !== 'image' ? (
                    /* non-image — no pixels to show, so the card says what the file IS:
                       a format-colored badge + the FILENAME (ext alone told nobody which
                       deck was which — 2026-08-10 사용자). */
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-2 bg-white">
                      <span className={`shrink-0 w-12 h-12 rounded-xl border flex flex-col items-center justify-center ${EXT_BADGE[item.ext] ?? EXT_BADGE_DEFAULT}`}>
                        <KindIcon size={18} strokeWidth={2} />
                        <span className="text-[8px] font-black tracking-wide leading-none mt-0.5 uppercase">{item.ext}</span>
                      </span>
                      <span
                        title={item.filenameHint || item.slug}
                        className="text-[10.5px] leading-snug font-medium text-slate-600 text-center break-all line-clamp-2 px-0.5"
                      >
                        {cardLabel(item.filenameHint || item.slug, item.ext)}
                      </span>
                    </div>
                  ) : (
                    <img
                      src={thumbSrc}
                      alt={item.filenameHint || item.slug}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover"
                    />
                  )}
                  {item.scope === 'system' && (
                    <span className="absolute top-1 right-1 bg-amber-500 text-white text-[8px] font-black px-1 py-0.5 rounded">SYS</span>
                  )}
                </button>
                </Tooltip>
              );
            })}
          </div>
        )}

        {/* load more */}
        {items.length < total && (
          <button
            onClick={handleLoadMore}
            disabled={loading}
            className="w-full mt-2 py-2 text-[11px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin inline" /> : t('media.load_more', { count: total - items.length })}
          </button>
        )}
      </div>

      {/* detail modal — rendered into document.body via Portal (escapes the sidebar/parent containing block) */}
      {selected && selectedIndex !== null && (
        <MediaDetailModal
          item={selected}
          index={selectedIndex}
          total={items.length}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex < items.length - 1}
          onPrev={() => setSelectedIndex(i => (i !== null && i > 0 ? i - 1 : i))}
          onNext={() => setSelectedIndex(i => (i !== null && i < items.length - 1 ? i + 1 : i))}
          onClose={() => setSelectedIndex(null)}
          onDelete={() => handleDelete(selected.slug)}
          onRegenerate={() => handleRegenerate(selected.slug)}
          regenerating={regenerating}
          usage={selectedUsage}
        />
      )}
    </div>
  );
}

function MediaDetailModal({
  item, index, total, hasPrev, hasNext, onPrev, onNext, onClose, onDelete, onRegenerate, regenerating, usage,
}: {
  item: MediaItem;
  index: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  regenerating: boolean;
  /** Pages using this media — empty shows the not-used label. Auto-refreshed from the PageManager index. */
  usage: Array<{ pageSlug: string; usedAt: number }>;
}) {
  const t = useTranslations();
  const isError = item.status === 'error';
  const itemKind = kindOf(item.contentType, item.ext);
  // 화살표를 미리보기 위에 띄우는 건 **그림일 때뿐**이다. 오디오·악보 미리보기는 그 자리가
  // 컨트롤이라, 세로 중앙에 뜬 화살표가 재생 버튼 위에 앉는다(모바일 실측 2026-08-21).
  // 그림이 아니면 화살표는 헤더로 간다 — 모바일에서도.
  const floatNav = itemKind === 'image';
  const HeaderIcon = KIND_ICON[itemKind];
  const canRegenerate = !!item.prompt; // a prompt is required to re-run
  const [copiedField, setCopiedField] = useState<string | null>(null);
  // Viewport quirk workaround — stops the box jumping when the iOS toolbar moves. md(768px+) keeps max-h-full.
  const { vw, vh } = useViewportSize();
  const isMobile = vw != null && vw < 768;
  const previewMaxH = isMobile && vh != null ? Math.floor(vh * 0.45) : null;
  // Keyboard: arrows for prev/next, Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      else if (e.key === 'ArrowRight' && hasNext) onNext();
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPrev, hasNext, onPrev, onNext, onClose]);

  const copy = async (text: string, field: string) => {
    // HTTP 에선 navigator.clipboard 가 없다 — 옛 `if` 는 그때 아무 말 없이 아무 일도 안 했다.
    const ok = await copyText(text);
    setCopiedField(ok ? field : `${field}:fail`);
    setTimeout(() => setCopiedField(null), 1500);
  };
  const url = `/${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`;
  const sizeKb = (item.bytes / 1024).toFixed(1);
  const createdStr = new Date(item.createdAt).toLocaleString('ko-KR');

  return (
    <Modal onClose={onClose}>
        {/* header — N/total indicator + prev/next + close. safe-area-inset-top keeps it off the status bar */}
        <div
          className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-slate-100 bg-slate-50 shrink-0 gap-2"
          style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}
        >
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 truncate min-w-0 flex-1">
            <HeaderIcon size={14} className="text-blue-500 shrink-0" />
            <span className="truncate">{item.filenameHint || item.slug}</span>
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[11px] text-slate-400 tabular-nums px-1">{index + 1} / {total}</span>
            {/* header arrows — desktop only (mobile uses the floating buttons over the image; no duplicates) */}
            <Tooltip label={t('media_modal.previous_image')}>
              <button
                onClick={onPrev}
                disabled={!hasPrev}
                className={`${floatNav ? 'hidden md:inline-flex' : 'inline-flex'} p-1.5 rounded text-slate-500 hover:bg-slate-200 disabled:opacity-30 transition-colors`}
                aria-label={t('media.aria_prev')}
              >
                <ChevronLeft size={18} />
              </button>
            </Tooltip>
            <Tooltip label={t('media_modal.next_image')}>
              <button
                onClick={onNext}
                disabled={!hasNext}
                className={`${floatNav ? 'hidden md:inline-flex' : 'inline-flex'} p-1.5 rounded text-slate-500 hover:bg-slate-200 disabled:opacity-30 transition-colors`}
                aria-label={t('media.aria_next')}
              >
                <ChevronRight size={18} />
              </button>
            </Tooltip>
            <button onClick={onClose} className="md:ml-1 text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-200" aria-label={t('media.aria_close')}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* body — mobile flex-col / desktop flex-row.
            Mobile: the body itself scrolls, so meta rows and buttons stay reachable on short viewports.
            Desktop: overflow-hidden — each column scrolls on its own. */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 p-3 sm:p-4 overflow-y-auto md:overflow-hidden">
          {/* preview — mobile: 45% of the viewport (in px, immune to toolbar moves); desktop: the whole left column.
              Three-way branch on status = error / rendering / done, same pattern as the grid.
              Cache busting (?v=bytes) — mobile browsers cache the grey placeholder response, and the done
              swap re-requests the same URL, so without the version the cache hit keeps it grey. */}
          <div
            className={`relative shrink-0 md:flex-1 md:min-w-0 md:max-h-full md:h-auto rounded-lg p-2 flex items-center justify-center overflow-hidden ${
              isError ? 'bg-red-50 border border-red-200' : item.status === 'rendering' ? 'bg-blue-50 border border-blue-200' : 'bg-slate-50'
            }`}
            style={previewMaxH ? { maxHeight: `${previewMaxH}px` } : undefined}
          >
            {isError ? (
              <div className="flex flex-col items-center gap-2 text-center px-4 py-6">
                <AlertTriangle size={32} className="text-red-500" />
                <div className="text-sm font-bold text-red-700">{t('media.gen_failed_title')}</div>
                {item.errorMsg && (
                  <p className="text-[11px] text-red-600 break-words leading-relaxed max-w-xs">{item.errorMsg}</p>
                )}
                {item.prompt && (
                  <p className="text-[10px] text-slate-500 italic mt-1">{t('media.gen_failed_retry_hint')}</p>
                )}
              </div>
            ) : item.status === 'rendering' ? (
              <div className="flex flex-col items-center gap-2 text-center px-4 py-6 text-blue-600">
                <Loader2 size={32} className="animate-spin" />
                <div className="text-sm font-bold">{t('media.generating_title')}</div>
                <p className="text-[11px] text-slate-500 italic mt-1">{t('media.generating_hint')}</p>
              </div>
            ) : itemKind === 'score' ? (
              <div className="flex flex-col items-center gap-3 w-full px-4 py-6 text-slate-600">
                <Music size={32} strokeWidth={1.5} />
                <ScorePreview path={`${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`} t={t} />
              </div>
            ) : itemKind === 'video' ? (
              <video
                controls
                preload="metadata"
                playsInline
                className="max-w-full max-h-full rounded-lg bg-black"
                src={`${url}?v=${item.bytes || item.createdAt}`}
              />
            ) : itemKind === 'audio' ? (
              <div className="flex flex-col items-center gap-3 w-full px-4 py-6 text-slate-600">
                <Music size={32} strokeWidth={1.5} />
                <div className="w-full max-w-sm">
                  <AudioTransport src={`${url}?v=${item.bytes || item.createdAt}`} study={false} />
                </div>
              </div>
            ) : itemKind !== 'image' ? (
              <div className="flex flex-col items-center gap-2 text-center px-4 py-8 text-slate-500">
                <HeaderIcon size={40} strokeWidth={1.5} />
                <span className="text-sm font-black tracking-wider uppercase text-slate-600">{item.ext}</span>
                <p className="text-[11px] text-slate-400">{t('media.no_preview')}</p>
              </div>
            ) : (
              <img
                src={`${url}?v=${item.bytes || item.createdAt}`}
                alt={item.filenameHint || item.slug}
                className="max-w-full max-h-full object-contain rounded"
              />
            )}
            {/* 그림 위에만 띄운다 — 다른 종류는 이 자리가 컨트롤이다(위 floatNav). */}
            {floatNav && (<>
            <button
              onClick={onPrev}
              disabled={!hasPrev}
              className="md:hidden absolute left-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/40 text-white hover:bg-slate-900/60 disabled:opacity-20 transition-colors"
              aria-label={t('media.aria_prev')}
            >
              <ChevronLeft size={20} />
            </button>
            <button
              onClick={onNext}
              disabled={!hasNext}
              className="md:hidden absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/40 text-white hover:bg-slate-900/60 disabled:opacity-20 transition-colors"
              aria-label={t('media.aria_next')}
            >
              <ChevronRight size={20} />
            </button>
            </>)}
          </div>

          {/* right column — only desktop scrolls the prompt; mobile flows naturally (body scroll owns it) */}
          <div className="md:flex-none md:w-64 md:shrink-0 md:min-h-0 flex flex-col gap-2 text-[12px]">
            {/* prompt — always rendered (placeholder when absent). Desktop only: flex-1 + own scroll */}
            <div className="md:flex-1 md:min-h-[60px] md:overflow-y-auto pr-1 border-b border-slate-100 pb-2">
              {item.prompt && (
                <div className="mb-2">
                  <div className="flex items-center gap-1 text-slate-400 font-bold uppercase text-[10px] mb-0.5"><Sparkles size={10} /> {t('media.prompt')}</div>
                  <p className="text-slate-700 break-words leading-relaxed">{item.prompt}</p>
                </div>
              )}
              {item.revisedPrompt && item.revisedPrompt !== item.prompt && (
                <div>
                  <div className="text-slate-400 font-bold uppercase text-[10px] mb-0.5">{t('media.revised_prompt')}</div>
                  <p className="text-slate-600 break-words italic leading-relaxed">{item.revisedPrompt}</p>
                </div>
              )}
              {!item.prompt && !item.revisedPrompt && (
                <p className="text-slate-400 italic text-[11px]">{t('media.no_prompt')}</p>
              )}
            </div>

            {/* meta — always the same row count (missing values show "—") so positions never shift */}
            <div className="shrink-0 flex flex-col gap-1.5">
              <MetaRow icon={<Calendar size={10} />} label={t('media.meta_created')} value={createdStr} />
              <MetaRow label={t('media.meta_model')} value={item.model || '—'} />
              <MetaRow label={t('media.meta_size')} value={item.size || '—'} />
              <MetaRow label={t('media.meta_quality')} value={item.quality || '—'} />
              <MetaRow icon={<Ruler size={10} />} label={t('media.meta_resolution')} value={(item.width && item.height) ? `${item.width} × ${item.height}` : '—'} />
              <MetaRow
                icon={<Crop size={10} />}
                label={t('media.meta_ratio')}
                value={item.aspectRatio
                  ? `${item.aspectRatio}${item.focusPoint ? ` (${typeof item.focusPoint === 'string' ? item.focusPoint : 'xy'})` : ''}`
                  : '—'}
              />
              <MetaRow label={t('media.meta_original')} value={`${sizeKb} KB · ${item.ext.toUpperCase()}`} />
              <MetaRow label="Variants" value={item.variants && item.variants.length > 0
                ? t('media.variants_value', { count: item.variants.length, formats: [...new Set(item.variants.map(v => v.format))].join('/') })
                : t('media.none')} />
              <MetaRow label="Blurhash" value={item.blurhash ? t('media.blurhash_yes') : '✗'} />
              {/* usage — pages whose PageSpec references this media. Empty array shows the not-used label. */}
              <div className="flex items-start gap-1.5 text-[11px]">
                <span className="shrink-0 text-slate-400 font-bold uppercase text-[10px] mt-0.5 min-w-[64px]">{t('media.usage')}</span>
                {usage.length === 0 ? (
                  <span className="text-slate-400 italic">{t('media.usage_none')}</span>
                ) : (
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    {usage.slice(0, 5).map(u => (
                      <a
                        key={u.pageSlug}
                        href={`/${u.pageSlug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline break-all"
                      >
                        /{u.pageSlug}
                      </a>
                    ))}
                    {usage.length > 5 && (
                      <span className="text-slate-400 text-[10px]">{t('media.usage_more', { count: usage.length - 5 })}</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* buttons — pinned to the bottom. safe-area-inset-bottom keeps them off the browser toolbar / home indicator.
                Regenerate shows only with a prompt — emphasized (red) on error, secondary (blue) otherwise.
                URL/Markdown copy only when a real file exists (status != 'error'). */}
            <div
              className="shrink-0 flex flex-col gap-1.5 pt-1"
              style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
            >
              {canRegenerate && (
                <button
                  onClick={onRegenerate}
                  disabled={regenerating}
                  className={`flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold rounded-lg transition-colors disabled:opacity-50 ${
                    isError
                      ? 'bg-red-500 hover:bg-red-600 text-white'
                      : 'bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200'
                  }`}
                >
                  {regenerating
                    ? <><Loader2 size={12} className="animate-spin" /> {t('media.regenerating')}</>
                    : <><RefreshCw size={12} /> {isError ? t('media.retry_same_prompt') : t('media.regenerate')}</>}
                </button>
              )}
              {!isError && itemKind !== 'image' && (
                /* non-image — a file you mostly take elsewhere (open the deck, feed the module) */
                <a
                  href={url}
                  download={`${item.filenameHint || item.slug}.${item.ext}`}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-lg transition-colors"
                >
                  <Download size={12} /> {t('media.download')}
                </a>
              )}
              {!isError && (
                <div className="relative">
                  <button
                    onClick={() => copy(new URL(url, window.location.origin).href, 'url')}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
                  >
                    <Copy size={12} /> {t('media.copy_url')}
                  </button>
                  <FeedbackBadge state={copiedField === 'url' ? 'ok' : copiedField === 'url:fail' ? 'err' : null} okLabel={t('media.copied')} errLabel={t('media.copy_failed')} absolute />
                </div>
              )}
              {!isError && (
                <div className="relative">
                  <button
                    onClick={() => copy(
                      // ![..] embeds only render pixels — non-image files copy as a plain link.
                      itemKind === 'image'
                        ? `![${item.filenameHint || ''}](${url})`
                        : `[${item.filenameHint || item.slug}](${url})`,
                      'md',
                    )}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
                  >
                    <Copy size={12} /> {t('media.copy_md')}
                  </button>
                  <FeedbackBadge state={copiedField === 'md' ? 'ok' : copiedField === 'md:fail' ? 'err' : null} okLabel={t('media.copied')} errLabel={t('media.copy_failed')} absolute />
                </div>
              )}
              <button
                onClick={onDelete}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-lg transition-colors"
              >
                <Trash2 size={12} /> {t('media.delete')}
              </button>
            </div>
          </div>
        </div>
    </Modal>
  );
}

function MetaRow({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-slate-400 font-bold uppercase text-[10px] flex items-center gap-1 shrink-0">{icon} {label}</span>
      <span className="text-slate-700 text-right break-all">{value}</span>
    </div>
  );
}
