'use client';

/**
 * ProjectThemeModal — the look one project's pages take, on top of the site's.
 *
 * The site has one theme; a project can override part of it, and only its own pages see the
 * difference (`user/projects/<name>/config.json`, read by the page RSC when `spec.project` matches).
 * Every field here is optional and an empty one is not written: blank means inherit, so a project
 * that sets one colour does not silently freeze the other eleven at whatever the site looked like
 * the day it was themed.
 *
 * The reading half has worked for a long time — this is the screen that was missing, which is why
 * no project had ever been themed.
 *
 * `kind: "app"` pages are unaffected by design: an app has no site chrome to restyle.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { X, Loader2, RotateCcw } from 'lucide-react';
import { apiGet, apiPatch } from '../../../lib/api-fetch';
import { logger } from '../../../lib/util/logger';

/** The colour tokens worth exposing — the ones the renderer actually reads. Korean labels because
 *  a person reads them; the keys are the token names. */
const COLORS: Array<[key: string, label: string, hint: string]> = [
  ['primary', '주 강조색', '링크·기본 버튼'],
  ['accent', '보조 강조색', '배지·보조 CTA'],
  ['up', '상승', '한국 관례 = 빨강'],
  ['down', '하락', '한국 관례 = 파랑'],
  ['text', '본문 글자', ''],
  ['textMuted', '보조 글자', '캡션·메타'],
  ['bg', '페이지 배경', ''],
  ['bgCard', '카드 배경', ''],
  ['border', '테두리', ''],
];

interface ThemeConfig {
  theme?: {
    vars?: Record<string, string>;
    heading?: { h1?: string; h2?: string; h3?: string };
    contentMaxWidth?: string;
  };
  customCss?: string;
  [k: string]: unknown;
}

export function ProjectThemeModal({ project, onClose }: { project: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [heading, setHeading] = useState<{ h1: string; h2: string; h3: string }>({ h1: '', h2: '', h3: '' });
  const [maxWidth, setMaxWidth] = useState('');
  const [css, setCss] = useState('');
  const [rest, setRest] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiGet<{ success: boolean; config?: ThemeConfig }>(
          `/api/fs/projects?project=${encodeURIComponent(project)}`,
          { category: 'projects' },
        );
        if (!alive) return;
        const cfg = (res.success ? res.config : {}) ?? {};
        const { theme, customCss, ...others } = cfg;
        setVars(theme?.vars ?? {});
        setHeading({ h1: theme?.heading?.h1 ?? '', h2: theme?.heading?.h2 ?? '', h3: theme?.heading?.h3 ?? '' });
        setMaxWidth(theme?.contentMaxWidth ?? '');
        setCss(typeof customCss === 'string' ? customCss : '');
        // Anything this screen does not edit is carried through untouched — a config written by
        // hand or by a later version must not be erased by saving from here.
        setRest(others);
      } catch (e) {
        logger.debug('projects', '프로젝트 테마 조회 실패', { error: e });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [project]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    // Blank = inherit, so an empty field is left out rather than written as "".
    const keptVars = Object.fromEntries(Object.entries(vars).filter(([, v]) => v.trim()));
    const keptHeading = Object.fromEntries(
      Object.entries(heading).filter(([, v]) => v.trim()),
    ) as Record<string, string>;
    const theme: Record<string, unknown> = {};
    if (Object.keys(keptVars).length) theme.vars = keptVars;
    if (Object.keys(keptHeading).length) theme.heading = keptHeading;
    if (maxWidth.trim()) theme.contentMaxWidth = maxWidth.trim();
    const config: Record<string, unknown> = { ...rest };
    if (Object.keys(theme).length) config.theme = theme; else delete config.theme;
    if (css.trim()) config.customCss = css; else delete config.customCss;
    try {
      const res = await apiPatch<{ success: boolean; error?: string }>(
        '/api/fs/projects',
        { action: 'config', project, config },
        { category: 'projects' },
      );
      if (!res.success) { setError(res.error ?? '저장하지 못했습니다.'); return; }
      onClose();
    } catch (e) {
      setError('저장하지 못했습니다.');
      logger.debug('projects', '프로젝트 테마 저장 실패', { error: e });
    } finally {
      setSaving(false);
    }
  }, [vars, heading, maxWidth, css, rest, project, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 id={titleId} className="text-sm font-bold text-slate-800">
            프로젝트 테마 — {project}
          </h3>
          <button type="button" onClick={onClose} aria-label="닫기" className="text-slate-400 hover:text-slate-600">
            <X size={16} />
          </button>
        </div>
        <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
          이 프로젝트에 속한 페이지에만 적용됩니다. 비워 두면 사이트 설정을 그대로 물려받습니다.
          앱(<code>kind: app</code>) 페이지는 사이트 크롬이 없어 영향을 받지 않습니다.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-[12px] text-slate-500">
            <Loader2 size={14} className="animate-spin" /> 불러오는 중입니다
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {COLORS.map(([key, label, hint]) => (
                <label key={key} className="flex items-center gap-2 text-[11px] text-slate-600">
                  <input
                    type="color"
                    aria-label={`${label} 색`}
                    value={/^#[0-9a-f]{6}$/i.test(vars[key] ?? '') ? vars[key] : '#000000'}
                    onChange={e => setVars(v => ({ ...v, [key]: e.target.value }))}
                    className="h-6 w-8 shrink-0 cursor-pointer rounded border border-slate-200 bg-white"
                  />
                  <span className="w-20 shrink-0">
                    {label}
                    {hint && <span className="block text-[10px] text-slate-400">{hint}</span>}
                  </span>
                  <input
                    type="text"
                    aria-label={`${label} 값`}
                    placeholder="상속"
                    value={vars[key] ?? ''}
                    onChange={e => setVars(v => ({ ...v, [key]: e.target.value }))}
                    className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 font-mono text-[11px]"
                  />
                  {vars[key] && (
                    <button
                      type="button"
                      aria-label={`${label} 되돌리기`}
                      title="상속으로 되돌리기"
                      onClick={() => setVars(v => { const n = { ...v }; delete n[key]; return n; })}
                      className="shrink-0 text-slate-300 hover:text-slate-500"
                    >
                      <RotateCcw size={11} />
                    </button>
                  )}
                </label>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-[11px] text-slate-600">
                본문 최대 폭
                <input
                  type="text"
                  placeholder="상속 (예: 900px)"
                  value={maxWidth}
                  onChange={e => setMaxWidth(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-200 px-2 py-1 font-mono text-[11px]"
                />
              </label>
              {(['h1', 'h2', 'h3'] as const).map(h => (
                <label key={h} className="text-[11px] text-slate-600">
                  {h.toUpperCase()} 스타일
                  <input
                    type="text"
                    placeholder="상속 (예: font-weight:800)"
                    value={heading[h]}
                    onChange={e => setHeading(s => ({ ...s, [h]: e.target.value }))}
                    className="mt-1 w-full rounded border border-slate-200 px-2 py-1 font-mono text-[11px]"
                  />
                </label>
              ))}
            </div>

            <label className="mt-4 block text-[11px] text-slate-600">
              추가 CSS
              <textarea
                rows={4}
                placeholder="이 프로젝트 페이지에만 들어갈 CSS"
                value={css}
                onChange={e => setCss(e.target.value)}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1 font-mono text-[11px]"
              />
            </label>

            {error && <p className="mt-3 text-[11px] text-red-500">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving && <Loader2 size={12} className="animate-spin" />} 저장
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
