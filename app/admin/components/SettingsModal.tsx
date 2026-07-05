'use client';

import { useState, useEffect, useCallback, useRef, useMemo, useId } from 'react';
import { Settings, X, KeyRound, Plug, Loader2, Trash2, Layers, Pencil, Server, Cpu, Wrench, Blocks, ChevronLeft, ChevronRight, DollarSign, Brain, Plus, ScrollText, Volume2 } from 'lucide-react';
import { McpServer } from '../types';
import { useAiModels, thinkingLevelLabel } from '../hooks/use-ai-models';
import { Field, FieldLabel, HelpText, TextInput, Textarea, SelectInput, SegButtons } from './settings-controls';
import { ErrorBoundary } from './ErrorBoundary';
import { useSetting, writeSetting } from '../hooks/settings-manager';
import { Tooltip } from './Tooltip';
import { FeedbackBadge } from './FeedbackBadge';
import { hubFetch } from '../../../lib/hub-fetch';
import { SaveButton, type SaveButtonState } from './SaveButton';
import { confirmDialog, alertDialog } from './Dialog';
import { LogPanel } from './LogPanel';
import { useLang, useTranslations, type Lang } from '../../../lib/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { TIMEZONE_OPTIONS, timezoneLabel } from '../../../lib/timezones';
import { logger } from '../../../lib/util/logger';
import { USER_PROMPT_MAX_CHARS } from '../../../lib/config';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../../lib/api-fetch';
import { TIME } from '../../../lib/util/time';
import { formatCompactNumber, formatTokenCount } from '../../../lib/util/number';
import { z } from 'zod';
import { validateForm } from '../../../lib/form-validation';

// Rust ModuleEntryPb.entry_type → proto-loader keepCase:false → entryType.
// 옛 type 필드명 호환 위해 둘 다 받음.
interface SystemModule {
  name: string;
  description: string;
  runtime: string;
  entryType?: string;
  type?: string; // legacy alias — entryType 우선
  scope?: string;
  enabled?: boolean;
}

type Props = {
  aiModel: string;
  onAiModelChange: (model: string) => void;
  onClose: () => void;
  onSave: () => void;
  onOpenModuleSettings?: (moduleName: string) => void;
  initialTab?: 'general' | 'ai' | 'secrets' | 'mcp' | 'capabilities' | 'system' | 'cost' | 'memory'; // 'cost' / 'memory' 는 호환 — 자동으로 AI 탭 + sub-tab 으로 변환
  // hub tenant mode: when set, scope to owner (hub session) and show only prompt/memory tabs (rest = root-only).
  // Reuse the admin SettingsModal as-is (owner-injection unification), not a separate mini version.
  hubContext?: { slug: string; apiToken: string; sessionId: string };
};

/** SettingsModal — 자체 ErrorBoundary 추가하여 modal 안 throw 가 admin tree 통째로 reset 되지 않게 격리.
 *  옛: cost sub-tab throw → admin/error.tsx 발동 → 사이드바 사라짐. 새: modal 안 fallback UI 만 표시 + 사이드바 유지. */
export function SettingsModal(props: Props) {
  return (
    <ErrorBoundary>
      <SettingsModalInner {...props} />
    </ErrorBoundary>
  );
}

