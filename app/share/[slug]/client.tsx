'use client';

import { Ghost } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import { ComponentRenderer } from '../../(user)/[...slug]/components';
import { isSuggestionClickUserMessage, isSectionStartBlock, escapeHtmlTagMentions } from '../../admin/hooks/chat-manager';
import { usePublicTranslations } from '../../../lib/i18n';
import { useViewportMaxHeight } from '../../../lib/use-viewport-size';
import { maskMath, splitFirebatRender } from '../../../lib/util/md';

/** 공유 페이지 텍스트 준비 — 수식($...$) 보호 → HTML 태그 escape + **bold** 주입 → 복원 (admin renderMarkdown 과 동일 취지). */
function prepShare(s: string): string {
  const { masked, restore } = maskMath(s);
  return restore(
    escapeHtmlTagMentions(masked)
      .replace(/\*\*([^\n*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*\*/g, ''),
  );
}

// 공유 페이지 전용 읽기 전용 메시지 리스트. 인터랙티브 버튼(승인/거부/즉시전송 등)은 빼되,
// suggest 선택 결과 · 페이지 발행/예약 결과 · PB 진행 단계는 읽기전용으로 보여 대화 맥락이 이어지게 한다.
// (복사·공유 버튼만 제거 — 결과 카드는 표시.)

type ShareSuggestion = string | { type?: string; label?: string; options?: string[]; [k: string]: unknown };
type SharePending = { planId?: string; name: string; summary?: string; args?: Record<string, unknown>; status?: string; errorMessage?: string };

type ShareMessage = {
  id?: string;
  role?: 'user' | 'system';
  content?: string;
  image?: string;
  pickedSuggestion?: string;
  suggestions?: ShareSuggestion[];
  pendingActions?: SharePending[];
  data?: ({ blocks?: Array<{ type: 'text' | 'html' | 'component'; text?: string; htmlContent?: string; htmlHeight?: string; name?: string; props?: Record<string, unknown> }>; buildSession?: { step?: string; status?: string } } & Record<string, unknown>) | unknown[];
};

const mdComponents = {
  h1: (props: any) => <h1 className="text-[18px] font-bold text-slate-800 mt-5 mb-2" {...props} />,
  h2: (props: any) => <h2 className="text-[16px] font-bold text-slate-800 mt-4 mb-1.5" {...props} />,
  h3: (props: any) => <h3 className="text-[15px] font-bold text-slate-800 mt-3 mb-1" {...props} />,
  h4: (props: any) => <h4 className="text-[14px] font-bold text-slate-700 mt-2 mb-1" {...props} />,
  p: (props: any) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props: any) => <ul className="list-disc list-outside ml-5 mb-2 space-y-1" {...props} />,
  ol: (props: any) => <ol className="list-decimal list-outside ml-5 mb-2 space-y-1" {...props} />,
  li: (props: any) => <li className="pl-0.5" {...props} />,
  strong: (props: any) => <strong className="font-bold text-slate-900" {...props} />,
  a: (props: any) => <a className="text-blue-600 hover:text-blue-800 underline" target="_blank" rel="noopener noreferrer" {...props} />,
  code: ({ inline, className, children, ...props }: any) => {
    if (inline) return <code className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[13px] font-mono" {...props}>{children}</code>;
    return <pre className="bg-slate-50 text-slate-800 p-4 overflow-x-auto text-[13px] font-mono rounded-xl border border-slate-200"><code {...props}>{children}</code></pre>;
  },
  blockquote: (props: any) => <blockquote className="border-l-3 border-slate-300 pl-3 text-slate-600 italic mb-2" {...props} />,
  table: (props: any) => (
    <div className="overflow-auto mb-2 rounded-xl border border-slate-200">
      <table className="min-w-full text-[13px] border-separate border-spacing-0" {...props} />
    </div>
  ),
  th: (props: any) => <th className="bg-slate-50 px-3 py-1.5 text-left font-bold text-slate-700 sticky top-0 z-10 border-b border-slate-200 min-w-[120px]" {...props} />,
  td: (props: any) => <td className="px-3 py-1.5 text-slate-600 border-b border-slate-100 min-w-[120px] align-top break-words" {...props} />,
};

// ── 읽기전용 카드 ────────────────────────────────────────────────────────────
// admin 채팅의 잠긴 suggest / PB stepper / 승인 카드를 공유에선 "결과"만 표시(버튼·핸들러 없음).
// 라벨은 usePublicTranslations 로 i18n — LangProvider 없이 <html lang>(=siteLang) 따라 ko/en 자동.
// 발행 페이지 컴포넌트(PlanCard 등)가 쓰는 공개 i18n 과 동일 메커니즘 + admin 과 같은 키 재사용.

// suggest 선택 결과 — admin 잠긴 카드(pickedSuggestion 경로)와 동일 톤. 칩에 안 잡힌 픽(직접 입력)은 파란 줄로.
function ReadonlySuggestCard({ suggestions, picked }: { suggestions: ShareSuggestion[]; picked?: string }) {
  const pick = (picked ?? '').trim();
  const isPicked = (s: string) => !!s && !!pick && pick.includes(s);
  const items = suggestions.filter(it => (typeof it === 'string' ? it.trim().length > 0 : !!it));
  if (items.length === 0 && !pick) return null;
  // 칩/토글 옵션 어디에도 안 잡힌 픽 = 직접 입력 또는 input 타입 픽 → 파란 줄로 한 번 표시.
  const represented = items.some(it => {
    if (typeof it === 'string') return pick.includes(it.trim());
    if (it.type === 'toggle' && Array.isArray(it.options)) return it.options.some(o => pick.includes(o));
    return false;
  });
  const pickRow = pick && !represented ? pick : '';
  return (
    <div className="border border-blue-200/60 rounded-2xl overflow-hidden bg-gradient-to-br from-white to-blue-50/40 shadow-sm w-full max-w-md sm:ml-auto">
      {items.map((item, i) => {
        if (typeof item === 'string') {
          const sel = isPicked(item);
          const mk = item.trimStart();
          const cancelMk = /^[✕✗×]/.test(mk);
          const approveMk = /^✓/.test(mk);
          const selCls = !sel ? 'text-slate-400' : cancelMk ? 'bg-rose-50 text-rose-700' : approveMk ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700';
          return (
            <div key={i} className={`w-full flex items-center justify-between gap-2 px-4 py-3 text-[13px] font-medium border-b border-blue-100/70 last:border-b-0 ${selCls}`}>
              <span className="min-w-0">{item}</span>
              {sel && !cancelMk && !approveMk && <span className="shrink-0 text-blue-500" aria-hidden>✓</span>}
            </div>
          );
        }
        if (item.type === 'toggle' && Array.isArray(item.options)) {
          return (
            <div key={i} className="flex flex-col px-4 py-3 border-b border-slate-200 last:border-b-0">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{item.label}</span>
              <div className="flex flex-col gap-1 mt-2">
                {item.options.map(opt => {
                  const sel = isPicked(opt);
                  return (
                    <div key={opt} className={`w-full px-4 py-2.5 text-left text-[13px] font-medium rounded-xl border flex items-center justify-between gap-2 ${sel ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-slate-400 border-slate-100'}`}>
                      <span>{opt}</span>
                      {sel && <span className="shrink-0 text-blue-500" aria-hidden>✓</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }
        return item.label ? (
          <div key={i} className="px-4 py-3 text-[12px] font-semibold text-slate-400 border-b border-blue-100/70 last:border-b-0">{item.label}</div>
        ) : null;
      })}
      {pickRow && (
        <div className="px-4 py-3 text-[13px] flex items-start gap-1.5 text-blue-700 bg-blue-50/60 border-t border-blue-100/70">
          <span className="font-bold shrink-0 text-blue-500" aria-hidden>✓</span>
          <span className="whitespace-pre-wrap break-words">{pickRow}</span>
        </div>
      )}
    </div>
  );
}

// PB 빌드 단계 — 읽기전용 stepper (admin BuildCard 헤더와 동일 단계·동일 i18n 키).
const BUILD_STEP_KEYS = [
  { key: 'requirements', i18n: 'build.step_requirements' },
  { key: 'design', i18n: 'build.step_design' },
  { key: 'refine', i18n: 'build.step_refine' },
  { key: 'implement', i18n: 'build.step_implement' },
];
function ReadonlyBuildStepper({ bs }: { bs: { step?: string; status?: string } }) {
  const t = usePublicTranslations();
  const curIdx = BUILD_STEP_KEYS.findIndex(s => s.key === bs.step);
  const allDone = bs.status === 'completed';
  return (
    <div className="border border-blue-200/60 rounded-2xl bg-gradient-to-br from-white to-blue-50/40 shadow-sm w-full px-4 py-3">
      <div className="flex items-center gap-1.5">
        {BUILD_STEP_KEYS.map((s, i) => {
          const state = allDone || (curIdx >= 0 && i < curIdx) ? 'done' : i === curIdx ? 'cur' : 'todo';
          return (
            <div key={s.key} className="flex items-center gap-1.5 flex-1 last:flex-none">
              <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${state === 'done' ? 'bg-blue-100 text-blue-600' : state === 'cur' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span className={`text-[12px] font-medium ${state === 'cur' ? 'text-blue-700' : state === 'done' ? 'text-slate-500' : 'text-slate-400'}`}>{t(s.i18n)}</span>
              {i < BUILD_STEP_KEYS.length - 1 && <span className="flex-1 h-px bg-slate-200 min-w-[8px]" aria-hidden />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 승인 카드 결과 — 발행/예약/실행/취소 상태 (버튼 없음). admin planSummary 와 동일 i18n 키 재사용.
function shareSummary(p: SharePending, t: (k: string, params?: Record<string, string | number>) => string): string {
  const a = (p.args ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (p.name) {
    case 'save_page': return t('plan.summary_save_page', { slug: s('slug') });
    case 'delete_page': return t('plan.summary_delete_page', { slug: s('slug') });
    case 'write_file': return t('plan.summary_write_file', { path: s('path') });
    case 'delete_file': return t('plan.summary_delete_file', { path: s('path') });
    case 'schedule_task': return t('plan.summary_schedule', { title: s('title') || s('targetPath') });
    case 'cancel_cron_job': return t('plan.summary_cancel_cron', { job: s('jobId') });
    default: return p.summary || p.name;
  }
}
function ReadonlyPendingActions({ actions }: { actions: SharePending[] }) {
  const t = usePublicTranslations();
  return (
    <div className="flex flex-col gap-2">
      {actions.map((p, idx) => {
        const status = p.status;
        const a = (p.args ?? {}) as Record<string, unknown>;
        const slug = typeof a.slug === 'string' ? (a.slug as string) : '';
        const toneCls = status === 'approved' ? 'bg-emerald-50 border-emerald-200'
          : status === 'rejected' || status === 'error' ? 'bg-rose-50 border-rose-200'
          : 'bg-amber-50 border-amber-200';
        return (
          <div key={p.planId || idx} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border ${toneCls}`}>
            <span className="flex-1 text-[13px] font-medium text-slate-700 truncate">{shareSummary(p, t)}</span>
            {status === 'approved' ? (
              <span className="inline-flex items-center gap-2 shrink-0">
                <span className="text-[12px] font-bold text-emerald-600">✓ {p.name === 'schedule_task' ? t('plan.scheduled') : t('plan.executed')}</span>
                {p.name === 'save_page' && slug && (
                  <a href={`/${slug}`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-[12px] font-bold rounded-lg border border-blue-200 transition-colors">{t('plan.open')}</a>
                )}
              </span>
            ) : status === 'rejected' ? (
              <span className="shrink-0 text-[12px] font-medium text-rose-500">{t('plan.cancelled')}</span>
            ) : status === 'error' ? (
              <span className="shrink-0 text-[12px] font-medium text-rose-600 truncate">{t('plan.exec_failed', { error: p.errorMessage || '' })}</span>
            ) : (
              <span className="shrink-0 text-[12px] font-medium text-amber-600">{t('plan.pending')}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MessageRow({ msg }: { msg: ShareMessage }) {
  // HTML iframe block 의 default height — 모바일 320px / PC 480px 캡.
  const iframeMaxH = useViewportMaxHeight({ mobile: 0.5, desktop: 0.7, mobileMaxPx: 320, desktopMaxPx: 480 });
  const iframeDefaultHeight = iframeMaxH ? `${iframeMaxH}px` : '320px';
  if (msg.role === 'user') {
    return (
      <div className="flex w-full gap-4 items-start justify-end">
        <div className="flex flex-col gap-2 max-w-[75%] items-end">
          {msg.image && (
            <img src={msg.image} alt="첨부" className="max-w-[240px] max-h-[180px] rounded-2xl border border-slate-300 shadow-md object-cover" />
          )}
          <div className="bg-slate-800 text-white px-4 py-3 sm:px-6 sm:py-4 rounded-3xl rounded-tr-sm shadow-md text-[14px] sm:text-[15.5px] leading-relaxed break-words border border-slate-700 w-fit">
            {msg.content}
          </div>
        </div>
      </div>
    );
  }
  // system (AI) 메시지 — blocks 우선, 없으면 content. data 는 배열(레거시)일 수 있어 객체일 때만 추출.
  const data = msg.data && !Array.isArray(msg.data) ? msg.data : undefined;
  const blocks = data?.blocks;
  const bs = data?.buildSession;
  return (
    <div className="flex w-full gap-2 sm:gap-4 items-start">
      <div className="hidden sm:flex w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-50 to-blue-100 border border-blue-200 items-center justify-center shadow-sm shrink-0">
        <Ghost size={22} className="text-blue-600" />
      </div>
      <div className="flex flex-col gap-3 flex-1 min-w-0 sm:pt-3">
        {Array.isArray(blocks) && blocks.length > 0 ? (
          blocks.map((b, i) => {
            // 섹션 경계 (Header / Divider) 앞에 추가 여백 — admin 대화창과 동일 규칙 (chat-manager.isSectionStartBlock)
            const wrapCls = isSectionStartBlock(b, i) ? 'mt-5' : '';
            if (b.type === 'text' && b.text) {
              return (
                <div key={i} className={`text-slate-800 text-[14px] sm:text-[15px] leading-relaxed space-y-1 ${wrapCls}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]} components={mdComponents}>{prepShare(b.text)}</ReactMarkdown>
                </div>
              );
            }
            if (b.type === 'html' && b.htmlContent) {
              // iframe 렌더 — 공유 페이지에서도 동일 sandbox 적용
              return (
                <iframe
                  key={i}
                  srcDoc={b.htmlContent}
                  sandbox="allow-scripts"
                  className={`w-full border border-slate-200 rounded-xl bg-white block ${wrapCls}`}
                  style={{ height: b.htmlHeight || iframeDefaultHeight }}
                  title="Shared HTML"
                />
              );
            }
            if (b.type === 'component' && b.name) {
              return (
                <div key={i} className={wrapCls}>
                  <ComponentRenderer components={[{ type: b.name, props: b.props || {} }]} />
                </div>
              );
            }
            return null;
          })
        ) : msg.content ? (
          <div className="text-slate-800 text-[14px] sm:text-[15px] leading-relaxed space-y-1">
            {/* firebat-render fence(텍스트 채널 render)는 ComponentRenderer 직접, 나머지만 마크다운 */}
            {splitFirebatRender(msg.content ?? '').map((s, i) =>
              'blocks' in s
                ? <ComponentRenderer key={i} components={s.blocks} />
                : <ReactMarkdown key={i} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, rehypeKatex]} components={mdComponents}>{prepShare(s.md)}</ReactMarkdown>,
            )}
          </div>
        ) : null}
        {/* 읽기전용 결과 카드 — PB 진행 / suggest 선택 결과(직접 입력 포함) / 발행·예약 결과. 대화 맥락 유지. */}
        {bs && bs.step && <ReadonlyBuildStepper bs={bs} />}
        {Array.isArray(msg.suggestions) && msg.suggestions.length > 0 && (
          <ReadonlySuggestCard suggestions={msg.suggestions} picked={msg.pickedSuggestion} />
        )}
        {Array.isArray(msg.pendingActions) && msg.pendingActions.length > 0 && (
          <ReadonlyPendingActions actions={msg.pendingActions} />
        )}
      </div>
    </div>
  );
}

export function SharedMessageList({ messages }: { messages: unknown[] }) {
  const msgs = (messages as ShareMessage[]).filter(m => {
    if (!m) return false;
    if (m.id === 'system-init') return false;
    if (m.role !== 'user' && m.role !== 'system') return false;
    // 버튼 클릭 흔적 user 말풍선 (✓실행 등) 은 읽기 전용 공유 페이지에서 불필요 — 실제 실행 버튼처럼 보이는 착시 유발
    if (isSuggestionClickUserMessage(m)) return false;
    return true;
  });
  // 어드민 대화창과 동일한 반응형 너비 — px-3 md:px-12 + w-full md:w-[70%] max-w-6xl
  return (
    <div className="w-full px-3 md:px-12 py-6 md:py-10">
      <div className="w-full md:w-[70%] max-w-6xl mx-auto space-y-10">
        {msgs.map((m, i) => <MessageRow key={m.id || i} msg={m} />)}
      </div>
    </div>
  );
}
