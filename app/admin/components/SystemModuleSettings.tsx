'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { X, Blocks, Save, Loader2, CheckCircle2, LinkIcon, Unlink, RefreshCw, Copy, Check, Globe, Terminal, Server, Image, Code, Settings2, ExternalLink, ArrowLeft, Plus, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { TelegramWebhookSection } from './TelegramWebhookSection';
import { confirmDialog } from './Dialog';
import { COLOR_PRESETS } from '../../../lib/design-tokens';
import { WidgetListField } from './WidgetListField';
import { useTranslations, useLang } from '../../../lib/i18n';
import type { Lang } from '../../../lib/i18n';

// ── 모듈별 설정 스키마 정의 ──────────────────────────────────────────────────
type FieldType = 'text' | 'number' | 'toggle' | 'textarea' | 'oauth' | 'secret' | 'verifications' | 'color-presets' | 'color-overrides' | 'select' | 'widget-list';
interface SelectOption { value: string; label: string }
interface SettingField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  description?: string;
  defaultValue?: any;
  tab?: string;              // 탭 그룹 (없으면 기본 탭)
  group?: string;            // 탭 안 sub-section heading. 같은 group 의 field 는 묶여 렌더, group 헤더 표시.
  oauthUrl?: string;        // oauth 타입 전용: 인증 시작 URL
  oauthSecrets?: string[];  // oauth 타입 전용: 연동 상태 확인용 시크릿 키
  secretName?: string;      // secret 타입 전용: Vault에 저장할 시크릿 키 이름
  options?: SelectOption[]; // select 타입 전용: dropdown 옵션
  widgetArea?: 'header' | 'sidebar' | 'footer'; // widget-list 전용: 영역
}

/**
 * config.json 의 `settings_fields` 영역 — 모듈 자기완결 i18n.
 *
 * **옵션 C 패턴 (2026-05-10 도입):** 모듈의 config.json 에 settings_fields 정의 시
 * 본 SystemModuleSettings 컴포넌트가 우선 사용. 외부 AI (Claude Code / Cursor 등) 가
 * VSCode MCP 통해 새 모듈 만들 때 ko/en 동시 작성 자연. messages/*.json 분리 entry 미필요.
 *
 * resolveConfigField() 가 활성 lang 기준 i18n 영역에서 label/description/placeholder 결정.
 * fallback chain: i18n[lang] → i18n[en] → i18n[ko] → field.label (raw).
 */
interface ConfigI18nText {
  label?: string;
  description?: string;
  placeholder?: string;
  /** 그룹 헤더 라벨 (현재 lang). 미설정 시 cf.group raw 사용. 같은 그룹의 여러 필드에 반복 작성 가능 (resolver 가 마지막 우선) */
  group?: string;
  /** select options 의 lang 별 라벨 — cf.options 와 같은 길이의 병렬 배열 (i 인덱스 매칭) */
  options?: string[];
}
interface ConfigSettingField {
  key: string;
  type: FieldType;
  placeholder?: string;
  defaultValue?: any;
  tab?: string;
  group?: string;
  oauthUrl?: string;
  oauthSecrets?: string[];
  secretName?: string;
  options?: SelectOption[];
  widgetArea?: 'header' | 'sidebar' | 'footer';
  i18n?: Partial<Record<Lang, ConfigI18nText>>;
}

/** i18n key 형태 ('system_modules.X.Y') 면 t() lookup, 그 외 raw 반환 (legacy hardcoded 한국어).
 *  config.json 의 settings_fields 가 풀어진 string + 옛 hardcoded MODULE_SETTINGS_SCHEMA 의
 *  한국어 raw label/description 모두 console warn 없이 그대로 표시. */
function localize(
  t: (k: string, params?: Record<string, string | number>) => string,
  s: string | undefined,
): string {
  if (!s) return '';
  if (s.startsWith('system_modules.')) return t(s);
  return s;
}

function resolveConfigField(cf: ConfigSettingField, lang: Lang): SettingField {
  const i18n = cf.i18n ?? {};
  const primary = i18n[lang] ?? {};
  const fallback = i18n['en'] ?? i18n['ko'] ?? {};

  // select options 라벨 i18n 적용 — primary.options[i] / fallback.options[i] 우선, 미설정 시 raw label 유지
  let resolvedOptions = cf.options;
  if (cf.options && (primary.options || fallback.options)) {
    resolvedOptions = cf.options.map((opt, i) => ({
      ...opt,
      label: primary.options?.[i] ?? fallback.options?.[i] ?? opt.label,
    }));
  }

  return {
    key: cf.key,
    type: cf.type,
    placeholder: primary.placeholder ?? fallback.placeholder ?? cf.placeholder,
    defaultValue: cf.defaultValue,
    label: primary.label ?? fallback.label ?? cf.key,
    description: primary.description ?? fallback.description,
    tab: cf.tab,
    group: primary.group ?? fallback.group ?? cf.group,
    oauthUrl: cf.oauthUrl,
    oauthSecrets: cf.oauthSecrets,
    secretName: cf.secretName,
    options: resolvedOptions,
    widgetArea: cf.widgetArea,
  };
}

// 탭 정의 (아이콘 + i18n 키) — 라벨은 컴포넌트 내부에서 t()로 번역
const TAB_META: Record<string, { i18nKey: string; icon: typeof Globe }> = {
  '일반':   { i18nKey: 'system_modules.common.tab_general', icon: Settings2 },
  '레이아웃': { i18nKey: 'system_modules.common.tab_layout',  icon: Server },
  '테마':   { i18nKey: 'system_modules.common.tab_theme',   icon: Blocks },
  '광고':   { i18nKey: 'system_modules.common.tab_ads',     icon: ExternalLink },
  'SEO':   { i18nKey: 'system_modules.common.tab_seo',     icon: Globe },
  '이미지': { i18nKey: 'system_modules.common.tab_image',   icon: Image },
  'OG':    { i18nKey: 'system_modules.common.tab_og',      icon: Image },
  '스크립트': { i18nKey: 'system_modules.common.tab_scripts', icon: Code },
};

