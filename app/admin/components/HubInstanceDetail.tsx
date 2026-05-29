'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { ArrowLeft, RotateCcw, Copy, ExternalLink } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { useTranslations } from '../../../lib/i18n';
import { logger } from '../../../lib/util/logger';
import { apiGet, apiPost } from '../../../lib/api-fetch';
import { SaveButton, type SaveButtonState } from './SaveButton';
import type { HubInstancePb, LibraryReferencePb } from '../../../lib/proto-gen/firebat_pb';

type HubApiResponse<T> = { success: boolean; data?: T; error?: string };
type LibraryApiResponse<T> = { success: boolean; data?: T; error?: string };

interface SysmodEntry { name: string; description?: string }

/**
 * HubInstanceDetail — 매 hub 의 settings 편집 UI.
 *
 * 편집 항목:
 *  - name / description
 *  - system_prompt (페르소나 / 가드레일)
 *  - allowed_references (Library Reference 영역 multi-select)
 *  - allowed_sysmods (sysmod 영역 multi-select)
 *  - allowed_domains (origin whitelist, 줄바꿈 분리)
 *  - enabled (활성 / 비활성 toggle)
 *  - api_token (표시 + 복사 + rotate)
 */
export function HubInstanceDetail({
  instance,
  onBack,
}: {
  instance: HubInstancePb;
  onBack: () => void;
}) {
  const t = useTranslations();
  const [name, setName] = useState(instance.name);
  const [description, setDescription] = useState(instance.description);
  const [systemPrompt, setSystemPrompt] = useState(instance.systemPrompt);
  const [enabled, setEnabled] = useState(instance.enabled);
  const [exposeWidget, setExposeWidget] = useState(instance.exposeWidget);
  const [exposePage, setExposePage] = useState(instance.exposePage);
  const [allowedReferences, setAllowedReferences] = useState<string[]>(instance.allowedReferences);
  const [allowedSysmods, setAllowedSysmods] = useState<string[]>(instance.allowedSysmods);
  const [allowedDomains, setAllowedDomains] = useState(instance.allowedDomains.join('\n'));
  const [apiToken, setApiToken] = useState(instance.apiToken);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 모든 Library Reference + sysmod list 영역 multi-select 위해 로드
  const [references, setReferences] = useState<LibraryReferencePb[]>([]);
  const [sysmods, setSysmods] = useState<SysmodEntry[]>([]);

  const nameId = useId();
  const descId = useId();
  const promptId = useId();
  const domainsId = useId();
  const embedId = useId();
  const enabledId = useId();
  const exposeWidgetId = useId();
  const exposePageId = useId();

  // 외부 위젯 embed snippet 영역 firebat URL 자동 결정 (SSR 호환 — 빈 초기값 + client effect).
  const [firebatUrl, setFirebatUrl] = useState('');
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location?.origin) {
      setFirebatUrl(window.location.origin);
    }
  }, []);

  useEffect(() => {
    // Library Reference 목록 (admin 영역 — 본인 자료)
    apiPost<LibraryApiResponse<LibraryReferencePb[]>>(
      '/api/library/list-references',
      { owner: 'admin' },
      { category: 'hub' },
    ).then(res => {
      if (res.success && res.data) setReferences(res.data);
    }).catch(e => logger.debug('hub', 'load_references 실패', { error: e }));

    // sysmod 목록 — `/api/fs/system-modules` (SettingsModal 에서 쓰는 것과 동일).
    // 옛 `/api/settings/modules?scope=system` = 단일 모듈 조회 endpoint 에 잘못된 호출 →
    // `name 필요` 400 BadRequest 였던 부분 정정.
    apiGet<{ success: boolean; modules?: Array<{ name: string; description?: string }> }>(
      '/api/fs/system-modules',
      { category: 'hub' },
    ).then(d => {
      if (d.success && Array.isArray(d.modules)) {
        setSysmods(d.modules.map(m => ({ name: m.name, description: m.description })));
      }
    }).catch(e => logger.debug('hub', 'load_sysmods 실패', { error: e }));
  }, []);

  const toggleReference = (id: string) => {
    setAllowedReferences(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSysmod = (name: string) => {
    setAllowedSysmods(prev =>
      prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]
    );
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const domains = allowedDomains.split('\n').map(s => s.trim()).filter(Boolean);
      const res = await apiPost<HubApiResponse<void>>(
        '/api/hub/update-instance',
        {
          id: instance.id,
          name,
          description,
          systemPrompt,
          enabled,
          exposeWidget,
          exposePage,
          allowedReferences,
          replaceAllowedReferences: true,
          allowedSysmods,
          replaceAllowedSysmods: true,
          allowedDomains: domains,
          replaceAllowedDomains: true,
        },
        { category: 'hub' },
      );
      if (!res.success) {
        await alertDialog({ title: '저장 실패', message: res.error ?? '오류가 발생했습니다.' });
      } else {
        // 성공 안내 — CheckCircle icon 2초 표시 후 자동 사라짐 (옛 settings 패턴).
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e) {
      logger.debug('hub', 'update_instance 실패', { error: e });
      // silent fail 차단 — 사용자 시점에서 동작 0 인 부분 명시 안내. network error / RPC fail 등.
      await alertDialog({ title: '저장 실패', message: (e as Error)?.message ?? '네트워크 또는 서버 오류' });
    } finally {
      setSaving(false);
    }
  }, [instance.id, name, description, systemPrompt, enabled, exposeWidget, exposePage, allowedReferences, allowedSysmods, allowedDomains]);

  const handleRotateToken = useCallback(async () => {
    const ok = await confirmDialog({
      title: 'API 토큰 재발급',
      message: '옛 토큰이 즉시 무효화되고 새 토큰이 발급됩니다. 워드프레스 위젯 영역도 새 토큰으로 갱신해야 합니다. 진행하시겠습니까?',
      okLabel: '재발급',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiPost<HubApiResponse<{ newToken: string }>>(
        '/api/hub/rotate-api-token',
        { id: instance.id },
        { category: 'hub' },
      );
      if (res.success && res.data) {
        setApiToken(res.data.newToken);
        await alertDialog({ title: '토큰 재발급 완료', message: '새 토큰이 적용됐습니다.' });
      }
    } catch (e) {
      logger.debug('hub', 'rotate_api_token 실패', { error: e });
    }
  }, [instance.id]);

  // embed snippet build — 사용자가 외부 사이트 HTML 에 삽입하는 코드.
  const embedSnippet = firebatUrl
    ? `<script
  src="${firebatUrl}/api/hub/widget.js"
  data-slug="${instance.slug}"
  data-token="${apiToken}"
  data-firebat-url="${firebatUrl}"
  async
></script>`
    : '(서버 URL 결정 중...)';

  const handleCopyEmbed = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(embedSnippet);
      await alertDialog({ title: '복사됨', message: '위젯 코드가 클립보드에 복사됐습니다. 외부 사이트 HTML 에 붙여넣어 주세요.' });
    } catch (e) {
      logger.debug('hub', 'copy_embed 실패', { error: e });
    }
  }, [embedSnippet]);

  const handleCopyToken = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(apiToken);
      await alertDialog({ title: '복사됨', message: '클립보드에 API 토큰이 복사됐습니다.' });
    } catch {
      // ignore
    }
  }, [apiToken]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/60 shrink-0">
        <button
          onClick={onBack}
          className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <ArrowLeft size={14} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-bold text-slate-700 truncate">{instance.name}</div>
          <div className="text-[10px] text-slate-400 truncate font-mono">{instance.slug}</div>
        </div>
        <Tooltip label="Hub 페이지 열기">
          <a
            href={`/${instance.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-slate-400 hover:text-blue-600 transition-colors"
          >
            <ExternalLink size={14} />
          </a>
        </Tooltip>
        <SaveButton
          state={(saving ? 'saving' : saved ? 'saved' : 'idle') as SaveButtonState}
          onClick={handleSave}
        />
      </div>

      {/* settings 본문 */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {/* 활성 / 비활성 toggle */}
        <label htmlFor={enabledId} className="flex items-center gap-2 text-[12px] font-semibold text-slate-700 cursor-pointer">
          <input
            id={enabledId}
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            name="hubEnabled"
          />
          <span>활성 (외부 호출 허용)</span>
        </label>

        {/* 노출 모드 — widget / page boolean 2개 (둘 다 동시 가능). 둘 다 OFF = instance 사실상 비활성. */}
        <div className="flex flex-col gap-1 border border-slate-200 rounded p-2 bg-slate-50/50">
          <div className="text-[11px] font-bold text-slate-600 mb-1">노출 모드</div>
          <label htmlFor={exposeWidgetId} className="flex items-start gap-2 text-[12px] text-slate-700 cursor-pointer">
            <input
              id={exposeWidgetId}
              type="checkbox"
              checked={exposeWidget}
              onChange={e => setExposeWidget(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              name="hubExposeWidget"
            />
            <div className="flex flex-col">
              <span className="font-semibold">위젯 임베드</span>
              <span className="text-[10px] text-slate-400">외부 사이트 (워드프레스 등) HTML 에 위젯 코드 삽입해 호출. allowed_domains 검증.</span>
            </div>
          </label>
          <label htmlFor={exposePageId} className="flex items-start gap-2 text-[12px] text-slate-700 cursor-pointer mt-1">
            <input
              id={exposePageId}
              type="checkbox"
              checked={exposePage}
              onChange={e => setExposePage(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              name="hubExposePage"
            />
            <div className="flex flex-col">
              <span className="font-semibold">페이지 노출</span>
              <span className="text-[10px] text-slate-400">우리 사이트 /{instance.slug} URL 풀스크린 chat. self host 자동 허용.</span>
            </div>
          </label>
        </div>

        {/* 이름 */}
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-[11px] font-bold text-slate-600">이름</label>
          <input
            id={nameId}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            name="hubName"
            autoComplete="off"
          />
        </div>

        {/* 설명 */}
        <div className="flex flex-col gap-1">
          <label htmlFor={descId} className="text-[11px] font-bold text-slate-600">설명</label>
          <input
            id={descId}
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            name="hubDescription"
            autoComplete="off"
          />
        </div>

        {/* system prompt */}
        <div className="flex flex-col gap-1">
          <label htmlFor={promptId} className="text-[11px] font-bold text-slate-600">System prompt (페르소나 / 가드레일)</label>
          <textarea
            id={promptId}
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            rows={6}
            placeholder="이 Hub 의 역할 / 답변 톤 / 금지 항목 등을 기술"
            className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y font-mono"
            name="hubSystemPrompt"
          />
        </div>

        {/* 허용 Library References */}
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-bold text-slate-600">허용 자료 (Library Reference)</div>
          {references.length === 0 ? (
            <p className="text-[11px] text-slate-400 italic">Library Reference 가 없습니다. Library 탭에서 먼저 자료를 추가해주세요.</p>
          ) : (
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-slate-200 rounded p-1.5">
              {references.map(ref => {
                const refInputId = `hub-ref-${ref.id}`;
                return (
                  <label key={ref.id} htmlFor={refInputId} className="flex items-center gap-2 text-[12px] cursor-pointer hover:bg-slate-50 px-1.5 py-1 rounded">
                    <input
                      id={refInputId}
                      type="checkbox"
                      name="allowedReferences"
                      value={ref.id}
                      checked={allowedReferences.includes(ref.id)}
                      onChange={() => toggleReference(ref.id)}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      aria-label={`Reference ${ref.name}`}
                    />
                    <span className="truncate">{ref.name}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* 허용 sysmod */}
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-bold text-slate-600">허용 시스템 모듈 (sysmod)</div>
          {sysmods.length === 0 ? (
            <p className="text-[11px] text-slate-400 italic">시스템 모듈 목록을 불러오는 중...</p>
          ) : (
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-slate-200 rounded p-1.5">
              {sysmods.map(mod => {
                const modInputId = `hub-sysmod-${mod.name}`;
                return (
                  <label key={mod.name} htmlFor={modInputId} className="flex items-center gap-2 text-[12px] cursor-pointer hover:bg-slate-50 px-1.5 py-1 rounded">
                    <input
                      id={modInputId}
                      type="checkbox"
                      name="allowedSysmods"
                      value={mod.name}
                      checked={allowedSysmods.includes(mod.name)}
                      onChange={() => toggleSysmod(mod.name)}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      aria-label={`sysmod ${mod.name}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[11px] text-slate-700">{mod.name}</div>
                      {mod.description && <div className="text-[10px] text-slate-400 truncate">{mod.description}</div>}
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* 허용 도메인 */}
        <div className="flex flex-col gap-1">
          <label htmlFor={domainsId} className="text-[11px] font-bold text-slate-600">허용 도메인 (origin whitelist)</label>
          <textarea
            id={domainsId}
            value={allowedDomains}
            onChange={e => setAllowedDomains(e.target.value)}
            rows={3}
            placeholder="https://example.com&#10;https://blog.example.com"
            className="w-full px-2 py-1.5 text-[11px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y font-mono"
            name="hubAllowedDomains"
          />
          <p className="text-[10px] text-slate-400">한 줄에 하나. 빈 영역 = 모든 origin 허용 (개발 영역).</p>
        </div>

        {/* API 토큰 */}
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-bold text-slate-600">API 토큰 (워드프레스 위젯 인증)</div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={apiToken}
              readOnly
              className="flex-1 px-2 py-1.5 text-[11px] font-mono border border-slate-300 rounded bg-slate-50"
              aria-label="API 토큰"
              name="hubApiToken"
            />
            <Tooltip label={t('common.copy')}>
              <button
                onClick={handleCopyToken}
                className="p-1.5 text-slate-500 hover:text-blue-600 transition-colors border border-slate-300 rounded"
              >
                <Copy size={13} />
              </button>
            </Tooltip>
            <Tooltip label={t('common.regenerate')}>
              <button
                onClick={handleRotateToken}
                className="p-1.5 text-slate-500 hover:text-red-600 transition-colors border border-slate-300 rounded"
              >
                <RotateCcw size={13} />
              </button>
            </Tooltip>
          </div>
          <p className="text-[10px] text-slate-400">위젯 HTML/JS 에 넣어 인증. 재발급 시 옛 토큰 즉시 무효.</p>
        </div>

        {/* 외부 위젯 embed snippet — 워드프레스 등 외부 사이트 HTML 에 넣는 코드 */}
        <div className="flex flex-col gap-1">
          <label htmlFor={embedId} className="text-[11px] font-bold text-slate-600">위젯 embed 코드</label>
          <div className="relative">
            <textarea
              id={embedId}
              value={embedSnippet}
              readOnly
              rows={7}
              className="w-full px-2 py-1.5 text-[11px] font-mono border border-slate-300 rounded bg-slate-50 resize-none"
              name="hubEmbedSnippet"
              onClick={e => (e.target as HTMLTextAreaElement).select()}
            />
            <button
              onClick={handleCopyEmbed}
              className="absolute top-1.5 right-1.5 p-1 text-slate-500 hover:text-blue-600 transition-colors border border-slate-300 rounded bg-white"
              aria-label="복사"
            >
              <Copy size={12} />
            </button>
          </div>
          <p className="text-[10px] text-slate-400">
            외부 사이트 (워드프레스 등) HTML 의 &lt;/body&gt; 직전에 넣으면 즉시 Hub 가 활성화됩니다. allowed_domains
            설정이 비어있으면 모든 origin 을 허용합니다 (개발). 운영 시 도메인 명시를 권장합니다.
          </p>
        </div>
      </div>
    </div>
  );
}
