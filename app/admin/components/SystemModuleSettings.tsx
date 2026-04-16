'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Blocks, Save, Loader2, CheckCircle2, LinkIcon, Unlink, RefreshCw, Copy, Check, Globe, Terminal, Server, Image, FileText, Code, Settings2, ExternalLink, ArrowLeft } from 'lucide-react';

// ── 모듈별 설정 스키마 정의 ──────────────────────────────────────────────────
type FieldType = 'text' | 'number' | 'toggle' | 'textarea' | 'oauth' | 'secret';
interface SettingField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  description?: string;
  defaultValue?: any;
  tab?: string;              // 탭 그룹 (없으면 기본 탭)
  oauthUrl?: string;        // oauth 타입 전용: 인증 시작 URL
  oauthSecrets?: string[];  // oauth 타입 전용: 연동 상태 확인용 시크릿 키
  secretName?: string;      // secret 타입 전용: Vault에 저장할 시크릿 키 이름
}

// 탭 정의 (아이콘 + 라벨)
const TAB_META: Record<string, { label: string; icon: typeof Globe }> = {
  '일반': { label: '일반', icon: Settings2 },
  'SEO': { label: 'SEO', icon: Globe },
  'OG': { label: 'OG 이미지', icon: Image },
  '스크립트': { label: '스크립트', icon: Code },
};

