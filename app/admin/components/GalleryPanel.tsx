'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, Loader2, X, Copy, Check, Trash2, Image as ImageIcon, Sparkles, Calendar, Ruler, Crop, ChevronLeft, ChevronRight } from 'lucide-react';
import { Tooltip } from './Tooltip';

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

  const handleLoadMore = () => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    // offset 변경 후 fetchList 를 리셋없이 호출 — 다음 useEffect 대신 직접
    setTimeout(() => fetchList(false), 0);
  };

  const handleDelete = async (slug: string) => {
    if (!window.confirm('이 이미지를 삭제하시겠어요? (원본 + 모든 variants + 썸네일 일괄 삭제)')) return;
    try {
      const res = await fetch(`/api/media/list?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setItems(prev => prev.filter(i => i.slug !== slug));
        setSelectedIndex(null);
      } else {
        alert(`삭제 실패: ${data.error || 'unknown'}`);
      }
    } catch (err: any) {
      alert(`삭제 실패: ${err.message}`);
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
              const thumbSrc = item.thumbnailUrl || `/${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`;
              return (
                <Tooltip key={`${item.scope}-${item.slug}`} label={item.filenameHint || item.slug}>
                <button
                  onClick={() => setSelectedIndex(idx)}
                  className="group relative aspect-square bg-slate-100 rounded-md overflow-hidden hover:ring-2 hover:ring-blue-400 transition-all"
                >
                  <img
                    src={thumbSrc}
                    alt={item.filenameHint || item.slug}
                    loading="lazy"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
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
        />
      )}
    </div>
  );
}

function MediaDetailModal({
  item, index, total, hasPrev, hasNext, onPrev, onNext, onClose, onDelete,
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
}) {
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center sm:p-4 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
      {/*
        모달 — dvh (dynamic viewport height) 사용해서 모바일 주소창 변화 대응.
        모바일: 100dvh (전체 화면) / PC: 85vh
        Portal 로 document.body 에 직접 렌더 → sidebar 등 부모의 containing block 회피.
      */}
      <div
        className="bg-white w-full sm:max-w-3xl sm:rounded-2xl rounded-t-none shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[100dvh] sm:h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 — N/total 인디케이터 + prev/next + 닫기 */}
        <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-slate-100 bg-slate-50 shrink-0 gap-2">
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
          {/* 프리뷰 — 높이 고정 (모바일 30dvh / PC flex-1) + 좌우 swipe-style 버튼 (모바일) */}
          <div className="relative shrink-0 md:flex-1 md:min-w-0 h-[30dvh] md:h-auto md:max-h-full bg-slate-50 rounded-lg p-2 flex items-center justify-center overflow-hidden">
            <img
              src={url}
              alt={item.filenameHint || item.slug}
              className="max-w-full max-h-full object-contain rounded"
            />
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
            </div>

            {/* 버튼 — 위치 고정 (하단) */}
            <div className="shrink-0 flex flex-col gap-1.5 pt-1">
              <button
                onClick={() => copy(url, 'url')}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
              >
                {copiedField === 'url' ? <><Check size={12} className="text-emerald-600" /> 복사됨</> : <><Copy size={12} /> URL 복사</>}
              </button>
              <button
                onClick={() => copy(`![${item.filenameHint || ''}](${url})`, 'md')}
                className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
              >
                {copiedField === 'md' ? <><Check size={12} className="text-emerald-600" /> 복사됨</> : <><Copy size={12} /> 마크다운 복사</>}
              </button>
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
