'use client';

/**
 * CmsFullPage — CMS 설정 풀스크린 + 라이브 미리보기.
 *
 * 진입: 어드민 안에서만 (사이드바 CMS / 설정 모달 → 시스템 모듈 → CMS).
 * URL 변경 X (/admin 그대로) → 직접 URL 진입 자체 불가 — 보안 부수 효과.
 *
 * 레이아웃:
 *   - 좌측 (40% / 모바일 100%) — SystemModuleSettings (CMS 탭 8종)
 *   - 우측 (60% / 모바일 hidden) — iframe `/` 라이브 미리보기 + 새로고침 버튼
 *   - 저장 시 우측 자동 새로고침 (변경 즉시 확인)
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { RefreshCw, X, ArrowLeft, ExternalLink, Monitor, Tablet, Smartphone } from 'lucide-react';
import { SystemModuleSettings } from './SystemModuleSettings';

type Viewport = 'desktop' | 'tablet' | 'mobile';
const VIEWPORT_CONFIG: Record<Viewport, { width: number; label: string; Icon: typeof Monitor }> = {
  desktop: { width: 1280, label: 'PC (1280px)', Icon: Monitor },
  tablet: { width: 768, label: '태블릿 (768px)', Icon: Tablet },
  mobile: { width: 375, label: '모바일 (375px)', Icon: Smartphone },
};

interface Props {
  onClose: () => void;
  onBack?: () => void;
}

export function CmsFullPage({ onClose, onBack }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeKey, setIframeKey] = useState(0);  // key 변경으로 강제 새로고침
  const [previewPath, setPreviewPath] = useState('/');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // 컨테이너 폭 측정 — viewport scale ratio 계산용. ResizeObserver 로 자동 추적.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 저장 시점 감지 — SystemModuleSettings 가 발행하는 'firebat-refresh' 이벤트 수신.
  // CMS 설정 변경·저장 시 useLocalRefresh emitLocalRefresh() 호출 → 여기서 받아 iframe 새로고침.
  useEffect(() => {
    const handler = () => setIframeKey(k => k + 1);
    window.addEventListener('firebat-refresh', handler);
    return () => window.removeEventListener('firebat-refresh', handler);
  }, []);

  const refreshIframe = useCallback(() => setIframeKey(k => k + 1), []);

  return (
    <div className="fixed top-12 left-0 right-0 bottom-0 z-40 bg-white flex flex-col">
      {/* 상단 바 — 뒤로/제목/외부 열기/닫기 */}
      <div className="flex items-center gap-2 px-3 sm:px-4 h-12 border-b border-slate-200 bg-slate-50 flex-shrink-0">
        {onBack && (
          <button
            onClick={onBack}
            className="text-slate-600 hover:text-slate-900 hover:bg-slate-200 rounded p-1.5"
            aria-label="설정으로 돌아가기"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="font-medium text-slate-900 text-sm">CMS 설정</div>
        <div className="text-xs text-slate-500 ml-2 hidden sm:block">사이트 디자인·레이아웃·SEO 통합</div>
        <div className="flex-1" />
        {/* Viewport 토글 — PC / 태블릿 / 모바일 (PC 만 노출) */}
        <div className="hidden md:flex items-center gap-0.5 bg-white border border-slate-300 rounded p-0.5">
          {(['desktop', 'tablet', 'mobile'] as Viewport[]).map((v) => {
            const cfg = VIEWPORT_CONFIG[v];
            const Icon = cfg.Icon;
            const active = viewport === v;
            return (
              <button
                key={v}
                onClick={() => setViewport(v)}
                title={cfg.label}
                aria-label={cfg.label}
                aria-pressed={active}
                className={`flex items-center justify-center px-1.5 py-1 rounded transition-colors ${active ? 'bg-blue-500 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                <Icon size={14} />
              </button>
            );
          })}
        </div>
        {/* 미리보기 path 입력 (PC 만) */}
        <input
          type="text"
          value={previewPath}
          onChange={(e) => setPreviewPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') refreshIframe(); }}
          placeholder="/"
          className="hidden md:block px-2 py-1 text-xs border border-slate-300 rounded w-40"
        />
        <button
          onClick={refreshIframe}
          className="hidden md:flex items-center gap-1 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 rounded"
          aria-label="미리보기 새로고침"
        >
          <RefreshCw size={14} /> 새로고침
        </button>
        <a
          href={previewPath}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden md:flex items-center gap-1 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 rounded"
        >
          <ExternalLink size={14} /> 새 탭
        </a>
        <button
          onClick={onClose}
          className="text-slate-600 hover:text-slate-900 hover:bg-slate-200 rounded p-1.5"
          aria-label="닫기"
        >
          <X size={16} />
        </button>
      </div>

      {/* 본문 — 좌 설정 패널 + 우 iframe */}
      <div className="flex-1 flex min-h-0">
        {/* 좌측 — 설정 패널. 모바일에서 풀폭, PC 에서 40% */}
        <div className="w-full md:w-2/5 md:max-w-xl border-r border-slate-200 overflow-hidden flex flex-col bg-white">
          {/* SystemModuleSettings 가 자체 닫기 버튼·헤더 가짐 — 풀페이지 안에선 닫기 onClose 비활성화 (상단바가 처리) */}
          <div className="flex-1 overflow-hidden relative">
            <SystemModuleSettings moduleName="cms" onClose={onClose} embeddedInPage />
          </div>
        </div>

        {/* 우측 — iframe (모바일 숨김). viewport 토글 시 width 변경 + scale.
         *  Desktop = 풀폭. Tablet/Mobile = 고정 너비 + 컨테이너 fit scale (가운데 정렬, 그림자). */}
        <div ref={containerRef} className="hidden md:flex flex-1 bg-slate-100 items-center justify-center overflow-auto p-4">
          {(() => {
            const cfg = VIEWPORT_CONFIG[viewport];
            const isDesktop = viewport === 'desktop';
            // 컨테이너 폭 보다 viewport 가 크면 scale down. 작으면 1.0 (실제 크기).
            const availableWidth = Math.max(0, containerWidth - 32); // padding 빼기
            const scale = !isDesktop && availableWidth > 0 && cfg.width > availableWidth
              ? availableWidth / cfg.width
              : 1;
            return (
              <div
                style={{
                  width: isDesktop ? '100%' : `${cfg.width}px`,
                  height: isDesktop ? '100%' : `${Math.round(900 * (isDesktop ? 1 : 1 / scale))}px`,
                  maxHeight: '100%',
                  transform: isDesktop ? undefined : `scale(${scale})`,
                  transformOrigin: 'top center',
                  background: '#fff',
                  boxShadow: isDesktop ? 'none' : '0 4px 16px rgba(0, 0, 0, 0.1)',
                  borderRadius: isDesktop ? 0 : '4px',
                  overflow: 'hidden',
                  flexShrink: 0,
                }}
              >
                <iframe
                  ref={iframeRef}
                  key={iframeKey}
                  src={previewPath}
                  className="w-full h-full border-0 block"
                  title="CMS 라이브 미리보기"
                  sandbox="allow-same-origin allow-scripts allow-forms"
                />
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
