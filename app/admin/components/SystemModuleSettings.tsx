'use client';

import { useState, useEffect, useCallback, useRef, useId, Fragment } from 'react';
import { X, Blocks, Loader2, CheckCircle2, LinkIcon, Unlink, RefreshCw, Copy, Check, Globe, Terminal, Server, Image, Code, Settings2, ExternalLink, ArrowLeft, Plus, Trash2, ChevronLeft, ChevronRight, Package, Download, AlertCircle } from 'lucide-react';
import { SaveButton, type SaveButtonState } from './SaveButton';
import { Tooltip } from './Tooltip';
import { TelegramWebhookSection } from './TelegramWebhookSection';
import { HubPanel } from './HubPanel';
import { confirmDialog } from './Dialog';
import { COLOR_PRESETS } from '../../../lib/design-tokens';
import { WidgetListField } from './WidgetListField';
import { useTranslations, useLang } from '../../../lib/i18n';
import type { Lang } from '../../../lib/i18n';
import { logger } from '../../../lib/util/logger';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../../lib/api-fetch';
import { usePolling } from '../../../lib/hooks/use-polling';

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
 *  config.json 의 settings_fields 안 raw 라벨도 console warn 없이 그대로 표시. */
function localize(
  t: (k: string, params?: Record<string, string | number>) => string,
  s: string | undefined,
): string {
  if (!s) return '';
  if (s.startsWith('system_modules.')) return t(s);
  return s;
}

/**
 * resolveConfigField — settings field 의 lang 별 label/description/placeholder/group/options 결정.
 *
 * **lookup 우선순위 (2026-05-16 분리 패턴 도입):**
 *  1. langData (lang/{lang}.json 의 `settings.{field_key}` 영역) — 새 표준 영역
 *  2. cf.i18n[lang] (config.json 의 inline i18n) — 옛 영역 (cms / 일부 system service 보존)
 *  3. raw fallback (cf.placeholder / cf.options[i].label / cf.key)
 *
 * 5 sysmod (browser-scrape / kakao-talk / telegram / firecrawl + 향후 cms) 의 i18n 영역은
 * `system/modules/{name}/lang/{lang}.json` 별도 파일로 이전. locality + 외부 AI 자연 작성 + i18n 통일.
 */
