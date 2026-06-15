'use client';
/**
 * SkillsPanel — 사이드바 SKILLS 탭 (템플릿 인접). 스킬 = 케이스별 사용 매뉴얼(.md).
 *
 * list(system∪user) 표시 + kind 배지 + 클릭 시 모나코로 user/skills/(slug).md 편집.
 * 새 스킬 — inline 모달(slug + kind) → 빈 .md 생성 후 모나코 편집. TemplatesPanel 미러.
 */
import { useId, useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, BookText } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { useTranslations } from '../../../lib/i18n';
import { confirmDialog, alertDialog } from './Dialog';
import { apiGet, apiPost, apiDelete } from '../../../lib/api-fetch';
import { RowActions, InteractiveRow } from './InteractiveRow';

interface SkillEntry {
  slug: string;
  name: string;
  kind: string;
  description: string;
  source: string; // system | user
}

const SKILL_KINDS = ['design', 'tool-usage', 'procedure', 'persona', 'policy'];

const starterBody = (slug: string) =>
  `# ${slug}\n\n언제 쓰나: (이 매뉴얼이 적용되는 케이스)\n\n단계:\n1. ...\n2. ...\n\n출력/형식: ...\n`;

export type SkillsHubContext = { slug: string; apiToken: string; sessionId: string };

