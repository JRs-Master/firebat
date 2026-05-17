'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { ArrowLeft, Save, RotateCcw, Copy, Loader2, ExternalLink } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { logger } from '../../../lib/util/logger';
import { apiGet, apiPost } from '../../../lib/api-fetch';
import type { ChatbotInstancePb, LibraryReferencePb } from '../../../lib/proto-gen/firebat_pb';

type ChatbotApiResponse<T> = { success: boolean; data?: T; error?: string };
type LibraryApiResponse<T> = { success: boolean; data?: T; error?: string };

interface SysmodEntry { name: string; description?: string }

/**
 * ChatbotInstanceDetail — 매 chatbot 의 settings 편집 UI.
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
export function ChatbotInstanceDetail({
  instance,
  onBack,
}: {
  instance: ChatbotInstancePb;
  onBack: () => void;
}) {
  const [name, setName] = useState(instance.name);
  const [description, setDescription] = useState(instance.description);
  const [systemPrompt, setSystemPrompt] = useState(instance.systemPrompt);
  const [enabled, setEnabled] = useState(instance.enabled);
  const [allowedReferences, setAllowedReferences] = useState<string[]>(instance.allowedReferences);
  const [allowedSysmods, setAllowedSysmods] = useState<string[]>(instance.allowedSysmods);
  const [allowedDomains, setAllowedDomains] = useState(instance.allowedDomains.join('\n'));
  const [apiToken, setApiToken] = useState(instance.apiToken);
  const [saving, setSaving] = useState(false);

  // 모든 Library Reference + sysmod list 영역 multi-select 위해 로드
  const [references, setReferences] = useState<LibraryReferencePb[]>([]);
  const [sysmods, setSysmods] = useState<SysmodEntry[]>([]);

  const nameId = useId();
  const descId = useId();
  const promptId = useId();
  const domainsId = useId();
  const embedId = useId();

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
      { category: 'chatbot' },
    ).then(res => {
      if (res.success && res.data) setReferences(res.data);
    }).catch(e => logger.debug('chatbot', 'load_references 실패', { error: e }));

    // sysmod 목록 — `/api/fs/system-modules` (SettingsModal 안 박은 영역 동일).
    // 옛 `/api/settings/modules?scope=system` 박은 영역 = 단일 모듈 조회 endpoint 안 잘못된 호출 →
    // `name 필요` 400 BadRequest 박힌 영역 정정.
    apiGet<{ success: boolean; modules?: Array<{ name: string; description?: string }> }>(
      '/api/fs/system-modules',
      { category: 'chatbot' },
    ).then(d => {
      if (d.success && Array.isArray(d.modules)) {
        setSysmods(d.modules.map(m => ({ name: m.name, description: m.description })));
      }
    }).catch(e => logger.debug('chatbot', 'load_sysmods 실패', { error: e }));
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
      const res = await apiPost<ChatbotApiResponse<void>>(
        '/api/chatbot/update-instance',
        {
          id: instance.id,
          name,
          description,
          systemPrompt,
          enabled,
          allowedReferences,
          replaceAllowedReferences: true,
          allowedSysmods,
          replaceAllowedSysmods: true,
          allowedDomains: domains,
          replaceAllowedDomains: true,
        },
        { category: 'chatbot' },
      );
      if (!res.success) {
        await alertDialog({ title: '저장 실패', message: res.error ?? '오류가 발생했습니다.' });
      }
    } catch (e) {
      logger.debug('chatbot', 'update_instance 실패', { error: e });
      // silent fail 차단 — 사용자 시점 안 동작 0 박은 영역 명시 안내. network error / RPC fail 등.
      await alertDialog({ title: '저장 실패', message: (e as Error)?.message ?? '네트워크 또는 서버 오류' });
    } finally {
      setSaving(false);
    }
  }, [instance.id, name, description, systemPrompt, enabled, allowedReferences, allowedSysmods, allowedDomains]);

  const handleRotateToken = useCallback(async () => {
    const ok = await confirmDialog({
      title: 'API 토큰 재발급',
      message: '옛 토큰이 즉시 무효화되고 새 토큰이 발급됩니다. 워드프레스 위젯 영역도 새 토큰으로 갱신해야 합니다. 진행하시겠습니까?',
      okLabel: '재발급',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiPost<ChatbotApiResponse<{ newToken: string }>>(
        '/api/chatbot/rotate-api-token',
        { id: instance.id },
        { category: 'chatbot' },
      );
      if (res.success && res.data) {
        setApiToken(res.data.newToken);
        await alertDialog({ title: '토큰 재발급 완료', message: '새 토큰이 적용됐습니다.' });
      }
    } catch (e) {
      logger.debug('chatbot', 'rotate_api_token 실패', { error: e });
    }
  }, [instance.id]);

  // embed snippet 영역 build — 사용자가 외부 사이트 HTML 영역 박는 영역.
  const embedSnippet = firebatUrl
    ? `<script
  src="${firebatUrl}/api/chatbot/widget.js"
  data-slug="${instance.slug}"
  data-token="${apiToken}"
  data-firebat-url="${firebatUrl}"
  async
></script>`
    : '(서버 URL 결정 중...)';

  const handleCopyEmbed = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(embedSnippet);
      await alertDialog({ title: '복사됨', message: '위젯 코드가 클립보드에 복사됐습니다. 외부 사이트 HTML 영역에 박아주세요.' });
    } catch (e) {
      logger.debug('chatbot', 'copy_embed 실패', { error: e });
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
        <Tooltip label="챗봇 페이지 열기">
          <a
            href={`/chat/${instance.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-slate-400 hover:text-blue-600 transition-colors"
          >
            <ExternalLink size={14} />
          </a>
        </Tooltip>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-slate-300"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          저장
        </button>
      </div>

      {/* settings 본문 */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {/* 활성 / 비활성 toggle */}
        <label className="flex items-center gap-2 text-[12px] font-semibold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            name="chatbotEnabled"
          />
          <span>활성 (외부 호출 허용)</span>
        </label>

        {/* 이름 */}
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-[11px] font-bold text-slate-600">이름</label>
          <input
            id={nameId}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            name="chatbotName"
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
            name="chatbotDescription"
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
            placeholder="이 챗봇의 역할 / 답변 톤 / 금지 영역 등을 기술"
            className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y font-mono"
            name="chatbotSystemPrompt"
          />
        </div>

        {/* 허용 Library References */}
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-bold text-slate-600">허용 자료 (Library Reference)</div>
          {references.length === 0 ? (
            <p className="text-[11px] text-slate-400 italic">Library Reference 가 없습니다. Library 탭에서 먼저 자료를 추가해주세요.</p>
          ) : (
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-slate-200 rounded p-1.5">
              {references.map(ref => (
                <label key={ref.id} className="flex items-center gap-2 text-[12px] cursor-pointer hover:bg-slate-50 px-1.5 py-1 rounded">
                  <input
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
              ))}
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
              {sysmods.map(mod => (
                <label key={mod.name} className="flex items-center gap-2 text-[12px] cursor-pointer hover:bg-slate-50 px-1.5 py-1 rounded">
                  <input
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
              ))}
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
            name="chatbotAllowedDomains"
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
              name="chatbotApiToken"
            />
            <Tooltip label="복사">
              <button
                onClick={handleCopyToken}
                className="p-1.5 text-slate-500 hover:text-blue-600 transition-colors border border-slate-300 rounded"
              >
                <Copy size={13} />
              </button>
            </Tooltip>
            <Tooltip label="재발급">
              <button
                onClick={handleRotateToken}
                className="p-1.5 text-slate-500 hover:text-red-600 transition-colors border border-slate-300 rounded"
              >
                <RotateCcw size={13} />
              </button>
            </Tooltip>
          </div>
          <p className="text-[10px] text-slate-400">위젯 HTML/JS 영역에 박아 인증. 재발급 시 옛 토큰 즉시 무효.</p>
        </div>

        {/* 외부 위젯 embed snippet — 워드프레스 등 외부 사이트 HTML 안 박는 코드 */}
        <div className="flex flex-col gap-1">
          <label htmlFor={embedId} className="text-[11px] font-bold text-slate-600">위젯 embed 코드</label>
          <div className="relative">
            <textarea
              id={embedId}
              value={embedSnippet}
              readOnly
              rows={7}
              className="w-full px-2 py-1.5 text-[11px] font-mono border border-slate-300 rounded bg-slate-50 resize-none"
              name="chatbotEmbedSnippet"
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
            외부 사이트 (워드프레스 등) HTML 안 &lt;/body&gt; 직전에 박으면 즉시 챗봇 활성. allowed_domains
            설정 영역 비어있으면 모든 origin 허용 (개발). 운영 시 도메인 명시 권장.
          </p>
        </div>
      </div>
    </div>
  );
}