function resolveConfigField(
  cf: ConfigSettingField,
  lang: Lang,
  langData: Record<string, any> | null,
): SettingField {
  // 1순위: lang/{lang}.json 의 settings.{field_key} 영역 (새 표준)
  const langSettings = (langData?.settings as Record<string, any> | undefined) ?? {};
  const langField = langSettings[cf.key] ?? {};

  // 2순위: config.json 의 inline i18n (옛 영역 — cms 등 호환)
  const i18n = cf.i18n ?? {};
  const primary = i18n[lang] ?? {};
  const fallback = i18n['en'] ?? i18n['ko'] ?? {};

  // select options 라벨 — langField.options[i] → primary.options[i] → fallback.options[i] → raw label
  let resolvedOptions = cf.options;
  const hasOptionsI18n =
    Array.isArray(langField.options) || primary.options || fallback.options;
  if (cf.options && hasOptionsI18n) {
    resolvedOptions = cf.options.map((opt, i) => ({
      ...opt,
      label:
        langField.options?.[i] ??
        primary.options?.[i] ??
        fallback.options?.[i] ??
        opt.label,
    }));
  }

  return {
    key: cf.key,
    type: cf.type,
    placeholder:
      langField.placeholder ?? primary.placeholder ?? fallback.placeholder ?? cf.placeholder,
    defaultValue: cf.defaultValue,
    label: langField.label ?? primary.label ?? fallback.label ?? cf.key,
    description: langField.description ?? primary.description ?? fallback.description,
    tab: cf.tab,
    group: langField.group ?? primary.group ?? fallback.group ?? cf.group,
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
 * 모듈 ↔ system service alias — 옛 이름으로 호출되어도 새 service 의 config/lang 로 dispatch.
 *
 * 'seo' 옛 모듈명 → 'cms' service (2026-04-28 SEO → CMS rename 호환).
 * 추가 alias 가 생길 때 이 매핑만 늘리면 됨.
 */
const MODULE_NAME_ALIASES: Record<string, string> = {
  seo: 'cms',
};

/**
 * config.json `secrets` 항목 — string (옛) | object (MODULE_BIBLE 제4장 일반화).
 * object 형태: { name, type?: 'key'|'token', lifetimeSec?, refreshFrom? }
 */
type SecretEntry = string | { name: string; type?: 'key' | 'token'; lifetimeSec?: number; refreshFrom?: string };

interface ParsedSecret {
  name: string;
  kind: 'key' | 'token';
}

function parseSecretEntries(secrets: SecretEntry[] | undefined): ParsedSecret[] {
  if (!Array.isArray(secrets)) return [];
  const out: ParsedSecret[] = [];
  for (const entry of secrets) {
    if (typeof entry === 'string') {
      out.push({ name: entry, kind: 'key' });
    } else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      out.push({ name: entry.name, kind: entry.type === 'token' ? 'token' : 'key' });
    }
  }
  return out;
}

/**
 * config.json secrets 배열 → SettingField[] 자동 생성.
 * type='token' (자동 발급 OAuth/cache) 항목은 입력 필드 생성하지 않음 — 사용자 직접 입력 금지.
 * `hiddenNames` 에 포함된 이름 (settings_fields 의 oauth.oauthSecrets) 도 동일하게 제외.
 */
function secretsToFields(secrets: SecretEntry[], hiddenNames: Set<string>): SettingField[] {
  return parseSecretEntries(secrets)
    .filter(s => s.kind !== 'token' && !hiddenNames.has(s.name))
    .map(({ name }) => ({
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
  // a11y — 매 field key 별 stable id 의 base (`${fieldIdBase}-${field.key}`).
  const fieldIdBase = useId();
  // 모듈명 alias resolve — 옛 이름 ('seo') 으로 호출되어도 새 service ('cms') 로 fetch.
  const resolvedName = MODULE_NAME_ALIASES[moduleName] ?? moduleName;
  const [schema, setSchema] = useState<{ title: string; fields: SettingField[] } | null>(null);
  const [langData, setLangData] = useState<Record<string, any> | null>(null);
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

  // 초기 로드 — config.json + settings + lang/{lang}.json 동시 조회.
  // lang 변경 시 schema 재계산 (lang 별 label/description 다시 resolve).
  useEffect(() => {
    setLoading(true);
    apiGet<{ success: boolean; settings?: Record<string, unknown>; config?: Record<string, unknown> | null; lang?: Record<string, any> | null }>(
      `/api/settings/modules?name=${encodeURIComponent(resolvedName)}&lang=${encodeURIComponent(lang)}`,
      { category: 'system-module' },
    )
      .then(data => {
        if (data.success) {
          // config.json에서 secrets 자동 생성
          const config = data.config as Record<string, unknown> | null;
          const fetchedLang = data.lang ?? null;
          setLangData(fetchedLang);
          const configSecrets = (config?.secrets as SecretEntry[] | undefined) ?? [];

          // 옵션 C — config.json 의 settings_fields 우선 (모듈 자기완결 i18n).
          // 2026-05-16: lang/{lang}.json 의 settings.{field_key} 영역 우선 + config.json inline i18n 폴백.
          const configSettingsFields = (config?.settings_fields as ConfigSettingField[] | undefined) ?? [];
          const configFields = configSettingsFields.map(cf => resolveConfigField(cf, lang, fetchedLang));

          // OAuth 가 자동 발급 관리하는 secret 이름 수집 — 자동 입력 필드 노출 차단.
          // (옛 형태: secrets 안 type 미명시 + settings_fields 의 oauth.oauthSecrets 에 들어있는 항목.)
          const oauthManagedNames = new Set<string>();
          for (const cf of configFields) {
            if (cf.type === 'oauth' && Array.isArray(cf.oauthSecrets)) {
              for (const s of cf.oauthSecrets) oauthManagedNames.add(s);
            }
          }
          const autoFields = secretsToFields(configSecrets, oauthManagedNames);

          const allFields = [...autoFields, ...configFields];
          // title — lang/{lang}.json 의 'title' 키 우선 (mcp-server-app / mcp-server-llm 등) → 옛 alias 입력값 → resolved 모듈명
          const title = (fetchedLang?.title as string | undefined) || moduleName;
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
      const data = await apiGet<{ success: boolean; secrets?: { name: string; hasValue: boolean }[] }>(
        '/api/vault/secrets',
        { category: 'system-module' },
      );
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
    } catch (e) { logger.debug('system-module', 'operation 실패', { error: e }); }
  }, [schema]);

  useEffect(() => { loadSecretsAndOauth(); }, [loadSecretsAndOauth]);

  const handleSaveSecret = async (field: SettingField) => {
    if (!field.secretName) return;
    const value = secretValues[field.key];
    if (!value?.trim()) return;
    setSecretSaving(prev => ({ ...prev, [field.key]: true }));
    try {
      await apiPost('/api/vault/secrets', { name: field.secretName, value }, { category: 'system-module' });
      setSecretSaved(prev => ({ ...prev, [field.key]: true }));
      setSecretValues(prev => ({ ...prev, [field.key]: '' }));
    } catch (e) { logger.debug('system-module', 'operation 실패', { error: e }); }
    finally { setSecretSaving(prev => ({ ...prev, [field.key]: false })); }
  };

  const handleChange = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await apiPatch<{ success: boolean }>(
        '/api/settings/modules',
        { name: resolvedName, settings },
        { category: 'system-module' },
      );
      if (data.success) setSaved(true);
    } catch (e) { logger.debug('system-module', 'operation 실패', { error: e }); }
    finally { setSaving(false); }
  };

  // ── MCP 서버 커스텀 상태 ──────────────────────────────────────────────────
  const [mcpTokenInfo, setMcpTokenInfo] = useState<{ exists: boolean; hint: string | null; createdAt: string | null }>({ exists: false, hint: null, createdAt: null });
  const [mcpTokenRaw, setMcpTokenRaw] = useState<string | null>(null);
  const [mcpTokenLoading, setMcpTokenLoading] = useState(false);
  const [mcpTokenCopied, setMcpTokenCopied] = useState(false);
  const [mcpJsonTab, setMcpJsonTab] = useState<'api' | 'stdio'>('api');
  const [mcpJsonCopied, setMcpJsonCopied] = useState(false);
  const [mcpWebUrlCopied, setMcpWebUrlCopied] = useState(false);

  // 서비스별 엔드포인트 매핑 (app=외부용, llm=내부용)
  const isMcpApp = resolvedName === 'mcp-server-app';
  const isMcpLlm = resolvedName === 'mcp-server-llm';
  const isHub = resolvedName === 'hub';

  // hub service — 옛 사이드바 별도 탭 폐기. 시스템 탭 안에 통합 — modal 안 HubPanel
  // 직접 render. settings_fields 사용 X (인스턴스 N + 위젯 코드 + 대화 내역 등 복잡 UI).
  if (isHub) {
    return (
      <div className={embeddedInPage ? 'flex flex-col h-full bg-white overflow-hidden' : 'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden'}>
        <div className={embeddedInPage ? 'flex flex-col h-full w-full overflow-hidden' : 'bg-white w-full sm:max-w-3xl sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[80vh] sm:h-[85vh]'}>
          {!embeddedInPage && (
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-100 bg-slate-50 shrink-0">
              <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
                {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
                Hub
              </h2>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-hidden">
            <HubPanel />
          </div>
        </div>
      </div>
    );
  }
  const mcpTokenEndpoint = isMcpLlm ? '/api/mcp-internal/token' : '/api/mcp/tokens';
  const mcpServerPath = isMcpLlm ? '/api/mcp-internal' : '/api/mcp';

  useEffect(() => {
    if (!isMcpApp && !isMcpLlm) return;
    apiGet<{
      success: boolean;
      exists?: boolean;
      hint?: string | null;
      createdAt?: string | null;
      token?: { hasToken?: boolean; masked?: string | null };
    }>(mcpTokenEndpoint, { category: 'mcp-token' })
      .then(data => {
        if (data.success) {
          if (isMcpLlm) {
            setMcpTokenInfo({ exists: data.token?.hasToken ?? false, hint: data.token?.masked ?? null, createdAt: data.createdAt ?? null });
          } else {
            setMcpTokenInfo({ exists: data.exists ?? false, hint: data.hint ?? null, createdAt: data.createdAt ?? null });
          }
        }
      })
      .catch(() => {});
  }, [moduleName, isMcpApp, isMcpLlm, mcpTokenEndpoint]);

  const generateMcpToken = async () => {
    if (mcpTokenInfo.exists && !await confirmDialog({ title: t('system_modules.common.token_regenerate_title'), message: t('system_modules.common.token_regenerate_message'), danger: true, okLabel: t('system_modules.common.token_regenerate_ok') })) return;
    setMcpTokenLoading(true);
    try {
      const data = await apiPost<{ success: boolean; token?: string; hint?: string; createdAt?: string }>(
        mcpTokenEndpoint,
        undefined,
        { category: 'mcp-token' },
      );
      if (data.success && data.token) {
        setMcpTokenRaw(data.token);
        const hint = isMcpLlm
          ? `${data.token.slice(0, 8)}****${data.token.slice(-4)}`
          : (data.hint ?? null);
        setMcpTokenInfo({ exists: true, hint, createdAt: data.createdAt ?? null });
      }
    } catch (e) { logger.debug('system-module', 'operation 실패', { error: e }); } finally { setMcpTokenLoading(false); }
  };

  const revokeMcpToken = async () => {
    if (!await confirmDialog({ title: t('system_modules.common.token_revoke_title'), message: t('system_modules.common.token_revoke_message'), danger: true, okLabel: t('system_modules.common.token_revoke_ok') })) return;
    await apiDelete(mcpTokenEndpoint, { category: 'mcp-token' });
    setMcpTokenInfo({ exists: false, hint: null, createdAt: null });
    setMcpTokenRaw(null);
  };

  const copyToClipboard = async (text: string, setCopied: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── MCP 서버 커스텀 렌더링 (외부 도구 연결 / LLM 통신용 공용) ─────────────────
  if (isMcpApp || isMcpLlm) {
    // title / description = system/services/mcp-server-{app,llm}/lang/{lang}.json 에서 lookup.
    // 옛 system_modules.common.mcp_*_title/desc i18n 영역은 폐기.
    const titleText = (langData?.title as string | undefined) ?? (isMcpLlm ? 'Firebat MCP Server (for LLMs)' : 'Firebat MCP Server (external tools)');
    const descText = (langData?.description as string | undefined) ?? '';
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

                    {/* Claude.ai 웹 커스텀 커넥터 — 웹 커넥터 폼은 URL+OAuth(선택)만 받고 헤더 칸이 없어
                        토큰을 URL(?token=)에 실어야 붙는다. Rust verify_token 의 쿼리 fallback 과 짝. */}
                    {isMcpApp && (
                      <div className="border-t border-slate-200 pt-2.5 flex flex-col gap-1.5">
                        <p className="text-[11px] sm:text-[12px] font-bold text-slate-600">{t('system_modules.common.mcp_web_connector_title')}</p>
                        <p className="text-[10px] sm:text-[11px] text-slate-500 leading-relaxed">{t('system_modules.common.mcp_web_connector_desc')}</p>
                        <div className="flex items-center gap-1.5">
                          <code className="flex-1 text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded px-2 py-1 overflow-x-auto whitespace-nowrap">{`${sseUrl}?token=${tokenValue}`}</code>
                          <Tooltip label={t('system_modules.common.copy')}>
                            <button onClick={() => copyToClipboard(`${sseUrl}?token=${tokenValue}`, setMcpWebUrlCopied)} className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors">
                              {mcpWebUrlCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                            </button>
                          </Tooltip>
                        </div>
                        <p className="text-[10px] sm:text-[11px] text-amber-600 leading-relaxed">{t('system_modules.common.mcp_web_connector_warning')}</p>
                      </div>
                    )}
                  </div>
                );
              })()}

              {mcpJsonTab === 'stdio' && (() => {
                const jsonConfig = JSON.stringify({
                  mcpServers: { firebat: { command: 'ssh', args: ['-i', '<SSH_KEY_PATH>', '<USER>@<SERVER_IP>', 'firebat-core --mcp-stdio'] } },
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
          {/* 패키지 상태 — settings 필드 없는 sysmod 도 packages 있을 수 있음 (예: yfinance) */}
          <PackageStatusSection moduleName={resolvedName} />
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

        {/* 패키지 상태 — config.json packages 설정된 sysmod (yfinance / playwright 등) 만 표시 */}
        <PackageStatusSection moduleName={resolvedName} />

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
            {activeTab === 'OG' && resolvedName === 'cms' && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs sm:text-sm font-bold text-slate-700">{t('system_modules.common.og_preview')}</span>
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
                    <label className="text-xs sm:text-sm font-bold text-slate-700" htmlFor={`${fieldIdBase}-${field.key}`}>{localize(t, field.label)}</label>
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
                          id={`${fieldIdBase}-${field.key}`}
                          name={field.key}
                          type="password"
                          value={secretValues[field.key] ?? ''}
                          onChange={e => setSecretValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                          autoComplete="new-password"
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
                    <span className="text-xs sm:text-sm font-bold text-slate-700">{localize(t, field.label)}</span>
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
                    langData={langData}
                  />
                ) : field.type === 'widget-list' ? (
                  <WidgetListField
                    label={localize(t, field.label)}
                    description={localize(t, field.description)}
                    area={(field.widgetArea ?? 'sidebar') as 'header' | 'sidebar' | 'footer'}
                    value={Array.isArray(settings[field.key]) ? settings[field.key] : undefined}
                    onChange={(next) => handleChange(field.key, next)}
                    langData={langData}
                  />
                ) : field.type === 'select' ? (
                  <>
                    <label className="text-xs sm:text-sm font-bold text-slate-700" htmlFor={`${fieldIdBase}-${field.key}`}>{localize(t, field.label)}</label>
                    <select
                      value={settings[field.key] ?? field.defaultValue ?? ''}
                      onChange={e => handleChange(field.key, e.target.value)}
                      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name={field.key} id={`${fieldIdBase}-${field.key}`}
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
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs sm:text-sm font-bold text-slate-700">{localize(t, field.label)}</span>
                      {field.description && (
                        <p className="text-[10px] sm:text-xs text-slate-400 font-medium mt-0.5">{localize(t, field.description)}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!settings[field.key]}
                      aria-label={localize(t, field.label)}
                      onClick={() => handleChange(field.key, !settings[field.key])}
                      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${settings[field.key] ? 'bg-blue-500' : 'bg-slate-300'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${settings[field.key] ? 'translate-x-5' : ''}`} />
                    </button>
                  </div>
                ) : (
                  <>
                    <label className="text-xs sm:text-sm font-bold text-slate-700" htmlFor={`${fieldIdBase}-${field.key}`}>{localize(t, field.label)}</label>
                    {field.type === 'textarea' ? (
                      <textarea
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        rows={4}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono resize-y" name={field.key} autoComplete="off" id={`${fieldIdBase}-${field.key}`}
                      />
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                        placeholder={field.placeholder}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500" name={field.key} autoComplete="off" id={`${fieldIdBase}-${field.key}`}
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
            {resolvedName === 'telegram' && <TelegramWebhookSection />}
            </>
          )}
        </div>

        {/* 하단 버튼 */}
        {(() => {
          const hasNonSecretFields = schema?.fields.some(f => f.type !== 'secret' && f.type !== 'oauth');
          return (
            <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex items-center justify-end shrink-0">
              <div className="flex gap-2 sm:gap-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors"
                >
                  {t('system_modules.common.close')}
                </button>
                {hasNonSecretFields && (
                  <SaveButton
                    size="md"
                    state={(saving ? 'saving' : saved ? 'saved' : 'idle') as SaveButtonState}
                    onClick={handleSave}
                  />
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
      <span className="text-xs sm:text-sm font-bold text-slate-700">{label}</span>
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
// langKey = service.cms.color_overrides.{X} (cms 의 lang/{lang}.json 안 color_overrides 영역).
// fallback = 영문 라벨 (lang lookup 실패 시 마지막 안전 표시).
const COLOR_OVERRIDE_FIELDS: Array<{
  key: string;
  langKey: string;
  fallback: string;
  defaultPresetKey: keyof (typeof COLOR_PRESETS)['slate-pro']['colors'];
}> = [
  { key: 'themeColor_primary',   langKey: 'primary',    fallback: 'Primary color',     defaultPresetKey: 'primary' },
  { key: 'themeColor_accent',    langKey: 'accent',     fallback: 'Accent color',      defaultPresetKey: 'accent' },
  { key: 'themeColor_up',        langKey: 'up',         fallback: 'Up color',          defaultPresetKey: 'up' },
  { key: 'themeColor_down',      langKey: 'down',       fallback: 'Down color',        defaultPresetKey: 'down' },
  { key: 'themeColor_text',      langKey: 'text',       fallback: 'Body text',         defaultPresetKey: 'text' },
  { key: 'themeColor_textMuted', langKey: 'text_muted', fallback: 'Muted text',        defaultPresetKey: 'textMuted' },
  { key: 'themeColor_bg',        langKey: 'bg',         fallback: 'Page background',   defaultPresetKey: 'bg' },
  { key: 'themeColor_bgCard',    langKey: 'bg_card',    fallback: 'Card background',   defaultPresetKey: 'bgCard' },
  { key: 'themeColor_border',    langKey: 'border',     fallback: 'Border',            defaultPresetKey: 'border' },
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

function ColorOverridesField({ label, description, settings, presetKey, onChange, langData }: {
  label: string;
  description?: string;
  settings: Record<string, any>;
  presetKey: string;
  onChange: (key: string, value: string) => void;
  langData: Record<string, any> | null;
}) {
  const t = useTranslations();
  const colorIdBase = useId();
  const preset = COLOR_PRESETS[presetKey] ?? COLOR_PRESETS['slate-pro'];
  // 색 라벨 lookup — service.cms.color_overrides.{X}. lookup miss 시 fallback (영문) 표시.
  const colorLangArea = (langData?.color_overrides as Record<string, string> | undefined) ?? {};
  const resetAll = () => {
    for (const f of COLOR_OVERRIDE_FIELDS) onChange(f.key, '');
  };
  const hasAnyOverride = COLOR_OVERRIDE_FIELDS.some(f => settings[f.key]);
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs sm:text-sm font-bold text-slate-700">{label}</span>
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
                    aria-label={`${colorLangArea[f.langKey] ?? f.fallback} 색상 선택`}
                    className="absolute inset-0 w-full h-full cursor-pointer border-0 p-0 opacity-0" name={`color-${f.key}`} autoComplete="off" id={`${colorIdBase}-color-${f.key}`}
                  />
                  <div
                    className="absolute inset-0"
                    style={{ background: formatColorValue(displayHex, displayAlpha) }}
                  />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-bold text-slate-600 truncate">{colorLangArea[f.langKey] ?? f.fallback}</p>
                <input
                  type="text"
                  value={overrideValue}
                  onChange={e => handleTextChange(e.target.value)}
                  placeholder={presetValue}
                  aria-label={`${colorLangArea[f.langKey] ?? f.fallback} 색상 값`}
                  className={`w-full text-[10px] font-mono border-0 bg-transparent focus:outline-none ${isOverridden ? 'text-slate-700' : 'text-slate-400'}`} name={`override-${f.key}`} autoComplete="off" id={`${colorIdBase}-override-${f.key}`}
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
                    aria-label={t('system_modules.common.alpha_label')} name={`alpha-${f.key}`} autoComplete="off" id={`${colorIdBase}-alpha-${f.key}`}
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
  const baseId = useId();
  const addItem = () => onChange([...value, { filename: '', content: '' }]);
  const removeItem = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const updateItem = (i: number, patch: Partial<{ filename: string; content: string }>) => {
    onChange(value.map((item, idx) => idx === i ? { ...item, ...patch } : item));
  };
  return (
    <>
      <span className="text-xs sm:text-sm font-bold text-slate-700">{label}</span>
      {description && (
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{description}</p>
      )}
      <div className="flex flex-col gap-2 mt-1">
        {value.length === 0 && (
          <p className="text-xs text-slate-400 italic py-2 text-center bg-slate-50 border border-dashed border-slate-200 rounded-lg">
            {t('system_modules.common.verifications_empty')}
          </p>
        )}
        {value.map((item, i) => {
          const filenameId = `${baseId}-filename-${i}`;
          const contentId = `${baseId}-content-${i}`;
          return (
          <div key={i} className="flex flex-col gap-1.5 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={item.filename}
                onChange={e => updateItem(i, { filename: e.target.value })}
                placeholder={t('system_modules.common.verifications_filename_placeholder')}
                aria-label={t('system_modules.common.verifications_filename_placeholder')}
                className="flex-1 px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" name="filename" autoComplete="off" id={filenameId}
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
              aria-label={t('system_modules.common.verifications_content_placeholder')}
              rows={3}
              className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-y" name="content" autoComplete="off" id={contentId}
            />
          </div>
          );
        })}
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

// ── Sysmod 패키지 상태 영역 ──────────────────────────────────────────────────
// silent install 폐기 (2026-05-16) — 매 sysmod 호출 시점 자동 install 폐기 + 설정 화면 명시 trigger.
// 매 패키지 install = background spawn (heavy/light 구분 없음) + StatusManager job 등록.
// 설정 화면 닫혀도 작업 계속 진행, 다시 열면 진행 상태 표시 (usePolling 2s).
interface PackageStatusItem {
  name: string;
  status: 'installed' | 'missing' | 'in_progress' | 'failed';
  jobId?: string;
  error?: string;
  installedVersion?: string;
  requiredVersion?: string;
  latestVersion?: string;
  upgradeAvailable?: boolean;
}

export function PackageStatusSection({ moduleName }: { moduleName: string }) {
  const [packages, setPackages] = useState<PackageStatusItem[] | null>(null);
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet<{ success: boolean; packages?: PackageStatusItem[] }>(
        `/api/settings/modules/packages?module=${encodeURIComponent(moduleName)}`,
        { category: 'system-module' },
      );
      if (data.success) setPackages(data.packages ?? []);
    } catch (e) {
      logger.debug('settings', 'package status 조회 실패', { error: e });
    }
  }, [moduleName]);

  // 2s polling — 진행 중 패키지 있을 때만 의미. 없어도 부담 작음.
  usePolling({ interval: 2000, onTick: fetchStatus, enabled: true });

  const triggerInstall = useCallback(async (upgrade: boolean) => {
    setInstalling(true);
    setFeedback(null);
    try {
      const data = await apiPost<{ success: boolean; jobIds?: string[]; error?: string }>(
        '/api/settings/modules/packages',
        { module: moduleName, upgrade },
        { category: 'system-module' },
      );
      if (data.success) {
        const count = data.jobIds?.length ?? 0;
        setFeedback(count === 0 ? '대상 패키지가 없습니다.' : `${count}개 패키지 작업을 시작했습니다.`);
        await fetchStatus();
      } else {
        setFeedback(data.error ?? '요청에 실패했습니다.');
      }
    } catch (e) {
      logger.debug('settings', 'install trigger 실패', { error: e });
      setFeedback('요청에 실패했습니다.');
    } finally {
      setInstalling(false);
      setTimeout(() => setFeedback(null), 3000);
    }
  }, [moduleName, fetchStatus]);

  // packages === null = 아직 첫 fetch 전 (skeleton 표시 X — 자연 idle).
  // packages === [] = config.json packages 미설정 — 컴포넌트 자체 표시 안 함.
  if (!packages || packages.length === 0) return null;

  const missing = packages.filter(p => p.status === 'missing').length;
  const inProgress = packages.filter(p => p.status === 'in_progress').length;
  const installed = packages.filter(p => p.status === 'installed').length;
  const failed = packages.filter(p => p.status === 'failed').length;

  return (
    <div className="px-4 sm:px-6 py-3 border-b border-slate-100 bg-slate-50/60">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-600">
          <Package size={13} className="text-indigo-500" />
          패키지
          <span className="text-[11px] font-medium text-slate-400">
            ({installed} 설치됨{missing > 0 ? ` · ${missing} 미설치` : ''}{inProgress > 0 ? ` · ${inProgress} 진행 중` : ''}{failed > 0 ? ` · ${failed} 실패` : ''})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {missing > 0 && (
            <button
              onClick={() => triggerInstall(false)}
              disabled={installing || inProgress > 0}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-slate-300"
            >
              <Download size={11} /> 설치
            </button>
          )}
          {packages.some(p => p.upgradeAvailable) && (
            <button
              onClick={() => triggerInstall(true)}
              disabled={installing || inProgress > 0}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} /> 업그레이드
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {packages.map(pkg => {
          const badgeClass =
            pkg.status === 'installed' ? 'bg-emerald-100 text-emerald-700' :
            pkg.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
            pkg.status === 'failed' ? 'bg-red-100 text-red-700' :
            'bg-slate-200 text-slate-600';
          const label =
            pkg.status === 'installed' ? '설치됨' :
            pkg.status === 'in_progress' ? '설치 중' :
            pkg.status === 'failed' ? '실패' :
            '미설치';
          return (
            <Tooltip key={pkg.name} label={pkg.error ?? label}>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${badgeClass}`}>
                {pkg.status === 'in_progress' && <Loader2 size={10} className="animate-spin" />}
                {pkg.status === 'failed' && <AlertCircle size={10} />}
                {pkg.name}
                <span className="opacity-60">· {label}</span>
              </span>
            </Tooltip>
          );
        })}
      </div>
      {feedback && (
        <p className="text-[11px] text-slate-500 italic mt-2">{feedback}</p>
      )}
    </div>
  );
}