// 모듈별 설정 필드 정의 — 새 모듈 추가 시 여기에 등록
const MODULE_SETTINGS_SCHEMA: Record<string, { title: string; fields: SettingField[] }> = {
  'browser-scrape': {
    title: 'Playwright 웹 스크래퍼',
    fields: [
      { key: 'timeout', label: '타임아웃 (ms)', type: 'number', placeholder: '30000', description: '페이지 로딩 제한 시간', defaultValue: 30000 },
      { key: 'headless', label: 'Headless 모드', type: 'toggle', description: '브라우저 UI 없이 실행', defaultValue: true },
      { key: 'maxTextLength', label: '최대 텍스트 길이', type: 'number', placeholder: '50000', description: '추출 텍스트 최대 글자 수', defaultValue: 50000 },
    ],
  },
  'kakao-talk': {
    title: '카카오톡 메시지',
    fields: [
      { key: 'kakaoRestApiKey', label: 'REST API 키', type: 'secret', secretName: 'KAKAO_REST_API_KEY', placeholder: '카카오 디벨로퍼스 → 앱 키', description: '카카오 앱의 REST API 키' },
      { key: 'kakaoClientSecret', label: '클라이언트 시크릿', type: 'secret', secretName: 'KAKAO_CLIENT_SECRET', placeholder: '카카오 로그인 → 보안', description: '클라이언트 시크릿 코드 (활성화한 경우)' },
      { key: 'kakaoOAuth', label: '카카오 계정 연동', type: 'oauth', oauthUrl: '/api/auth/kakao', oauthSecrets: ['KAKAO_ACCESS_TOKEN'], description: '위 키 등록 후 연동하면 액세스 토큰이 자동 발급됩니다.' },
      { key: 'defaultType', label: '기본 메시지 타입', type: 'text', placeholder: 'text', description: 'text | feed | list (기본: text)', defaultValue: 'text' },
    ],
  },
  'firecrawl': {
    title: 'Firecrawl 웹 스크래퍼',
    fields: [
      { key: 'firecrawlApiKey', label: 'API 키', type: 'secret', secretName: 'FIRECRAWL_API_KEY', placeholder: 'fc-...', description: 'firecrawl.dev에서 발급받은 API 키' },
      { key: 'maxTextLength', label: '최대 텍스트 길이', type: 'number', placeholder: '30000', description: '마크다운 결과 최대 글자 수', defaultValue: 30000 },
    ],
  },
  'naver-search': {
    title: '네이버 검색 API',
    fields: [
      { key: 'naverClientId', label: 'Client ID', type: 'secret', secretName: 'NAVER_CLIENT_ID', placeholder: '네이버 개발자센터 → 앱 → Client ID', description: '네이버 검색 API Client ID' },
      { key: 'naverClientSecret', label: 'Client Secret', type: 'secret', secretName: 'NAVER_CLIENT_SECRET', placeholder: '네이버 개발자센터 → 앱 → Client Secret', description: '네이버 검색 API Client Secret' },
    ],
  },
  'naver-ads': {
    title: '네이버 광고 키워드 도구',
    fields: [
      { key: 'naverAdLicenseKey', label: 'License 키', type: 'secret', secretName: 'NAVER_AD_LICENSE_KEY', placeholder: '네이버 검색광고 → API 사용 관리', description: 'API License Key (액세스라이선스)' },
      { key: 'naverAdSecretKey', label: 'Secret 키', type: 'secret', secretName: 'NAVER_AD_SECRET_KEY', placeholder: 'HMAC 서명에 사용', description: 'API Secret Key' },
      { key: 'naverAdCustomerId', label: 'Customer ID', type: 'secret', secretName: 'NAVER_AD_CUSTOMER_ID', placeholder: '광고주 ID (숫자)', description: '네이버 검색광고 고객 ID' },
    ],
  },
  'kiwoom': {
    title: '키움증권 REST API',
    fields: [
      { key: 'kiwoomAppKey', label: 'App Key', type: 'secret', secretName: 'KIWOOM_APP_KEY', placeholder: '키움 Open API → 앱 등록', description: '키움증권 API App Key' },
      { key: 'kiwoomAppSecret', label: 'App Secret', type: 'secret', secretName: 'KIWOOM_APP_SECRET', placeholder: '키움 Open API → 앱 등록', description: '키움증권 API App Secret' },
    ],
  },
  'korea-invest': {
    title: '한국투자증권 Open API',
    fields: [
      { key: 'kisAppKey', label: 'App Key', type: 'secret', secretName: 'KIS_APP_KEY', placeholder: '한투 API 포털 → 앱 등록', description: '한국투자증권 API App Key' },
      { key: 'kisAppSecret', label: 'App Secret', type: 'secret', secretName: 'KIS_APP_SECRET', placeholder: '한투 API 포털 → 앱 등록', description: '한국투자증권 API App Secret' },
    ],
  },
  'law-search': {
    title: '국가법령정보 Open API',
    fields: [
      { key: 'lawApiOc', label: 'API 인증값 (OC)', type: 'secret', secretName: 'LAW_API_OC', placeholder: 'open.law.go.kr → 마이페이지 → 인증값', description: '국가법령정보 공동활용 API 인증값' },
    ],
  },
  'mcp-server': {
    title: 'Firebat MCP 서버',
    fields: [],  // MCP 서버는 커스텀 렌더링 (토큰 관리 + JSON 설정)
  },
  'seo': {
    title: 'SEO 설정',
    fields: [
      // 일반 탭 — placeholder는 힌트용, 빈 값이면 백엔드에서 기본값 적용
      { key: 'siteTitle', label: '사이트 제목', type: 'text', tab: '일반', placeholder: 'Firebat', description: 'SEO 기본 사이트 제목 (OG, RSS, Sitemap 등에 사용)' },
      { key: 'siteDescription', label: '사이트 설명', type: 'text', tab: '일반', placeholder: 'Just Imagine. Firebat Runs.', description: 'SEO 기본 사이트 설명' },
      { key: 'siteUrl', label: '사이트 URL', type: 'text', tab: '일반', placeholder: 'https://firebat.co.kr', description: 'JSON-LD, Sitemap 등에 사용되는 기본 URL' },
      { key: 'jsonLdEnabled', label: 'JSON-LD 구조화 데이터', type: 'toggle', tab: '일반', description: 'WebSite + Organization 스키마 자동 삽입', defaultValue: true },
      { key: 'jsonLdOrganization', label: '조직/브랜드명', type: 'text', tab: '일반', placeholder: 'Firebat', description: 'JSON-LD Organization name' },
      { key: 'jsonLdLogoUrl', label: '로고 URL', type: 'text', tab: '일반', placeholder: 'https://firebat.co.kr/icon.svg', description: 'JSON-LD Organization 로고 이미지 URL' },
      // SEO 탭
      { key: 'sitemapEnabled', label: 'Sitemap 생성', type: 'toggle', tab: 'SEO', description: '/sitemap.xml 자동 생성', defaultValue: true },
      { key: 'rssEnabled', label: 'RSS 피드', type: 'toggle', tab: 'SEO', description: '/feed.xml 자동 생성', defaultValue: true },
      { key: 'robotsTxt', label: 'robots.txt', type: 'textarea', tab: 'SEO', placeholder: 'User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin', description: 'robots.txt 내용', defaultValue: 'User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin' },
      // OG 탭
      { key: 'ogBgColor', label: '배경색', type: 'text', tab: 'OG', placeholder: '#f8fafc', description: 'OG 이미지 배경색 (HEX)' },
      { key: 'ogAccentColor', label: '강조색', type: 'text', tab: 'OG', placeholder: '#2563eb', description: '상단 라인, 로고 테두리 색상' },
      { key: 'ogDomain', label: '도메인 표시', type: 'text', tab: 'OG', placeholder: 'firebat.co.kr', description: 'OG 이미지 우하단 도메인 텍스트' },
      // 스크립트 탭
      { key: 'headScripts', label: '<head> 스크립트', type: 'textarea', tab: '스크립트', placeholder: '<!-- Google Analytics 등 -->', description: '모든 페이지 <head>에 삽입할 HTML' },
      { key: 'bodyScripts', label: '</body> 스크립트', type: 'textarea', tab: '스크립트', placeholder: '<!-- 채팅 위젯 등 -->', description: '모든 페이지 </body> 앞에 삽입할 HTML' },
    ],
  },
};