function SettingsModalInner({ aiModel, onAiModelChange, onClose, onSave, onOpenModuleSettings, initialTab, hubContext }: Props) {
  const t = useTranslations();
  // hub tenant mode: limit tabs to prompt/memory and route data through owner-scoped /api/hub/<slug>/*.
  const hubMode = !!hubContext;
  const queryClient = useQueryClient();
  // Single owner-injected settings endpoint — the ONE place owner (hubContext) branches. Both
  // load() and save() use the identical full-settings shape as admin; a hub tenant just routes
  // through /api/hub/<slug>/settings (owner-scoped) instead of /api/settings. Load and save below
  // are owner-agnostic, so enabling more tenant tabs later needs no change here.
  const settingsEndpoint = useMemo(() => (hubContext ? {
    load: () => hubFetch(hubContext, 'settings', 'get-settings', {}),
    save: async (p: Record<string, any>) =>
      (await hubFetch(hubContext, 'settings', 'save-settings', p).catch(() => null))?.success === true,
  } : {
    load: () => apiGet<any>('/api/settings', { category: 'settings' }).catch(() => null),
    save: async (p: Record<string, any>) => {
      await apiPatch('/api/settings', p, { category: 'settings' }).catch(() => {});
      return true;
    },
  }), [hubContext]);
  const { lang: uiLang, setLang: setUiLang } = useLang();
  // a11y — 안정 form field id (DevTools "Duplicate form field id" 회피 + label-input 매칭).
  const userTimezoneId = useId();
  const adminCurrentPwId = useId();
  const adminNewIdId = useId();
  const adminNewPwId = useId();
  const anthropicCacheId = useId();
  const subAgentEnabledId = useId();
  const aiRouterEnabledId = useId();
  const newSecretNameId = useId();
  const newSecretValueId = useId();
  const moduleSecretIdBase = useId();
  const mcpEditCommandId = useId();
  const mcpEditArgsId = useId();
  const mcpEditUrlId = useId();
  const mcpNewNameId = useId();
  const mcpNewCommandId = useId();
  const mcpNewArgsId = useId();
  const mcpNewUrlId = useId();
  const openaiKeyId = useId();
  const googleKeyId = useId();
  const anthropicKeyId = useId();
  const vertexSaId = useId();
  const upstageKeyId = useId();
  // useAiModels 컴포넌트 상단 호출 — inferModeProvider / categoryOf 가 aiModelsList 참조하므로 hoist 보장.
  const { models: aiModelsList } = useAiModels();
  // 비용·메모리는 AI 탭 하위 sub-tab 으로 통합 — initialTab='cost'/'memory' 면 자동으로 AI 탭 + sub-tab 으로 변환.
  const [settingsTab, setSettingsTab] = useState<'general' | 'ai' | 'secrets' | 'mcp' | 'capabilities' | 'system' | 'logs'>(() => {
    if (hubContext) return 'ai'; // hub tenant = AI tab (prompt/memory) only
    if (initialTab === 'cost' || initialTab === 'memory') return 'ai';
    return (initialTab ?? 'general') as any;
  });
  // AI 탭 sub-tab 의 cost/memory 는 아래 line 164 에서 type 확장 + initialTab 처리.
  // AI 탭: 실행모드(api/cli) + 모드(일반/Vertex) + 프로바이더(openai/google/anthropic)
  // api 모드: 키 기반, pay-per-token (기존)
  // cli 모드: 구독 기반, 자체 인증 (월정액 Claude Pro/Max, ChatGPT Plus, Gemini Advanced 등)
  type CliProvider = 'claude' | 'codex' | 'gemini';
  // 모델 분류 — JSON registry (system/llm/models.json) 단일 source. entry.execMode/cliProvider/category 만 read.
  // 옛 prefix 분기 (model.startsWith('cli-') 등) 폐기 (2026-05-13). entry 미준비 시점 = 기본값 + useEffect sync.
  const inferModeProvider = (model: string): { execMode: 'api' | 'cli'; mode: 'general' | 'vertex'; provider: 'openai' | 'google' | 'anthropic' | 'upstage'; cliProvider: CliProvider } => {
    const entry = aiModelsList.find(m => m.value === model);
    if (!entry) return { execMode: 'api', mode: 'general', provider: 'openai', cliProvider: 'claude' };
    if (entry.execMode === 'cli') {
      return { execMode: 'cli', mode: 'general', provider: 'anthropic', cliProvider: (entry.cliProvider ?? 'claude') };
    }
    if (entry.category === 'vertex-google') return { execMode: 'api', mode: 'vertex', provider: 'google', cliProvider: 'claude' };
    if (entry.category === 'api-openai') return { execMode: 'api', mode: 'general', provider: 'openai', cliProvider: 'claude' };
    if (entry.category === 'api-anthropic') return { execMode: 'api', mode: 'general', provider: 'anthropic', cliProvider: 'claude' };
    if (entry.category === 'api-google') return { execMode: 'api', mode: 'general', provider: 'google', cliProvider: 'claude' };
    if (entry.category === 'api-upstage') return { execMode: 'api', mode: 'general', provider: 'upstage', cliProvider: 'claude' };
    return { execMode: 'api', mode: 'general', provider: 'openai', cliProvider: 'claude' };
  };
  const _initMp = inferModeProvider(aiModel);
  const [execMode, setExecMode] = useState<'api' | 'cli'>(_initMp.execMode);
  const [aiMode, setAiMode] = useState<'general' | 'vertex'>(_initMp.mode);
  const [aiProvider, setAiProvider] = useState<'openai' | 'google' | 'anthropic' | 'upstage'>(_initMp.provider);
  const [cliProvider, setCliProvider] = useState<CliProvider>(_initMp.cliProvider);

  // Staged model selection — the model dropdown / provider tabs write here (a draft), and the
  // draft only becomes the *active* chat model (parent `onAiModelChange`) + backend value on the
  // main Save button. Prevents an accidental/temporary switch (e.g. picking Opus to peek at the
  // thinking block) from silently taking effect on the next turn. Syncs from the `aiModel` prop
  // whenever the active model changes externally (after Save, or a load); on close-without-save the
  // modal unmounts and the draft is discarded.
  const [draftModel, setDraftModel] = useState(aiModel);
  useEffect(() => { setDraftModel(aiModel); }, [aiModel]);

  // useAiModels React Query ready 시점 entry 준비 — useState 가 옛 기본값에 머문 상태면 sync.
  // 매 마운트 시 첫 render 는 aiModelsList 빈 list → 기본값 (api/openai/general) → ready 후 자동 갱신.
  // draftModel(스테이징된 선택) 변경 시점에도 같이 동작 — 탭/드롭다운이 draft 를 바꾸면 mode/provider 재추론.
  useEffect(() => {
    if (aiModelsList.length === 0) return;
    const mp = inferModeProvider(draftModel);
    setExecMode(mp.execMode);
    setAiMode(mp.mode);
    setAiProvider(mp.provider);
    setCliProvider(mp.cliProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiModelsList, draftModel]);

  /** 카테고리별 마지막 선택 모델 — 공급자/모드 전환 시 첫 모델(auto) 대신 직전 선택 복원.
   *  카테고리 키 = JSON registry entry.category 단일 source. 옛 prefix 분기 폐기 (2026-05-13).
   *  카테고리: cli-claude / cli-codex / cli-gemini / vertex-google / api-openai / api-google / api-anthropic */
  const categoryOf = (model: string): string => {
    return aiModelsList.find(m => m.value === model)?.category ?? '';
  };
  // SettingsManager 경유 — 다른 탭에서 변경하면 `storage` 이벤트로 자동 동기화.
  const [lastModelByCategory, setLastModelByCategory] = useSetting('firebat_last_model_by_category');
  // 모델별 thinking level 기억 — 카테고리별 모델 기억과 같은 패턴.
  const [lastThinkingByModel, setLastThinkingByModel] = useSetting('firebat_last_thinking_by_model');
  /** 새 카테고리 전환 시 호출 — 마지막 선택 모델을 draft 로 복원(없으면 첫 모델). 활성 모델은 안 바뀜(저장 전까지). */
  const restoreOrFirst = (newCategory: string, fallbackFirst: string | undefined) => {
    const remembered = lastModelByCategory[newCategory];
    const isValid = remembered && aiModelsList.some(m => m.value === remembered) && categoryOf(remembered) === newCategory;
    if (isValid) setDraftModel(remembered);
    else if (fallbackFirst) setDraftModel(fallbackFirst);
  };

  // draftModel(스테이징된 선택)이 바뀌면 모드/공급자 재추론. 활성 모델(aiModel)은 저장 눌러야 바뀜.
  //
  // 모델 선택은 draft 스테이징 — cascade 탭(execMode / aiMode / aiProvider / cliProvider) 클릭이나
  // 드롭다운 변경은 draftModel 만 바꿔 UI(그 카테고리의 직전 모델·thinking)를 미리 보여주고, 실제
  // 활성 모델·카테고리 기억(lastModelByCategory)은 메인 "저장" 버튼(handleSave)에서만 반영된다.
  // 그래서 "탭 미리보기"로 클릭만 하고 저장 안 하면 활성 모델은 그대로다(잘못된/임시 전환 방지).
  useEffect(() => {
    const mp = inferModeProvider(draftModel);
    setExecMode(mp.execMode);
    setAiMode(mp.mode);
    setAiProvider(mp.provider);
    setCliProvider(mp.cliProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftModel]);
  // CLI 상태
  const [cliStatus, setCliStatus] = useState<{ installed: boolean; loggedIn: boolean; error?: string } | null>(null);
  const [cliChecking, setCliChecking] = useState(false);

  // 일반 설정
  const [userTimezone, setUserTimezone] = useState('Asia/Seoul');
  const [thinkingLevel, setThinkingLevel] = useState('low');

  // draft 모델 변경 시 그 모델에 기억된 thinking 복원(탭 전환 시 그 카테고리 직전 thinking 미리보기).
  useEffect(() => {
    const remembered = lastThinkingByModel[draftModel];
    if (remembered && remembered !== thinkingLevel) setThinkingLevel(remembered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftModel]);

  // thinkingLevel 변경 시 현재 draft 모델 키에 기억(localStorage). 활성 적용은 저장 버튼(persistSettings).
  useEffect(() => {
    if (!draftModel || !thinkingLevel) return;
    if (lastThinkingByModel[draftModel] === thinkingLevel) return;
    setLastThinkingByModel({ ...lastThinkingByModel, [draftModel]: thinkingLevel });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftModel, thinkingLevel]);

  // Provider API 키 (OpenAI / Google AI Studio / Anthropic / Vertex SA)
  const [geminiApiKey, setGeminiApiKey] = useState(''); // OpenAI (기존 이름 유지)
  const [googleApiKey, setGoogleApiKey] = useState(''); // Gemini AI Studio
  const [anthropicApiKey, setAnthropicApiKey] = useState(''); // Claude
  const [vertexSaJson, setVertexSaJson] = useState(''); // Vertex AI Service Account JSON
  const [upstageApiKey, setUpstageApiKey] = useState(''); // Upstage Solar

  // AI 어시스턴트 라우터 (Self-learning Flash Lite)
  const [aiRouterEnabled, setAiRouterEnabled] = useState(false);
  const [aiAssistantModel, setAiAssistantModel] = useState('current');
  // Backend `getAvailableAiAssistantModels()` 응답이 truth source ({id, displayName} 객체 배열) —
  // 이 fallback list 는 첫 fetch 전 / API 실패 시점만 사용. (옛 string[] 취급 = [object Object] 잠복 버그였음.)
  const [aiAssistantModels, setAiAssistantModels] = useState<{ id: string; displayName: string }[]>([
    { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' },
  ]);
  // AI 모델 carousel — useAiModels 컴포넌트 상단 (L57) 에서 호출. 중복 hoist 회피 — 단일 reference.

  // 사용자 커스텀 프롬프트 (어드민 채팅·모나코 에디터 공유)
  const [userPrompt, setUserPrompt] = useState('');

  // Anthropic prompt caching 토글 — Claude API 모드에서만 노출
  const [anthropicCacheEnabled, setAnthropicCacheEnabled] = useState(false);
  const [subAgentEnabled, setSubAgentEnabled] = useState(false);

  // 이미지 생성 모델 (AI 탭 하단 섹션)
  type ImageModelEntry = {
    id: string;
    displayName: string;
    provider: string;
    format: string;
    requiresOrganizationVerification?: boolean;
    sizes?: string[];
    qualities?: string[];
    subscription?: boolean;
  };
  const [imageModel, setImageModelState] = useState('gpt-image-1');
  const [imageModels, setImageModels] = useState<ImageModelEntry[]>([]);
  const [imageDefaultSize, setImageDefaultSize] = useState<string>('');
  const [imageDefaultQuality, setImageDefaultQuality] = useState<string>('');

  // 음성(TTS) — provider(browser/openai/gemini) + 모델 + 기본 보이스. openai/gemini 는 키 있을 때만 선택 가능.
  const [ttsProvider, setTtsProvider] = useState<string>('browser');
  const [ttsModel, setTtsModel] = useState<string>('');
  const [ttsVoice, setTtsVoice] = useState<string>('');
  // 타임스탬프(자막 동기) provider — '' = 자동(Whisper 우선) / 'openai'(Whisper) / 'gemini'. 키 게이팅.
  const [ttsAlignProvider, setTtsAlignProvider] = useState<string>('');
  const [hasOpenaiKey, setHasOpenaiKey] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  // 보이스 샘플 미리듣기 — 현재 합성 중인 voice id (스피너 표시).
  const [ttsSampleVoice, setTtsSampleVoice] = useState<string | null>(null);
  const ttsSampleAudioRef = useRef<HTMLAudioElement | null>(null);

  // AI 탭 서브탭 — LLM(모델) / 프롬프트(사용자 지시사항) / 이미지(생성 모델) / 음성(TTS) / 비용(한도·통계) / 메모리(AI Recall 메타).
  // initialTab='cost'/'memory' 는 SettingsModal entry 시점에 settingsTab='ai' + aiSubTab 으로 자동 변환.
  const [aiSubTab, setAiSubTab] = useState<'llm' | 'prompt' | 'image' | 'tts' | 'cost' | 'memory'>(() => {
    if (hubContext) return 'prompt'; // hub tenant = prompt/memory only (default prompt)
    if (initialTab === 'cost') return 'cost';
    if (initialTab === 'memory') return 'memory';
    return 'llm';
  });

  // 관리자 계정 변경
  const [adminCurrentPw, setAdminCurrentPw] = useState('');
  const [adminNewId, setAdminNewId] = useState('');
  const [adminNewPw, setAdminNewPw] = useState('');
  const [adminPwError, setAdminPwError] = useState('');


  // 시크릿
  const [userSecrets, setUserSecrets] = useState<{ name: string; hasValue: boolean; maskedValue: string }[]>([]);
  const [moduleSecrets, setModuleSecrets] = useState<{ secretName: string; moduleName: string; hasValue: boolean }[]>([]);
  const [moduleSecretValues, setModuleSecretValues] = useState<Record<string, string>>({});
  const [moduleSecretSaving, setModuleSecretSaving] = useState<string | null>(null);
  /** 시크릿별 FeedbackBadge 상태 — 'ok'/'err' 1.5초 표시 후 자동 정리 */
  const [moduleSecretFeedback, setModuleSecretFeedback] = useState<Record<string, 'ok' | 'err' | null>>({});
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [secretSaving, setSecretSaving] = useState(false);
  const [secretFeedback, setSecretFeedback] = useState<'ok' | 'err' | null>(null);
  const [editingSecret, setEditingSecret] = useState<{ name: string; value: string } | null>(null);

  // MCP
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpNewName, setMcpNewName] = useState('');
  const [mcpNewTransport, setMcpNewTransport] = useState<'stdio' | 'sse'>('stdio');
  const [mcpNewCommand, setMcpNewCommand] = useState('');
  const [mcpNewArgs, setMcpNewArgs] = useState('');
  const [mcpNewUrl, setMcpNewUrl] = useState('');
  const [mcpSaving, setMcpSaving] = useState(false);
  const [mcpEditing, setMcpEditing] = useState<string | null>(null);
  const [mcpEditCommand, setMcpEditCommand] = useState('');
  const [mcpEditArgs, setMcpEditArgs] = useState('');
  const [mcpEditUrl, setMcpEditUrl] = useState('');
  const [mcpEditSaving, setMcpEditSaving] = useState(false);
  const [mcpEditFeedback, setMcpEditFeedback] = useState<'ok' | 'err' | null>(null);
  const [mcpAuth, setMcpAuth] = useState<{ server: string; step: 'starting' | 'waiting' | 'done' | 'error'; authUrl?: string; error?: string } | null>(null);

  // 시스템 모듈
  const [sysModules, setSysModules] = useState<SystemModule[]>([]);
  const fetchSysModules = useCallback(async () => {
    try {
      const data = await apiGet<{ success: boolean; modules?: SystemModule[] }>(
        '/api/fs/system-modules',
        { category: 'settings' },
      );
      if (data.success) setSysModules(data.modules ?? []);
    } catch (e) { logger.debug('settings', 'operation 실패', { error: e }); }
  }, []);
  // 모듈별 패키지 업그레이드 가용 여부 — 리스트에 뱃지 표시용. sysModules 로드 후 병렬 fetch.
  // PyPI 결과는 sandbox 어댑터에서 1시간 캐시되므로 매 시스템 탭 진입에 PyPI 호출 부담 0.
  // 모듈별 업그레이드 정보 — 값이 있으면 업그레이드 가능(현재→최신 버전 표시용), 없으면 최신.
  const [moduleUpgradeMap, setModuleUpgradeMap] = useState<Record<string, { installed?: string; latest?: string }>>({});
  useEffect(() => {
    if (sysModules.length === 0) return;
    let cancelled = false;
    (async () => {
      const moduleNames = sysModules
        .filter(m => (m.entryType ?? m.type) !== 'service')
        .map(m => m.name);
      const results = await Promise.all(
        moduleNames.map(async name => {
          try {
            // API route 경유 — typed gRPC client(`lib/api-gen/module`) 는 node:http2 의존이라
            // browser bundle 에 못 들어감 (build error). server-side route 가 typed client 호출 + JSON 반환.
            const res = await apiGet<{ success: boolean; packages?: Array<{ upgradeAvailable?: boolean; installedVersion?: string; latestVersion?: string }> }>(
              `/api/settings/modules/packages?module=${encodeURIComponent(name)}`,
              { category: 'settings' },
            );
            if (res.success && Array.isArray(res.packages)) {
              const up = res.packages.find(p => p.upgradeAvailable === true);
              return [name, up ? { installed: up.installedVersion, latest: up.latestVersion } : null] as const;
            }
          } catch (e) {
            logger.debug('settings', `package status fetch 실패 (${name})`, { error: e });
          }
          return [name, null] as const;
        }),
      );
      if (!cancelled) setModuleUpgradeMap(Object.fromEntries(results.filter(([, v]) => v).map(([n, v]) => [n, v!])));
    })();
    return () => { cancelled = true; };
  }, [sysModules]);
  const toggleModuleEnabled = useCallback(async (name: string, enabled: boolean) => {
    // 낙관적 UI 업데이트
    setSysModules(prev => prev.map(m => m.name === name ? { ...m, enabled } : m));
    try {
      await apiPost('/api/settings/modules', { name, enabled }, { category: 'settings' });
    } catch {
      // 실패 시 롤백
      setSysModules(prev => prev.map(m => m.name === name ? { ...m, enabled: !enabled } : m));
    }
  }, []);

  // Vault 키 현황 로드 — mount + 저장 직후(키 추가 시 게이팅 실시간 반영, F5 불필요).
  const refreshVaultKeys = useCallback(() => {
    return apiGet<{ success?: boolean; keys?: Record<string, { hasKey?: boolean; maskedKey?: string }> }>('/api/vault', { category: 'settings' })
      .then(data => {
        if (!data?.success) return;
        setHasOpenaiKey(!!data.keys?.openai_api_key?.hasKey);
        setHasGeminiKey(!!data.keys?.gemini_api_key?.hasKey);
        if (data.keys?.openai_api_key?.hasKey) setGeminiApiKey(data.keys.openai_api_key.maskedKey ?? '');
        if (data.keys?.gemini_api_key?.hasKey) setGoogleApiKey(data.keys.gemini_api_key.maskedKey ?? '');
        if (data.keys?.anthropic_api_key?.hasKey) setAnthropicApiKey(data.keys.anthropic_api_key.maskedKey ?? '');
        if (data.keys?.google_service_account_json?.hasKey) setVertexSaJson(data.keys.google_service_account_json.maskedKey ?? '');
        if (data.keys?.upstage_api_key?.hasKey) setUpstageApiKey(data.keys.upstage_api_key.maskedKey ?? '');
      })
      .catch(() => {});
  }, []);

  // ── Data load — one owner-injected path (settingsEndpoint), identical full shape for admin & hub.
  useEffect(() => {
    settingsEndpoint.load()
      .then((data: any) => {
        if (!data?.success) return;
        if (data.timezone) setUserTimezone(data.timezone);
        if (data.aiThinkingLevel) setThinkingLevel(data.aiThinkingLevel);
        if (typeof data.aiRouterEnabled === 'boolean') setAiRouterEnabled(data.aiRouterEnabled);
        if (data.aiAssistantModel) setAiAssistantModel(data.aiAssistantModel);
        if (Array.isArray(data.aiAssistantModels) && data.aiAssistantModels.length > 0) setAiAssistantModels(data.aiAssistantModels);
        if (typeof data.userPrompt === 'string') setUserPrompt(data.userPrompt);
        if (typeof data.anthropicCacheEnabled === 'boolean') setAnthropicCacheEnabled(data.anthropicCacheEnabled);
        if (typeof data.subAgentEnabled === 'boolean') setSubAgentEnabled(data.subAgentEnabled);
        if (typeof data.imageModel === 'string') setImageModelState(data.imageModel);
        if (Array.isArray(data.imageModels)) setImageModels(data.imageModels);
        if (typeof data.imageDefaultSize === 'string') setImageDefaultSize(data.imageDefaultSize);
        if (typeof data.imageDefaultQuality === 'string') setImageDefaultQuality(data.imageDefaultQuality);
        if (typeof data.ttsProvider === 'string' && data.ttsProvider) setTtsProvider(data.ttsProvider);
        if (typeof data.ttsModel === 'string') setTtsModel(data.ttsModel);
        if (typeof data.ttsVoice === 'string') setTtsVoice(data.ttsVoice);
        if (typeof data.ttsAlignProvider === 'string') setTtsAlignProvider(data.ttsAlignProvider);
      })
      .catch(() => {});
    // Vault key display = admin-only capability (a tenant has no key management, uses shared vault).
    if (!hubContext) refreshVaultKeys();
  }, [settingsEndpoint, refreshVaultKeys, hubContext]);

  // 사용자 커스텀 프롬프트 저장
  // 시크릿
  const fetchSecrets = useCallback(async () => {
    try {
      const data = await apiGet<any>('/api/vault/secrets', { category: 'settings' });
      if (data.success) {
        setUserSecrets(data.secrets ?? []);
        setModuleSecrets(data.moduleSecrets ?? []);
      }
    } catch (e) { logger.debug('settings', 'operation 실패', { error: e }); }
  }, []);

  const addSecret = async () => {
    if (!newSecretName.trim() || !newSecretValue.trim()) return;
    setSecretSaving(true);
    try {
      const data = await apiPost<{ success: boolean }>(
        '/api/vault/secrets',
        { name: newSecretName.trim(), value: newSecretValue.trim() },
        { category: 'settings' },
      );
      if (data.success) {
        setNewSecretName(''); setNewSecretValue('');
        setSecretFeedback('ok');
        fetchSecrets();
      } else {
        setSecretFeedback('err');
      }
    } catch {
      setSecretFeedback('err');
    }
    finally {
      setSecretSaving(false);
      setTimeout(() => setSecretFeedback(null), 1800);
    }
  };

  const saveModuleSecret = async (secretName: string) => {
    const value = moduleSecretValues[secretName]?.trim();
    if (!value) return;
    setModuleSecretSaving(secretName);
    try {
      const data = await apiPost<{ success: boolean }>(
        '/api/vault/secrets',
        { name: secretName, value },
        { category: 'settings' },
      );
      if (data.success) {
        setModuleSecretValues(prev => { const n = { ...prev }; delete n[secretName]; return n; });
        setModuleSecretFeedback(prev => ({ ...prev, [secretName]: 'ok' }));
        fetchSecrets();
      } else {
        setModuleSecretFeedback(prev => ({ ...prev, [secretName]: 'err' }));
      }
      setTimeout(() => setModuleSecretFeedback(prev => ({ ...prev, [secretName]: null })), 1500);
    } catch {
      setModuleSecretFeedback(prev => ({ ...prev, [secretName]: 'err' }));
      setTimeout(() => setModuleSecretFeedback(prev => ({ ...prev, [secretName]: null })), 1500);
    } finally { setModuleSecretSaving(null); }
  };

  const deleteSecret = async (name: string) => {
    if (!await confirmDialog({ title: t('settings_modal.secret_delete_title'), message: t('settings_modal.secret_delete_message', { name }), danger: true, okLabel: t('settings_modal.secret_delete_ok') })) return;
    await apiDelete(`/api/vault/secrets?name=${encodeURIComponent(name)}`, { category: 'settings' });
    fetchSecrets();
  };

  // MCP 서버
  const mcpLoaded = useRef(false);
  const fetchMcpServers = useCallback(async () => {
    if (!mcpLoaded.current) setMcpLoading(true);
    try {
      const data = await apiGet<{ success: boolean; servers?: McpServer[] }>(
        '/api/mcp/servers',
        { category: 'settings' },
      );
      if (data.success) setMcpServers(data.servers ?? []);
      mcpLoaded.current = true;
    } catch (e) { logger.debug('settings', 'operation 실패', { error: e }); } finally { setMcpLoading(false); }
  }, []);

  const addMcpServer = async () => {
    const name = mcpNewName.trim();
    if (!name) return;
    setMcpSaving(true);
    try {
      const body: any = { name, transport: mcpNewTransport, enabled: true };
      if (mcpNewTransport === 'stdio') {
        body.command = mcpNewCommand.trim();
        body.args = mcpNewArgs.trim() ? mcpNewArgs.trim().split(/\s+/) : [];
      } else {
        body.url = mcpNewUrl.trim();
      }
      try {
        await apiPost('/api/mcp/servers', body, { category: 'settings' });
      } catch {
        return;
      }

      const testData = await apiGet<{ success: boolean; error?: string }>(
        `/api/mcp/tools?server=${encodeURIComponent(name)}`,
        { category: 'settings' },
      ).catch(() => ({ success: false, error: t('settings_modal.mcp_fetch_failed') }));

      if (testData.success) {
        setMcpNewName(''); setMcpNewCommand(''); setMcpNewArgs(''); setMcpNewUrl('');
      } else {
        await apiDelete(`/api/mcp/servers?name=${encodeURIComponent(name)}`, { category: 'settings' });
        await alertDialog({ title: t('settings_modal.mcp_connect_failed_title'), message: t('settings_modal.mcp_connect_failed_message', { error: String(testData.error ?? '') }), danger: true });
      }
      fetchMcpServers();
    } finally { setMcpSaving(false); }
  };

  const deleteMcpServer = async (name: string) => {
    if (!await confirmDialog({ title: t('settings_modal.mcp_remove_title'), message: t('settings_modal.mcp_remove_message', { name }), danger: true, okLabel: t('settings_modal.mcp_remove_ok') })) return;
    await apiDelete(`/api/mcp/servers?name=${encodeURIComponent(name)}`, { category: 'settings' });
    setMcpEditing(null);
    fetchMcpServers();
  };

  const startEditMcp = (server: McpServer) => {
    setMcpEditing(server.name);
    setMcpEditCommand(server.command ?? '');
    setMcpEditArgs((server.args ?? []).join(' '));
    setMcpEditUrl(server.url ?? '');
  };

  const saveEditMcp = async (server: McpServer) => {
    setMcpEditSaving(true);
    try {
      // 삭제 후 재등록 (서버 설정 업데이트 API가 없으므로)
      await apiDelete(`/api/mcp/servers?name=${encodeURIComponent(server.name)}`, { category: 'settings' });
      const body: any = { name: server.name, transport: server.transport, enabled: true };
      if (server.transport === 'stdio') {
        body.command = mcpEditCommand.trim();
        body.args = mcpEditArgs.trim() ? mcpEditArgs.trim().split(/\s+/) : [];
      } else {
        body.url = mcpEditUrl.trim();
      }
      try {
        await apiPost('/api/mcp/servers', body, { category: 'settings' });
        setMcpEditing(null);
        setMcpEditFeedback('ok');
        fetchMcpServers();
      } catch {
        setMcpEditFeedback('err');
      }
    } catch {
      setMcpEditFeedback('err');
    }
    finally {
      setMcpEditSaving(false);
      setTimeout(() => setMcpEditFeedback(null), 1800);
    }
  };

  const startMcpAuth = async (serverName: string) => {
    setMcpAuth({ server: serverName, step: 'starting' });
    try {
      const data = await apiPost<{ success: boolean; alreadyAuthenticated?: boolean; authUrl?: string; error?: string }>(
        '/api/mcp/auth',
        { serverName },
        { category: 'settings' },
      );
      if (data.success && data.alreadyAuthenticated) {
        setMcpAuth({ server: serverName, step: 'done' });
      } else if (data.success && data.authUrl) {
        setMcpAuth({ server: serverName, step: 'waiting', authUrl: data.authUrl });
        const popup = window.open(data.authUrl, 'mcp-oauth', 'width=500,height=700,left=200,top=100');
        const handler = (ev: MessageEvent) => {
          if (ev.origin !== window.location.origin) return;
          if (ev.data?.type === 'mcp-oauth-done') {
            window.removeEventListener('message', handler);
            if (ev.data.success) {
              setMcpAuth(prev => prev ? { ...prev, step: 'done' } : null);
            } else {
              setMcpAuth(prev => prev ? { ...prev, step: 'error', error: t('settings_modal.mcp_oauth_failed') } : null);
            }
          }
        };
        window.addEventListener('message', handler);
        const pollClosed = setInterval(() => {
          if (popup && popup.closed) {
            clearInterval(pollClosed);
            setTimeout(() => {
              setMcpAuth(prev => {
                if (prev?.step === 'waiting') {
                  window.removeEventListener('message', handler);
                  return { ...prev, step: 'error', error: t('settings_modal.mcp_oauth_popup_closed') };
                }
                return prev;
              });
            }, 1000);
          }
        }, 500);
      } else {
        setMcpAuth({ server: serverName, step: 'error', error: data.error });
      }
    } catch (err: any) {
      setMcpAuth({ server: serverName, step: 'error', error: err.message });
    }
  };

  // 탭 콘텐츠 스크롤 리셋용
  const contentRef = useRef<HTMLDivElement>(null);
  // 탭 바 — PC에서 드래그로 가로 스크롤 (모바일은 터치로 기본 동작)
  const tabBarRef = useRef<HTMLDivElement>(null);

  const switchTab = (tab: typeof settingsTab) => {
    setSettingsTab(tab);
    contentRef.current?.scrollTo(0, 0);
  };

  // PC용: 탭 바 마우스 드래그 스크롤 (임계값 넘어야 실제 드래그로 간주 → 클릭과 충돌 방지)
  const draggedRef = useRef(false);
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    let isDown = false;
    let startX = 0;
    let startScroll = 0;
    const DRAG_THRESHOLD = 5;
    const onDown = (e: MouseEvent) => { isDown = true; startX = e.pageX; startScroll = bar.scrollLeft; draggedRef.current = false; };
    const onMove = (e: MouseEvent) => {
      if (!isDown) return;
      const dx = e.pageX - startX;
      if (!draggedRef.current && Math.abs(dx) < DRAG_THRESHOLD) return;
      draggedRef.current = true;
      bar.style.cursor = 'grabbing';
      e.preventDefault();
      bar.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      isDown = false;
      bar.style.cursor = '';
      // 다음 tick에 reset — click 이벤트 확인 후
      setTimeout(() => { draggedRef.current = false; }, 0);
    };
    // 드래그 직후 click 차단
    const onClickCapture = (e: MouseEvent) => {
      if (draggedRef.current) { e.preventDefault(); e.stopPropagation(); }
    };
    bar.addEventListener('mousedown', onDown);
    bar.addEventListener('click', onClickCapture, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      bar.removeEventListener('mousedown', onDown);
      bar.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 탭 스크롤 상태 — 좌/우 화살표 가시성 제어
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: false });
  const updateScrollState = useCallback(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    setScrollState({
      canLeft: bar.scrollLeft > 2,
      canRight: bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2,
    });
  }, []);
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    updateScrollState();
    bar.addEventListener('scroll', updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(bar);
    return () => { bar.removeEventListener('scroll', updateScrollState); ro.disconnect(); };
  }, [updateScrollState]);
  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    const bar = tabBarRef.current;
    if (!bar) return;
    bar.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' });
  }, []);

  // 탭 전환 시 데이터 로드
  useEffect(() => {
    if (settingsTab === 'secrets') fetchSecrets();
    if (settingsTab === 'mcp') fetchMcpServers();
    if (settingsTab === 'system') fetchSysModules();
  }, [settingsTab, fetchSecrets, fetchMcpServers, fetchSysModules]);

  // ── 저장 ───────────────────────────────────────────────────────────────────
  const [mainSaveState, setMainSaveState] = useState<'ok' | 'err' | 'loading' | null>(null);
  // Persist settings. owner-injection lives entirely in settingsEndpoint.save (single point); the
  // admin-only extras below (model-category memory, provider vault keys) are capability-guarded,
  // not forks of shared logic. Returns false only on a real save failure.
  const persistSettings = async (): Promise<boolean> => {
    // The staged draft becomes the active/persisted model on Save (not on selection).
    const saveCat = draftModel ? categoryOf(draftModel) : '';
    const nextLastModelByCategory = saveCat
      ? { ...lastModelByCategory, [saveCat]: draftModel }
      : lastModelByCategory;
    // Model tab is admin-only, so the localStorage fallback + per-category memory apply only there.
    if (!hubContext) {
      writeSetting('firebat_model', draftModel);
      if (saveCat) setLastModelByCategory(nextLastModelByCategory);
    }

    // Settings batch — single owner-injected endpoint, identical full payload for admin & hub.
    // The hub backend persists only its per-tenant fields; the rest are read-only there.
    const ok = await settingsEndpoint.save({
      timezone: userTimezone,
      aiModel: draftModel,
      aiThinkingLevel: thinkingLevel,
      aiRouterEnabled,
      aiAssistantModel,
      imageModel,
      imageDefaultSize,
      imageDefaultQuality,
      userPrompt,
      ttsProvider,
      ttsModel,
      ttsVoice,
      ttsAlignProvider,
      lastModelByCategory: nextLastModelByCategory,
    });
    if (!ok) return false;

    // Refresh the sidebar (CronPanel's ['settings','ai-router'], etc.) right after saving — no F5.
    queryClient.invalidateQueries({ queryKey: ['settings'] });

    // Provider API keys → vault. Admin-only capability (a tenant has no key inputs, uses the shared
    // admin vault) → guarded by hubContext, not a fork of the shared save path.
    if (!hubContext) {
      const saveProviderKey = async (provider: 'openai' | 'gemini' | 'anthropic' | 'vertex' | 'upstage', value: string) => {
        if (!value || value.includes('...') || value === '***') return;
        await apiPost('/api/vault', { provider, apiKey: value }, { category: 'settings' }).catch(() => {});
      };
      await saveProviderKey('openai', geminiApiKey);
      await saveProviderKey('gemini', googleApiKey);
      await saveProviderKey('anthropic', anthropicApiKey);
      await saveProviderKey('vertex', vertexSaJson);
      await saveProviderKey('upstage', upstageApiKey);
      // Refresh vault-key gating so e.g. the TTS provider activates without F5.
      await refreshVaultKeys();
    }
    return true;
  };

  const handleSave = async () => {
    setMainSaveState('loading');

    const ok = await persistSettings();
    if (!ok) {
      setMainSaveState('err');
      setTimeout(() => setMainSaveState(null), 2000);
      return;
    }
    // Apply the staged model as the active chat model now (persist succeeded). Until this point the
    // dropdown / provider tabs only changed the draft — this is where the switch actually takes effect.
    if (draftModel && draftModel !== aiModel) onAiModelChange(draftModel);

    // Account change — runs only when a current password was entered (never in hub-mode; that
    // field's tab is hidden), so this is data-guarded, not a hubContext branch. Server
    // validate_password_policy is authoritative.
    if (adminCurrentPw) {
      const adminPwSchema = z.object({
        currentPassword: z.string().min(1),
        newId: z.string(),
        newPassword: z.string(),
      }).refine((v) => v.newId.trim().length > 0 || v.newPassword.trim().length > 0, {
        message: t('settings_modal.admin_pw_either_required'),
        path: ['newPassword'],
      });
      const parsed = validateForm(adminPwSchema, {
        currentPassword: adminCurrentPw,
        newId: adminNewId,
        newPassword: adminNewPw,
      });
      if (!parsed.success) {
        setAdminPwError(Object.values(parsed.errors)[0] ?? t('settings_modal.admin_pw_input_error'));
        setMainSaveState('err');
        setTimeout(() => setMainSaveState(null), 2000);
        return;
      }
      try {
        await apiPatch(
          '/api/auth',
          { currentPassword: parsed.data.currentPassword, newId: parsed.data.newId, newPassword: parsed.data.newPassword },
          { category: 'settings' },
        );
        setAdminCurrentPw(''); setAdminNewId(''); setAdminNewPw(''); setAdminPwError('');
      } catch (err: any) {
        setAdminPwError(err?.responseBody?.error ?? err?.message ?? t('settings_modal.admin_pw_change_failed'));
        setMainSaveState('err');
        setTimeout(() => setMainSaveState(null), 2000);
        return;
      }
    }

    // Saved — show ✓ only and keep the modal open (more edits possible). The user closes it via
    // the close button. Identical for admin and hub (no per-surface behavior fork).
    setMainSaveState('ok');
    setTimeout(() => setMainSaveState(null), 2000);
  };

  // 보이스 샘플 미리듣기 — 후보 보이스로 짧은 문장 합성 → data URL <audio> 재생. browser provider 는 호출 안 함.
  const playTtsSample = useCallback(async (provider: string, model: string, voice: string) => {
    if (!provider || provider === 'browser') return;
    // 재생 중이면 중지
    if (ttsSampleAudioRef.current) {
      ttsSampleAudioRef.current.pause();
      ttsSampleAudioRef.current = null;
    }
    setTtsSampleVoice(voice);
    try {
      const data = await apiPost<{ success?: boolean; url?: string; contentType?: string; error?: string }>(
        '/api/tts/sample',
        { provider, model, voice, text: 'Hello, this is a sample of my voice. I hope you like it.' },
        { category: 'settings' },
      );
      if (!data?.success || !data.url) {
        logger.warn('tts', `보이스 샘플 실패: ${data?.error ?? 'unknown'}`);
        setTtsSampleVoice(null);
        return;
      }
      // generate-once 파일 URL — 같은 보이스 재생 시 브라우저 캐시로 즉시.
      const audio = new Audio(data.url);
      ttsSampleAudioRef.current = audio;
      audio.onended = () => { setTtsSampleVoice(null); ttsSampleAudioRef.current = null; };
      audio.onerror = () => { setTtsSampleVoice(null); ttsSampleAudioRef.current = null; };
      await audio.play().catch(() => { setTtsSampleVoice(null); });
    } catch (e) {
      logger.warn('tts', `보이스 샘플 오류: ${String(e)}`);
      setTtsSampleVoice(null);
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]">
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
          <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
            <Settings size={18} className="text-blue-500" /> Settings
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X size={22} />
          </button>
        </div>

        {/* 탭 — 모바일은 터치 스크롤, PC는 드래그 + 호버 시 화살표 */}
        <div className="relative shrink-0 border-b border-slate-200 bg-white group">
          {scrollState.canLeft && (
            <button
              type="button"
              onClick={() => scrollTabs('left')}
              className="hidden sm:flex absolute left-0 top-0 bottom-0 z-20 w-7 items-center justify-center text-slate-400 hover:text-slate-700 bg-gradient-to-r from-white via-white to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={t('system_modules.common.prev_tab')}
            ><ChevronLeft size={16} /></button>
          )}
          {scrollState.canRight && (
            <button
              type="button"
              onClick={() => scrollTabs('right')}
              className="hidden sm:flex absolute right-0 top-0 bottom-0 z-20 w-7 items-center justify-center text-slate-400 hover:text-slate-700 bg-gradient-to-l from-white via-white to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={t('system_modules.common.next_tab')}
            ><ChevronRight size={16} /></button>
          )}
          <div ref={tabBarRef} className="flex px-3 sm:px-6 bg-white overflow-x-auto scrollbar-none select-none cursor-grab">
          {/* hub tenant = AI tab (prompt/memory) only 노출. 나머지 탭(general·secrets·mcp·capabilities·system·logs)은 root 전용이라 숨김. */}
          {!hubMode && (
          <button
            onClick={() => switchTab('general')}
            data-active={settingsTab === 'general'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors whitespace-nowrap ${settingsTab === 'general' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            {t('settings_modal.tab_general')}
          </button>
          )}
          <button
            onClick={() => switchTab('ai')}
            data-active={settingsTab === 'ai'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'ai' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <Cpu size={14} /> AI
          </button>
          {!hubMode && (<>
          <button
            onClick={() => switchTab('secrets')}
            data-active={settingsTab === 'secrets'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'secrets' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <KeyRound size={14} /> {t('settings_modal.tab_secrets')}
          </button>
          <button
            onClick={() => switchTab('mcp')}
            data-active={settingsTab === 'mcp'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'mcp' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <Plug size={14} /> {t('settings_modal.tab_mcp')}
          </button>
          <button
            onClick={() => switchTab('capabilities')}
            data-active={settingsTab === 'capabilities'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'capabilities' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <Layers size={14} /> {t('settings_modal.tab_capabilities')}
          </button>
          <button
            onClick={() => switchTab('system')}
            data-active={settingsTab === 'system'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'system' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <Cpu size={14} /> {t('settings_modal.tab_system')}
          </button>
          <button
            onClick={() => switchTab('logs')}
            data-active={settingsTab === 'logs'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'logs' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <ScrollText size={14} /> {t('settings_modal.tab_logs')}
          </button>
          </>)}
          </div>
        </div>

        <div ref={contentRef} className="p-3 sm:p-6 flex flex-col gap-4 overflow-y-auto min-w-0 flex-1 min-h-0 [scrollbar-gutter:stable_both-edges]">
          {settingsTab === 'general' && (
            <>
              {/* 인터페이스 언어 */}
              <div className="flex flex-col gap-2">
                <span className="text-xs sm:text-sm font-bold text-slate-700">{t('settings.interface_lang')}</span>
                <div className="flex gap-2">
                  {(['ko', 'en'] as const).map(l => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setUiLang(l as Lang)}
                      className={`flex-1 py-1.5 sm:py-2 text-[13px] sm:text-[14px] font-medium rounded-lg border transition-colors ${
                        uiLang === l
                          ? 'bg-blue-50 border-blue-500 text-blue-700'
                          : 'bg-white border-slate-300 text-slate-600 hover:border-slate-400'
                      }`}
                    >
                      {l === 'ko' ? '한국어' : 'English'}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                  {t('settings.interface_lang_desc')}
                </p>
              </div>

              {/* 타임존 */}
              <div className="flex flex-col gap-2">
                <label className="text-xs sm:text-sm font-bold text-slate-700" htmlFor={userTimezoneId}>{t('settings.timezone')}</label>
                <select
                  value={userTimezone}
                  onChange={e => setUserTimezone(e.target.value)}
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer" name="userTimezone" id={userTimezoneId}
                >
                  {TIMEZONE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{timezoneLabel(opt, uiLang)}</option>
                  ))}
                </select>
                <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                  {t('settings_modal.timezone_help')}
                </p>
              </div>

              {/* 관리자 계정 변경 */}
              <div className="flex flex-col gap-2 pt-1 border-t border-slate-100">
                <span className="text-xs sm:text-sm font-bold text-slate-700 pt-1">{t('settings_modal.admin_account_change')}</span>
                <input
                  id={adminCurrentPwId}
                  name="currentPassword"
                  type="password"
                  value={adminCurrentPw}
                  onChange={e => { setAdminCurrentPw(e.target.value); setAdminPwError(''); }}
                  placeholder={t('settings_modal.current_password_placeholder')}
                  autoComplete="current-password"
                  aria-label={t('settings_modal.current_password_label')}
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <input
                  type="text"
                  value={adminNewId}
                  onChange={e => setAdminNewId(e.target.value)}
                  placeholder={t('settings_modal.new_id_placeholder')}
                  autoComplete="username"
                  aria-label={t('settings_modal.new_id_label')}
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="adminNewId" id={adminNewIdId}
                />
                <input
                  id={adminNewPwId}
                  name="newPassword"
                  type="password"
                  value={adminNewPw}
                  onChange={e => setAdminNewPw(e.target.value)}
                  placeholder={t('settings_modal.new_password_placeholder')}
                  autoComplete="new-password"
                  aria-label={t('settings_modal.new_password_label')}
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {adminPwError && <p className="text-[10px] sm:text-xs text-red-500 font-medium">{adminPwError}</p>}
                <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{t('settings_modal.admin_account_change_hint')}</p>
                <p className="text-[10px] sm:text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 leading-relaxed">
                  {t('settings_modal.admin_account_change_warning')}
                </p>
              </div>

            </>
          )}

          {settingsTab === 'ai' && (() => {
            // 모드별 사용 가능 프로바이더
            // 공급자는 ABC 순. Anthropic → Google → OpenAI
            const providersByMode: Record<'general' | 'vertex', Array<'openai' | 'google' | 'anthropic' | 'upstage'>> = {
              general: ['anthropic', 'google', 'openai', 'upstage'],
              vertex: ['google'],
            };
            const activeProviders = providersByMode[aiMode];
            const effectiveProvider = activeProviders.includes(aiProvider) ? aiProvider : activeProviders[0];
            const cliProviderPrefix: Record<CliProvider, string> = {
              claude: 'cli-claude-code',
              codex: 'cli-codex',
              gemini: 'cli-gemini',
            };
            // 모델 필터: 실행모드(api/cli) + 모드(일반/Vertex) + 프로바이더
            // 모델 순서는 types.ts 원본 유지 (최신·고품질 순서, ABC 아님)
            const modelsForProvider = aiModelsList.filter(m => {
              const v = m.value;
              if (execMode === 'cli') return v.startsWith(cliProviderPrefix[cliProvider]);
              if (v.startsWith('cli-')) return false;
              if (aiMode === 'vertex') return v.startsWith('vertex-');
              if (v.startsWith('vertex-')) return false; // vertex 모델은 일반 모드 제외
              if (effectiveProvider === 'openai') return v.startsWith('gpt-');
              if (effectiveProvider === 'google') return v.startsWith('gemini-');
              if (effectiveProvider === 'anthropic') return v.startsWith('claude-');
              if (effectiveProvider === 'upstage') return v.startsWith('solar-');
              return false;
            });
            const providerLabels: Record<'openai' | 'google' | 'anthropic' | 'upstage', string> = {
              openai: 'OpenAI', google: 'Google', anthropic: 'Anthropic', upstage: 'Upstage',
            };
            // 공급자 통일 — API/CLI 모두 Anthropic / Google / OpenAI (회사명 고정).
            // 내부 키는 역사적 이유로 CliProvider=claude/codex/gemini 유지 — 라벨만 회사명으로 매핑.
            const cliProviderLabels: Record<CliProvider, string> = {
              claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google',
            };
            // 모델 드롭다운용 option 배열
            const modelOptions = modelsForProvider.length > 0
              ? modelsForProvider.map(m => ({ value: m.value, label: m.label }))
              : [{ value: '', label: t('settings_modal.image_no_model_option') }];
            const modelValue = modelsForProvider.some(m => m.value === draftModel) ? draftModel : (modelsForProvider[0]?.value ?? '');
            // Thinking — JSON registry single source. 옛 hardcoded prefix 기반 polices 폐기 (2026-05-13).
            const modelEntry = aiModelsList.find(m => m.value === modelValue);
            const thinkingKind = modelEntry?.thinking?.kind;
            const thinkingOptions = (modelEntry?.thinking?.levels ?? []).map(l => ({
              value: l.value,
              label: thinkingLevelLabel(l, uiLang),
            }));
            const thinkingValid = thinkingOptions.some(l => l.value === thinkingLevel);
            const thinkingValue = thinkingValid ? thinkingLevel : (thinkingOptions[0]?.value ?? 'medium');
            const thinkingLabel = thinkingKind === 'reasoning' ? 'Reasoning (OpenAI)'
              : thinkingKind === 'thinking' ? 'Thinking (Gemini)'
              : 'Extended Thinking (Claude)';
            return (
              <>
                {/* AI 서브탭 바 — 메인 탭 nav 와 동일 underline 패턴 (border-b-2).
                    overflow-x-auto 폐기 — root cause: commit 19e2dc4 가 5 button (3→5) +
                    overflow-x-auto 추가하여 부모 flex flex-col 안 child 의 overflow:auto box 가
                    height collapse (flex + overflow 충돌). 5 button width 합 ~290px <
                    modal sm:max-w-lg 512px 라 overflow-x-auto 불필요. */}
                <div className="flex items-center gap-1 border-b border-slate-200 mb-3">
                  {([
                    { v: 'llm', label: 'LLM' },
                    { v: 'prompt', label: t('settings_modal.ai_sub_tab_prompt') },
                    { v: 'image', label: t('settings_modal.ai_sub_tab_image') },
                    { v: 'tts', label: t('settings_modal.ai_sub_tab_tts') },
                    { v: 'cost', label: t('settings_modal.ai_sub_tab_cost') },
                    { v: 'memory', label: t('settings_modal.ai_sub_tab_memory') },
                  ] as const).filter(tab => !hubMode || tab.v === 'prompt' || tab.v === 'memory').map(tab => (
                    <button
                      key={tab.v}
                      onClick={() => setAiSubTab(tab.v)}
                      className={`px-3 py-1.5 text-xs sm:text-sm font-bold border-b-2 transition-colors whitespace-nowrap ${
                        aiSubTab === tab.v
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-slate-400 hover:text-slate-600'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                {aiSubTab === 'cost' && <CostTabContent />}
                {aiSubTab === 'memory' && <MemoryTabContent hubContext={hubContext} />}
                {aiSubTab === 'llm' && (<>
                <Field label={t('settings_modal.exec_mode_label')} help={t('settings_modal.exec_mode_help')}>
                  <SegButtons<'api' | 'cli'>
                    value={execMode}
                    onChange={(em) => {
                      if (em === execMode) return;
                      setExecMode(em);
                      if (em === 'cli') {
                        if (draftModel.startsWith('cli-')) return;
                        const newCat = `cli-${cliProvider}`;
                        const prefix = cliProviderPrefix[cliProvider];
                        const firstCli = aiModelsList.find(mm => mm.value.startsWith(prefix));
                        restoreOrFirst(newCat, firstCli?.value);
                      } else {
                        if (!draftModel.startsWith('cli-')) return;
                        const newCat = aiMode === 'vertex' ? 'vertex-google' : `api-${aiProvider}`;
                        const firstApi = aiModelsList.find(mm => {
                          const v = mm.value;
                          if (v.startsWith('cli-')) return false;
                          if (aiMode === 'vertex') return v.startsWith('vertex-');
                          if (v.startsWith('vertex-')) return false;
                          if (aiProvider === 'openai') return v.startsWith('gpt-');
                          if (aiProvider === 'google') return v.startsWith('gemini-');
                          return v.startsWith('claude-');
                        });
                        restoreOrFirst(newCat, firstApi?.value);
                      }
                    }}
                    options={[{ value: 'api', label: t('settings_modal.exec_mode_api') }, { value: 'cli', label: t('settings_modal.exec_mode_cli') }]}
                  />
                </Field>

                {execMode === 'api' && (
                <Field label={t('settings_modal.mode_label')} help={t('settings_modal.mode_help')}>
                  <SegButtons<'general' | 'vertex'>
                    value={aiMode}
                    onChange={(m) => {
                      if (m === aiMode) return;
                      setAiMode(m);
                      const nextProviders = providersByMode[m];
                      const nextProvider = nextProviders.includes(aiProvider) ? aiProvider : nextProviders[0];
                      setAiProvider(nextProvider);
                      const fits = (m === 'vertex' ? draftModel.startsWith('vertex-') : !draftModel.startsWith('vertex-'))
                        && (nextProvider === 'openai' ? draftModel.startsWith('gpt-')
                            : nextProvider === 'google' ? draftModel.startsWith('gemini-')
                            : draftModel.startsWith('claude-'));
                      if (fits) return;
                      const newCat = m === 'vertex' ? 'vertex-google' : `api-${nextProvider}`;
                      const nextModels = aiModelsList.filter(mm => {
                        const v = mm.value;
                        if (v.startsWith('cli-')) return false;
                        if (m === 'vertex') return v.startsWith('vertex-');
                        if (v.startsWith('vertex-')) return false;
                        if (nextProvider === 'openai') return v.startsWith('gpt-');
                        if (nextProvider === 'google') return v.startsWith('gemini-');
                        return v.startsWith('claude-');
                      });
                      restoreOrFirst(newCat, nextModels[0]?.value);
                    }}
                    options={[{ value: 'general', label: t('settings_modal.mode_general') }, { value: 'vertex', label: 'Vertex' }]}
                  />
                </Field>
                )}

                {execMode === 'api' && (
                <Field label={t('settings_modal.provider_label')}>
                  <SegButtons<'openai' | 'google' | 'anthropic' | 'upstage'>
                    value={effectiveProvider}
                    onChange={(p) => {
                      if (p === effectiveProvider) return;
                      setAiProvider(p);
                      const fits = (aiMode === 'vertex' ? draftModel.startsWith('vertex-') : !draftModel.startsWith('vertex-'))
                        && (p === 'openai' ? draftModel.startsWith('gpt-')
                            : p === 'google' ? draftModel.startsWith('gemini-')
                            : p === 'anthropic' ? draftModel.startsWith('claude-')
                            : draftModel.startsWith('solar-'));
                      if (fits) return;
                      const newCat = aiMode === 'vertex' ? 'vertex-google' : `api-${p}`;
                      const nextModels = aiModelsList.filter(mm => {
                        const v = mm.value;
                        if (v.startsWith('cli-')) return false;
                        if (aiMode === 'vertex') return v.startsWith('vertex-');
                        if (v.startsWith('vertex-')) return false;
                        if (p === 'openai') return v.startsWith('gpt-');
                        if (p === 'google') return v.startsWith('gemini-');
                        if (p === 'anthropic') return v.startsWith('claude-');
                        return v.startsWith('solar-');
                      });
                      restoreOrFirst(newCat, nextModels[0]?.value);
                    }}
                    options={activeProviders.map(p => ({ value: p, label: providerLabels[p] }))}
                  />
                </Field>
                )}

                {execMode === 'cli' && (
                <Field label={t('settings_modal.provider_label')} help={t('settings_modal.cli_provider_help')}>
                  <SegButtons<CliProvider>
                    value={cliProvider}
                    onChange={(p) => {
                      if (p === cliProvider) return;
                      setCliProvider(p);
                      setCliStatus(null);
                      const prefix = cliProviderPrefix[p];
                      if (draftModel.startsWith(prefix)) return;
                      const newCat = `cli-${p}`;
                      const first = aiModelsList.find(mm => mm.value.startsWith(prefix));
                      restoreOrFirst(newCat, first?.value);
                    }}
                    options={(['claude', 'gemini', 'codex'] as CliProvider[]).map(p => ({ value: p, label: cliProviderLabels[p] }))}
                  />
                </Field>
                )}

                <Field label={t('settings_modal.model_label')}>
                  <SelectInput value={modelValue} onChange={setDraftModel} options={modelOptions} />
                </Field>

                {/* Thinking — 모델 드롭다운 바로 아래. API / CLI 둘 다 동일 위치. */}
                {thinkingKind && thinkingOptions.length > 0 && (
                  <Field label={thinkingLabel}>
                    <SelectInput value={thinkingValue} onChange={setThinkingLevel} options={thinkingOptions} />
                  </Field>
                )}

                {/* Anthropic prompt caching 토글 — Claude API 모드 전용 (모드=일반 AND 공급자=Anthropic) */}
                {execMode === 'api' && aiMode === 'general' && aiProvider === 'anthropic' && (
                  <Field label={t('settings_modal.prompt_caching_label')} help={t('settings_modal.prompt_caching_help')}>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={anthropicCacheEnabled}
                        onChange={async (e) => {
                          const next = e.target.checked;
                          setAnthropicCacheEnabled(next);
                          await apiPatch('/api/settings', { anthropicCacheEnabled: next }, { category: 'settings' });
                        }}
                        aria-label={t('settings_modal.prompt_caching_aria')}
                        className="w-4 h-4 cursor-pointer" name="anthropicCacheEnabled" autoComplete="off" id={anthropicCacheId}
                      />
                      <span className="text-[12px] text-slate-700">{anthropicCacheEnabled ? t('settings_modal.prompt_caching_on') : t('settings_modal.prompt_caching_off')}</span>
                    </label>
                  </Field>
                )}

                {/* Sub-agent 병렬 토글 — 모든 모드에 노출. ON 시 spawn_subagent 도구 LLM 한테 노출 */}
                <Field label={t('settings_modal.subagent_label')} help={t('settings_modal.subagent_help')}>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={subAgentEnabled}
                      onChange={async (e) => {
                        const next = e.target.checked;
                        setSubAgentEnabled(next);
                        await apiPatch('/api/settings', { subAgentEnabled: next }, { category: 'settings' });
                      }}
                      aria-label={t('settings_modal.subagent_aria')}
                      className="w-4 h-4 cursor-pointer" name="subAgentEnabled" autoComplete="off" id={subAgentEnabledId}
                    />
                    <span className="text-[12px] text-slate-700">{subAgentEnabled ? t('settings_modal.subagent_on') : t('settings_modal.subagent_off')}</span>
                  </label>
                </Field>

                {execMode === 'cli' && (() => {
                  // 현재 공급자별 설치/인증 안내
                  const guide: Record<CliProvider, {
                    name: string;
                    install: string;
                    login: string;
                    subscription: string;
                    apiProvider: 'claude-code' | 'codex' | 'gemini';
                  }> = {
                    claude: {
                      name: 'Claude Code',
                      install: 'npm i -g @anthropic-ai/claude-code',
                      login: 'claude auth login',
                      subscription: t('settings_modal.cli_subscription_claude'),
                      apiProvider: 'claude-code',
                    },
                    codex: {
                      name: 'Codex CLI',
                      install: 'npm i -g @openai/codex',
                      login: 'codex login',
                      subscription: t('settings_modal.cli_subscription_codex'),
                      apiProvider: 'codex',
                    },
                    gemini: {
                      name: 'Gemini CLI',
                      install: 'npm i -g @google/gemini-cli',
                      login: 'gemini auth login',
                      subscription: t('settings_modal.cli_subscription_gemini'),
                      apiProvider: 'gemini',
                    },
                  };
                  const g = guide[cliProvider];
                  return (
                  <div className="pt-3 border-t border-slate-100 flex flex-col gap-2">
                    <FieldLabel>{t('settings_modal.cli_status_label', { name: g.name })}</FieldLabel>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={cliChecking}
                        onClick={async () => {
                          setCliChecking(true);
                          try {
                            const data = await apiGet<any>(`/api/auth/cli?provider=${g.apiProvider}`, { category: 'settings' });
                            setCliStatus({ installed: !!data.installed, loggedIn: !!data.loggedIn, error: data.error });
                          } catch (e) {
                            setCliStatus({ installed: false, loggedIn: false, error: (e as Error).message });
                          } finally { setCliChecking(false); }
                        }}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 disabled:bg-slate-400 text-white text-[12px] font-bold rounded-lg"
                      >
                        {cliChecking ? t('settings_modal.cli_checking') : t('settings_modal.cli_check_button')}
                      </button>
                      {cliStatus && (
                        <span className={`text-[12px] font-bold ${cliStatus.loggedIn ? 'text-green-600' : cliStatus.installed ? 'text-amber-600' : 'text-red-600'}`}>
                          {cliStatus.loggedIn ? t('settings_modal.cli_status_logged_in') : cliStatus.installed ? t('settings_modal.cli_status_installed') : t('settings_modal.cli_status_not_installed')}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 leading-relaxed bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                      <b>{t('settings_modal.cli_guide_title', { name: g.name })}</b>
                      <ul className="mt-1 ml-4 list-disc space-y-0.5">
                        <li>{t('settings_modal.cli_guide_install_step')}</li>
                        <li>{t('settings_modal.cli_guide_install_label')}<code className="bg-white px-1 rounded">{g.install}</code></li>
                        <li>{t('settings_modal.cli_guide_login_label')}<code className="bg-white px-1 rounded">{g.login}</code></li>
                        <li>{t('settings_modal.cli_guide_verify')}</li>
                        <li>{t('settings_modal.cli_guide_subscription', { subscription: g.subscription })}</li>
                        <li><span className="text-amber-700 font-bold">{t('settings_modal.cli_guide_tos_label')}</span>: {t('settings_modal.cli_guide_tos')}</li>
                      </ul>
                      {cliStatus?.error && (
                        <div className="mt-2 text-red-600 font-mono text-[10px]">{cliStatus.error.slice(0, 200)}</div>
                      )}
                    </div>
                  </div>
                  );
                })()}

                {/* API 키 — API 모드에서만 노출. CLI 모드는 자체 인증이라 키 불필요 */}
                {execMode === 'api' && (
                <div className="pt-2 border-t border-slate-100 flex flex-col gap-3">
                  <FieldLabel>{t('settings_modal.provider_api_keys')}</FieldLabel>

                  {aiMode === 'general' && effectiveProvider === 'openai' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500" htmlFor={openaiKeyId}>OpenAI</label>
                      <TextInput type="password" value={geminiApiKey} onChange={setGeminiApiKey} placeholder="sk-proj-..." id={openaiKeyId} name="openaiApiKey" />
                      <HelpText className="!text-[10px]">platform.openai.com → API Keys</HelpText>
                    </div>
                  )}

                  {aiMode === 'general' && effectiveProvider === 'google' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500" htmlFor={googleKeyId}>Google AI Studio</label>
                      <TextInput type="password" value={googleApiKey} onChange={setGoogleApiKey} placeholder="AIza..." id={googleKeyId} name="googleApiKey" />
                      <HelpText className="!text-[10px]">aistudio.google.com → Get API key</HelpText>
                    </div>
                  )}

                  {aiMode === 'general' && effectiveProvider === 'anthropic' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500" htmlFor={anthropicKeyId}>Anthropic</label>
                      <TextInput type="password" value={anthropicApiKey} onChange={setAnthropicApiKey} placeholder="sk-ant-..." id={anthropicKeyId} name="anthropicApiKey" />
                      <HelpText className="!text-[10px]">console.anthropic.com → API Keys</HelpText>
                    </div>
                  )}
                  {aiMode === 'general' && effectiveProvider === 'upstage' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500" htmlFor={upstageKeyId}>Upstage (Solar)</label>
                      <TextInput type="password" value={upstageApiKey} onChange={setUpstageApiKey} placeholder="up_..." id={upstageKeyId} name="upstageApiKey" />
                      <HelpText className="!text-[10px]">console.upstage.ai → API Keys</HelpText>
                    </div>
                  )}

                  {aiMode === 'vertex' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500" htmlFor={vertexSaId}>{t('settings_modal.vertex_sa_label')}</label>
                      <Textarea value={vertexSaJson} onChange={setVertexSaJson} placeholder='{"type":"service_account","project_id":"...","private_key":"..."}' rows={5} mono id={vertexSaId} name="vertexServiceAccountJson" />
                      <HelpText className="!text-[10px]">{t('settings_modal.vertex_sa_help')}</HelpText>
                    </div>
                  )}
                </div>
                )}

                {/* AI 어시스턴트 라우터 */}
                {(() => {
                  // Toggle is enableable when ANY model can be the worker: main is CLI ("current" worker
                  // = the CLI main, free), OR any provider API key is registered (so an API worker — incl.
                  // "current" if main is that API model — can run). Since there's always a main model, this
                  // is effectively "is any model usable". (geminiApiKey state = OpenAI key, legacy name.)
                  const hasAssistantKey =
                    execMode === 'cli' || !!googleApiKey || !!vertexSaJson || !!geminiApiKey || !!anthropicApiKey || !!upstageApiKey;
                  return (
                    <div className="pt-4 border-t border-slate-100 flex flex-col gap-2">
                      <FieldLabel>{t('settings_modal.ai_assistant_label')}</FieldLabel>
                      <label className={`flex items-start gap-2 p-3 rounded-xl border ${hasAssistantKey ? 'border-slate-200 hover:bg-slate-50 cursor-pointer' : 'border-slate-100 bg-slate-50 cursor-not-allowed opacity-60'}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={aiRouterEnabled}
                          disabled={!hasAssistantKey}
                          onChange={e => setAiRouterEnabled(e.target.checked)}
                          aria-label={t('settings_modal.ai_assistant_aria')}
                          name="aiRouterEnabled" autoComplete="off" id={aiRouterEnabledId}
                        />
                        <div className="flex-1">
                          <div className="text-[13px] font-bold text-slate-800">{t('settings_modal.ai_assistant_enable')}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                            {t('settings_modal.ai_assistant_desc')}
                          </div>
                          <ul className="text-[11px] text-slate-600 mt-1.5 space-y-0.5 list-disc list-inside leading-relaxed">
                            <li dangerouslySetInnerHTML={{ __html: t('settings_modal.ai_assistant_role_recall') }} />
                            <li dangerouslySetInnerHTML={{ __html: t('settings_modal.ai_assistant_role_consolidation') }} />
                          </ul>
                          <div className="text-[11px] text-slate-500 mt-1.5 leading-relaxed" dangerouslySetInnerHTML={{ __html: t('settings_modal.ai_assistant_cli_note') }} />
                          <div className="text-[11px] text-slate-400 mt-1.5">
                            {t('settings_modal.ai_assistant_cache_note')}
                          </div>
                          {!hasAssistantKey && (
                            <div className="text-[11px] text-amber-600 mt-1.5 font-bold">
                              {t('settings_modal.ai_assistant_no_key_warning')}
                            </div>
                          )}
                        </div>
                      </label>
                      {aiRouterEnabled && (
                        <Field label={t('settings_modal.ai_assistant_model_label')}>
                          <SelectInput
                            value={aiAssistantModel}
                            onChange={setAiAssistantModel}
                            options={aiAssistantModels
                              // 싼 API worker 는 목록엔 항상 표시하되 해당 제공자 키 없으면 선택 불가(disabled).
                              // "current"(= 메인 모델)는 항상 가능. (geminiApiKey state = OpenAI 키, 레거시 이름.)
                              .map(m => {
                                const needsKey =
                                  m.id === 'current'
                                    ? false
                                    : m.id.includes('gpt')
                                      ? !geminiApiKey
                                      : m.id.includes('gemini')
                                        ? !googleApiKey
                                        : false;
                                return {
                                  value: m.id,
                                  label:
                                    m.id === 'current'
                                      ? t('settings_modal.ai_assistant_model_current')
                                      : m.displayName + (needsKey ? t('settings_modal.ai_assistant_model_needs_key') : ''),
                                  disabled: needsKey,
                                };
                              })}
                          />
                        </Field>
                      )}
                    </div>
                  );
                })()}
                </>)}

                {/* 사용자 지시사항 — User AI 전용 (Code Assistant·AI Assistant 미적용) */}
                {aiSubTab === 'prompt' && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <FieldLabel>
                      {t('settings_modal.user_prompt_label')} <span className="text-[10px] font-normal text-slate-400">{t('settings_modal.user_prompt_scope_note')}</span>
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-400">{userPrompt.length} / {USER_PROMPT_MAX_CHARS}</span>
                    </div>
                  </div>
                  <Textarea
                    value={userPrompt}
                    onChange={(v) => setUserPrompt(v.slice(0, USER_PROMPT_MAX_CHARS))}
                    rows={6}
                    placeholder={t('settings_modal.preferences_placeholder')}
                  />
                  <HelpText>
                    {t('settings_modal.user_prompt_help')}
                  </HelpText>
                </div>
                )}

                {/* 이미지 생성 모델 — image_gen 도구 호출 시 사용 */}
                {aiSubTab === 'image' && (
                <div>
                  <FieldLabel>{t('settings_modal.image_model_label')}</FieldLabel>
                  <HelpText>
                    {t('settings_modal.image_model_help')}
                  </HelpText>
                  {(() => {
                    // Mode 판정: format prefix 로 API/CLI 구분
                    const modelMode = (m: ImageModelEntry): 'api' | 'cli' =>
                      m.format.startsWith('cli-') ? 'cli' : 'api';
                    const currentModelEntry = imageModels.find(m => m.id === imageModel);
                    const imageExecMode: 'api' | 'cli' = currentModelEntry ? modelMode(currentModelEntry) : 'api';

                    // 현재 execMode 에 해당하는 모델만 필터
                    const modelsInMode = imageModels.filter(m => modelMode(m) === imageExecMode);
                    // 공급자는 LLM 탭과 통일 — 항상 Anthropic / Google / OpenAI (ABC 순). 해당 provider 에 모델 없으면 비활성 표시.
                    const CANONICAL_PROVIDERS: Array<'anthropic' | 'google' | 'openai'> = ['anthropic', 'google', 'openai'];
                    const providersWithModel = new Set(modelsInMode.map(m => m.provider));
                    const activeProvider = currentModelEntry?.provider ?? CANONICAL_PROVIDERS.find(p => providersWithModel.has(p)) ?? 'openai';
                    const modelsForProvider = modelsInMode.filter(m => m.provider === activeProvider);
                    const currentModel = currentModelEntry || modelsForProvider[0];

                    // 변경은 상태에 staging만 — 영속은 LLM 탭과 동일하게 하단 전역 저장 버튼으로 (UX 통일).
                    const saveImageModel = (modelId: string) => {
                      setImageModelState(modelId);
                      // 모델 바뀌면 사이즈/품질 호환성 재검증 — 지원 안 하는 값이면 리셋
                      const newModel = imageModels.find(m => m.id === modelId);
                      setImageDefaultSize(newModel?.sizes?.includes(imageDefaultSize) ? imageDefaultSize : '');
                      setImageDefaultQuality(newModel?.qualities?.includes(imageDefaultQuality) ? imageDefaultQuality : '');
                    };
                    const switchMode = (mode: 'api' | 'cli') => {
                      if (mode === imageExecMode) return;
                      const firstOfMode = imageModels.find(m => modelMode(m) === mode);
                      if (firstOfMode) saveImageModel(firstOfMode.id);
                    };
                    const switchProvider = (prov: string) => {
                      const firstOfProv = modelsInMode.find(m => m.provider === prov);
                      if (firstOfProv) saveImageModel(firstOfProv.id);
                    };
                    const saveSize = (v: string) => setImageDefaultSize(v);
                    const saveQuality = (v: string) => setImageDefaultQuality(v);

                    const providerLabels: Record<string, string> = {
                      anthropic: 'Anthropic', google: 'Google', openai: 'OpenAI',
                    };
                    const sizeLabels: Record<string, string> = {
                      'auto': t('settings_modal.image_size_auto'),
                      // OpenAI gpt-image-1/2 픽셀 사이즈
                      '1024x1024': t('settings_modal.image_size_1024_square'),
                      '1536x1024': t('settings_modal.image_size_1536_landscape'),
                      '1024x1536': t('settings_modal.image_size_1024_portrait'),
                      // Gemini aspect ratios (프롬프트 힌트로 전달)
                      '1:1': t('settings_modal.image_aspect_square'),
                      '16:9': t('settings_modal.image_aspect_wide'),
                      '9:16': t('settings_modal.image_aspect_story'),
                      '4:3': t('settings_modal.image_aspect_classic'),
                      '3:4': t('settings_modal.image_aspect_portrait'),
                    };
                    const qualityLabels: Record<string, string> = {
                      'low': t('settings_modal.image_quality_low'),
                      'medium': t('settings_modal.image_quality_medium'),
                      'high': t('settings_modal.image_quality_high'),
                      'standard': t('settings_modal.image_quality_standard'),
                    };

                    if (imageModels.length === 0) {
                      return <div className="text-[12px] text-slate-400 mt-2">{t('settings_modal.image_no_models')}</div>;
                    }

                    const hasModesAvailable = {
                      api: imageModels.some(m => modelMode(m) === 'api'),
                      cli: imageModels.some(m => modelMode(m) === 'cli'),
                    };

                    return (
                      <div className="flex flex-col gap-3 mt-2">
                        <Field label={t('settings_modal.exec_mode_label')} help={t('settings_modal.image_exec_mode_help')}>
                          <SegButtons<'api' | 'cli'>
                            value={imageExecMode}
                            onChange={switchMode}
                            options={[
                              { value: 'api', label: `${t('settings_modal.exec_mode_api')}${hasModesAvailable.api ? '' : t('settings_modal.image_mode_unavailable')}` },
                              { value: 'cli', label: `${t('settings_modal.exec_mode_cli')}${hasModesAvailable.cli ? '' : t('settings_modal.image_mode_unavailable')}` },
                            ]}
                          />
                        </Field>
                        <Field label={t('settings_modal.provider_label')}>
                          <SegButtons<string>
                            value={activeProvider}
                            onChange={(p) => { if (providersWithModel.has(p)) switchProvider(p); }}
                            options={CANONICAL_PROVIDERS.map(p => ({
                              value: p,
                              label: providersWithModel.has(p) ? providerLabels[p] : `${providerLabels[p]}${t('settings_modal.image_provider_unavailable_suffix')}`,
                            }))}
                          />
                        </Field>
                        <Field label={t('settings_modal.model_label')}>
                          <SelectInput
                            value={imageModel}
                            onChange={saveImageModel}
                            options={modelsForProvider.length > 0
                              ? modelsForProvider.map(m => ({ value: m.id, label: m.displayName }))
                              : [{ value: '', label: t('settings_modal.image_no_model_option') }]}
                          />
                        </Field>
                        {currentModel?.sizes && currentModel.sizes.length > 0 && (
                          <Field label={t('settings_modal.image_default_size')} help={t('settings_modal.image_default_help')}>
                            <SelectInput
                              value={imageDefaultSize || (currentModel.sizes.includes('auto') ? 'auto' : currentModel.sizes[0])}
                              onChange={saveSize}
                              options={currentModel.sizes.map(s => ({ value: s, label: sizeLabels[s] ?? s }))}
                            />
                          </Field>
                        )}
                        {currentModel?.qualities && currentModel.qualities.length > 0 && (
                          <Field label={t('settings_modal.image_default_quality')} help={t('settings_modal.image_default_help')}>
                            <SelectInput
                              value={imageDefaultQuality || (currentModel.qualities.includes('medium') ? 'medium' : currentModel.qualities[0])}
                              onChange={saveQuality}
                              options={currentModel.qualities.map(q => ({ value: q, label: qualityLabels[q] ?? q }))}
                            />
                          </Field>
                        )}
                        {currentModel?.requiresOrganizationVerification && (
                          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 leading-relaxed">
                            {t('settings_modal.image_org_verify_warning_prefix')}<b>{currentModel.displayName}</b>{t('settings_modal.image_org_verify_warning_suffix')}{' '}
                            <a href="https://platform.openai.com/settings/organization/general" target="_blank" rel="noopener noreferrer" className="underline font-bold">
                              platform.openai.com
                            </a>{t('settings_modal.image_org_verify_link_suffix')}
                          </div>
                        )}
                        {currentModel?.subscription && (() => {
                          const cliBinByProvider: Record<string, string> = {
                            openai: 'codex', google: 'gemini', anthropic: 'claude',
                          };
                          const cliBin = cliBinByProvider[currentModel.provider] ?? 'cli';
                          return (
                            <div className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded-md px-2.5 py-1.5 leading-relaxed" dangerouslySetInnerHTML={{ __html: t('settings_modal.image_subscription_note', { bin: cliBin }) }} />
                          );
                        })()}
                      </div>
                    );
                  })()}
                </div>
                )}
                {aiSubTab === 'tts' && (() => {
                  // 큐레이션 = 미국식 억양 + 스타일이 서로 확실히 다른 보이스만(들어보고 1명 선택).
                  // 라벨 = 캐릭터 가이드(Gemini 는 공식 character, OpenAI 는 특성) — 실제 톤은 🔊 로 확인.
                  type V = { id: string; label: string };
                  const TTS_META: Record<string, { models: string[]; voices: { female: V[]; male: V[] } }> = {
                    openai: { models: ['gpt-4o-mini-tts'], voices: {
                      female: [{ id: 'nova', label: '밝고 활기찬' }, { id: 'shimmer', label: '부드럽고 차분한' }, { id: 'coral', label: '친근하고 따뜻한' }],
                      male: [{ id: 'onyx', label: '깊고 묵직한' }, { id: 'echo', label: '차분하고 또렷한' }, { id: 'ash', label: '단단하고 자신감 있는' }],
                    } },
                    gemini: { models: ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'], voices: {
                      female: [{ id: 'Kore', label: '단단한' }, { id: 'Leda', label: '발랄한' }, { id: 'Aoede', label: '산뜻한' }, { id: 'Sulafat', label: '따뜻한' }],
                      male: [{ id: 'Puck', label: '경쾌한' }, { id: 'Charon', label: '안정적인' }, { id: 'Fenrir', label: '활기찬' }, { id: 'Orus', label: '단단한' }],
                    } },
                  };
                  const switchTtsProvider = (p: string) => {
                    if (p === 'openai' && !hasOpenaiKey) return;
                    if (p === 'gemini' && !hasGeminiKey) return;
                    setTtsProvider(p);
                    if (p === 'browser') { setTtsModel(''); setTtsVoice(''); return; }
                    const m = TTS_META[p];
                    setTtsModel(m.models.includes(ttsModel) ? ttsModel : m.models[0]);
                    const all = [...m.voices.female, ...m.voices.male];
                    setTtsVoice(all.some(v => v.id === ttsVoice) ? ttsVoice : m.voices.female[0].id);
                  };
                  const meta = TTS_META[ttsProvider];
                  const curModel = meta ? (meta.models.includes(ttsModel) ? ttsModel : meta.models[0]) : '';
                  const curVoice = meta
                    ? (() => { const all = [...meta.voices.female, ...meta.voices.male]; return all.some(v => v.id === ttsVoice) ? ttsVoice : meta.voices.female[0].id; })()
                    : '';
                  return (
                    <div className="flex flex-col gap-3">
                      <FieldLabel>{t('settings_modal.tts_title')}</FieldLabel>
                      <HelpText>{t('settings_modal.tts_help')}</HelpText>
                      <Field label={t('settings_modal.provider_label')}>
                        <SegButtons<string>
                          value={ttsProvider}
                          onChange={switchTtsProvider}
                          options={[
                            { value: 'browser', label: t('settings_modal.tts_provider_browser') },
                            { value: 'openai', label: hasOpenaiKey ? 'OpenAI' : `OpenAI${t('settings_modal.tts_key_required_suffix')}` },
                            { value: 'gemini', label: hasGeminiKey ? 'Gemini' : `Gemini${t('settings_modal.tts_key_required_suffix')}` },
                          ]}
                        />
                      </Field>
                      {ttsProvider === 'browser' ? (
                        <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 leading-relaxed">
                          {t('settings_modal.tts_browser_note')}
                        </div>
                      ) : meta ? (
                        <>
                          <Field label={t('settings_modal.model_label')}>
                            <SelectInput
                              value={curModel}
                              onChange={setTtsModel}
                              options={meta.models.map(m => ({ value: m, label: m }))}
                            />
                          </Field>
                          <Field label={t('settings_modal.tts_default_voice')} help={t('settings_modal.tts_default_voice_help')}>
                            <div className="flex flex-col gap-2">
                              {(['female', 'male'] as const).map(g => (
                                <div key={g}>
                                  <div className="text-[11px] font-bold text-slate-500 mb-1">
                                    {g === 'female' ? t('settings_modal.tts_female') : t('settings_modal.tts_male')}
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {meta.voices[g].map(v => {
                                      const active = curVoice === v.id;
                                      return (
                                        <span
                                          key={v.id}
                                          onClick={() => setTtsVoice(v.id)}
                                          className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-[12px] font-medium border cursor-pointer transition-colors ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'}`}
                                        >
                                          <span>{v.id}<span className={`ml-1 font-normal ${active ? 'text-white/75' : 'text-slate-400'}`}>{v.label}</span></span>
                                          <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); playTtsSample(ttsProvider, curModel, v.id); }}
                                            aria-label={t('settings_modal.tts_play_sample', { voice: v.id })}
                                            className={`rounded-full p-0.5 transition-colors ${active ? 'text-white/85 hover:bg-white/20' : 'text-slate-400 hover:text-blue-500'}`}
                                          >
                                            {ttsSampleVoice === v.id ? <Loader2 size={12} className="animate-spin" /> : <Volume2 size={12} />}
                                          </button>
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </Field>
                          <Field label={t('settings_modal.tts_align_label')} help={t('settings_modal.tts_align_help')}>
                            <SegButtons<string>
                              value={ttsAlignProvider === 'local' || ttsAlignProvider === 'openai' ? ttsAlignProvider : 'auto'}
                              onChange={(p) => {
                                if (p === 'openai' && !hasOpenaiKey) return;
                                setTtsAlignProvider(p === 'auto' ? '' : p);
                              }}
                              options={[
                                { value: 'auto', label: t('settings_modal.tts_align_auto') },
                                { value: 'local', label: t('settings_modal.tts_align_local') },
                                { value: 'openai', label: hasOpenaiKey ? 'OpenAI (Whisper)' : `OpenAI${t('settings_modal.tts_key_required_suffix')}` },
                              ]}
                            />
                          </Field>
                        </>
                      ) : null}
                    </div>
                  );
                })()}
              </>
            );
          })()}

          {settingsTab === 'secrets' && (
            <>
              <p className="text-[11px] sm:text-[12px] text-slate-400 font-medium -mt-1 mb-1" dangerouslySetInnerHTML={{ __html: t('settings_modal.secrets_llm_note') }} />

              {/* 모듈 필요 API 키 (config.json에서 자동 수집) */}
              {moduleSecrets.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs sm:text-sm font-bold text-slate-700">{t('settings_modal.secrets_module_keys')}</span>
                  <p className="text-[10px] sm:text-xs text-slate-400 font-medium -mt-1">
                    {t('settings_modal.secrets_module_keys_hint')}
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {moduleSecrets.map(ms => (
                      <div key={ms.secretName} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[13px] font-bold text-slate-700">{ms.secretName}</span>
                          <span className="text-[10px] text-slate-400">{ms.moduleName}</span>
                        </div>
                        {ms.hasValue && !moduleSecretValues[ms.secretName] && moduleSecretValues[ms.secretName] !== '' ? (
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-emerald-600 font-medium">{t('settings_modal.secrets_registered_badge')}</span>
                            <div className="flex items-center gap-2">
                              <button onClick={() => setModuleSecretValues(prev => ({ ...prev, [ms.secretName]: '' }))} className="text-slate-400 hover:text-blue-500 transition-colors">
                                <Pencil size={13} />
                              </button>
                              <button onClick={() => deleteSecret(ms.secretName)} className="text-[11px] text-slate-400 hover:text-red-500 transition-colors">
                                {t('settings_modal.secret_delete_button')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-1.5">
                            <input
                              id={`${moduleSecretIdBase}-${ms.secretName}`}
                              name={ms.secretName}
                              aria-label={t('settings_modal.secrets_module_value_aria', { name: ms.secretName })}
                              type="password"
                              value={moduleSecretValues[ms.secretName] || ''}
                              onChange={e => setModuleSecretValues(prev => ({ ...prev, [ms.secretName]: e.target.value }))}
                              placeholder={ms.hasValue ? t('settings_modal.secrets_module_new_value_placeholder') : t('settings_modal.secrets_module_init_value_placeholder')}
                              autoComplete="new-password"
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveModuleSecret(ms.secretName);
                                if (e.key === 'Escape' && ms.hasValue) setModuleSecretValues(prev => { const n = { ...prev }; delete n[ms.secretName]; return n; });
                              }}
                              autoFocus={ms.hasValue}
                              className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            />
                            <SaveButton
                              size="md"
                              state={(
                                moduleSecretSaving === ms.secretName ? 'saving' :
                                moduleSecretFeedback[ms.secretName] === 'ok' ? 'saved' :
                                moduleSecretFeedback[ms.secretName] === 'err' ? 'error' :
                                'idle'
                              ) as SaveButtonState}
                              disabled={!moduleSecretValues[ms.secretName]?.trim()}
                              onClick={() => saveModuleSecret(ms.secretName)}
                            />
                            {ms.hasValue && (
                              <button
                                onClick={() => setModuleSecretValues(prev => { const n = { ...prev }; delete n[ms.secretName]; return n; })}
                                className="px-2 py-1.5 text-[12px] text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                              >
                                {t('common.cancel')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 저장된 시크릿 목록 (모듈에서 감지되지 않은 수동 등록 키) */}
              {userSecrets.filter(s => !moduleSecrets.some(ms => ms.secretName === s.name)).length > 0 && (
                <div className="flex flex-col gap-2 pt-1 border-t border-slate-100">
                  <span className="text-xs sm:text-sm font-bold text-slate-700 pt-1">{t('settings_modal.secrets_other')}</span>
                  <div className="flex flex-col gap-1.5">
                    {userSecrets.filter(s => !moduleSecrets.some(ms => ms.secretName === s.name)).map(s => (
                      <div key={s.name} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
                        {editingSecret?.name === s.name ? (
                          <div>
                            <span className="text-[13px] font-bold text-slate-700 mb-1 block">{s.name}</span>
                            <div className="flex gap-1.5">
                              <input
                                type="password"
                                name="editSecretValue"
                                autoComplete="new-password"
                                aria-label={t('settings_modal.secrets_other_new_value_aria', { name: s.name })}
                                value={editingSecret.value}
                                onChange={e => setEditingSecret({ name: s.name, value: e.target.value })}
                                placeholder={t('settings_modal.new_value_placeholder')}
                                autoFocus
                                onKeyDown={async e => {
                                  if (e.key === 'Enter' && editingSecret.value.trim()) {
                                    await apiPost('/api/vault/secrets', { name: s.name, value: editingSecret.value.trim() }, { category: 'settings' });
                                    setEditingSecret(null); fetchSecrets();
                                  }
                                  if (e.key === 'Escape') setEditingSecret(null);
                                }}
                                className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                              />
                              <SaveButton
                                size="md"
                                disabled={!editingSecret.value.trim()}
                                onClick={async () => {
                                  if (!editingSecret.value.trim()) return;
                                  await apiPost('/api/vault/secrets', { name: s.name, value: editingSecret.value.trim() }, { category: 'settings' });
                                  setEditingSecret(null); fetchSecrets();
                                }}
                              />
                              <button onClick={() => setEditingSecret(null)} className="px-2 py-1.5 text-[12px] text-slate-400 hover:text-slate-600 transition-colors shrink-0">{t('common.cancel')}</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div className="min-w-0">
                              <span className="text-[13px] font-bold text-slate-700">{s.name}</span>
                              <span className="text-[11px] text-slate-400 ml-2">{s.maskedValue}</span>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0 ml-2">
                              <button onClick={() => setEditingSecret({ name: s.name, value: '' })} className="text-slate-400 hover:text-blue-500 transition-colors">
                                <Pencil size={14} />
                              </button>
                              <button onClick={() => deleteSecret(s.name)} className="text-slate-400 hover:text-red-500 transition-colors">
                                <X size={16} />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 수동 키 추가 */}
              <div className="flex flex-col gap-2 pt-1 border-t border-slate-100">
                <span className="text-xs sm:text-sm font-bold text-slate-700 pt-1">{t('settings_modal.secrets_manual_add')}</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newSecretName}
                    onChange={e => setNewSecretName(e.target.value)}
                    placeholder={t('settings_modal.key_name_placeholder')}
                    aria-label={t('settings_modal.key_name_label')}
                    className="flex-1 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="newSecretName" autoComplete="off" id={newSecretNameId}
                  />
                  <input
                    id={newSecretValueId}
                    name="newSecretValue"
                    type="password"
                    value={newSecretValue}
                    onChange={e => setNewSecretValue(e.target.value)}
                    placeholder={t('settings_modal.key_value_placeholder')}
                    onKeyDown={e => e.key === 'Enter' && addSecret()}
                    autoComplete="new-password"
                    aria-label={t('settings_modal.key_value_label')}
                    className="flex-1 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <button
                    onClick={addSecret}
                    disabled={!newSecretName.trim() || !newSecretValue.trim() || secretSaving}
                    className="px-3 py-2 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shrink-0"
                  >
                    {t('settings_modal.secret_add_button')}
                  </button>
                  <FeedbackBadge state={secretSaving ? 'loading' : secretFeedback} okLabel={t('settings_modal.secret_add_ok')} errLabel={t('settings_modal.secret_add_err')} loadingLabel={t('settings_modal.secret_add_loading')} />
                </div>
              </div>
            </>
          )}

          {settingsTab === 'mcp' && (
            <>
              {/* Firebat MCP server exposure (external tools / LLM comms) is managed under Settings > System tab > Services; this tab is only for connecting external (outbound) MCP servers. */}

              {/* 등록된 MCP 서버 목록 */}
              <div className="flex flex-col gap-2">
                <span className="text-xs sm:text-sm font-bold text-slate-700">{t('settings_modal.mcp_external_servers')}</span>
                {mcpLoading ? (
                  <div className="flex items-center justify-center py-6 min-h-[80px]">
                    <Loader2 size={18} className="animate-spin text-slate-400" />
                  </div>
                ) : mcpServers.length === 0 ? (
                  <p className="text-[12px] sm:text-[13px] text-slate-400 py-4 text-center min-h-[80px] flex items-center justify-center">{t('settings_modal.mcp_no_servers')}</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {mcpServers.map(s => {
                      const isEditing = mcpEditing === s.name;
                      return (
                      <div key={s.name} className={`px-3 py-2 bg-slate-50 border rounded-lg ${isEditing ? 'border-blue-300 bg-blue-50/30' : 'border-slate-200'}`}>
                        <div className="flex items-center justify-between">
                          <div className="min-w-0 flex-1">
                            <span className="text-[13px] font-bold text-slate-700">{s.name}</span>
                            <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded font-medium ${s.transport === 'stdio' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                              {s.transport}
                            </span>
                            {!isEditing && (
                              <p className="text-[11px] text-slate-400 truncate mt-0.5">
                                {s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            <Tooltip label={t('common.edit')}>
                              <button
                                onClick={() => isEditing ? setMcpEditing(null) : startEditMcp(s)}
                                className={`p-1 rounded transition-colors ${isEditing ? 'text-blue-600 bg-blue-50' : 'text-slate-400 hover:text-amber-600 hover:bg-amber-50'}`}
                              >
                                <Pencil size={14} />
                              </button>
                            </Tooltip>
                            {s.transport === 'stdio' && (
                              <Tooltip label={t('settings_modal.mcp_oauth_tooltip')}>
                                <button
                                  onClick={() => startMcpAuth(s.name)}
                                  disabled={mcpAuth?.server === s.name && mcpAuth.step === 'starting'}
                                  className="text-[11px] px-2 py-1 rounded font-bold text-slate-500 hover:text-amber-600 hover:bg-amber-50 border border-slate-200 transition-colors disabled:opacity-50"
                                >
                                  {t('settings_modal.mcp_oauth_button')}
                                </button>
                              </Tooltip>
                            )}
                            <button onClick={() => deleteMcpServer(s.name)} className="text-slate-400 hover:text-red-500 transition-colors p-1">
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>
                        {/* 인라인 편집 */}
                        {isEditing && (
                          <div className="mt-2 flex flex-col gap-1.5 border-t border-slate-200 pt-2">
                            {s.transport === 'stdio' ? (
                              <>
                                <input
                                  type="text"
                                  value={mcpEditCommand}
                                  onChange={e => setMcpEditCommand(e.target.value)}
                                  placeholder={t('settings_modal.command_placeholder')}
                                  aria-label={t('settings_modal.mcp_command_label')}
                                  className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" name="mcpEditCommand" autoComplete="off" id={mcpEditCommandId}
                                />
                                <input
                                  type="text"
                                  value={mcpEditArgs}
                                  onChange={e => setMcpEditArgs(e.target.value)}
                                  placeholder={t('settings_modal.args_placeholder')}
                                  aria-label={t('settings_modal.mcp_args_label')}
                                  className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" name="mcpEditArgs" autoComplete="off" id={mcpEditArgsId}
                                />
                              </>
                            ) : (
                              <input
                                type="text"
                                value={mcpEditUrl}
                                onChange={e => setMcpEditUrl(e.target.value)}
                                placeholder="SSE URL"
                                aria-label={t('settings_modal.mcp_sse_url_aria')}
                                className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" name="mcpEditUrl" autoComplete="off" id={mcpEditUrlId}
                              />
                            )}
                            <div className="flex gap-1.5 justify-end">
                              <button
                                onClick={() => setMcpEditing(null)}
                                className="px-2.5 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-200 rounded transition-colors"
                              >
                                {t('common.cancel')}
                              </button>
                              <SaveButton
                                state={(
                                  mcpEditSaving ? 'saving' :
                                  mcpEditFeedback === 'ok' ? 'saved' :
                                  mcpEditFeedback === 'err' ? 'error' :
                                  'idle'
                                ) as SaveButtonState}
                                onClick={() => saveEditMcp(s)}
                              />
                            </div>
                          </div>
                        )}
                        {/* OAuth 인증 플로우 */}
                        {mcpAuth?.server === s.name && (
                          <div className="mt-1.5 border border-slate-200 rounded-lg overflow-hidden">
                            {mcpAuth.step === 'starting' && (
                              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 text-[11px] text-slate-500">
                                <Loader2 size={12} className="animate-spin" /> {t('settings_modal.mcp_oauth_starting')}
                              </div>
                            )}
                            {mcpAuth.step === 'waiting' && (
                              <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 text-[11px] text-amber-700">
                                <Loader2 size={12} className="animate-spin" />
                                <span>{t('settings_modal.mcp_oauth_waiting')}</span>
                                {mcpAuth.authUrl && (
                                  <button onClick={() => window.open(mcpAuth.authUrl!, 'mcp-oauth', 'width=500,height=700,left=200,top=100')}
                                    className="ml-auto text-[10px] text-blue-600 hover:text-blue-800 underline whitespace-nowrap">
                                    {t('settings_modal.mcp_oauth_reopen')}
                                  </button>
                                )}
                              </div>
                            )}
                            {mcpAuth.step === 'done' && (
                              <div className="flex items-center justify-between px-3 py-2 bg-green-50 text-[11px] text-green-700 font-bold">
                                <span>{t('settings_modal.mcp_oauth_done')}</span>
                                <button onClick={() => setMcpAuth(null)} className="text-green-500 hover:text-green-700"><X size={14} /></button>
                              </div>
                            )}
                            {mcpAuth.step === 'error' && (
                              <div className="flex items-center justify-between px-3 py-2 bg-red-50 text-[11px] text-red-600">
                                <span>{mcpAuth.error}</span>
                                <button onClick={() => setMcpAuth(null)} className="text-red-400 hover:text-red-600"><X size={14} /></button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 새 MCP 서버 추가 */}
              <div className="flex flex-col gap-2 pt-1 border-t border-slate-100">
                <label className="text-xs sm:text-sm font-bold text-slate-700 pt-1" htmlFor={mcpNewNameId}>{t('settings_modal.mcp_server_add_label')}</label>
                <input
                  type="text"
                  value={mcpNewName}
                  onChange={e => setMcpNewName(e.target.value)}
                  placeholder={t('settings_modal.server_name_placeholder')}
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="mcpNewName" autoComplete="off" id={mcpNewNameId}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setMcpNewTransport('stdio')}
                    className={`flex-1 px-3 py-1.5 text-[12px] sm:text-[13px] font-bold rounded-lg border transition-colors ${mcpNewTransport === 'stdio' ? 'border-green-500 bg-green-50 text-green-700' : 'border-slate-300 text-slate-400 hover:text-slate-600'}`}
                  >
                    {t('settings_modal.mcp_transport_stdio')}
                  </button>
                  <button
                    onClick={() => setMcpNewTransport('sse')}
                    className={`flex-1 px-3 py-1.5 text-[12px] sm:text-[13px] font-bold rounded-lg border transition-colors ${mcpNewTransport === 'sse' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-400 hover:text-slate-600'}`}
                  >
                    {t('settings_modal.mcp_transport_sse')}
                  </button>
                </div>
                {mcpNewTransport === 'stdio' ? (
                  <>
                    <input
                      type="text"
                      value={mcpNewCommand}
                      onChange={e => setMcpNewCommand(e.target.value)}
                      placeholder={t('settings_modal.mcp_command_placeholder')}
                      aria-label={t('settings_modal.mcp_command_label')}
                      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="mcpNewCommand" autoComplete="off" id={mcpNewCommandId}
                    />
                    <input
                      type="text"
                      value={mcpNewArgs}
                      onChange={e => setMcpNewArgs(e.target.value)}
                      placeholder={t('settings_modal.mcp_args_placeholder')}
                      aria-label={t('settings_modal.mcp_args_label')}
                      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="mcpNewArgs" autoComplete="off" id={mcpNewArgsId}
                    />
                  </>
                ) : (
                  <input
                    type="text"
                    value={mcpNewUrl}
                    onChange={e => setMcpNewUrl(e.target.value)}
                    placeholder={t('settings_modal.mcp_sse_url_placeholder')}
                    aria-label={t('settings_modal.mcp_sse_url_label')}
                    className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="mcpNewUrl" autoComplete="off" id={mcpNewUrlId}
                  />
                )}
                <button
                  onClick={addMcpServer}
                  disabled={!mcpNewName.trim() || (mcpNewTransport === 'stdio' ? !mcpNewCommand.trim() : !mcpNewUrl.trim()) || mcpSaving}
                  className="w-full px-3 py-2 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors"
                >
                  {mcpSaving ? t('settings_modal.mcp_add_testing') : t('settings_modal.mcp_add_button')}
                </button>
                <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                  {t('settings_modal.mcp_add_hint')}
                </p>
              </div>
            </>
          )}

          {settingsTab === 'capabilities' && (
            <CapabilityTabContent />
          )}
          {settingsTab === 'system' && (
            <div className="flex flex-col gap-4">
              {/* 서비스 */}
              {sysModules.filter(m => (m.entryType ?? m.type) === 'service').length > 0 && (
                <div>
                  <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase flex items-center gap-1.5 mb-2"><Wrench size={11} /> {t('settings_modal.system_service')}</p>
                  <div className="space-y-1">
                    {sysModules.filter(m => (m.entryType ?? m.type) === 'service').map(m => (
                      <div key={m.name} className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors group ${m.enabled === false ? 'border-slate-100 bg-slate-50/50 opacity-60' : 'border-slate-200 hover:border-blue-200 hover:bg-blue-50/50'}`}>
                        <button onClick={() => onOpenModuleSettings?.(m.name)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                          <Server size={16} className="text-emerald-500 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-slate-700">{m.name}</p>
                            <p className="text-[11px] text-slate-400 truncate">{m.description}</p>
                          </div>
                          <Settings size={14} className="text-slate-300 group-hover:text-blue-500 transition-colors shrink-0" />
                        </button>
                        <Tooltip label={m.enabled !== false ? t('common.activate') : t('common.inactive')}>
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleModuleEnabled(m.name, m.enabled === false); }}
                            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${m.enabled !== false ? 'bg-blue-500' : 'bg-slate-300'}`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${m.enabled !== false ? 'translate-x-4' : ''}`} />
                          </button>
                        </Tooltip>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 모듈 */}
              {sysModules.filter(m => (m.entryType ?? m.type) !== 'service').length > 0 && (
                <div>
                  <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase flex items-center gap-1.5 mb-2"><Blocks size={11} /> {t('settings_modal.system_module')}</p>
                  <div className="space-y-1">
                    {sysModules.filter(m => (m.entryType ?? m.type) !== 'service').map(m => (
                      <div key={m.name} className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors group ${m.enabled === false ? 'border-slate-100 bg-slate-50/50 opacity-60' : 'border-slate-200 hover:border-blue-200 hover:bg-blue-50/50'}`}>
                        <button onClick={() => onOpenModuleSettings?.(m.name)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                          <Blocks size={16} className="text-indigo-500 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[13px] font-semibold text-slate-700">{m.name}</p>
                              {moduleUpgradeMap[m.name] && (
                                <span className="text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded shrink-0">
                                  {t('settings_modal.upgrade_available_badge')}
                                  {moduleUpgradeMap[m.name].installed && moduleUpgradeMap[m.name].latest && (
                                    <span className="ml-1 font-semibold">{moduleUpgradeMap[m.name].installed} → {moduleUpgradeMap[m.name].latest}</span>
                                  )}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 truncate">{m.description}</p>
                          </div>
                          <Settings size={14} className="text-slate-300 group-hover:text-blue-500 transition-colors shrink-0" />
                        </button>
                        <Tooltip label={m.enabled !== false ? t('common.activate') : t('common.inactive')}>
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleModuleEnabled(m.name, m.enabled === false); }}
                            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${m.enabled !== false ? 'bg-blue-500' : 'bg-slate-300'}`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${m.enabled !== false ? 'translate-x-4' : ''}`} />
                          </button>
                        </Tooltip>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {sysModules.length === 0 && (
                <p className="text-[13px] text-slate-400 italic text-center py-8">{t('settings_modal.system_no_items')}</p>
              )}
            </div>
          )}

          {settingsTab === 'logs' && <LogPanel />}

        </div>

        <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2 sm:gap-3 shrink-0">
          <button
            onClick={onClose}
            disabled={mainSaveState === 'loading'}
            className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
          >
            {t('common.close')}
          </button>
          {/* 전역 저장은 handleSave 가 실제로 저장하는 탭(일반 = timezone·admin / AI>LLM = 모델·토글·키)에서만 노출.
              나머지 탭(프롬프트·이미지·비용·메모리·시크릿·MCP·시스템·로그)은 자체 인라인 저장이 있어 중복 버튼 제거. */}
          {(settingsTab === 'general' || (settingsTab === 'ai' && (aiSubTab === 'llm' || aiSubTab === 'image' || aiSubTab === 'prompt' || aiSubTab === 'tts'))) && (
            <SaveButton
              size="md"
              state={(
                mainSaveState === 'loading' ? 'saving' :
                mainSaveState === 'ok' ? 'saved' :
                mainSaveState === 'err' ? 'error' :
                'idle'
              ) as SaveButtonState}
              onClick={handleSave}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Capability 탭 내부 컴포넌트 ──────────────────────────────────────────────
type CapInfo = { id: string; label: string; description: string; providerCount: number };
type ProviderInfo = { moduleName: string; providerType: 'local' | 'api'; location: 'system' | 'user'; description: string };

function CapabilityTabContent() {
  const t = useTranslations();
  const [caps, setCaps] = useState<CapInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCap, setSelectedCap] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orderFeedback, setOrderFeedback] = useState<'ok' | 'err' | null>(null);
  const [orderChanged, setOrderChanged] = useState(false);

  useEffect(() => {
    apiGet<any>('/api/capabilities', { category: 'capabilities' })
      .then(data => { if (data.success) setCaps(data.capabilities ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadDetail = async (id: string) => {
    setSelectedCap(id);
    setDetailLoading(true);
    setOrderChanged(false);
    try {
      const data = await apiPost<any>('/api/capabilities', { id }, { category: 'capabilities' });
      if (data.success) {
        const provs: ProviderInfo[] = data.providers ?? [];
        const savedOrder: string[] = data.settings?.providers ?? [];
        // 저장된 순서가 있으면 그 순서로 정렬
        if (savedOrder.length > 0) {
          provs.sort((a, b) => {
            const aIdx = savedOrder.indexOf(a.moduleName);
            const bIdx = savedOrder.indexOf(b.moduleName);
            return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
          });
        }
        setProviders(provs);
      }
    } catch (e) { logger.debug('settings', 'operation 실패', { error: e }); }
    finally { setDetailLoading(false); }
  };

  const moveProvider = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= providers.length) return;
    const next = [...providers];
    [next[index], next[target]] = [next[target], next[index]];
    setProviders(next);
    setOrderChanged(true);
  };

  const saveOrder = async () => {
    if (!selectedCap) return;
    setSaving(true);
    try {
      await apiPatch(
        '/api/capabilities',
        { id: selectedCap, settings: { providers: providers.map(p => p.moduleName) } },
        { category: 'capabilities' },
      );
      setOrderChanged(false);
      setOrderFeedback('ok');
    } catch {
      setOrderFeedback('err');
    }
    finally {
      setSaving(false);
      setTimeout(() => setOrderFeedback(null), 1800);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={18} className="animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="text-xs sm:text-sm font-bold text-slate-700">{t('settings_modal.capability_list')}</span>
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium -mt-1">
          {t('settings_modal.capability_list_hint')}
        </p>
        {caps.length === 0 ? (
          <p className="text-[12px] sm:text-[13px] text-slate-400 py-4 text-center">{t('settings_modal.capability_none')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {caps.map(cap => {
              const isOpen = selectedCap === cap.id;
              return (
                <div key={cap.id} className={`rounded-lg border transition-colors ${
                  isOpen ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                }`}>
                  <button
                    onClick={() => isOpen ? setSelectedCap(null) : loadDetail(cap.id)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left"
                  >
                    <div className="min-w-0">
                      <span className="text-[13px] font-bold text-slate-700">{cap.label}</span>
                      <span className="ml-1.5 text-[11px] text-slate-400 font-mono">{cap.id}</span>
                      <p className="text-[11px] text-slate-400 truncate">{cap.description}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${
                        cap.providerCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'
                      }`}>
                        {cap.providerCount}{t('settings_modal.capability_count_suffix')}
                      </span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        className={`text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}>
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </div>
                  </button>

                  {/* inline detail — 클릭한 capability row 안에서 expand/collapse */}
                  {isOpen && (
                    <div className="flex flex-col gap-3 px-3 pb-3 pt-1 border-t border-slate-200/60">
                      {detailLoading ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 size={16} className="animate-spin text-slate-400" />
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-col gap-1.5">
                            <span className="text-xs sm:text-sm font-bold text-slate-700">
                              {t('settings_modal.capability_exec_order')} {providers.length > 1 && <span className="text-[10px] text-slate-400 font-normal ml-1">{t('settings_modal.capability_exec_order_hint')}</span>}
                            </span>
                            {providers.length === 0 ? (
                              <p className="text-[12px] text-slate-400 py-2">{t('settings_modal.capability_no_providers')}</p>
                            ) : (
                              providers.map((p, i) => (
                                <div key={p.moduleName} className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg">
                                  <span className="text-[11px] font-bold text-slate-400 w-4 text-center shrink-0">{i + 1}</span>
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0 ${
                                    p.providerType === 'api' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                                  }`}>
                                    {p.providerType === 'api' ? 'API' : 'LOCAL'}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <span className="text-[13px] font-bold text-slate-700">{p.moduleName}</span>
                                    <span className="ml-1.5 text-[10px] text-slate-400">{p.location}</span>
                                  </div>
                                  {providers.length > 1 && (
                                    <div className="flex flex-col gap-0.5 shrink-0">
                                      <Tooltip label={t('common.move_up')}>
                                        <button
                                          onClick={() => moveProvider(i, -1)}
                                          disabled={i === 0}
                                          className="p-0.5 text-slate-400 hover:text-slate-700 disabled:text-slate-200 disabled:cursor-default transition-colors"
                                        >
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                                        </button>
                                      </Tooltip>
                                      <Tooltip label={t('common.move_down')}>
                                        <button
                                          onClick={() => moveProvider(i, 1)}
                                          disabled={i === providers.length - 1}
                                          className="p-0.5 text-slate-400 hover:text-slate-700 disabled:text-slate-200 disabled:cursor-default transition-colors"
                                        >
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                        </button>
                                      </Tooltip>
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>

                          {providers.length > 1 && (orderChanged || orderFeedback) && (
                            <div className="flex items-center gap-2">
                              {orderChanged && (
                                <SaveButton
                                  size="md"
                                  state={(
                                    saving ? 'saving' :
                                    orderFeedback === 'ok' ? 'saved' :
                                    orderFeedback === 'err' ? 'error' :
                                    'idle'
                                  ) as SaveButtonState}
                                  label={t('settings_modal.capability_save_order')}
                                  className="flex-1"
                                  onClick={saveOrder}
                                />
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ── 비용 통계 탭 (LLM 호출 누적 추적) ─────────────────────────────────────────
interface CostRecord {
  date: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastCallAt: number;
}
interface CostStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  records: CostRecord[];
}

// ── Memory tab — Firebat AI 자율 메모리 CRUD ──
type MemoryItem = { category: string; name: string; description: string; content: string };
const MEMORY_CATEGORY_KEYS = ['user', 'feedback', 'project', 'reference', 'idea'] as const;
const MEMORY_CATEGORY_I18N: Record<string, string> = {
  user: 'settings_modal.memory_category_user',
  feedback: 'settings_modal.memory_category_feedback',
  project: 'settings_modal.memory_category_project',
  reference: 'settings_modal.memory_category_reference',
  idea: 'settings_modal.memory_category_idea',
};

function MemoryTabContent({ hubContext }: { hubContext?: { slug: string; apiToken: string; sessionId: string } }) {
  const t = useTranslations();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [creating, setCreating] = useState(false);

  // admin=/api/memory / hub=owner-scoped /api/hub/<slug>/memory op-dispatch. Same backend, only owner differs.
  const load = async () => {
    setLoading(true);
    try {
      if (hubContext) {
        const d = await hubFetch(hubContext, 'memory', 'list', {});
        if (d?.success) setItems((d.items as MemoryItem[]) ?? []);
        return;
      }
      const data = await apiGet<{ success: boolean; items: MemoryItem[] }>(
        '/api/memory',
        { category: 'memory' },
      );
      if (data.success) setItems(data.items);
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const save = async (item: MemoryItem, isNew: boolean) => {
    const data = hubContext
      ? await hubFetch(hubContext, 'memory', 'save', { ...item }) ?? { success: false }
      : await apiPost<{ success: boolean; error?: string }>('/api/memory', item, { category: 'memory' });
    if (!data.success) { await alertDialog({ title: t('settings_modal.memory_save_failed_title'), message: (data as any).error ?? t('settings_modal.memory_unknown_error'), danger: true }); return; }
    setEditing(null); setCreating(false);
    void load();
  };

  const remove = async (name: string) => {
    if (!await confirmDialog({ title: t('settings_modal.memory_delete_title'), message: t('settings_modal.memory_delete_message', { name }), danger: true, okLabel: t('settings_modal.memory_delete_ok') })) return;
    const data = hubContext
      ? await hubFetch(hubContext, 'memory', 'delete', { name }) ?? { success: false }
      : await apiDelete<{ success: boolean; error?: string }>(`/api/memory?name=${encodeURIComponent(name)}`, { category: 'memory' });
    if (!data.success) { await alertDialog({ title: t('settings_modal.memory_delete_failed_title'), message: (data as any).error ?? t('settings_modal.memory_unknown_error'), danger: true }); return; }
    void load();
  };

  const grouped: Record<string, MemoryItem[]> = { user: [], feedback: [], project: [], reference: [], idea: [] };
  for (const it of items) {
    if (grouped[it.category]) grouped[it.category].push(it);
  }

  if (editing || creating) {
    const initial: MemoryItem = editing ?? { category: 'user', name: '', description: '', content: '' };
    return <MemoryEditForm initial={initial} isNew={creating} onSave={save} onCancel={() => { setEditing(null); setCreating(false); }} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-slate-500">
          {t('settings_modal.memory_intro')}
        </p>
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 text-[12px] bg-blue-500 hover:bg-blue-600 text-white rounded flex items-center gap-1 shrink-0 whitespace-nowrap"
        >
          <Plus size={12} /> {t('settings_modal.memory_new')}
        </button>
      </div>
      {loading ? (
        <p className="text-[13px] text-slate-400 italic text-center py-8">{t('settings_modal.memory_loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-[13px] text-slate-400 italic text-center py-8">
          {t('settings_modal.memory_empty_line1')}<br />
          {t('settings_modal.memory_empty_line2')}
        </p>
      ) : (
        MEMORY_CATEGORY_KEYS.map(cat => grouped[cat].length > 0 && (
          <div key={cat}>
            <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase mb-2">
              {t(MEMORY_CATEGORY_I18N[cat])} ({grouped[cat].length})
            </p>
            <div className="space-y-1">
              {grouped[cat].map(it => (
                <div key={it.name} className="flex items-start gap-3 px-3 py-2.5 rounded-lg border border-slate-200 hover:border-blue-200 hover:bg-blue-50/30 group">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-slate-700">{it.name}</p>
                    <p className="text-[11px] text-slate-500 truncate">{it.description}</p>
                  </div>
                  <button
                    onClick={() => setEditing(it)}
                    className="text-slate-400 hover:text-blue-500 p-1"
                    aria-label={t('common.edit')}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => remove(it.name)}
                    className="text-slate-400 hover:text-red-500 p-1"
                    aria-label={t('common.delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function MemoryEditForm({ initial, isNew, onSave, onCancel }: {
  initial: MemoryItem;
  isNew: boolean;
  onSave: (item: MemoryItem, isNew: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const categoryId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const contentId = useId();
  const [item, setItem] = useState(initial);
  const [saving, setSaving] = useState(false);
  const handleSubmit = async () => {
    if (!item.name.trim() || !item.description.trim()) return;
    setSaving(true);
    try { await onSave(item, isNew); } finally { setSaving(false); }
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="text-slate-600 hover:text-slate-900 p-1">
          <ChevronLeft size={16} />
        </button>
        <h3 className="text-[14px] font-bold">{isNew ? t('settings_modal.memory_new') : t('settings_modal.memory_edit_title', { name: item.name })}</h3>
      </div>
      <div>
        <label className="text-[11px] font-bold tracking-wider text-slate-400 uppercase block mb-1" htmlFor={categoryId}>{t('settings_modal.memory_category_label')}</label>
        <select
          value={item.category}
          onChange={e => setItem({ ...item, category: e.target.value })}
          disabled={!isNew}
          className="w-full px-3 py-2 text-[13px] border border-slate-300 rounded disabled:bg-slate-100" name="category" id={categoryId}
        >
          {MEMORY_CATEGORY_KEYS.map(k => <option key={k} value={k}>{t(MEMORY_CATEGORY_I18N[k])}</option>)}
        </select>
      </div>
      <div>
        <label className="text-[11px] font-bold tracking-wider text-slate-400 uppercase block mb-1" htmlFor={nameId}>{t('settings_modal.memory_name_label')}</label>
        <input
          type="text"
          value={item.name}
          onChange={e => setItem({ ...item, name: e.target.value.replace(/[^a-z0-9_-]/gi, '').toLowerCase() })}
          disabled={!isNew}
          placeholder={t('settings_modal.memory_slug_placeholder')}
          className="w-full px-3 py-2 text-[13px] border border-slate-300 rounded disabled:bg-slate-100" name="name" autoComplete="off" id={nameId}
        />
      </div>
      <div>
        <label className="text-[11px] font-bold tracking-wider text-slate-400 uppercase block mb-1" htmlFor={descriptionId}>{t('settings_modal.memory_description_label')}</label>
        <input
          type="text"
          value={item.description}
          onChange={e => setItem({ ...item, description: e.target.value })}
          placeholder={t('settings_modal.memory_summary_placeholder')}
          className="w-full px-3 py-2 text-[13px] border border-slate-300 rounded" name="description" autoComplete="off" id={descriptionId}
        />
      </div>
      <div>
        <label className="text-[11px] font-bold tracking-wider text-slate-400 uppercase block mb-1" htmlFor={contentId}>{t('settings_modal.memory_content_label')}</label>
        <textarea
          value={item.content}
          onChange={e => setItem({ ...item, content: e.target.value })}
          rows={12}
          placeholder={t('settings_modal.memory_body_placeholder')}
          className="w-full px-3 py-2 text-[13px] border border-slate-300 rounded font-mono resize-y" name="content" autoComplete="off" id={contentId}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-4 py-2 text-[13px] text-slate-600 hover:bg-slate-100 rounded">{t('common.cancel')}</button>
        <SaveButton
          size="md"
          state={(saving ? 'saving' : 'idle') as SaveButtonState}
          disabled={!item.name.trim() || !item.description.trim()}
          onClick={handleSubmit}
        />
      </div>
    </div>
  );
}

// 비용 한도 섹션 — Vault 'system:cost:budget' 일/월 USD + 호출 수 + 알림 임계 %
type BudgetState = {
  dailyUsd: number;
  monthlyUsd: number;
  dailyCalls: number;
  monthlyCalls: number;
  alertAtPercent: number;
  dailySpentUsd: number;
  monthlySpentUsd: number;
  dailySpentCalls: number;
  monthlySpentCalls: number;
};

function CostBudgetSection() {
  const t = useTranslations();
  const dailyUsdId = useId();
  const monthlyUsdId = useId();
  const dailyCallsId = useId();
  const monthlyCallsId = useId();
  const alertAtPercentId = useId();
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ success: boolean; data: typeof budget }>(
        '/api/llm/budget',
        { category: 'budget' },
      );
      if (data.success) setBudget(data.data);
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    if (!budget) return;
    setSaving(true);
    try {
      const data = await apiPost<{ success: boolean; error?: string }>(
        '/api/llm/budget',
        {
          dailyUsd: budget.dailyUsd, monthlyUsd: budget.monthlyUsd,
          dailyCalls: budget.dailyCalls, monthlyCalls: budget.monthlyCalls,
          alertAtPercent: budget.alertAtPercent,
        },
        { category: 'budget' },
      );
      if (data.success) { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000); void load(); }
      else await alertDialog({ title: t('settings_modal.cost_budget_save_failed_title'), message: data.error ?? t('settings_modal.memory_unknown_error'), danger: true });
    } finally { setSaving(false); }
  };

  if (loading || !budget) return null;

  // 4개 한도 progress 계산
  const calc = (limit: number, spent: number) => {
    if (limit <= 0) return { pct: 0, over: false, alert: false };
    const pct = Math.min(100, (spent / limit) * 100);
    return { pct, over: spent >= limit, alert: pct >= budget.alertAtPercent };
  };
  const dailyU = calc(budget.dailyUsd, budget.dailySpentUsd);
  const monthlyU = calc(budget.monthlyUsd, budget.monthlySpentUsd);
  const dailyC = calc(budget.dailyCalls, budget.dailySpentCalls);
  const monthlyC = calc(budget.monthlyCalls, budget.monthlySpentCalls);
  const anyOver = dailyU.over || monthlyU.over || dailyC.over || monthlyC.over;

  const renderProgress = (kind: 'usd' | 'calls', limit: number, spent: number, calc: { pct: number; over: boolean; alert: boolean }) => {
    if (limit <= 0) return null;
    const fmt = kind === 'usd' ? (n: number) => `$${n.toFixed(2)}` : (n: number) => t('settings_modal.cost_progress_calls_unit', { value: n.toLocaleString() });
    return (
      <div className="mt-1.5">
        <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full transition-all ${calc.over ? 'bg-red-500' : calc.alert ? 'bg-orange-500' : 'bg-blue-500'}`} style={{ width: `${calc.pct}%` }} />
        </div>
        <p className="text-[10px] text-slate-500 mt-0.5">{fmt(spent)} / {fmt(limit)} ({calc.pct.toFixed(0)}%)</p>
      </div>
    );
  };

  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">{t('settings_modal.cost_budget_limits_label')}</p>
        {anyOver && <span className="text-[11px] font-bold text-red-600">{t('settings_modal.cost_budget_over_warning')}</span>}
      </div>
      <p className="text-[11px] text-slate-500 mb-2">{t('settings_modal.cost_budget_explainer')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
        <div>
          <label className="text-[11px] text-slate-500 block mb-1" htmlFor={dailyUsdId}>{t('settings_modal.cost_budget_daily_usd')}</label>
          <input type="number" min="0" step="0.5" value={budget.dailyUsd} onChange={e => setBudget({ ...budget, dailyUsd: Number(e.target.value) || 0 })} className="w-full px-2 py-1.5 text-[13px] border border-slate-300 rounded" name="dailyUsd" autoComplete="off" id={dailyUsdId} />
          {renderProgress('usd', budget.dailyUsd, budget.dailySpentUsd, dailyU)}
        </div>
        <div>
          <label className="text-[11px] text-slate-500 block mb-1" htmlFor={monthlyUsdId}>{t('settings_modal.cost_budget_monthly_usd')}</label>
          <input type="number" min="0" step="5" value={budget.monthlyUsd} onChange={e => setBudget({ ...budget, monthlyUsd: Number(e.target.value) || 0 })} className="w-full px-2 py-1.5 text-[13px] border border-slate-300 rounded" name="monthlyUsd" autoComplete="off" id={monthlyUsdId} />
          {renderProgress('usd', budget.monthlyUsd, budget.monthlySpentUsd, monthlyU)}
        </div>
        <div>
          <label className="text-[11px] text-slate-500 block mb-1" htmlFor={dailyCallsId}>{t('settings_modal.cost_budget_daily_calls')}</label>
          <input type="number" min="0" step="10" value={budget.dailyCalls} onChange={e => setBudget({ ...budget, dailyCalls: Number(e.target.value) || 0 })} className="w-full px-2 py-1.5 text-[13px] border border-slate-300 rounded" name="dailyCalls" autoComplete="off" id={dailyCallsId} />
          {renderProgress('calls', budget.dailyCalls, budget.dailySpentCalls, dailyC)}
        </div>
        <div>
          <label className="text-[11px] text-slate-500 block mb-1" htmlFor={monthlyCallsId}>{t('settings_modal.cost_budget_monthly_calls')}</label>
          <input type="number" min="0" step="100" value={budget.monthlyCalls} onChange={e => setBudget({ ...budget, monthlyCalls: Number(e.target.value) || 0 })} className="w-full px-2 py-1.5 text-[13px] border border-slate-300 rounded" name="monthlyCalls" autoComplete="off" id={monthlyCallsId} />
          {renderProgress('calls', budget.monthlyCalls, budget.monthlySpentCalls, monthlyC)}
        </div>
      </div>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label className="text-[11px] text-slate-500 block mb-1" htmlFor={alertAtPercentId}>{t('settings_modal.cost_budget_alert_label')}</label>
          <input type="number" min="1" max="100" step="5" value={budget.alertAtPercent} onChange={e => setBudget({ ...budget, alertAtPercent: Number(e.target.value) || 80 })} className="w-full px-2 py-1.5 text-[13px] border border-slate-300 rounded" name="alertAtPercent" autoComplete="off" id={alertAtPercentId} />
        </div>
        <SaveButton
          state={(saving ? 'saving' : savedFlash ? 'saved' : 'idle') as SaveButtonState}
          label={t('settings_modal.cost_budget_save')}
          onClick={save}
        />
      </div>
      <p className="text-[10px] text-slate-400 mt-2">{t('settings_modal.cost_budget_usage_note', { dailyUsd: budget.dailySpentUsd.toFixed(2), dailyCalls: budget.dailySpentCalls.toLocaleString(), monthlyUsd: budget.monthlySpentUsd.toFixed(2), monthlyCalls: budget.monthlySpentCalls.toLocaleString() })}</p>
    </div>
  );
}

function CostTabContent() {
  const t = useTranslations();
  const { lang: uiLang } = useLang();
  const [stats, setStats] = useState<CostStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const today = new Date();
    const fromDate = new Date(today.getTime() - (days - 1) * TIME.DAY_MS);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const params = new URLSearchParams({ fromDate: fmt(fromDate), toDate: fmt(today) });
    apiGet<{ success: boolean; data?: CostStats; error?: string }>(
      `/api/llm/cost-stats?${params.toString()}`,
      { category: 'cost-stats' },
    )
      .then(data => {
        if (data.success) setStats(data.data ?? null);
        else setError(data.error || t('settings_modal.cost_query_failed'));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  // 일별 합계 (모델 무관) — 모델별 records 를 date 키로 그루핑
  const dailyTotals = useMemo(() => {
    if (!stats || !Array.isArray(stats.records)) return [];
    const map = new Map<string, { date: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>();
    for (const r of stats.records) {
      const exist = map.get(r.date) ?? { date: r.date, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      exist.calls += r.calls;
      exist.inputTokens += r.inputTokens;
      exist.outputTokens += r.outputTokens;
      exist.costUsd += r.costUsd;
      map.set(r.date, exist);
    }
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [stats]);

  // 모델별 합계
  const modelTotals = useMemo(() => {
    if (!stats || !Array.isArray(stats.records)) return [];
    const map = new Map<string, { model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }>();
    for (const r of stats.records) {
      const exist = map.get(r.model) ?? { model: r.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      exist.calls += r.calls;
      exist.inputTokens += r.inputTokens;
      exist.outputTokens += r.outputTokens;
      exist.costUsd += r.costUsd;
      map.set(r.model, exist);
    }
    return Array.from(map.values()).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  }, [stats]);

  const fmtNum = (n: number) => n.toLocaleString(uiLang === 'ko' ? 'ko-KR' : 'en-US');
  // 비용 표시 — $1000 미만은 센트까지(소수 둘째자리, $305.13), $1000 이상은 컴팩트($1.2K/$1.5M). 토큰·호출 셀과 일관.
  const fmtUsd = (n: number) => (n >= 1000 ? `$${formatCompactNumber(n, 'en')}` : `$${n.toFixed(2)}`);
  // 표시는 축약(좁은 칸 넘침 방지), 정확값은 title(hover). 호출 수=일반 로케일 축약 / 토큰=항상 M(공급사 가격 단위).
  const fmtCompact = (n: number) => formatCompactNumber(n, uiLang === 'ko' ? 'ko' : 'en');
  const fmtTok = (n: number) => formatTokenCount(n);

  return (
    <div className="flex flex-col gap-4">
      <CostBudgetSection />
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-slate-600" dangerouslySetInnerHTML={{ __html: t('settings_modal.cost_summary_intro', { days: String(days) }) }} />
        <div className="flex gap-1">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} className={`px-2.5 py-1 text-[11px] font-bold rounded-md transition-colors ${days === d ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>
              {d}{t('settings_modal.cost_range_days_suffix')}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="text-center py-8 text-slate-400 text-[13px]"><Loader2 size={16} className="inline animate-spin mr-2" />{t('settings_modal.cost_loading')}</div>}
      {error && <div className="text-[13px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</div>}

      {stats && !loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <div className="border border-slate-200 rounded-lg p-3"><p className="text-[10px] font-bold text-slate-400 uppercase">{t('settings_modal.cost_metric_calls')}</p><p className="text-[16px] font-bold text-slate-800 tabular-nums" title={fmtNum(stats.totalCalls)}>{fmtCompact(stats.totalCalls)}</p></div>
            <div className="border border-slate-200 rounded-lg p-3"><p className="text-[10px] font-bold text-slate-400 uppercase">{t('settings_modal.cost_metric_input_tokens')}</p><p className="text-[16px] font-bold text-slate-800 tabular-nums" title={fmtNum(stats.totalInputTokens)}>{fmtTok(stats.totalInputTokens)}</p></div>
            <div className="border border-slate-200 rounded-lg p-3"><p className="text-[10px] font-bold text-slate-400 uppercase">{t('settings_modal.cost_metric_cached_tokens')}</p><p className="text-[16px] font-bold text-slate-800 tabular-nums" title={fmtNum(stats.totalCachedTokens)}>{fmtTok(stats.totalCachedTokens)}</p></div>
            <div className="border border-slate-200 rounded-lg p-3"><p className="text-[10px] font-bold text-slate-400 uppercase">{t('settings_modal.cost_metric_output_tokens')}</p><p className="text-[16px] font-bold text-slate-800 tabular-nums" title={fmtNum(stats.totalOutputTokens)}>{fmtTok(stats.totalOutputTokens)}</p></div>
            <div className="border border-blue-200 bg-blue-50 rounded-lg p-3"><p className="text-[10px] font-bold text-blue-500 uppercase">{t('settings_modal.cost_metric_cost_usd')}</p><p className="text-[16px] font-bold text-blue-700 tabular-nums">{fmtUsd(stats.totalCostUsd)}</p></div>
          </div>

          {modelTotals.length > 0 && (
            <div>
              <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase mb-2">{t('settings_modal.cost_section_by_model')}</p>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-[12px]">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-bold text-slate-600">{t('settings_modal.cost_column_model')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_calls')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_input')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_output')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelTotals.map(r => (
                      <tr key={r.model} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-700 font-mono text-[11px]">{r.model}</td>
                        <td className="px-3 py-2 text-right text-slate-700 tabular-nums" title={fmtNum(r.calls)}>{fmtCompact(r.calls)}</td>
                        <td className="px-3 py-2 text-right text-slate-500 tabular-nums" title={fmtNum(r.inputTokens)}>{fmtTok(r.inputTokens)}</td>
                        <td className="px-3 py-2 text-right text-slate-500 tabular-nums" title={fmtNum(r.outputTokens)}>{fmtTok(r.outputTokens)}</td>
                        <td className="px-3 py-2 text-right text-blue-700 font-bold tabular-nums">{fmtUsd(r.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {dailyTotals.length > 0 && (
            <div>
              <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase mb-2">{t('settings_modal.cost_section_daily')}</p>
              <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[300px] overflow-y-auto">
                <table className="w-full text-[12px]">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-bold text-slate-600">{t('settings_modal.cost_column_date')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_calls')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_input')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_output')}</th>
                      <th className="px-3 py-2 text-right font-bold text-slate-600">{t('settings_modal.cost_column_cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyTotals.map(r => (
                      <tr key={r.date} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-slate-700 tabular-nums">{r.date}</td>
                        <td className="px-3 py-2 text-right text-slate-700 tabular-nums" title={fmtNum(r.calls)}>{fmtCompact(r.calls)}</td>
                        <td className="px-3 py-2 text-right text-slate-500 tabular-nums" title={fmtNum(r.inputTokens)}>{fmtTok(r.inputTokens)}</td>
                        <td className="px-3 py-2 text-right text-slate-500 tabular-nums" title={fmtNum(r.outputTokens)}>{fmtTok(r.outputTokens)}</td>
                        <td className="px-3 py-2 text-right text-blue-700 font-bold tabular-nums">{fmtUsd(r.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {stats.totalCalls === 0 && (
            <div className="text-center py-8 text-slate-400 text-[13px]">{t('settings_modal.cost_empty_message', { days: String(days) })}</div>
          )}
        </>
      )}
    </div>
  );
}
