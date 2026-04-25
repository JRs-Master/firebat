'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Loader2, X, Copy, Check, Trash2, Image as ImageIcon, Sparkles, Calendar, Ruler, Crop } from 'lucide-react';
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
  const [selected, setSelected] = useState<MediaItem | null>(null);
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
        setSelected(null);
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
            {items.map(item => {
              const thumbSrc = item.thumbnailUrl || `/${item.scope ?? 'user'}/media/${item.slug}.${item.ext}`;
              return (
                <Tooltip key={`${item.scope}-${item.slug}`} label={item.filenameHint || item.slug}>
                <button
                  onClick={() => setSelected(item)}
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

      {/* 상세 모달 */}
      {selected && (
        <MediaDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          onDelete={() => handleDelete(selected.slug)}
        />
      )}
    </div>
  );
}

function MediaDetailModal({
  item, onClose, onDelete,
}: { item: MediaItem; onClose: () => void; onDelete: () => void }) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center sm:p-4 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}>
      {/*
        모달 크기 — dvh (dynamic viewport height) 사용해서 모바일 주소창 변화 대응.
        모바일: 100dvh (전체 화면) / PC: 85vh
        구조:
          [header shrink-0]
          [body flex-1 min-h-0 flex-col(mobile) flex-row(md+)]
            [preview shrink-0 (높이 고정)]
            [right column flex-col]
              [prompt 영역 flex-1 min-h-0 overflow-y-auto] ← 프롬프트만 스크롤
              [meta rows shrink-0]   ← 위치 고정
              [buttons shrink-0]     ← 위치 고정
      */}
      <div
        className="bg-white w-full sm:max-w-3xl sm:rounded-2xl rounded-t-none shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[100dvh] sm:h-[85vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50 shrink-0">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 truncate">
            <ImageIcon size={14} className="text-blue-500 shrink-0" />
            <span className="truncate">{item.filenameHint || item.slug}</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0 p-1 rounded hover:bg-slate-200" aria-label="닫기">
            <X size={18} />
          </button>
        </div>

        {/* 본문 — 모바일 flex-col / PC flex-row */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3 p-3 sm:p-4 overflow-hidden">
          {/* 프리뷰 — 높이 고정 (모바일 30dvh / PC flex-1) */}
          <div className="shrink-0 md:flex-1 md:min-w-0 h-[30dvh] md:h-auto md:max-h-full bg-slate-50 rounded-lg p-2 flex items-center justify-center overflow-hidden">
            <img
              src={url}
              alt={item.filenameHint || item.slug}
              className="max-w-full max-h-full object-contain rounded"
            />
          </div>

          {/* 우측 컬럼 — 프롬프트만 스크롤, 메타·버튼 고정 */}
          <div className="flex-1 md:flex-none md:w-64 md:shrink-0 min-h-0 flex flex-col gap-2 text-[12px]">
            {/* 프롬프트 — flex-1 + overflow-y-auto. 길면 여기만 스크롤됨 */}
            {(item.prompt || item.revisedPrompt) && (
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
              </div>
            )}

            {/* 메타 정보 — 위치 고정 */}
            <div className="shrink-0 flex flex-col gap-1.5">
              <MetaRow icon={<Calendar size={10} />} label="생성" value={createdStr} />
              {item.model && <MetaRow label="모델" value={item.model} />}
              {item.size && <MetaRow label="사이즈" value={item.size} />}
              {item.quality && <MetaRow label="품질" value={item.quality} />}
              {(item.width && item.height) && <MetaRow icon={<Ruler size={10} />} label="해상도" value={`${item.width} × ${item.height}`} />}
              {item.aspectRatio && (
                <MetaRow
                  icon={<Crop size={10} />}
                  label="비율"
                  value={`${item.aspectRatio}${item.focusPoint ? ` (${typeof item.focusPoint === 'string' ? item.focusPoint : 'xy'})` : ''}`}
                />
              )}
              <MetaRow label="원본" value={`${sizeKb} KB · ${item.ext.toUpperCase()}`} />
              {item.variants && item.variants.length > 0 && (
                <MetaRow label="Variants" value={`${item.variants.length}개 (${[...new Set(item.variants.map(v => v.format))].join('/')})`} />
              )}
              {item.blurhash && <MetaRow label="Blurhash" value="✓ 생성됨" />}
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
}

function MetaRow({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-slate-400 font-bold uppercase text-[10px] flex items-center gap-1 shrink-0">{icon} {label}</span>
      <span className="text-slate-700 text-right break-all">{value}</span>
    </div>
  );
}