interface Props {
  moduleName: string;
  onClose: () => void;
  onBack?: () => void;
}

export function SystemModuleSettings({ moduleName, onClose, onBack }: Props) {
  const schema = MODULE_SETTINGS_SCHEMA[moduleName];
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

  // 초기 로드
  useEffect(() => {
    setLoading(true);
    fetch(`/api/settings/modules?name=${encodeURIComponent(moduleName)}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          // 기본값과 저장된 값 병합
          const merged: Record<string, any> = {};
          if (schema) {
            for (const field of schema.fields) {
              merged[field.key] = field.defaultValue ?? '';
            }
          }
          // 저장된 값 병합 (빈 문자열도 유효한 저장값으로 표시)
          const saved = data.settings ?? {};
          for (const [key, val] of Object.entries(saved)) {
            if (val !== null && val !== undefined) {
              merged[key] = val;
            }
          }
          setSettings(merged);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [moduleName, schema]);

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

  useEffect(() => {
    if (moduleName !== 'mcp-server') return;
    fetch('/api/mcp/tokens').then(r => r.json()).then(data => {
      if (data.success) setMcpTokenInfo({ exists: data.exists, hint: data.hint, createdAt: data.createdAt });
    }).catch(() => {});
  }, [moduleName]);

  const generateMcpToken = async () => {
    if (mcpTokenInfo.exists && !confirm('기존 토큰이 무효화됩니다. 새 토큰을 생성하시겠습니까?')) return;
    setMcpTokenLoading(true);
    try {
      const res = await fetch('/api/mcp/tokens', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setMcpTokenRaw(data.token);
        setMcpTokenInfo({ exists: true, hint: data.hint, createdAt: data.createdAt });
      }
    } catch {} finally { setMcpTokenLoading(false); }
  };

  const revokeMcpToken = async () => {
    if (!confirm('토큰을 폐기하면 SSE(API) 연결이 즉시 차단됩니다. 계속하시겠습니까?')) return;
    await fetch('/api/mcp/tokens', { method: 'DELETE' });
    setMcpTokenInfo({ exists: false, hint: null, createdAt: null });
    setMcpTokenRaw(null);
  };

  const copyToClipboard = async (text: string, setCopied: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── MCP 서버 커스텀 렌더링 ─────────────────────────────────────────────────
  if (moduleName === 'mcp-server') {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden">
        <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]">
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
              {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
              <Server size={18} className="text-emerald-500" /> Firebat MCP 서버
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
          </div>

          <div className="p-3 sm:p-6 flex flex-col gap-4 overflow-y-scroll flex-1 min-h-0">
            <p className="text-[11px] sm:text-[12px] text-slate-400">
              외부 AI 도구(Claude Code, Cursor, VS Code 등)에서 이 파이어뱃 서버에 연결할 수 있습니다.
            </p>

            {/* JSON 설정 보기 */}
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="flex border-b border-slate-200">
                <button
                  onClick={() => { setMcpJsonTab('api'); setMcpJsonCopied(false); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] sm:text-[12px] font-bold transition-colors ${mcpJsonTab === 'api' ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-500' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <Globe size={12} /> SSE (API)
                </button>
                <button
                  onClick={() => { setMcpJsonTab('stdio'); setMcpJsonCopied(false); }}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] sm:text-[12px] font-bold transition-colors ${mcpJsonTab === 'stdio' ? 'bg-green-50 text-green-700 border-b-2 border-green-500' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  <Terminal size={12} /> stdio (SSH)
                </button>
              </div>

              {mcpJsonTab === 'api' && (() => {
                const sseUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/mcp` : '/api/mcp';
                const tokenValue = mcpTokenRaw || (mcpTokenInfo.exists ? '<생성된 토큰>' : '<토큰을 먼저 생성하세요>');
                const jsonConfig = JSON.stringify({
                  mcpServers: { firebat: { url: sseUrl, headers: { Authorization: `Bearer ${tokenValue}` } } },
                }, null, 2);
                return (
                  <div className="p-3 flex flex-col gap-3">
                    {/* 인증 토큰 */}
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col gap-2 min-h-[60px]">
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] sm:text-[13px] font-bold text-slate-600">인증 토큰</span>
                        <div className="flex items-center gap-1.5">
                          {mcpTokenInfo.exists && (
                            <button onClick={revokeMcpToken} className="text-[10px] sm:text-[11px] px-2 py-0.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors">
                              폐기
                            </button>
                          )}
                          <button
                            onClick={generateMcpToken}
                            disabled={mcpTokenLoading}
                            className="text-[10px] sm:text-[11px] px-2.5 py-1 font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded transition-colors flex items-center gap-1"
                          >
                            {mcpTokenLoading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                            {mcpTokenInfo.exists ? '재생성' : '토큰 생성'}
                          </button>
                        </div>
                      </div>

                      {mcpTokenRaw && (
                        <div className="bg-amber-50 border border-amber-300 rounded-lg p-2.5 flex flex-col gap-1.5">
                          <p className="text-[10px] sm:text-[11px] font-bold text-amber-700">이 토큰은 다시 볼 수 없습니다. 지금 복사하세요.</p>
                          <div className="flex items-center gap-1.5">
                            <code className="flex-1 text-[11px] sm:text-[12px] font-mono bg-white border border-amber-200 rounded px-2 py-1 text-slate-700 break-all select-all">
                              {mcpTokenRaw}
                            </code>
                            <button onClick={() => copyToClipboard(mcpTokenRaw, setMcpTokenCopied)} className="shrink-0 p-1.5 rounded hover:bg-amber-100 transition-colors" title="복사">
                              {mcpTokenCopied ? <Check size={14} className="text-green-600" /> : <Copy size={14} className="text-amber-600" />}
                            </button>
                          </div>
                        </div>
                      )}

                      {mcpTokenInfo.exists && !mcpTokenRaw && (
                        <div className="flex items-center gap-2 text-[11px] sm:text-[12px] text-slate-500">
                          <code className="font-mono bg-white border border-slate-200 rounded px-2 py-0.5 text-slate-600">{mcpTokenInfo.hint}</code>
                          {mcpTokenInfo.createdAt && (
                            <span className="text-slate-400">생성: {new Date(mcpTokenInfo.createdAt).toLocaleDateString('ko-KR')}</span>
                          )}
                        </div>
                      )}

                      {!mcpTokenInfo.exists && !mcpTokenRaw && (
                        <p className="text-[10px] sm:text-[11px] text-slate-400">토큰이 없습니다. SSE(API) 연결을 사용하려면 토큰을 생성하세요.</p>
                      )}
                    </div>

                    {/* JSON 설정 */}
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] sm:text-[11px] text-slate-500">VS Code / Cursor MCP 설정에 아래 JSON을 추가하세요.</p>
                      <button onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)} className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors" title="복사">
                        {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                      </button>
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
                      <p className="text-[10px] sm:text-[11px] text-slate-500">SSH를 통해 서버에 직접 접속하여 실행합니다.</p>
                      <button onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)} className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors" title="복사">
                        {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                      </button>
                    </div>
                    <pre className="text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">{jsonConfig}</pre>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[10px] sm:text-[11px] text-amber-700 flex flex-col gap-1">
                      <p className="font-bold">SSH 키 필수</p>
                      <p>stdio 모드는 서버에 SSH 키가 등록되어 있어야 합니다. 서버 관리자에게 SSH 공개키 등록을 요청하세요.</p>
                      <p className="text-amber-500 mt-0.5">SSH_KEY_PATH, USER, SERVER_IP, firebat 경로를 실제 값으로 변경하세요.</p>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* 하단 */}
          <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex justify-end shrink-0">
            <button onClick={onClose} className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors">
              닫기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 스키마가 없는 모듈 — 기본 정보만 표시
  if (!schema) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden">
        <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]">
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
            <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
              {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
              <Blocks size={18} className="text-indigo-500" /> {moduleName}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
          </div>
          <div className="p-6 text-center text-slate-500 text-sm flex-1 flex items-center justify-center">
            이 모듈에 대한 설정 항목이 아직 정의되지 않았습니다.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/40 backdrop-blur-sm overflow-hidden">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col h-[70vh] sm:h-[80vh]">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-5 border-b border-slate-100 bg-slate-50 shrink-0">
          <h2 className="text-base sm:text-lg font-bold text-slate-800 flex items-center gap-2">
            {onBack && <button onClick={onBack} className="text-slate-400 hover:text-slate-600 transition-colors mr-1"><ArrowLeft size={18} /></button>}
            <Blocks size={18} className="text-indigo-500" /> {schema.title}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors"><X size={22} /></button>
        </div>

        {/* 탭 바 */}
        {hasTabs && (
          <div className="flex border-b border-slate-200 px-3 sm:px-6 shrink-0 bg-white">
            {tabs.map(tab => {
              const meta = TAB_META[tab];
              const Icon = meta?.icon;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-[11px] sm:text-[12px] font-bold transition-colors border-b-2 ${activeTab === tab ? 'text-blue-700 border-blue-500' : 'text-slate-400 border-transparent hover:text-slate-600'}`}
                >
                  {Icon && <Icon size={13} />} {meta?.label ?? tab}
                </button>
              );
            })}
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
            {activeTab === 'OG' && moduleName === 'seo' && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs sm:text-sm font-bold text-slate-700">미리보기</label>
                  <a
                    href="/api/og"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] sm:text-[11px] text-blue-500 hover:text-blue-700 font-bold"
                  >
                    <ExternalLink size={11} /> 원본 보기
                  </a>
                </div>
                <div
                  className="relative rounded-lg border border-slate-200 overflow-hidden shadow-sm"
                  style={{ aspectRatio: '1200/630' }}
                >
                  <img
                    src={`/api/og?_t=${Date.now()}`}
                    alt="OG 미리보기"
                    className="w-full h-full object-cover"
                  />
                </div>
                <p className="text-[10px] text-slate-400">1200×630px · 설정 저장 후 새로고침하면 반영됩니다</p>
              </div>
            )}

            {(hasTabs ? schema.fields.filter(f => (f.tab ?? '기본') === activeTab) : schema.fields).map(field => (
              <div key={field.key} className="flex flex-col gap-1.5 mb-1">
                {field.type === 'secret' ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</label>
                    {secretSaved[field.key] ? (
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex-1">
                          <CheckCircle2 size={15} /> 등록됨
                        </span>
                        <button
                          onClick={() => setSecretSaved(prev => ({ ...prev, [field.key]: false }))}
                          className="px-3 py-2 text-[12px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors shrink-0"
                        >
                          변경
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
                          {secretSaving[field.key] ? <Loader2 size={14} className="animate-spin" /> : '저장'}
                        </button>
                      </div>
                    )}
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{field.description}</p>
                    )}
                  </div>
                ) : field.type === 'oauth' ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</label>
                    <div className="flex items-center gap-2">
                      {oauthStatus[field.key] ? (
                        <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg flex-1">
                          <CheckCircle2 size={15} /> 연동 완료
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-slate-400 text-[13px] font-medium px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg flex-1">
                          <Unlink size={14} /> 미연동
                        </span>
                      )}
                      <button
                        onClick={() => window.open(field.oauthUrl, 'oauth', 'width=500,height=700,left=200,top=100')}
                        className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors shadow-sm shrink-0"
                      >
                        <LinkIcon size={14} /> {oauthStatus[field.key] ? '재연동' : '연동하기'}
                      </button>
                    </div>
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{field.description}</p>
                    )}
                  </div>
                ) : field.type === 'toggle' ? (
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</span>
                      {field.description && (
                        <p className="text-[10px] sm:text-xs text-slate-400 font-medium mt-0.5">{field.description}</p>
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
                    <label className="text-xs sm:text-sm font-bold text-slate-700">{field.label}</label>
                    {field.type === 'textarea' ? (
                      <textarea
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        rows={4}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono resize-y"
                      />
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={settings[field.key] ?? ''}
                        onChange={e => handleChange(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                        placeholder={field.placeholder}
                        className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    )}
                    {field.description && (
                      <p className="text-[10px] sm:text-xs text-slate-400 font-medium">{field.description}</p>
                    )}
                  </>
                )}
              </div>
            ))}
            </>
          )}
        </div>

        {/* 하단 버튼 */}
        <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex items-center justify-between shrink-0">
          <div>
            {saved && (
              <span className="flex items-center gap-1.5 text-emerald-600 text-[13px] font-bold">
                <CheckCircle2 size={15} /> 저장 완료
              </span>
            )}
          </div>
          <div className="flex gap-2 sm:gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors"
            >
              닫기
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shadow-sm"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
