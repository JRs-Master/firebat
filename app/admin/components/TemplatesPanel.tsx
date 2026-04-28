'use client';
/**
 * TemplatesPanel — Phase 8b-C. 사이드바 TEMPLATES 탭.
 *
 * user/templates/* 의 list 표시 + 클릭 시 모나코 에디터로 template.json 편집.
 * 새 템플릿 만들기 버튼 — 빈 template.json 생성 후 모나코 에디터로 즉시 편집.
 */
import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, FileCode } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog } from './Dialog';

interface TemplateEntry {
  slug: string;
  name: string;
  description: string;
  tags: string[];
}

const STARTER_TEMPLATE = {
  name: '새 템플릿',
  description: '템플릿 목적·사용 시점',
  tags: [] as string[],
  spec: {
    head: {
      title: '{date} 제목',
      description: 'SEO 설명',
      keywords: [] as string[],
    },
    body: [
      { type: 'Header', props: { text: '{date} 제목', level: 1 } },
      { type: 'Text', props: { content: '본문 시작...' } },
    ],
  },
};

export function TemplatesPanel({ onEditFile }: { onEditFile?: (filePath: string) => void }) {
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/templates');
      const data = await res.json();
      if (data.success) setTemplates(data.templates);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleCreate = useCallback(async () => {
    const slug = prompt('새 템플릿 slug (영숫자·하이픈·언더스코어, 예: weekly-stock-summary):')?.trim();
    if (!slug) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      alert('slug 는 영숫자·하이픈·언더스코어만.');
      return;
    }
    if (templates.some(t => t.slug === slug)) {
      alert(`"${slug}" 템플릿이 이미 존재합니다.`);
      return;
    }
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, config: STARTER_TEMPLATE }),
    });
    const data = await res.json();
    if (!data.success) {
      alert(`생성 실패: ${data.error}`);
      return;
    }
    await fetchTemplates();
    onEditFile?.(`user/templates/${slug}/template.json`);
  }, [templates, fetchTemplates, onEditFile]);

  const handleDelete = useCallback(async (slug: string) => {
    if (!await confirmDialog({
      title: '템플릿 삭제',
      message: `"${slug}" 템플릿을 삭제하시겠습니까? 기존 페이지는 영향 없음 (템플릿은 다음 발행부터 적용).`,
      danger: true,
      okLabel: '삭제',
    })) return;
    const res = await fetch(`/api/templates/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      alert(`삭제 실패: ${data.error}`);
      return;
    }
    await fetchTemplates();
  }, [fetchTemplates]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200/80">
        <span className="text-[10px] font-extrabold tracking-widest text-slate-400">TEMPLATES</span>
        <Tooltip label="새 템플릿">
          <button
            onClick={handleCreate}
            className="p-1 rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
            aria-label="새 템플릿"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-3 py-3 text-[11px] text-slate-400 italic">로딩 중...</p>
        ) : templates.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-[11px] text-slate-400 mb-2">등록된 템플릿이 없습니다.</p>
            <button
              onClick={handleCreate}
              className="text-[11px] text-blue-600 font-bold hover:underline"
            >
              + 첫 템플릿 만들기
            </button>
          </div>
        ) : (
          <div className="space-y-0.5 px-2 py-1">
            {templates.map(t => (
              <div
                key={t.slug}
                className="group flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-slate-100 cursor-pointer"
                onClick={() => onEditFile?.(`user/templates/${t.slug}/template.json`)}
              >
                <FileCode size={13} className="shrink-0 text-slate-400" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-bold text-slate-700 truncate">{t.name}</div>
                  <div className="text-[10px] text-slate-400 truncate">{t.slug}</div>
                </div>
                <Tooltip label="삭제">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(t.slug); }}
                    className="p-1 text-slate-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                    aria-label="삭제"
                  >
                    <Trash2 size={12} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/50">
        <p className="text-[10px] text-slate-500 leading-relaxed">
          템플릿은 cron-agent 가 발행 시 일관 layout 으로 사용. AI 가 매칭 시 spec.head·body 를 baseline 으로 변동값만 교체.
        </p>
      </div>
    </div>
  );
}
