'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, Loader2, X, Copy, Trash2, Image as ImageIcon, Sparkles, Calendar, Ruler, Crop, ChevronLeft, ChevronRight, AlertTriangle, RefreshCw } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { FeedbackBadge } from './FeedbackBadge';
import { confirmDialog, alertDialog } from './Dialog';
import { useEvents } from '../hooks/events-manager';

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
  /** 미설정(legacy) = 'done' 으로 간주 */
  status?: 'rendering' | 'done' | 'error';
  errorMsg?: string;
}

const PAGE_SIZE = 48;

export function GalleryPanel() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<'all' | 'user' | 'system'>('user');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  // selected 를 index 로 추적 — prev/next 탐색 가능
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selected = selectedIndex !== null && selectedIndex < items.length ? items[selectedIndex] : null;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchList = useCallback(async (reset: boolean) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('scope', scope);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(reset ? 0 : offset));
      if (search) params.set('search', search);
      const res = await fetch(`/api/media/list?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        setItems(prev => reset ? data.items : [...prev, ...data.items]);
        setTotal(data.total || 0);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [scope, search, offset]);

  // scope/search 변경 시 리셋 — debounced for search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setOffset(0);
      fetchList(true);
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, search]);

  // SSE `gallery:refresh` 구독 — image_gen 완료·미디어 삭제·재생성 시 자동 갱신.
  // 현재 scope/search 그대로 유지하면서 첫 페이지로 리셋해 새 이미지 즉시 노출.
  useEvents(['gallery:refresh'], () => {
    setOffset(0);
    fetchList(true);
  });

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    // offset 변경 후 fetchList 를 리셋없이 호출 — 다음 useEffect 대신 직접
    setTimeout(() => fetchList(false), 0);
  };

  // 선택된 미디어의 사용처 — 모달 열릴 때 fetch. 페이지에 박힌 이미지 삭제 경고 + 메타 표시.
  const [selectedUsage, setSelectedUsage] = useState<Array<{ pageSlug: string; usedAt: number }>>([]);
  useEffect(() => {
    if (!selected) { setSelectedUsage([]); return; }
    fetch(`/api/media/usage?slug=${encodeURIComponent(selected.slug)}`)
      .then(r => r.json())
      .then(j => { if (j.success) setSelectedUsage(j.data ?? []); })
      .catch(() => {});
  }, [selected?.slug]);

  const handleDelete = async (slug: string) => {
    // 사용처 차등 confirm — 페이지에 박힌 이미지면 빨간 경고 + 페이지 목록.
    const usage = selectedUsage;
    const msg = usage.length > 0
      ? `이 이미지는 ${usage.length}개 페이지에 사용 중입니다:\n\n${usage.map(u => `  • /${u.pageSlug}`).join('\n')}\n\n삭제하면 해당 페이지의 이미지가 깨집니다. 정말 삭제하시겠어요?`
      : '이 이미지를 삭제하시겠어요? (원본 + 모든 variants + 썸네일 일괄 삭제)';
    if (!await confirmDialog({ title: '이미지 삭제', message: msg, danger: true, okLabel: '삭제' })) return;
    try {
      const res = await fetch(`/api/media/list?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setItems(prev => prev.filter(i => i.slug !== slug));
        setSelectedIndex(null);
      } else {
        await alertDialog({ title: '삭제 실패', message: data.error || 'unknown', danger: true });
      }
    } catch (err: any) {
      await alertDialog({ title: '삭제 실패', message: err.message, danger: true });
    }
  };

  const [regenerating, setRegenerating] = useState(false);
  const handleRegenerate = async (slug: string) => {
    setRegenerating(true);
    try {
      const res = await fetch(`/api/media/regenerate?slug=${encodeURIComponent(slug)}`, { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        await alertDialog({ title: '재생성 실패', message: data.error || 'unknown', danger: true });
      }
      // 성공/실패 모두 SSE gallery:refresh 가 자동 갱신. 모달은 닫음.
      setSelectedIndex(null);
    } catch (err: any) {
      await alertDialog({ title: '재생성 실패', message: err.message, danger: true });
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 필터 바 */}
      <div className="shrink-0 flex flex-col gap-2 px-3 py-3 border-b border-slate-100 bg-slate-50/50">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="프롬프트·파일명·모델로 검색"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-7 pr-2 py-1.5 text-[12px] bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              {s === 'user' ? '사용자' : s === 'system' ? '시스템' : '전체'}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-slate-400">
          {total > 0 ? `총 ${total}개${items.length < total ? ` (${items.length} 로드됨)` : ''}` : loading ? '로딩 중…' : '이미지 없음'}
        </div>
      </div>

      {/* 그리드 */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-2">
        {items.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-2">
            <ImageIcon size={32} strokeWidth={1.5} />
            <p className="text-[12px]">이미지가 없어요</p>
            <p className="text-[10px] text-slate-300">채팅에서 "이미지 만들어줘" 로 생성하세요</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {items.map((item, idx) => {
              const isError = item.status === 'error';
              const isRendering = item.status === 'rendering';
              const thumbSrc = item.thumbnailUrl || `/${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`;
              const tooltipLabel = isError
                ? `생성 실패: ${item.errorMsg?.slice(0, 80) ?? 'unknown'}`
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
                      <span className="text-[9px] font-bold">생성 실패</span>
                    </div>
                  ) : isRendering ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-blue-500">
                      <Loader2 size={20} className="animate-spin" />
                      <span className="text-[9px] font-bold">생성 중</span>
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

        {/* 더 보기 */}
        {items.length < total && (
          <button
            onClick={handleLoadMore}
            disabled={loading}
            className="w-full mt-2 py-2 text-[11px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin inline" /> : `더 보기 (${total - items.length})`}
          </button>
        )}
      </div>

      {/* 상세 모달 — Portal 로 document.body 직접 렌더링 (sidebar/parent 의 containing block 회피) */}
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
  /** 페이지 사용처 — 비어있으면 '사용 안 됨' 표시. PageManager 인덱스에서 자동 갱신. */
  usage: Array<{ pageSlug: string; usedAt: number }>;
}) {
  const isError = item.status === 'error';
  const canRegenerate = !!item.prompt; // prompt 있어야 재실행 가능
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  // SSR 안전: client 마운트 후에만 portal 활성화
  useEffect(() => { setMounted(true); }, []);
  // 키보드 ← → 로 이전/다음, Esc 로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) onPrev();
      else if (e.key === 'ArrowRight' && hasNext) onNext();
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPrev, hasNext, onPrev, onNext, onClose]);

  const copy = (text: string, field: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 1500);
      });
    }
  };
  const url = `/${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`;
  const sizeKb = (item.bytes / 1024).toFixed(1);
  const createdStr = new Date(item.createdAt).toLocaleString('ko-KR');

  if (!mounted) return null;

  const modalContent = (
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center sm:items-center sm:p-4 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
      {/*
        모달 크기 — 모바일은 inset-0 의 자식 flex item 으로 자연스러운 viewport 높이 채움.
        - 외부 fixed inset-0 + flex items-stretch → 모달이 부모 높이 자동 계산 (viewport unit 의존 X)
        - viewport unit (vh/dvh/svh) 은 일부 모바일 브라우저(Samsung Internet)에서 부정확 → 사용 회피
        - 안전을 위해 헤더 paddingTop·버튼 paddingBottom 에 env(safe-area-inset-*) 추가
        Portal 로 document.body 에 직접 렌더 → sidebar 등 부모의 containing block 회피.
      */}
      <div
        className="bg-white w-full sm:max-w-3xl sm:rounded-2xl rounded-t-none shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-full sm:h-[85vh] sm:max-h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 — N/total 인디케이터 + prev/next + 닫기. safe-area-inset-top 으로 status bar 침범 방지 */}
        <div
          className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-slate-100 bg-slate-50 shrink-0 gap-2"
          style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}
        >
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 truncate min-w-0 flex-1">
            <ImageIcon size={14} className="text-blue-500 shrink-0" />
            <span className="truncate">{item.filenameHint || item.slug}</span>
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[11px] text-slate-400 tabular-nums px-1">{index + 1} / {total}</span>
            {/* 헤더 화살표 — PC 전용 (모바일은 이미지 좌우 floating 버튼으로 대체, 중복 회피) */}
            <Tooltip label="이전 (←)">
              <button
                onClick={onPrev}
                disabled={!hasPrev}
                className="hidden md:inline-flex p-1.5 rounded text-slate-500 hover:bg-slate-200 disabled:opacity-30 transition-colors"
                aria-label="이전"
              >
                <ChevronLeft size={18} />
              </button>
            </Tooltip>
            <Tooltip label="다음 (→)">
              <button
                onClick={onNext}
                disabled={!hasNext}
                className="hidden md:inline-flex p-1.5 rounded text-slate-500 hover:bg-slate-200 disabled:opacity-30 transition-colors"
                aria-label="다음"
              >
                <ChevronRight size={18} />
              </button>
            </Tooltip>
            <button onClick={onClose} className="md:ml-1 text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-200" aria-label="닫기">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* 본문 — 모바일 flex-col / PC flex-row */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 p-3 sm:p-4 overflow-hidden">
          {/* 프리뷰 — 높이 고정 (모바일: viewport 의 1/3 정도, basis 로 자연 비율).
              status='error' / 'rendering' / 'done' 3 분기. 그리드와 동일 패턴.
              cache busting (?v=bytes) — 모바일 브라우저가 placeholder 단계의 회색 응답을
              cache 한 후 done swap 시 같은 URL 재요청해도 cache hit 으로 회색 박힘 방지. */}
          <div className={`relative shrink-0 md:flex-1 md:min-w-0 basis-[30%] md:basis-auto md:h-auto md:max-h-full rounded-lg p-2 flex items-center justify-center overflow-hidden ${
            isError ? 'bg-red-50 border border-red-200' : item.status === 'rendering' ? 'bg-blue-50 border border-blue-200' : 'bg-slate-50'
          }`}>
            {isError ? (
              <div className="flex flex-col items-center gap-2 text-center px-4 py-6">
                <AlertTriangle size={32} className="text-red-500" />
                <div className="text-sm font-bold text-red-700">이미지 생성 실패</div>
                {item.errorMsg && (
                  <p className="text-[11px] text-red-600 break-words leading-relaxed max-w-xs">{item.errorMsg}</p>
                )}
                {item.prompt && (
                  <p className="text-[10px] text-slate-500 italic mt-1">위 프롬프트로 재생성을 시도할 수 있습니다.</p>
                )}
              </div>
            ) : item.status === 'rendering' ? (
              <div className="flex flex-col items-center gap-2 text-center px-4 py-6 text-blue-600">
                <Loader2 size={32} className="animate-spin" />
                <div className="text-sm font-bold">이미지 생성 중…</div>
                <p className="text-[11px] text-slate-500 italic mt-1">완료 후 자동으로 표시됩니다.</p>
              </div>
            ) : (
              <img
                src={`${url}?v=${item.bytes || item.createdAt}`}
                alt={item.filenameHint || item.slug}
                className="max-w-full max-h-full object-contain rounded"
              />
            )}
            {/* 모바일 prev/next floating — 모바일 전용 (헤더 화살표는 PC 전용, 중복 회피).
                hasPrev/Next 항상 렌더해서 위치 안정 — disabled 시 opacity 만 낮춤 (cursor 모양 변경 X) */}
            <button
              onClick={onPrev}
              disabled={!hasPrev}
              className="md:hidden absolute left-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/40 text-white hover:bg-slate-900/60 disabled:opacity-20 transition-colors"
              aria-label="이전"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              onClick={onNext}
              disabled={!hasNext}
              className="md:hidden absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/40 text-white hover:bg-slate-900/60 disabled:opacity-20 transition-colors"
              aria-label="다음"
            >
              <ChevronRight size={20} />
            </button>
          </div>

          {/* 우측 컬럼 — 프롬프트만 스크롤, 메타·버튼 고정 */}
          <div className="flex-1 md:flex-none md:w-64 md:shrink-0 min-h-0 flex flex-col gap-2 text-[12px]">
            {/* 프롬프트 — 항상 렌더(prompt 없을 때 placeholder). flex-1 유지로 메타·버튼 위치 일정 */}
            <div className="flex-1 min-h-[60px] overflow-y-auto pr-1 border-b border-slate-100 pb-2">
              {item.prompt && (
                <div className="mb-2">
                  <div className="flex items-center gap-1 text-slate-400 font-bold uppercase text-[10px] mb-0.5"><Sparkles size={10} /> 프롬프트</div>
                  <p className="text-slate-700 break-words leading-relaxed">{item.prompt}</p>
                </div>
              )}
              {item.revisedPrompt && item.revisedPrompt !== item.prompt && (
                <div>
                  <div className="text-slate-400 font-bold uppercase text-[10px] mb-0.5">AI 수정본</div>
                  <p className="text-slate-600 break-words italic leading-relaxed">{item.revisedPrompt}</p>
                </div>
              )}
              {!item.prompt && !item.revisedPrompt && (
                <p className="text-slate-400 italic text-[11px]">프롬프트 정보 없음</p>
              )}
            </div>

            {/* 메타 정보 — 항상 같은 행 수 (누락은 "—" placeholder). 위치 완전 고정 */}
            <div className="shrink-0 flex flex-col gap-1.5">
              <MetaRow icon={<Calendar size={10} />} label="생성" value={createdStr} />
              <MetaRow label="모델" value={item.model || '—'} />
              <MetaRow label="사이즈" value={item.size || '—'} />
              <MetaRow label="품질" value={item.quality || '—'} />
              <MetaRow icon={<Ruler size={10} />} label="해상도" value={(item.width && item.height) ? `${item.width} × ${item.height}` : '—'} />
              <MetaRow
                icon={<Crop size={10} />}
                label="비율"
                value={item.aspectRatio
                  ? `${item.aspectRatio}${item.focusPoint ? ` (${typeof item.focusPoint === 'string' ? item.focusPoint : 'xy'})` : ''}`
                  : '—'}
              />
              <MetaRow label="원본" value={`${sizeKb} KB · ${item.ext.toUpperCase()}`} />
              <MetaRow label="Variants" value={item.variants && item.variants.length > 0
                ? `${item.variants.length}개 (${[...new Set(item.variants.map(v => v.format))].join('/')})`
                : '없음'} />
              <MetaRow label="Blurhash" value={item.blurhash ? '✓ 생성됨' : '✗'} />
              {/* 사용처 — 페이지 PageSpec 안 박힌 곳. 빈 배열 = '사용 안 됨'. */}
              <div className="flex items-start gap-1.5 text-[11px]">
                <span className="shrink-0 text-slate-400 font-bold uppercase text-[10px] mt-0.5 min-w-[64px]">사용처</span>
                {usage.length === 0 ? (
                  <span className="text-slate-400 italic">사용 안 됨</span>
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
                      <span className="text-slate-400 text-[10px]">+{usage.length - 5}개 더</span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 버튼 — 위치 고정 (하단). safe-area-inset-bottom 으로 브라우저 하단 툴바·home indicator 침범 방지.
                재생성 버튼은 prompt 있을 때만 — 에러 상태면 강조(빨강), 정상 상태면 보조(파랑).
                URL/마크다운 복사는 실제 파일이 있을 때만 (status!='error'). */}
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
                    ? <><Loader2 size={12} className="animate-spin" /> 재생성 중…</>
                    : <><RefreshCw size={12} /> {isError ? '같은 프롬프트로 재시도' : '재생성'}</>}
                </button>
              )}
              {!isError && (
                <div className="relative">
                  <button
                    onClick={() => copy(url, 'url')}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
                  >
                    <Copy size={12} /> URL 복사
                  </button>
                  <FeedbackBadge state={copiedField === 'url' ? 'ok' : null} okLabel="복사됨" absolute />
                </div>
              )}
              {!isError && (
                <div className="relative">
                  <button
                    onClick={() => copy(`![${item.filenameHint || ''}](${url})`, 'md')}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
                  >
                    <Copy size={12} /> 마크다운 복사
                  </button>
                  <FeedbackBadge state={copiedField === 'md' ? 'ok' : null} okLabel="복사됨" absolute />
                </div>
              )}
              <button
                onClick={onDelete}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-lg transition-colors"
              >
                <Trash2 size={12} /> 삭제
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // Portal — document.body 직접 렌더링으로 sidebar/parent 의 fixed containing block 회피
  return createPortal(modalContent, document.body);
}

function MetaRow({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-slate-400 font-bold uppercase text-[10px] flex items-center gap-1 shrink-0">{icon} {label}</span>
      <span className="text-slate-700 text-right break-all">{value}</span>
    </div>
  );
}