/**
 * 특수 설정이 필요한 모듈만 등록 (oauth, 커스텀 필드 등).
 * 일반 secret 필드는 config.json의 secrets 배열에서 자동 생성됨.
 *
 * **C 옵션 마이그레이션 (2026-05-10):** 옛 hardcoded 한국어 schema 들이 모듈 config.json 의
 * `settings_fields` (i18n.ko/en 자기완결) 으로 이전 완료. config.json 에 settings_fields 가
 * 정의된 모듈은 이 hardcoded schema 보다 우선 적용됨 (resolveFieldsFromConfig).
 * 5 모듈 이전 완료: browser-scrape / kakao-talk / telegram / firecrawl / cms.
 * mcp-server-app / mcp-server-llm 는 fields:[] (커스텀 렌더링) 만 유지 — 이전 불필요.
 */
const MODULE_SETTINGS_SCHEMA: Record<string, { title?: string; fields: SettingField[] }> = {
  // browser-scrape / kakao-talk / telegram / firecrawl 폐기 — config.json settings_fields 로 이전됨.
  'mcp-server-app': {
    fields: [],  // 커스텀 렌더링 (앱 개발용 — Claude Code, Cursor, VS Code)
  },
  'mcp-server-llm': {
    fields: [],  // 커스텀 렌더링 (LLM 통신용 — OpenAI Responses API, Claude API)
  },
};

/** config.json secrets 배열 → SettingField[] 자동 생성 */
function secretsToFields(secrets: string[]): SettingField[] {
  return secrets.map(name => ({
    key: `_secret_${name}`,
    label: name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    type: 'secret' as FieldType,
    secretName: name,
    placeholder: name,
  }));
}

interface Props {
  moduleName: string;
  onClose: () => void;
  onBack?: () => void;
  /** 풀페이지(CmsFullPage) 안에 임베드된 경우 — modal chrome (배경 dim, X 버튼) 비활성. 상단바가 닫기 처리. */
  embeddedInPage?: boolean;
}