export function SkillsPanel({
  onEditFile,
  hubMode,
  hubContext,
}: {
  onEditFile?: (filePath: string) => void;
  hubMode?: boolean;
  hubContext?: SkillsHubContext;
}) {
  const t = useTranslations();
  const newSlugId = useId();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newKind, setNewKind] = useState('procedure');
  const [submitting, setSubmitting] = useState(false);

  // hub fetch 헬퍼 — admin 은 /api/skills, hub 는 /api/hub/<slug>/skills dispatcher.
  const hubFetch = useCallback(async (op: string, payload: Record<string, unknown>) => {
    if (!hubContext) return null;
    const res = await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Token': hubContext.apiToken,
        'X-Session-Id': hubContext.sessionId,
      },
      body: JSON.stringify({ op, ...payload }),
    });
    return res.json().catch(() => null);
  }, [hubContext]);

  const { data, isLoading } = useQuery({
    queryKey: ['skills', hubMode && hubContext ? `hub-${hubContext.slug}` : 'admin'],
    queryFn: async () => {
      if (hubMode) {
        if (!hubContext) return { success: true, items: [] as SkillEntry[] };
        const json = await hubFetch('list', {});
        return (json ?? { success: true, items: [] }) as { success: boolean; items: SkillEntry[] };
      }
      return apiGet<{ success: boolean; items: SkillEntry[] }>('/api/skills', { category: 'skills' });
    },
  });
  const skills = data?.items ?? [];
  const loading = isLoading;
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
    [queryClient],
  );

  // AI 가 도구(save_skill)로 저장 시 firebat-refresh → 자동 재조회.
  useEffect(() => {
    const onRefresh = () => invalidate();
    window.addEventListener('firebat-refresh', onRefresh);
    return () => window.removeEventListener('firebat-refresh', onRefresh);
  }, [invalidate]);

  const openCreate = useCallback(() => {
    setNewSlug('');
    setNewKind('procedure');
    setCreating(true);
  }, []);

  const submitCreate = useCallback(async () => {
    const slug = newSlug.trim();
    if (!slug) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      await alertDialog({ title: '잘못된 slug', message: 'slug 는 영숫자·하이픈·언더스코어만 가능합니다.', danger: true });
      return;
    }
    if (skills.some(s => s.slug === slug)) {
      await alertDialog({ title: '중복', message: `"${slug}" 스킬이 이미 존재합니다.`, danger: true });
      return;
    }
    setSubmitting(true);
    try {
      const payload = { slug, kind: newKind, name: slug, description: '', content: starterBody(slug) };
      const res = hubMode && hubContext
        ? await hubFetch('save', payload)
        : await apiPost<{ success: boolean; error?: string }>('/api/skills', payload, { category: 'skills' });
      if (!res?.success) {
        await alertDialog({ title: '생성 실패', message: res?.error || '알 수 없는 오류', danger: true });
        return;
      }
      await invalidate();
      setCreating(false);
      // hub mode 면 FileEditor 가 admin filesystem 호출이라 의미 0 — skip.
      if (!hubMode) onEditFile?.(`user/skills/${slug}.md`);
    } finally {
      setSubmitting(false);
    }
  }, [newSlug, newKind, skills, invalidate, onEditFile, hubMode, hubContext, hubFetch]);

  const handleDelete = useCallback(async (slug: string, source: string) => {
    if (source === 'system') {
      await alertDialog({ title: '삭제 불가', message: '시스템(기본) 스킬은 repo 에서 관리합니다.', danger: true });
      return;
    }
    if (!await confirmDialog({ title: '스킬 삭제', message: `"${slug}" 스킬을 삭제하시겠습니까?`, danger: true, okLabel: '삭제' })) return;
    const res = hubMode && hubContext
      ? await hubFetch('delete', { slug })
      : await apiDelete<{ success: boolean; error?: string }>(`/api/skills?slug=${encodeURIComponent(slug)}`, { category: 'skills' });
    if (!res?.success) {
      await alertDialog({ title: '삭제 실패', message: res?.error || '알 수 없는 오류', danger: true });
      return;
    }
    await invalidate();
  }, [invalidate, hubMode, hubContext, hubFetch]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200/80">
        <span className="text-[10px] font-extrabold tracking-widest text-slate-400">SKILLS</span>
        <Tooltip label={t('common.create') || '새 스킬'}>
          <button
            onClick={openCreate}
            className="p-1 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            aria-label="새 스킬"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-3 py-3 text-[11px] text-slate-400 italic">로딩 중...</p>
        ) : skills.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-[11px] text-slate-400 mb-2">등록된 스킬이 없습니다.</p>
            <button onClick={openCreate} className="text-[11px] text-blue-600 font-bold hover:underline">+ 첫 스킬 만들기</button>
          </div>
        ) : (
          <RowActions>
            <div className="space-y-0.5 px-2 py-1">
              {skills.map(sk => (
                <InteractiveRow
                  key={sk.slug}
                  id={sk.slug}
                  kind="enter"
                  onActivate={() => onEditFile?.(`user/skills/${sk.slug}.md`)}
                  rowClassName="px-2 py-1.5 rounded-lg hover:bg-slate-100"
                  className="flex items-center gap-1.5"
                  actions={
                    sk.source === 'system' ? null : (
                      <Tooltip label={t('common.delete')}>
                        <button
                          onClick={() => handleDelete(sk.slug, sk.source)}
                          className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                          aria-label="삭제"
                        >
                          <Trash2 size={12} />
                        </button>
                      </Tooltip>
                    )
                  }
                >
                  <BookText size={13} className="shrink-0 text-slate-400" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-bold text-slate-700 truncate flex items-center gap-1">
                      <span className={`shrink-0 px-1 py-0.5 rounded text-[8px] font-bold uppercase ${sk.kind === 'design' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>{sk.kind || 'skill'}</span>
                      <span className="truncate">{sk.name || sk.slug}</span>
                      {sk.source === 'system' && <span className="shrink-0 text-[8px] text-slate-400">(기본)</span>}
                    </div>
                    {sk.description ? (
                      <div className="text-[10px] text-slate-400 truncate">{sk.description}</div>
                    ) : (
                      <div className="text-[10px] text-slate-400 truncate">{sk.slug}</div>
                    )}
                  </div>
                </InteractiveRow>
              ))}
            </div>
          </RowActions>
        )}
      </div>

      {/* 새 스킬 만들기 모달 — slug + kind → 빈 .md 생성 후 모나코 편집 */}
      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onMouseDown={(e) => { if (submitting) return; if (e.target === e.currentTarget) setCreating(false); }}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden" onMouseDown={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
              <h3 className="text-sm font-bold text-slate-800">새 스킬</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">slug·kind 입력 → 빈 매뉴얼(.md) 생성 후 모나코로 편집</p>
            </div>
            <div className="px-5 py-4 flex flex-col gap-3">
              <label htmlFor={newSlugId} className="sr-only">스킬 slug</label>
              <input
                type="text"
                value={newSlug}
                onChange={e => setNewSlug(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !submitting) submitCreate(); if (e.key === 'Escape' && !submitting) setCreating(false); }}
                placeholder="slug (예: stock-report)"
                disabled={submitting}
                aria-label="스킬 slug"
                className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100" name="newSlug" autoComplete="off" id={newSlugId}
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-500 shrink-0">kind</span>
                <select
                  value={newKind}
                  onChange={e => setNewKind(e.target.value)}
                  disabled={submitting}
                  aria-label="스킬 kind"
                  className="flex-1 px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SKILL_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
              <p className="text-[10px] text-slate-400">slug 는 영숫자·하이픈·언더스코어만. user/skills/{'{slug}'}.md 에 저장.</p>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
              <button onClick={() => setCreating(false)} disabled={submitting} className="px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-40">취소</button>
              <button onClick={submitCreate} disabled={submitting || !newSlug.trim()} className="px-3 py-1.5 text-[12px] bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg disabled:bg-slate-300">{submitting ? '생성 중...' : '만들기'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