export function SystemModuleSettings({ moduleName, onClose, onBack, embeddedInPage }: Props) {
  const t = useTranslations();
  const { lang } = useLang();
  // 'seo' 옛 모듈명 → 'cms' fallback (2026-04-28 SEO → CMS rename 호환)
  const manualSchema = MODULE_SETTINGS_SCHEMA[moduleName] ?? (moduleName === 'seo' ? MODULE_SETTINGS_SCHEMA['cms'] : undefined);
  const [schema, setSchema] = useState<{ title: string; fields: SettingField[] } | null>(null);
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('');

  // 탭 목록 계산
  const hasTabs = schema?.fields.some(f => f.tab);
  const tabs = hasTabs ? [...new Set(schema!.fields.map(f => f.tab ?? '기본'))] : [];

  // 초기 탭 설정
  useEffect(() => { if (tabs.length > 0 && !activeTab) setActiveTab(tabs[0]); }, [tabs.length]); // eslint-disable-line

  // ── 탭 바 스크롤 (SettingsModal 동일 패턴 — 드래그 + 좌/우 화살표) ─────
  const tabBarRef = useRef<HTMLDivElement>(null);
  const draggedRef = useRef(false);
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: false });

  // PC 마우스 드래그 스크롤
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
      setTimeout(() => { draggedRef.current = false; }, 0);
    };
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

  // 좌/우 화살표 가시성 갱신
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
  }, [updateScrollState, tabs.length]);
  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    const bar = tabBarRef.current;
    if (!bar) return;
    bar.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' });
  }, []);

  // 초기 로드 — config.json + settings 동시 조회.
  // lang 변경 시 schema 재계산 (config.json 의 i18n 영역에서 lang 별 label/description 다시 resolve).
  useEffect(() => {
    setLoading(true);
    fetch(`/api/settings/modules?name=${encodeURIComponent(moduleName)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          // config.json에서 secrets 자동 생성
          const config = data.config as Record<string, unknown> | null;
          const configSecrets = (config?.secrets as string[] | undefined) ?? [];
          const autoFields = secretsToFields(configSecrets);

          // 옵션 C — config.json 의 settings_fields 우선 (모듈 자기완결 i18n).
          // 활성 lang 기준 i18n 영역에서 label/description/placeholder 자동 결정.
          const configSettingsFields = (config?.settings_fields as ConfigSettingField[] | undefined) ?? [];
          const configFields = configSettingsFields.map(cf => resolveConfigField(cf, lang));

          // 옛 hardcoded MODULE_SETTINGS_SCHEMA — config.json 미정의 모듈 fallback (cms / mcp-server-* 등).
          // settings_fields 가 정의된 모듈은 manual 무시.
          const manualFields = configFields.length > 0 ? [] : (manualSchema?.fields ?? []);
          const autoSecretNames = new Set(configSecrets);
          const filteredManual = manualFields.filter(f => !(f.type === 'secret' && f.secretName && autoSecretNames.has(f.secretName)));

          // 병합: 자동 secret + config.json fields + (legacy manual fallback)
          const allFields = [...autoFields, ...configFields, ...filteredManual];
          const title = manualSchema?.title || moduleName;
          setSchema({ title, fields: allFields });

          // 기본값과 저장된 값 병합
          const merged: Record<string, any> = {};
          for (const field of allFields) {
            if (field.defaultValue !== undefined) merged[field.key] = field.defaultValue;
          }
          const savedData = data.settings ?? {};
          for (const [key, val] of Object.entries(savedData)) {
            if (val !== null && val !== undefined) {
              merged[key] = val;
            }
          }
          setSettings(merged);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [moduleName, lang]); // eslint-disable-line

  // OAuth 연동 상태 + 시크릿 값 로드
  const [oauthStatus, setOauthStatus] = useState<Record<string, boolean>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretSaved, setSecretSaved] = useState<Record<string, boolean>>({});
  const [secretSaving, setSecretSaving] = useState<Record<string, boolean>>({});

  const loadSecretsAndOauth = useCallback(async () => {
    if (!schema) return;
    const hasSecretOrOauth = schema.fields.some(f => f.type === 'oauth' || f.type === 'secret');
    if (!hasSecretOrOauth) return;
    try {
      const res = await fetch('/api/vault/secrets');
      const data = await res.json();
      if (!data.success) return;
      const secrets: { name: string; hasValue: boolean }[] = data.secrets ?? [];
      const secretNames = secrets.map(s => s.name);

      // OAuth 상태
      const oStatus: Record<string, boolean> = {};
      for (const field of schema.fields.filter(f => f.type === 'oauth' && f.oauthSecrets)) {
        oStatus[field.key] = (field.oauthSecrets ?? []).every(s => secretNames.includes(s));
      }
      setOauthStatus(oStatus);

      // 시크릿 필드 저장 상태
      const sStatus: Record<string, boolean> = {};
      for (const field of schema.fields.filter(f => f.type === 'secret' && f.secretName)) {
        sStatus[field.key] = secretNames.includes(field.secretName!);
      }
      setSecretSaved(sStatus);
    } catch {}
  }, [schema]);

  useEffect(() => { loadSecretsAndOauth(); }, [loadSecretsAndOauth]);

  const handleSaveSecret = async (field: SettingField) => {
    if (!field.secretName) return;
    const value = secretValues[field.key];
    if (!value?.trim()) return;
    setSecretSaving(prev => ({ ...prev, [field.key]: true }));
    try {
      await fetch('/api/vault/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: field.secretName, value }),
      });
      setSecretSaved(prev => ({ ...prev, [field.key]: true }));
      setSecretValues(prev => ({ ...prev, [field.key]: '' }));
    } catch {}
    finally { setSecretSaving(prev => ({ ...prev, [field.key]: false })); }
  };

  const handleChange = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/modules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: moduleName, settings }),
      });
      const data = await res.json();
      if (data.success) setSaved(true);
    } catch {}
    finally { setSaving(false); }
  };

  // ── MCP 서버 커스텀 상태 ──────────────────────────────────────────────────
  const [mcpTokenInfo, setMcpTokenInfo] = useState<{ exists: boolean; hint: string | null; createdAt: string | null }>({ exists: false, hint: null, createdAt: null });
  const [mcpTokenRaw, setMcpTokenRaw] = useState<string | null>(null);
  const [mcpTokenLoading, setMcpTokenLoading] = useState(false);
  const [mcpTokenCopied, setMcpTokenCopied] = useState(false);
  const [mcpJsonTab, setMcpJsonTab] = useState<'api' | 'stdio'>('api');
  const [mcpJsonCopied, setMcpJsonCopied] = useState(false);

  // 서비스별 엔드포인트 매핑 (app=외부용, llm=내부용)
  const isMcpApp = moduleName === 'mcp-server-app';
  const isMcpLlm = moduleName === 'mcp-server-llm';
  const mcpTokenEndpoint = isMcpLlm ? '/api/mcp-internal/token' : '/api/mcp/tokens';
  const mcpServerPath = isMcpLlm ? '/api/mcp-internal' : '/api/mcp';

  useEffect(() => {
    if (!isMcpApp && !isMcpLlm) return;
    fetch(mcpTokenEndpoint).then(r => r.json()).then(data => {
      if (data.success) {
        if (isMcpLlm) {
          // /api/mcp-internal/token 응답 형식: { token: {hasToken, masked}, createdAt }
          setMcpTokenInfo({ exists: data.token?.hasToken ?? false, hint: data.token?.masked ?? null, createdAt: data.createdAt ?? null });
        } else {
          setMcpTokenInfo({ exists: data.exists, hint: data.hint, createdAt: data.createdAt });
        }
      }
    }).catch(() => {});
  }, [moduleName, isMcpApp, isMcpLlm, mcpTokenEndpoint]);

  const generateMcpToken = async () => {
    if (mcpTokenInfo.exists && !await confirmDialog({ title: t('system_modules.common.token_regenerate_title'), message: t('system_modules.common.token_regenerate_message'), danger: true, okLabel: t('system_modules.common.token_regenerate_ok') })) return;
    setMcpTokenLoading(true);
    try {
      const res = await fetch(mcpTokenEndpoint, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setMcpTokenRaw(data.token);
        const hint = isMcpLlm
          ? `${(data.token as string).slice(0, 8)}****${(data.token as string).slice(-4)}`
          : data.hint;
        setMcpTokenInfo({ exists: true, hint, createdAt: data.createdAt });
      }
    } catch {} finally { setMcpTokenLoading(false); }
  };

  const revokeMcpToken = async () => {
    if (!await confirmDialog({ title: t('system_modules.common.token_revoke_title'), message: t('system_modules.common.token_revoke_message'), danger: true, okLabel: t('system_modules.common.token_revoke_ok') })) return;
    await fetch(mcpTokenEndpoint, { method: 'DELETE' });
    setMcpTokenInfo({ exists: false, hint: null, createdAt: null });
    setMcpTokenRaw(null);
  };

  const copyToClipboard = async (text: string, setCopied: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── MCP 서버 커스텀 렌더링 (앱 개발용 / LLM 통신용 공용) ─────────────────────
  if (isMcpApp || isMcpLlm) {
    const titleText = isMcpLlm ? t('system_modules.common.mcp_llm_title') : t('system_modules.common.mcp_app_title');
    const descText = isMcpLlm
      ? t('system_modules.common.mcp_llm_desc')
      : t('system_modules.common.mcp_app_desc');
    return (
      <div className={embeddedInPage ? 'flex flex-col h-full bg-white overflow-hidden' : 'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden'}>
        <div className={embeddedInPage ? 'flex flex-col h-full w-full overflow-hidden' : 'bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]'}>
          {!embeddedInPage && (
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
              {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
              <Server size={18} className={isMcpLlm ? 'text-purple-500' : 'text-emerald-500'} /> {titleText}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
          </div>
          )}

          <div className="p-3 sm:p-6 flex flex-col gap-4 overflow-y-scroll flex-1 min-h-0">
            <p className="text-[11px] sm:text-[12px] text-slate-400">{descText}</p>

            {/* JSON 설정 보기 */}
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="flex border-b border-slate-200">
                <button
                  onClick={() => { setMcpJsonTab('api'); setMcpJsonCopied(false); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] sm:text-[12px] font-bold transition-colors ${mcpJsonTab === 'api' ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-500' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <Globe size={12} /> {t('system_modules.common.mcp_tab_sse')}
                </button>
                {isMcpApp && (
                  <button
                    onClick={() => { setMcpJsonTab('stdio'); setMcpJsonCopied(false); }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] sm:text-[12px] font-bold transition-colors ${mcpJsonTab === 'stdio' ? 'bg-green-50 text-green-700 border-b-2 border-green-500' : 'text-slate-400 hover:text-slate-600'}`}
                  >
                    <Terminal size={12} /> {t('system_modules.common.mcp_tab_stdio')}
                  </button>
                )}
              </div>

              {mcpJsonTab === 'api' && (() => {
                const sseUrl = typeof window !== 'undefined' ? `${window.location.origin}${mcpServerPath}` : mcpServerPath;
                const tokenValue = mcpTokenRaw || (mcpTokenInfo.exists ? t('system_modules.common.token_existing_placeholder') : t('system_modules.common.token_generated_placeholder'));
                const jsonConfig = isMcpLlm
                  ? JSON.stringify({
                      tools: [{
                        type: 'mcp',
                        server_label: 'firebat-internal',
                        server_url: sseUrl,
                        headers: { Authorization: `Bearer ${tokenValue}` },
                        require_approval: 'never',
                      }],
                    }, null, 2)
                  : JSON.stringify({
                      mcpServers: { firebat: { url: sseUrl, headers: { Authorization: `Bearer ${tokenValue}` } } },
                    }, null, 2);
                return (
                  <div className="p-3 flex flex-col gap-3">
                    {/* 인증 토큰 */}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col gap-2 min-h-[60px]">
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] sm:text-[13px] font-bold text-slate-600">{t('system_modules.common.mcp_auth_token')}</span>
                        <div className="flex items-center gap-1.5">
                          {mcpTokenInfo.exists && (
                            <button onClick={revokeMcpToken} className="text-[10px] sm:text-[11px] px-2 py-0.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors">
                              {t('system_modules.common.revoke')}
                            </button>
                          )}
                          <button
                            onClick={generateMcpToken}
                            disabled={mcpTokenLoading}
                            className="text-[10px] sm:text-[11px] px-2.5 py-1 font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded transition-colors flex items-center gap-1"
                          >
                            {mcpTokenLoading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                            {mcpTokenInfo.exists ? t('system_modules.common.regenerate') : t('system_modules.common.generate_token')}
                          </button>
                        </div>
                      </div>

                      {mcpTokenRaw && (
                        <div className="bg-amber-50 border border-amber-300 rounded-lg p-2.5 flex flex-col gap-1.5">
                          <p className="text-[10px] sm:text-[11px] font-bold text-amber-700">{t('system_modules.common.token_warning')}</p>
                          <div className="flex items-center gap-1.5">
                            <code className="flex-1 text-[11px] sm:text-[12px] font-mono bg-white border border-amber-200 rounded px-2 py-1 text-slate-700 break-all select-all">
                              {mcpTokenRaw}
                            </code>
                            <Tooltip label={t('system_modules.common.copy')}>
                              <button onClick={() => copyToClipboard(mcpTokenRaw, setMcpTokenCopied)} className="shrink-0 p-1.5 rounded hover:bg-amber-100 transition-colors">
                                {mcpTokenCopied ? <Check size={14} className="text-green-600" /> : <Copy size={14} className="text-amber-600" />}
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      )}

                      {mcpTokenInfo.exists && !mcpTokenRaw && (
                        <div className="flex items-center gap-2 text-[11px] sm:text-[12px] text-slate-500">
                          <code className="font-mono bg-white border border-slate-200 rounded px-2 py-0.5 text-slate-600">{mcpTokenInfo.hint}</code>
                          {mcpTokenInfo.createdAt && (
                            <span className="text-slate-400">{t('system_modules.common.token_created_at')}{new Date(mcpTokenInfo.createdAt).toLocaleDateString('ko-KR')}</span>
                          )}
                        </div>
                      )}

                      {!mcpTokenInfo.exists && !mcpTokenRaw && (
                        <p className="text-[10px] sm:text-[11px] text-slate-400">{t('system_modules.common.token_none')}</p>
                      )}
                    </div>

                    {/* JSON 설정 */}
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] sm:text-[11px] text-slate-500">{isMcpLlm ? t('system_modules.common.mcp_sse_hint_llm') : t('system_modules.common.mcp_sse_hint_app')}</p>
                      <Tooltip label={t('system_modules.common.copy')}>
                        <button onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)} className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors">
                          {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                        </button>
                      </Tooltip>
                    </div>
                    <pre className="text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 whitespace-pre-wrap break-all leading-relaxed">{jsonConfig}</pre>
                  </div>
                );
              })()}

              {mcpJsonTab === 'stdio' && (() => {
                const jsonConfig = JSON.stringify({
                  mcpServers: { firebat: { command: 'ssh', args: ['-i', '<SSH_KEY_PATH>', '<USER>@<SERVER_IP>', 'cd /path/to/firebat && npx tsx mcp/stdio.ts'] } },
                }, null, 2);
                return (
                  <div className="p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] sm:text-[11px] text-slate-500">{t('system_modules.common.mcp_stdio_hint')}</p>
                      <Tooltip label={t('system_modules.common.copy')}>
                        <button onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)} className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors">
                          {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                        </button>
                      </Tooltip>
                    </div>
                    <pre className="text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">{jsonConfig}</pre>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[10px] sm:text-[11px] text-amber-700 flex flex-col gap-1">
                      <p className="font-bold">{t('system_modules.common.mcp_stdio_ssh_required_title')}</p>
                      <p>{t('system_modules.common.mcp_stdio_ssh_required_body')}</p>
                      <p className="text-amber-500 mt-0.5">{t('system_modules.common.mcp_stdio_ssh_required_note')}</p>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* 하단 */}
          <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex justify-end shrink-0">
            <button onClick={onClose} className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors">
              {t('system_modules.common.close')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 로딩 중이거나 설정 필드가 없는 모듈
  if (!loading && schema && schema.fields.length === 0) {
    return (
      <div className={embeddedInPage ? 'flex flex-col h-full bg-white overflow-hidden' : 'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden'}>
        <div className={embeddedInPage ? 'flex flex-col h-full w-full overflow-hidden' : 'bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]'}>
          {!embeddedInPage && (
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
              {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
              <Blocks size={18} className="text-indigo-500" /> {schema.title}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
          </div>
          )}
          <div className="p-6 text-center text-slate-500 text-sm flex-1 flex items-center justify-center">
            {t('system_modules.common.no_settings')}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={embeddedInPage ? 'flex flex-col h-full bg-white overflow-hidden' : 'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden'}>
      <div className={embeddedInPage ? 'flex flex-col h-full w-full overflow-hidden' : 'bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]'}>
        {/* 헤더 — embeddedInPage 시 풀페이지 wrapper 의 상단 바가 처리하므로 hide */}
        {!embeddedInPage && (
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
          <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
            {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
            <Blocks size={18} className="text-indigo-500" /> {schema?.title ?? moduleName}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
        </div>
        )}

        {/* 탭 바 — SettingsModal 동일 패턴. 모바일은 터치 스크롤, PC는 드래그 + 호버 시 화살표 */}
        {hasTabs && (
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
              {tabs.map(tab => {
                const meta = TAB_META[tab];
                const Icon = meta?.icon;
                const tabLabel = meta ? t(meta.i18nKey) : tab;
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${activeTab === tab ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                  >
                    {Icon && <Icon size={14} />} {tabLabel}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 설정 필드 */}
        <div className="p-3 sm:p-6 flex flex-col gap-4 overflow-y-scroll flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-slate-400" />
            </div>
          ) : (
            <>
            {/* OG 미리보기 */}
            {activeTab === 'OG' && (moduleName === 'cms' || moduleName === 'seo') && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs sm:text-sm font-bold text-slate-700">{t('system_modules.common.og_preview')}</label>
                  <a
                    href="/api/og"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] sm:text-[11px] text-blue-500 hover:text-blue-700 font-bold"
                  >
                    <ExternalLink size={11} /> {t('system_modules.common.og_view_original')}
                  </a>
                </div>
                <div
                  className="relative rounded-lg border border-slate-200 overflow-hidden shadow-sm"
                  style={{ aspectRatio: '1200/630' }}
                >
                  <img
                    src={`/api/og?_t=${Date.now()}`}
                    alt={t('system_modules.common.og_preview')}
                    className="w-full h-full object-cover"
                  />
                </div>
                <p className="text-[10px] text-slate-400">{t('system_modules.common.og_size_hint')}</p>
              </div>
            )}

            {(hasTabs ? (schema?.fields ?? []).filter(f => (f.tab ?? '기본') === activeTab) : (schema?.fields ?? [])).map((field, idx, arr) => {
              const prevGroup = idx > 0 ? (arr[idx - 1].group ?? '') : '__INIT__';
              const currentGroup = field.group ?? '';
              const showGroupHeader = currentGroup !== '' && currentGroup !== prevGroup;
              return (
              <Fragment key={field.key}>
                {showGroupHeader && (
                  <div className={`${idx > 0 ? 'mt-6' : 'mt-1'} mb-2 pb-1.5 border-b border-slate-200`}>
                    <h4 className="text-[11px] font-bold text-slate-500 tracking-wider uppercase">{currentGroup}</h4>
                  </div>
                )}
                <div className="flex flex-col gap-1.5 mb-1">
                {field.type === 'secret' ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{localize(t, field.label)}</label>
                    {secretSaved[field.key] ? (
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex-1">
                          <CheckCircle2 size={15} /> {t('system_modules.common.registered')}
                        </span>
                        <button
                          onClick={() => setSecretSaved(prev => ({ ...prev, [field.key]: false }))}
                          className="px-3 py-2 text-[12px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors shrink-0"
                        >
                          {t('system_modules.common.change')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={secretValues[field.key] ?? ''}
                          onChange={e => setSecretValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                          className="flex-1 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                        <button
                          onClick={() => handleSaveSecret(field)}
                          disabled={!secretValues[field.key]?.trim() || secretSaving[field.key]}
                          className="px-3 py-2 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shrink-0"
                        >
                          {secretSaving[field.key] ? <Loader2 size={14} className="animate-spin" /> : t('system_modules.common.save')}
                        </button>
                      </div>
                    )}
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{localize(t, field.description)}</p>
                    )}
                  </div>
                ) : field.type === 'oauth' ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{localize(t, field.label)}</label>
                    <div className="flex items-center gap-2">
                      {oauthStatus[field.key] ? (
                        <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex-1">
                          <CheckCircle2 size={15} /> {t('system_modules.common.connected')}
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-slate-400 text-[13px] font-medium px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg flex-1">
                          <Unlink size={14} /> {t('system_modules.common.not_connected')}
                        </span>
                      )}
                      <button
                        onClick={() => window.open(field.oauthUrl, 'oauth', 'width=500,height=700,left=200,top=100')}
                        className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors shadow-sm shrink-0"
                      >
                        <LinkIcon size={14} /> {oauthStatus[field.key] ? t('system_modules.common.reconnect') : t('system_modules.common.connect')}
                      </button>
                    </div>
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{localize(t, field.description)}</p>
                    )}
                  </div>
                ) : field.type === 'verifications' ? (
                  <VerificationsField
                    label={localize(t, field.label)}
                    description={localize(t, field.description)}
                    value={Array.isArray(settings[field.key]) ? settings[field.key] : []}
                    onChange={(v) => handleChange(field.key, v)}
                  />
                ) : field.type === 'color-presets' ? (
                  <ColorPresetField
                    label={localize(t, field.label)}
                    description={localize(t, field.description)}
                    value={settings[field.key] ?? field.defaultValue ?? 'slate-pro'}
                    onChange={(v) => handleChange(field.key, v)}
                  />
                ) : field.type === 'color-overrides' ? (
                  <ColorOverridesField
                    label={localize(t, field.label)}
                    description={localize(t, field.description)}
                    settings={settings}
                    presetKey={settings.themePreset ?? 'slate-pro'}
                    onChange={(k, v) => handleChange(k, v)}
                  />
                ) : field.type === 'widget-list' ? (
                  <WidgetListField
                    label={localize(t, field.label)}
                    description={localize(t, field.description)}
                    area={(field.widgetArea ?? 'sidebar') as 'header' | 'sidebar' | 'footer'}
                    value={Array.isArray(settings[field.key]) ? settings[field.key] : undefined}
                    onChange={(next) => handleChange(field.key, next)}
                  />
                ) : field.type === 'select' ? (
                  <>
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{localize(t, field.label)}</label>
                    <select
                      value={settings[field.key] ?? field.defaultValue ?? ''}
                      onChange={e => handleChange(field.key, e.target.value)}
                      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="field798" id="field798"
                    >
                      {(field.options ?? []).map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{localize(t, field.description)}</p>
                    )}
                  </>
                ) : field.type === 'toggle' ? (
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-xs sm:text-sm font-bold text-slate-700">{localize(t, field.label)}</span>
                      {field.description && (
                        <p className="text-[10px] sm:text-xs text-slate-400 font-medium mt-0.5">{localize(t, field.description)}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleChange(field.key, !settings[field.key])}
                      className={`relative w-11 h-6 rounded-full transition-colors ${settings[field.key] ? 'bg-blue-500' : 'bg-slate-300'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${settings[field.key] ? 'translate-x-5' : ''}`} />
                    </button>
                  </label>
                ) : (
                  <>
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{localize(t, field.label)}</label>
                    {field.type === 'textarea' ? (
                      <textarea
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        rows={4}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono resize-y" name="field830" autoComplete="off" id="field830"
                      />
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                        placeholder={field.placeholder}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name="field838" autoComplete="off" id="field838"
                      />
                    )}
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{localize(t, field.description)}</p>
                    )}
                  </>
                )}
                </div>
              </Fragment>
              );
            })}
            {moduleName === 'telegram' && <TelegramWebhookSection />}
            </>
          )}
        </div>

        {/* 하단 버튼 */}
        {(() => {
          const hasNonSecretFields = schema?.fields.some(f => f.type !== 'secret' && f.type !== 'oauth');
          return (
            <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex items-center justify-between shrink-0">
              <div>
                {saved && (
                  <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold">
                    <CheckCircle2 size={15} /> {t('system_modules.common.saved')}
                  </span>
                )}
              </div>
              <div className="flex gap-2 sm:gap-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors"
                >
                  {t('system_modules.common.close')}
                </button>
                {hasNonSecretFields && (
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shadow-sm"
                  >
                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                    {saving ? t('system_modules.common.saving') : t('system_modules.common.save')}
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ── 색 프리셋 button grid — 클릭 한 번으로 primary/accent/up/down 등 일괄 변경 ──
function ColorPresetField({ label, description, value, onChange }: {
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <label className="text-xs sm:text-sm font-bold text-slate-700">{label}</label>
      {description && (
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{description}</p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
        {Object.entries(COLOR_PRESETS).map(([key, preset]) => {
          const active = value === key;
          const c = preset.colors;
          return (
            <button
              key={key}
              onClick={() => onChange(key)}
              className={`relative flex flex-col gap-1.5 p-2 border rounded-lg text-left transition-all overflow-hidden ${
                active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200 hover:border-slate-300'
              }`}
              style={{ background: c.bgCard, color: c.text }}
            >
              {/* 미니 미리보기 — 'Aa' 본문 + accent line + primary 버튼 sample */}
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-extrabold leading-none" style={{ color: c.text, fontFamily: 'serif' }}>Aa</span>
                <span className="h-3 w-0.5 shrink-0" style={{ background: c.accent }} />
                <span className="text-[10px] font-bold leading-none truncate" style={{ color: c.primary }}>{preset.label}</span>
              </div>
              {/* 색 칩 — primary / accent / up / down 4 종 */}
              <div className="flex gap-1 shrink-0">
                <div style={{ background: c.primary, width: 16, height: 12, borderRadius: 2 }} title="primary" />
                <div style={{ background: c.accent, width: 16, height: 12, borderRadius: 2 }} title="accent" />
                <div style={{ background: c.up, width: 16, height: 12, borderRadius: 2 }} title="up" />
                <div style={{ background: c.down, width: 16, height: 12, borderRadius: 2 }} title="down" />
              </div>
              <span className="text-[9px] uppercase tracking-wider font-bold opacity-50">{preset.mode}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ── 색 개별 편집 — 9 색 picker (themeColor_<key> Vault 키). 빈 값 = 프리셋 그대로.
const COLOR_OVERRIDE_FIELDS: Array<{ key: string; i18nKey: string; defaultPresetKey: keyof (typeof COLOR_PRESETS)['slate-pro']['colors'] }> = [
  { key: 'themeColor_primary',  i18nKey: 'system_modules.color_overrides.primary',   defaultPresetKey: 'primary' },
  { key: 'themeColor_accent',   i18nKey: 'system_modules.color_overrides.accent',    defaultPresetKey: 'accent' },
  { key: 'themeColor_up',       i18nKey: 'system_modules.color_overrides.up',        defaultPresetKey: 'up' },
  { key: 'themeColor_down',     i18nKey: 'system_modules.color_overrides.down',      defaultPresetKey: 'down' },
  { key: 'themeColor_text',     i18nKey: 'system_modules.color_overrides.text',      defaultPresetKey: 'text' },
  { key: 'themeColor_textMuted',i18nKey: 'system_modules.color_overrides.text_muted',defaultPresetKey: 'textMuted' },
  { key: 'themeColor_bg',       i18nKey: 'system_modules.color_overrides.bg',        defaultPresetKey: 'bg' },
  { key: 'themeColor_bgCard',   i18nKey: 'system_modules.color_overrides.bg_card',   defaultPresetKey: 'bgCard' },
  { key: 'themeColor_border',   i18nKey: 'system_modules.color_overrides.border',    defaultPresetKey: 'border' },
];

/** 색 입력 — hex(#RRGGBB) / rgb(...) / rgba(...) 모두 받아 정규화.
 *  반환: { hex: '#RRGGBB', alpha: 0~1 }. alpha 1 이면 hex 그대로 저장, <1 이면 rgba() 형식 저장.
 *  잘못된 입력 시 alpha=1 + hex='#000000' 폴백. */
function parseColorValue(raw: string): { hex: string; alpha: number } {
  const v = (raw || '').trim();
  if (!v) return { hex: '#000000', alpha: 1 };
  // #RRGGBB / #RRGGBBAA
  const hexMatch = v.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (hexMatch) {
    const hex = '#' + hexMatch[1].toLowerCase();
    const alpha = hexMatch[2] ? parseInt(hexMatch[2], 16) / 255 : 1;
    return { hex, alpha };
  }
  // rgba(r,g,b,a) / rgb(r,g,b)
  const rgbaMatch = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (rgbaMatch) {
    const r = Math.min(255, parseInt(rgbaMatch[1], 10));
    const g = Math.min(255, parseInt(rgbaMatch[2], 10));
    const b = Math.min(255, parseInt(rgbaMatch[3], 10));
    const a = rgbaMatch[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgbaMatch[4]))) : 1;
    const hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
    return { hex, alpha: a };
  }
  return { hex: '#000000', alpha: 1 };
}

/** hex + alpha → CSS 값 문자열. alpha=1 → '#RRGGBB', alpha<1 → 'rgba(r,g,b,a)'. */
function formatColorValue(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (a >= 0.9999) return hex.toLowerCase();
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
}

function ColorOverridesField({ label, description, settings, presetKey, onChange }: {
  label: string;
  description?: string;
  settings: Record<string, any>;
  presetKey: string;
  onChange: (key: string, value: string) => void;
}) {
  const t = useTranslations();
  const preset = COLOR_PRESETS[presetKey] ?? COLOR_PRESETS['slate-pro'];
  const resetAll = () => {
    for (const f of COLOR_OVERRIDE_FIELDS) onChange(f.key, '');
  };
  const hasAnyOverride = COLOR_OVERRIDE_FIELDS.some(f => settings[f.key]);
  return (
    <>
      <div className="flex items-center justify-between">
        <label className="text-xs sm:text-sm font-bold text-slate-700">{label}</label>
        {hasAnyOverride && (
          <button
            type="button"
            onClick={resetAll}
            className="text-[10px] text-slate-500 hover:text-red-500 underline"
          >
            {t('system_modules.common.reset_all_preset')}
          </button>
        )}
      </div>
      {description && (
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{description}</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
        {COLOR_OVERRIDE_FIELDS.map(f => {
          const overrideValue = (typeof settings[f.key] === 'string' ? settings[f.key] : '').trim();
          const presetValue = preset.colors[f.defaultPresetKey] as string;
          // overrideValue 비어있으면 프리셋 값으로 표시 (placeholder 효과). 빈 값 = 프리셋 그대로.
          const displayRaw = overrideValue || presetValue;
          const { hex: displayHex, alpha: displayAlpha } = parseColorValue(displayRaw);
          const isOverridden = !!overrideValue;
          // hex picker 변경 시 — 기존 alpha 유지하고 새 hex 적용
          const handleHexChange = (newHex: string) => {
            onChange(f.key, formatColorValue(newHex, displayAlpha));
          };
          // alpha 변경 시 — 기존 hex 유지하고 새 alpha 적용
          const handleAlphaChange = (newAlphaPct: number) => {
            onChange(f.key, formatColorValue(displayHex, newAlphaPct / 100));
          };
          // 텍스트 input — 자유 입력 (hex / rgba 모두)
          const handleTextChange = (raw: string) => {
            onChange(f.key, raw);
          };
          // 프리뷰 swatch — checkered 배경 위 실제 색 (alpha 시각화)
          return (
            <div key={f.key} className="border border-slate-200 rounded p-2 flex items-start gap-2">
              <div className="flex flex-col items-center gap-1 shrink-0">
                <div
                  className="relative w-8 h-8 rounded border border-slate-200 overflow-hidden"
                  style={{
                    backgroundImage: 'linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)',
                    backgroundSize: '8px 8px',
                    backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0px',
                  }}
                >
                  <input
                    type="color"
                    value={displayHex}
                    onChange={e => handleHexChange(e.target.value)}
                    className="absolute inset-0 w-full h-full cursor-pointer border-0 p-0 opacity-0" name="displayHex" autoComplete="off" id="displayHex"
                  />
                  <div
                    className="absolute inset-0"
                    style={{ background: formatColorValue(displayHex, displayAlpha) }}
                  />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold text-slate-600 truncate">{t(f.i18nKey)}</p>
                <input
                  type="text"
                  value={overrideValue}
                  onChange={e => handleTextChange(e.target.value)}
                  placeholder={presetValue}
                  className={`w-full text-[10px] font-mono border-0 bg-transparent focus:outline-none ${isOverridden ? 'text-slate-700' : 'text-slate-400'}`} name="overrideValue" autoComplete="off" id="overrideValue"
                />
                {/* Alpha slider — hex picker 와 별도 (native color picker 가 alpha 미지원) */}
                <div className="flex items-center gap-1.5 mt-0.5">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(displayAlpha * 100)}
                    onChange={e => handleAlphaChange(parseInt(e.target.value, 10))}
                    className="flex-1 h-1 cursor-pointer"
                    aria-label={t('system_modules.common.alpha_label')} name="rounddisplayAlpha100" autoComplete="off" id="rounddisplayAlpha100"
                  />
                  <span className="text-[9px] text-slate-400 font-mono w-7 text-right tabular-nums">
                    {Math.round(displayAlpha * 100)}%
                  </span>
                </div>
              </div>
              {isOverridden && (
                <button
                  type="button"
                  onClick={() => onChange(f.key, '')}
                  className="text-slate-400 hover:text-red-500 text-[10px] mt-0.5"
                  title={t('system_modules.common.reset_to_preset')}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── 사이트 인증 파일 편집 — verifications 배열 (filename, content) UI ─────────
function VerificationsField({ label, description, value, onChange }: {
  label: string;
  description?: string;
  value: Array<{ filename: string; content: string }>;
  onChange: (v: Array<{ filename: string; content: string }>) => void;
}) {
  const t = useTranslations();
  const addItem = () => onChange([...value, { filename: '', content: '' }]);
  const removeItem = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const updateItem = (i: number, patch: Partial<{ filename: string; content: string }>) => {
    onChange(value.map((item, idx) => idx === i ? { ...item, ...patch } : item));
  };
  return (
    <>
      <label className="text-xs sm:text-sm font-bold text-slate-700">{label}</label>
      {description && (
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{description}</p>
      )}
      <div className="flex flex-col gap-2 mt-1">
        {value.length === 0 && (
          <p className="text-xs text-slate-400 italic py-2 text-center bg-slate-50 border border-dashed border-slate-200 rounded-lg">
            {t('system_modules.common.verifications_empty')}
          </p>
        )}
        {value.map((item, i) => (
          <div key={i} className="flex flex-col gap-1.5 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={item.filename}
                onChange={e => updateItem(i, { filename: e.target.value })}
                placeholder={t('system_modules.common.verifications_filename_placeholder')}
                className="flex-1 px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" name="filename" autoComplete="off" id="filename"
              />
              <Tooltip label={t('common.delete')}>
                <button
                  onClick={() => removeItem(i)}
                  className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                  aria-label={t('common.delete')}
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            </div>
            <textarea
              value={item.content}
              onChange={e => updateItem(i, { content: e.target.value })}
              placeholder={t('system_modules.common.verifications_content_placeholder')}
              rows={3}
              className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y" name="content" autoComplete="off" id="content"
            />
          </div>
        ))}
        <button
          onClick={addItem}
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-bold text-blue-600 hover:bg-blue-50 border border-dashed border-blue-300 rounded-lg transition-colors"
        >
          <Plus size={14} /> {t('system_modules.common.verifications_add')}
        </button>
      </div>
    </>
  );
}
