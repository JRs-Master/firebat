'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Settings, X, KeyRound, Plug, Loader2, Trash2, Layers, Pencil, Copy, Check, RefreshCw, Download, Server, Terminal, Globe, Cpu, Wrench, Blocks, ChevronLeft, ChevronRight } from 'lucide-react';
import { GEMINI_MODELS, THINKING_LEVELS, McpServer, getThinkingKind, filterThinkingLevels } from '../types';
import { Field, FieldLabel, HelpText, TextInput, Textarea, SelectInput, SegButtons } from './settings-controls';

interface SystemModule { name: string; description: string; runtime: string; type?: string; enabled?: boolean; }

type Props = {
  isDemo: boolean;
  aiModel: string;
  onAiModelChange: (model: string) => void;
  onClose: () => void;
  onSave: () => void;
  onOpenModuleSettings?: (moduleName: string) => void;
  initialTab?: 'general' | 'ai' | 'secrets' | 'mcp' | 'capabilities' | 'system';
};

export function SettingsModal({ isDemo, aiModel, onAiModelChange, onClose, onSave, onOpenModuleSettings, initialTab }: Props) {
  const [settingsTab, setSettingsTab] = useState<'general' | 'ai' | 'secrets' | 'mcp' | 'capabilities' | 'system'>(initialTab ?? 'general');
  // AI 탭: 모드(일반/Vertex) + 프로바이더(openai/google/anthropic)
  // 현재 aiModel로부터 초기값 자동 유도
  const inferModeProvider = (model: string): { mode: 'general' | 'vertex'; provider: 'openai' | 'google' | 'anthropic' } => {
    if (model.endsWith('-vertex')) return { mode: 'vertex', provider: 'google' };
    if (model.startsWith('gpt-')) return { mode: 'general', provider: 'openai' };
    if (model.startsWith('claude-')) return { mode: 'general', provider: 'anthropic' };
    if (model.startsWith('gemini-')) return { mode: 'general', provider: 'google' };
    return { mode: 'general', provider: 'openai' };
  };
  const _initMp = inferModeProvider(aiModel);
  const [aiMode, setAiMode] = useState<'general' | 'vertex'>(_initMp.mode);
  const [aiProvider, setAiProvider] = useState<'openai' | 'google' | 'anthropic'>(_initMp.provider);
  // aiModel이 외부에서 바뀌면(상위에서 저장값 로드 등) 모드/공급자도 재추론
  useEffect(() => {
    const mp = inferModeProvider(aiModel);
    setAiMode(mp.mode);
    setAiProvider(mp.provider);
  }, [aiModel]);
  const [mcpSubTab, setMcpSubTab] = useState<'app' | 'llm'>('app');
  // 내부 MCP 토큰 (LLM 통신용)
  const [internalMcpToken, setInternalMcpToken] = useState<{ hasToken: boolean; masked: string }>({ hasToken: false, masked: '' });
  const [internalMcpTokenRaw, setInternalMcpTokenRaw] = useState<string | null>(null);
  const [internalMcpCreatedAt, setInternalMcpCreatedAt] = useState<string | null>(null);
  const [internalMcpLoading, setInternalMcpLoading] = useState(false);
  const [internalMcpCopied, setInternalMcpCopied] = useState(false);
  const [internalMcpConfigCopied, setInternalMcpConfigCopied] = useState(false);

  // 일반 설정
  const [userTimezone, setUserTimezone] = useState('Asia/Seoul');
  const [thinkingLevel, setThinkingLevel] = useState('low');

  // Provider API 키 (OpenAI / Google AI Studio / Anthropic / Vertex SA)
  const [geminiApiKey, setGeminiApiKey] = useState(''); // OpenAI (기존 이름 유지)
  const [googleApiKey, setGoogleApiKey] = useState(''); // Gemini AI Studio
  const [anthropicApiKey, setAnthropicApiKey] = useState(''); // Claude
  const [vertexSaJson, setVertexSaJson] = useState(''); // Vertex AI Service Account JSON

  // AI 어시스턴트 라우터 (Self-learning Flash Lite)
  const [aiRouterEnabled, setAiRouterEnabled] = useState(false);
  const [aiRouterModel, setAiRouterModel] = useState('gemini-3-flash-lite');

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
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [secretSaving, setSecretSaving] = useState(false);
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
  const [mcpTestStatus, setMcpTestStatus] = useState<Record<string, { loading: boolean; result?: { success: boolean; tools?: number; error?: string } }>>({});
  const [mcpAuth, setMcpAuth] = useState<{ server: string; step: 'starting' | 'waiting' | 'done' | 'error'; authUrl?: string; error?: string } | null>(null);

  // Firebat MCP 서버 토큰
  const [mcpTokenInfo, setMcpTokenInfo] = useState<{ exists: boolean; hint: string | null; createdAt: string | null }>({ exists: false, hint: null, createdAt: null });
  const [mcpTokenRaw, setMcpTokenRaw] = useState<string | null>(null); // 생성 직후 1회만 표시
  const [mcpTokenLoading, setMcpTokenLoading] = useState(false);
  const [mcpTokenCopied, setMcpTokenCopied] = useState(false);
  const [mcpJsonTab, setMcpJsonTab] = useState<'api' | 'stdio'>('api');
  const [mcpJsonCopied, setMcpJsonCopied] = useState(false);

  // 시스템 모듈
  const [sysModules, setSysModules] = useState<SystemModule[]>([]);
  const fetchSysModules = useCallback(async () => {
    try {
      const res = await fetch('/api/fs/system-modules');
      const data = await res.json();
      if (data.success) setSysModules(data.modules ?? []);
    } catch {}
  }, []);
  const toggleModuleEnabled = useCallback(async (name: string, enabled: boolean) => {
    // 낙관적 UI 업데이트
    setSysModules(prev => prev.map(m => m.name === name ? { ...m, enabled } : m));
    try {
      await fetch('/api/settings/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, enabled }) });
    } catch {
      // 실패 시 롤백
      setSysModules(prev => prev.map(m => m.name === name ? { ...m, enabled: !enabled } : m));
    }
  }, []);

  // ── 데이터 로드 ────────────────────────────────────────────────────────────
  useEffect(() => {
    // 타임존 + thinking level
    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data.success) {
        if (data.timezone) setUserTimezone(data.timezone);
        if (data.aiThinkingLevel) setThinkingLevel(data.aiThinkingLevel);
        if (typeof data.aiRouterEnabled === 'boolean') setAiRouterEnabled(data.aiRouterEnabled);
        if (data.aiRouterModel) setAiRouterModel(data.aiRouterModel);
      }
    }).catch(() => {});

    // Vault 키
    fetch('/api/vault').then(r => r.json()).then(data => {
      if (!data.success) return;
      if (data.keys?.openai_api_key?.hasKey) setGeminiApiKey(data.keys.openai_api_key.maskedKey);
      if (data.keys?.gemini_api_key?.hasKey) setGoogleApiKey(data.keys.gemini_api_key.maskedKey);
      if (data.keys?.anthropic_api_key?.hasKey) setAnthropicApiKey(data.keys.anthropic_api_key.maskedKey);
      if (data.keys?.google_service_account_json?.hasKey) setVertexSaJson(data.keys.google_service_account_json.maskedKey);
    }).catch(() => {});
  }, []);

  // 시크릿
  const fetchSecrets = useCallback(async () => {
    try {
      const res = await fetch('/api/vault/secrets');
      const data = await res.json();
      if (data.success) {
        setUserSecrets(data.secrets ?? []);
        setModuleSecrets(data.moduleSecrets ?? []);
      }
    } catch {}
  }, []);

  const addSecret = async () => {
    if (!newSecretName.trim() || !newSecretValue.trim()) return;
    setSecretSaving(true);
    try {
      const res = await fetch('/api/vault/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSecretName.trim(), value: newSecretValue.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setNewSecretName(''); setNewSecretValue('');
        fetchSecrets();
      }
    } finally { setSecretSaving(false); }
  };

  const saveModuleSecret = async (secretName: string) => {
    const value = moduleSecretValues[secretName]?.trim();
    if (!value) return;
    setModuleSecretSaving(secretName);
    try {
      const res = await fetch('/api/vault/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: secretName, value }),
      });
      const data = await res.json();
      if (data.success) {
        setModuleSecretValues(prev => { const n = { ...prev }; delete n[secretName]; return n; });
        fetchSecrets();
      }
    } finally { setModuleSecretSaving(null); }
  };

  const deleteSecret = async (name: string) => {
    if (!confirm(`"${name}" 키를 삭제하시겠습니까?`)) return;
    await fetch(`/api/vault/secrets?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    fetchSecrets();
  };

  // MCP 서버
  const mcpLoaded = useRef(false);
  const fetchMcpServers = useCallback(async () => {
    if (!mcpLoaded.current) setMcpLoading(true);
    try {
      const res = await fetch('/api/mcp/servers');
      const data = await res.json();
      if (data.success) setMcpServers(data.servers ?? []);
      mcpLoaded.current = true;
    } catch {} finally { setMcpLoading(false); }
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
      const res = await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return;

      setMcpTestStatus(prev => ({ ...prev, [name]: { loading: true } }));
      const testRes = await fetch(`/api/mcp/tools?server=${encodeURIComponent(name)}`);
      const testData = await testRes.json();

      if (testData.success) {
        setMcpTestStatus(prev => ({ ...prev, [name]: { loading: false, result: { success: true, tools: testData.tools?.length ?? 0 } } }));
        setMcpNewName(''); setMcpNewCommand(''); setMcpNewArgs(''); setMcpNewUrl('');
      } else {
        await fetch(`/api/mcp/servers?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
        setMcpTestStatus(prev => ({ ...prev, [name]: { loading: false, result: { success: false, error: testData.error } } }));
        alert(`연결 실패로 등록이 취소되었습니다.\n\n${testData.error}`);
      }
      fetchMcpServers();
    } finally { setMcpSaving(false); }
  };

  const deleteMcpServer = async (name: string) => {
    if (!confirm(`"${name}" MCP 서버를 제거하시겠습니까?`)) return;
    await fetch(`/api/mcp/servers?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    setMcpTestStatus(prev => { const next = { ...prev }; delete next[name]; return next; });
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
      await fetch(`/api/mcp/servers?name=${encodeURIComponent(server.name)}`, { method: 'DELETE' });
      const body: any = { name: server.name, transport: server.transport, enabled: true };
      if (server.transport === 'stdio') {
        body.command = mcpEditCommand.trim();
        body.args = mcpEditArgs.trim() ? mcpEditArgs.trim().split(/\s+/) : [];
      } else {
        body.url = mcpEditUrl.trim();
      }
      await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setMcpEditing(null);
      fetchMcpServers();
    } finally { setMcpEditSaving(false); }
  };

  const startMcpAuth = async (serverName: string) => {
    setMcpAuth({ server: serverName, step: 'starting' });
    try {
      const res = await fetch('/api/mcp/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName }),
      });
      const data = await res.json();
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
              setMcpAuth(prev => prev ? { ...prev, step: 'error', error: '인증 실패' } : null);
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
                  return { ...prev, step: 'error', error: '인증 창이 닫혔습니다. 다시 시도해 주세요.' };
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

  // Firebat MCP 토큰
  const fetchMcpToken = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp/tokens');
      const data = await res.json();
      if (data.success) setMcpTokenInfo({ exists: data.exists, hint: data.hint, createdAt: data.createdAt });
    } catch {}
  }, []);

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

  // 내부 MCP 토큰 (LLM 통신용)
  const fetchInternalMcpToken = useCallback(async () => {
    try {
      const res = await fetch('/api/mcp-internal/token');
      const data = await res.json();
      if (data.success) {
        setInternalMcpToken(data.token);
        setInternalMcpCreatedAt(data.createdAt);
      }
    } catch {}
  }, []);

  const generateInternalMcpToken = async () => {
    if (internalMcpToken.hasToken && !confirm('기존 내부 MCP 토큰이 무효화됩니다. 새로 생성하시겠습니까?')) return;
    setInternalMcpLoading(true);
    try {
      const res = await fetch('/api/mcp-internal/token', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setInternalMcpTokenRaw(data.token);
        setInternalMcpToken({ hasToken: true, masked: `${data.token.slice(0, 8)}****${data.token.slice(-4)}` });
        setInternalMcpCreatedAt(data.createdAt);
      }
    } catch {} finally { setInternalMcpLoading(false); }
  };

  const revokeInternalMcpToken = async () => {
    if (!confirm('내부 MCP 토큰을 폐기하면 OpenAI/Claude API의 연결이 즉시 차단됩니다.')) return;
    await fetch('/api/mcp-internal/token', { method: 'DELETE' });
    setInternalMcpToken({ hasToken: false, masked: '' });
    setInternalMcpTokenRaw(null);
    setInternalMcpCreatedAt(null);
  };

  const copyToClipboard = async (text: string, setCopied: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
    if (settingsTab === 'mcp') { fetchMcpServers(); fetchMcpToken(); fetchInternalMcpToken(); }
    if (settingsTab === 'system') fetchSysModules();
  }, [settingsTab, fetchSecrets, fetchMcpServers, fetchMcpToken, fetchInternalMcpToken, fetchSysModules]);

  // ── 저장 ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    localStorage.setItem('firebat_model', aiModel); // 폴백용

    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timezone: userTimezone,
        aiModel,
        aiThinkingLevel: thinkingLevel,
        aiRouterEnabled,
        aiRouterModel,
      }),
    }).catch(() => {});

    const saveProviderKey = async (provider: 'openai' | 'gemini' | 'anthropic' | 'vertex', value: string) => {
      if (!value || value.includes('...') || value === '***') return;
      await fetch('/api/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: value }),
      }).catch(() => {});
    };
    await saveProviderKey('openai', geminiApiKey);
    await saveProviderKey('gemini', googleApiKey);
    await saveProviderKey('anthropic', anthropicApiKey);
    await saveProviderKey('vertex', vertexSaJson);

    if (adminCurrentPw && (adminNewId.trim() || adminNewPw.trim())) {
      const res = await fetch('/api/auth', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: adminCurrentPw, newId: adminNewId, newPassword: adminNewPw }),
      }).catch(() => null);
      if (res && !res.ok) {
        const data = await res.json().catch(() => ({}));
        setAdminPwError(data.error ?? '계정 변경에 실패했습니다.');
        return;
      }
      setAdminCurrentPw(''); setAdminNewId(''); setAdminNewPw(''); setAdminPwError('');
    }

    onSave();
  };

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
              aria-label="이전 탭"
            ><ChevronLeft size={16} /></button>
          )}
          {scrollState.canRight && (
            <button
              type="button"
              onClick={() => scrollTabs('right')}
              className="hidden sm:flex absolute right-0 top-0 bottom-0 z-20 w-7 items-center justify-center text-slate-400 hover:text-slate-700 bg-gradient-to-l from-white via-white to-transparent opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="다음 탭"
            ><ChevronRight size={16} /></button>
          )}
          <div ref={tabBarRef} className="flex px-3 sm:px-6 bg-white overflow-x-auto scrollbar-none select-none cursor-grab">
          <button
            onClick={() => switchTab('general')}
            data-active={settingsTab === 'general'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors whitespace-nowrap ${settingsTab === 'general' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            일반
          </button>
          <button
            onClick={() => switchTab('ai')}
            data-active={settingsTab === 'ai'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'ai' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <Cpu size={14} /> AI
          </button>
          <button
            onClick={() => switchTab('secrets')}
            data-active={settingsTab === 'secrets'}
            className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'secrets' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            <KeyRound size={14} /> API 키
          </button>
          {!isDemo && (
            <button
              onClick={() => switchTab('mcp')}
              data-active={settingsTab === 'mcp'}
              className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'mcp' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              <Plug size={14} /> 외부 MCP
            </button>
          )}
          {!isDemo && (
            <button
              onClick={() => switchTab('capabilities')}
              data-active={settingsTab === 'capabilities'}
              className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'capabilities' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              <Layers size={14} /> 기능
            </button>
          )}
          {!isDemo && (
            <button
              onClick={() => switchTab('system')}
              data-active={settingsTab === 'system'}
              className={`px-3 sm:px-4 py-2.5 text-[13px] sm:text-[14px] font-bold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${settingsTab === 'system' ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              <Cpu size={14} /> 시스템
            </button>
          )}
          </div>
        </div>

        <div ref={contentRef} className="p-3 sm:p-6 flex flex-col gap-4 overflow-y-auto min-w-0 flex-1 min-h-0 [scrollbar-gutter:stable_both-edges]">
          {settingsTab === 'general' && (
            <>
              {/* 타임존 */}
              <div className="flex flex-col gap-2">
                <label className="text-xs sm:text-sm font-bold text-slate-700">타임존</label>
                <select
                  value={userTimezone}
                  onChange={e => setUserTimezone(e.target.value)}
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
                >
                  <option value="Pacific/Midway">(UTC-11:00) 미드웨이</option>
                  <option value="Pacific/Honolulu">(UTC-10:00) 하와이</option>
                  <option value="America/Anchorage">(UTC-09:00) 알래스카</option>
                  <option value="America/Los_Angeles">(UTC-08:00) 태평양 (LA)</option>
                  <option value="America/Denver">(UTC-07:00) 산악 (덴버)</option>
                  <option value="America/Chicago">(UTC-06:00) 중부 (시카고)</option>
                  <option value="America/New_York">(UTC-05:00) 동부 (뉴욕)</option>
                  <option value="America/Caracas">(UTC-04:30) 카라카스</option>
                  <option value="America/Halifax">(UTC-04:00) 대서양 (핼리팩스)</option>
                  <option value="America/St_Johns">(UTC-03:30) 뉴펀들랜드</option>
                  <option value="America/Sao_Paulo">(UTC-03:00) 브라질리아</option>
                  <option value="Atlantic/South_Georgia">(UTC-02:00) 사우스조지아</option>
                  <option value="Atlantic/Azores">(UTC-01:00) 아조레스</option>
                  <option value="UTC">(UTC+00:00) UTC / 런던</option>
                  <option value="Europe/Paris">(UTC+01:00) 중앙유럽 (파리)</option>
                  <option value="Europe/Helsinki">(UTC+02:00) 동유럽 (헬싱키)</option>
                  <option value="Europe/Moscow">(UTC+03:00) 모스크바</option>
                  <option value="Asia/Tehran">(UTC+03:30) 테헤란</option>
                  <option value="Asia/Dubai">(UTC+04:00) 두바이</option>
                  <option value="Asia/Kabul">(UTC+04:30) 카불</option>
                  <option value="Asia/Karachi">(UTC+05:00) 카라치</option>
                  <option value="Asia/Kolkata">(UTC+05:30) 인도 (뭄바이)</option>
                  <option value="Asia/Kathmandu">(UTC+05:45) 카트만두</option>
                  <option value="Asia/Dhaka">(UTC+06:00) 다카</option>
                  <option value="Asia/Yangon">(UTC+06:30) 양곤</option>
                  <option value="Asia/Bangkok">(UTC+07:00) 방콕</option>
                  <option value="Asia/Shanghai">(UTC+08:00) 중국 (상하이)</option>
                  <option value="Asia/Tokyo">(UTC+09:00) 일본 (도쿄)</option>
                  <option value="Asia/Seoul">(UTC+09:00) 한국 (서울)</option>
                  <option value="Australia/Adelaide">(UTC+09:30) 애들레이드</option>
                  <option value="Australia/Sydney">(UTC+10:00) 시드니</option>
                  <option value="Pacific/Noumea">(UTC+11:00) 누메아</option>
                  <option value="Pacific/Auckland">(UTC+12:00) 오클랜드</option>
                  <option value="Pacific/Tongatapu">(UTC+13:00) 통가</option>
                </select>
                <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                  크론 스케줄링과 AI 시간 기준에 반영됩니다
                </p>
              </div>

              {/* 관리자 계정 변경 */}
              <div className="flex flex-col gap-2 pt-1 border-t border-slate-100">
                <label className="text-xs sm:text-sm font-bold text-slate-700 pt-1">관리자 계정 변경</label>
                <input
                  type="password"
                  value={adminCurrentPw}
                  onChange={e => { setAdminCurrentPw(e.target.value); setAdminPwError(''); }}
                  placeholder="현재 비밀번호"
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <input
                  type="text"
                  value={adminNewId}
                  onChange={e => setAdminNewId(e.target.value)}
                  placeholder="새 아이디"
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <input
                  type="password"
                  value={adminNewPw}
                  onChange={e => setAdminNewPw(e.target.value)}
                  placeholder="새 비밀번호"
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {adminPwError && <p className="text-[10px] sm:text-xs text-red-500 font-medium">{adminPwError}</p>}
                <p className="text-[10px] sm:text-xs text-slate-400 font-medium">현재 비밀번호 입력 필수. 빈칸은 기존 유지.</p>
              </div>
            </>
          )}

          {settingsTab === 'ai' && (() => {
            // 모드별 사용 가능 프로바이더
            const providersByMode: Record<'general' | 'vertex', Array<'openai' | 'google' | 'anthropic'>> = {
              general: ['openai', 'google', 'anthropic'],
              vertex: ['google'],
            };
            const activeProviders = providersByMode[aiMode];
            const effectiveProvider = activeProviders.includes(aiProvider) ? aiProvider : activeProviders[0];
            // 모델 필터: 모드(일반/Vertex) + 프로바이더
            const modelsForProvider = GEMINI_MODELS.filter(m => {
              const v = m.value;
              if (aiMode === 'vertex') return v.endsWith('-vertex');
              if (v.endsWith('-vertex')) return false; // vertex 모델은 일반 모드 제외
              if (effectiveProvider === 'openai') return v.startsWith('gpt-');
              if (effectiveProvider === 'google') return v.startsWith('gemini-');
              if (effectiveProvider === 'anthropic') return v.startsWith('claude-');
              return false;
            });
            const providerLabels: Record<'openai' | 'google' | 'anthropic', string> = {
              openai: 'OpenAI', google: 'Google', anthropic: 'Anthropic',
            };
            // 모델 드롭다운용 option 배열
            const modelOptions = modelsForProvider.length > 0
              ? modelsForProvider.map(m => ({ value: m.value, label: m.label }))
              : [{ value: '', label: '사용 가능한 모델 없음' }];
            const modelValue = modelsForProvider.some(m => m.value === aiModel) ? aiModel : (modelsForProvider[0]?.value ?? '');
            // Thinking 필터 — 현재 실제 선택된 모델(modelValue) 기준, aiModel(stale) 아님
            const thinkingKind = getThinkingKind(modelValue);
            const thinkingOptions = filterThinkingLevels(thinkingKind);
            const thinkingValid = thinkingOptions.some(l => l.value === thinkingLevel);
            const thinkingValue = thinkingValid ? thinkingLevel : (thinkingOptions[0]?.value ?? 'medium');
            const thinkingLabel = thinkingKind === 'reasoning' ? 'Reasoning (OpenAI)'
              : thinkingKind === 'thinking' ? 'Thinking (Gemini)'
              : 'Extended Thinking (Claude)';
            return (
              <>
                <Field label="모드" help="일반 모드: 각 공급자 직통 API · Vertex 모드: GCP Vertex AI (Service Account 인증)">
                  <SegButtons<'general' | 'vertex'>
                    value={aiMode}
                    onChange={(m) => {
                      setAiMode(m);
                      // 새 모드에서 현재 공급자가 유효한지 재확인, 유효한 첫 모델로 전환
                      const nextProviders = providersByMode[m];
                      const nextProvider = nextProviders.includes(aiProvider) ? aiProvider : nextProviders[0];
                      setAiProvider(nextProvider);
                      const nextModels = GEMINI_MODELS.filter(mm => {
                        const v = mm.value;
                        if (m === 'vertex') return v.endsWith('-vertex');
                        if (v.endsWith('-vertex')) return false;
                        if (nextProvider === 'openai') return v.startsWith('gpt-');
                        if (nextProvider === 'google') return v.startsWith('gemini-');
                        return v.startsWith('claude-');
                      });
                      if (nextModels[0]) onAiModelChange(nextModels[0].value);
                    }}
                    options={[{ value: 'general', label: '일반' }, { value: 'vertex', label: 'Vertex' }]}
                  />
                </Field>

                <Field label="공급자">
                  <SegButtons<'openai' | 'google' | 'anthropic'>
                    value={effectiveProvider}
                    onChange={(p) => {
                      setAiProvider(p);
                      const nextModels = GEMINI_MODELS.filter(mm => {
                        const v = mm.value;
                        if (aiMode === 'vertex') return v.endsWith('-vertex');
                        if (v.endsWith('-vertex')) return false;
                        if (p === 'openai') return v.startsWith('gpt-');
                        if (p === 'google') return v.startsWith('gemini-');
                        return v.startsWith('claude-');
                      });
                      if (nextModels[0]) onAiModelChange(nextModels[0].value);
                    }}
                    options={activeProviders.map(p => ({ value: p, label: providerLabels[p] }))}
                  />
                </Field>

                <Field label="모델">
                  <SelectInput value={modelValue} onChange={onAiModelChange} options={modelOptions} />
                </Field>

                {thinkingKind && thinkingOptions.length > 0 && (
                  <Field label={thinkingLabel}>
                    <SelectInput value={thinkingValue} onChange={setThinkingLevel} options={thinkingOptions} />
                  </Field>
                )}

                {/* API 키 — 선택된 프로바이더/모드에 따라 */}
                <div className="pt-2 border-t border-slate-100 flex flex-col gap-3">
                  <FieldLabel>공급자 API 키</FieldLabel>

                  {aiMode === 'general' && effectiveProvider === 'openai' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500">OpenAI</label>
                      <TextInput type="password" value={geminiApiKey} onChange={setGeminiApiKey} placeholder="sk-proj-..." />
                      <HelpText className="!text-[10px]">platform.openai.com → API Keys</HelpText>
                    </div>
                  )}

                  {aiMode === 'general' && effectiveProvider === 'google' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500">Google AI Studio</label>
                      <TextInput type="password" value={googleApiKey} onChange={setGoogleApiKey} placeholder="AIza..." />
                      <HelpText className="!text-[10px]">aistudio.google.com → Get API key</HelpText>
                    </div>
                  )}

                  {aiMode === 'general' && effectiveProvider === 'anthropic' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500">Anthropic</label>
                      <TextInput type="password" value={anthropicApiKey} onChange={setAnthropicApiKey} placeholder="sk-ant-..." />
                      <HelpText className="!text-[10px]">console.anthropic.com → API Keys</HelpText>
                    </div>
                  )}

                  {aiMode === 'vertex' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] text-slate-500">Google Vertex AI 서비스 계정 JSON</label>
                      <Textarea value={vertexSaJson} onChange={setVertexSaJson} placeholder='{"type":"service_account","project_id":"...","private_key":"..."}' rows={5} mono />
                      <HelpText className="!text-[10px]">GCP Console → IAM → 서비스 계정 → 키 생성 (JSON 전체 붙여넣기)</HelpText>
                    </div>
                  )}
                </div>

                {/* AI 어시스턴트 라우터 */}
                {(() => {
                  const hasGeminiKey = !!googleApiKey || !!vertexSaJson;
                  return (
                    <div className="pt-4 border-t border-slate-100 flex flex-col gap-2">
                      <FieldLabel>AI 어시스턴트 라우터</FieldLabel>
                      <label className={`flex items-start gap-2 p-3 rounded-xl border ${hasGeminiKey ? 'border-slate-200 hover:bg-slate-50 cursor-pointer' : 'border-slate-100 bg-slate-50 cursor-not-allowed opacity-60'}`}>
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={aiRouterEnabled}
                          disabled={!hasGeminiKey}
                          onChange={e => setAiRouterEnabled(e.target.checked)}
                        />
                        <div className="flex-1">
                          <div className="text-[13px] font-bold text-slate-800">AI 어시스턴트 활성화</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            도구·컴포넌트 선별을 Gemini Flash Lite 가 학습하며 자동 수행합니다.
                            결과는 캐시되어 시간이 지날수록 LLM 호출이 줄어듭니다.
                          </div>
                          {!hasGeminiKey && (
                            <div className="text-[11px] text-amber-600 mt-1.5 font-bold">
                              ⚠️ Gemini(Google AI Studio) 또는 Vertex API 키를 먼저 등록하세요.
                            </div>
                          )}
                        </div>
                      </label>
                      {aiRouterEnabled && hasGeminiKey && (
                        <Field label="모델">
                          <SelectInput
                            value={aiRouterModel}
                            onChange={setAiRouterModel}
                            options={[
                              { value: 'gemini-3-flash-lite', label: 'Gemini 3 Flash Lite (저비용)' },
                              { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview (정확도↑)' },
                            ]}
                          />
                        </Field>
                      )}
                    </div>
                  );
                })()}
              </>
            );
          })()}

          {settingsTab === 'secrets' && (
            <>
              <p className="text-[11px] sm:text-[12px] text-slate-400 font-medium -mt-1 mb-1">
                LLM 공급자 키(OpenAI / Google / Anthropic / Vertex)는 <span className="font-bold text-blue-600">AI 탭</span>에서 관리하세요.
              </p>

              {/* 모듈 필요 API 키 (config.json에서 자동 수집) */}
              {moduleSecrets.length > 0 && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs sm:text-sm font-bold text-slate-700">모듈 필요 API 키</label>
                  <p className="text-[10px] sm:text-xs text-slate-400 font-medium -mt-1">
                    모듈의 config.json에서 자동으로 감지된 키입니다.
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
                            <span className="text-[11px] text-emerald-600 font-medium">✓ 등록됨</span>
                            <div className="flex items-center gap-2">
                              <button onClick={() => setModuleSecretValues(prev => ({ ...prev, [ms.secretName]: '' }))} className="text-slate-400 hover:text-blue-500 transition-colors">
                                <Pencil size={13} />
                              </button>
                              <button onClick={() => deleteSecret(ms.secretName)} className="text-[11px] text-slate-400 hover:text-red-500 transition-colors">
                                삭제
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-1.5">
                            <input
                              type="password"
                              value={moduleSecretValues[ms.secretName] || ''}
                              onChange={e => setModuleSecretValues(prev => ({ ...prev, [ms.secretName]: e.target.value }))}
                              placeholder={ms.hasValue ? '새 값 입력' : '키 값 입력'}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveModuleSecret(ms.secretName);
                                if (e.key === 'Escape' && ms.hasValue) setModuleSecretValues(prev => { const n = { ...prev }; delete n[ms.secretName]; return n; });
                              }}
                              autoFocus={ms.hasValue}
                              className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            />
                            <button
                              onClick={() => saveModuleSecret(ms.secretName)}
                              disabled={!moduleSecretValues[ms.secretName]?.trim() || moduleSecretSaving === ms.secretName}
                              className="px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shrink-0"
                            >
                              {moduleSecretSaving === ms.secretName ? '...' : '저장'}
                            </button>
                            {ms.hasValue && (
                              <button
                                onClick={() => setModuleSecretValues(prev => { const n = { ...prev }; delete n[ms.secretName]; return n; })}
                                className="px-2 py-1.5 text-[12px] text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                              >
                                취소
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
                  <label className="text-xs sm:text-sm font-bold text-slate-700 pt-1">기타 저장된 키</label>
                  <div className="flex flex-col gap-1.5">
                    {userSecrets.filter(s => !moduleSecrets.some(ms => ms.secretName === s.name)).map(s => (
                      <div key={s.name} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
                        {editingSecret?.name === s.name ? (
                          <div>
                            <span className="text-[13px] font-bold text-slate-700 mb-1 block">{s.name}</span>
                            <div className="flex gap-1.5">
                              <input
                                type="password"
                                value={editingSecret.value}
                                onChange={e => setEditingSecret({ name: s.name, value: e.target.value })}
                                placeholder="새 값 입력"
                                autoFocus
                                onKeyDown={async e => {
                                  if (e.key === 'Enter' && editingSecret.value.trim()) {
                                    await fetch('/api/vault/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name, value: editingSecret.value.trim() }) });
                                    setEditingSecret(null); fetchSecrets();
                                  }
                                  if (e.key === 'Escape') setEditingSecret(null);
                                }}
                                className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                              />
                              <button
                                onClick={async () => {
                                  if (!editingSecret.value.trim()) return;
                                  await fetch('/api/vault/secrets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.name, value: editingSecret.value.trim() }) });
                                  setEditingSecret(null); fetchSecrets();
                                }}
                                disabled={!editingSecret.value.trim()}
                                className="px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shrink-0"
                              >저장</button>
                              <button onClick={() => setEditingSecret(null)} className="px-2 py-1.5 text-[12px] text-slate-400 hover:text-slate-600 transition-colors shrink-0">취소</button>
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
                <label className="text-xs sm:text-sm font-bold text-slate-700 pt-1">키 수동 추가</label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newSecretName}
                    onChange={e => setNewSecretName(e.target.value)}
                    placeholder="키 이름"
                    className="flex-1 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <input
                    type="password"
                    value={newSecretValue}
                    onChange={e => setNewSecretValue(e.target.value)}
                    placeholder="키 값"
                    onKeyDown={e => e.key === 'Enter' && addSecret()}
                    className="flex-1 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <button
                    onClick={addSecret}
                    disabled={!newSecretName.trim() || !newSecretValue.trim() || secretSaving}
                    className="px-3 py-2 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors shrink-0"
                  >
                    {secretSaving ? '...' : '추가'}
                  </button>
                </div>
              </div>
            </>
          )}

          {settingsTab === 'mcp' && (
            <>
              {/* Firebat MCP 서버(앱 개발용/LLM 통신용)는 사이드바 > SYSTEM > 서비스에서 각각 관리 */}
              <div className="flex flex-col gap-3 pb-4 border-b border-slate-200 hidden">
                <div className="flex items-center gap-2">
                  <Server size={16} className="text-blue-600" />
                  <label className="text-xs sm:text-sm font-bold text-slate-700">Firebat MCP 서버</label>
                </div>
                <p className="text-[11px] sm:text-[12px] text-slate-400 -mt-1">
                  외부 AI 도구(Claude Code, Cursor, VS Code 등)에서 이 파이어뱃 서버에 연결할 수 있습니다.
                </p>

                {/* 토큰 관리 */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] sm:text-[13px] font-bold text-slate-600">인증 토큰</span>
                    <div className="flex items-center gap-1.5">
                      {mcpTokenInfo.exists && (
                        <button
                          onClick={revokeMcpToken}
                          className="text-[10px] sm:text-[11px] px-2 py-0.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
                        >
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

                  {/* 토큰 1회 표시 (생성 직후) */}
                  {mcpTokenRaw && (
                    <div className="bg-amber-50 border border-amber-300 rounded-lg p-2.5 flex flex-col gap-1.5">
                      <p className="text-[10px] sm:text-[11px] font-bold text-amber-700">이 토큰은 다시 볼 수 없습니다. 지금 복사하세요.</p>
                      <div className="flex items-center gap-1.5">
                        <code className="flex-1 text-[11px] sm:text-[12px] font-mono bg-white border border-amber-200 rounded px-2 py-1 text-slate-700 break-all select-all">
                          {mcpTokenRaw}
                        </code>
                        <button
                          onClick={() => copyToClipboard(mcpTokenRaw, setMcpTokenCopied)}
                          className="shrink-0 p-1.5 rounded hover:bg-amber-100 transition-colors"
                          title="복사"
                        >
                          {mcpTokenCopied ? <Check size={14} className="text-green-600" /> : <Copy size={14} className="text-amber-600" />}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 마스킹된 토큰 정보 */}
                  {mcpTokenInfo.exists && !mcpTokenRaw && (
                    <div className="flex items-center gap-2 text-[11px] sm:text-[12px] text-slate-500">
                      <code className="font-mono bg-white border border-slate-200 rounded px-2 py-0.5 text-slate-600">{mcpTokenInfo.hint}</code>
                      {mcpTokenInfo.createdAt && (
                        <span className="text-slate-400">
                          생성: {new Date(mcpTokenInfo.createdAt).toLocaleDateString('ko-KR')}
                        </span>
                      )}
                    </div>
                  )}

                  {!mcpTokenInfo.exists && !mcpTokenRaw && (
                    <p className="text-[10px] sm:text-[11px] text-slate-400">토큰이 없습니다. SSE(API) 연결을 사용하려면 토큰을 생성하세요.</p>
                  )}
                </div>

                {/* JSON 설정 보기 (API / stdio 탭) */}
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
                    const sseUrl = `${window.location.origin}/api/mcp`;
                    const tokenValue = mcpTokenRaw || (mcpTokenInfo.exists ? '<생성된 토큰>' : '<토큰을 먼저 생성하세요>');
                    const jsonConfig = JSON.stringify({
                      mcpServers: {
                        firebat: {
                          url: sseUrl,
                          headers: { Authorization: `Bearer ${tokenValue}` },
                        },
                      },
                    }, null, 2);
                    return (
                      <div className="p-3 flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] sm:text-[11px] text-slate-500">
                            VS Code / Cursor MCP 설정에 아래 JSON을 추가하세요.
                          </p>
                          <button
                            onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)}
                            className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors"
                            title="복사"
                          >
                            {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                          </button>
                        </div>
                        <pre className="text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">
                          {jsonConfig}
                        </pre>
                        {!mcpTokenInfo.exists && (
                          <p className="text-[10px] text-amber-600 font-bold">위에서 토큰을 먼저 생성하세요.</p>
                        )}
                      </div>
                    );
                  })()}

                  {mcpJsonTab === 'stdio' && (() => {
                    const jsonConfig = JSON.stringify({
                      mcpServers: {
                        firebat: {
                          command: 'ssh',
                          args: ['-i', '<SSH_KEY_PATH>', '<USER>@<SERVER_IP>', 'cd /path/to/firebat && npx tsx mcp/stdio.ts'],
                        },
                      },
                    }, null, 2);
                    return (
                      <div className="p-3 flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] sm:text-[11px] text-slate-500">
                            SSH를 통해 서버에 직접 접속하여 실행합니다.
                          </p>
                          <button
                            onClick={() => copyToClipboard(jsonConfig, setMcpJsonCopied)}
                            className="shrink-0 p-1 rounded hover:bg-slate-100 transition-colors"
                            title="복사"
                          >
                            {mcpJsonCopied ? <Check size={12} className="text-green-600" /> : <Copy size={12} className="text-slate-400" />}
                          </button>
                        </div>
                        <pre className="text-[10px] sm:text-[11px] font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">
                          {jsonConfig}
                        </pre>
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

              {/* 등록된 MCP 서버 목록 */}
              <div className="flex flex-col gap-2">
                <label className="text-xs sm:text-sm font-bold text-slate-700">외부 MCP 서버</label>
                {mcpLoading ? (
                  <div className="flex items-center justify-center py-6 min-h-[80px]">
                    <Loader2 size={18} className="animate-spin text-slate-400" />
                  </div>
                ) : mcpServers.length === 0 ? (
                  <p className="text-[12px] sm:text-[13px] text-slate-400 py-4 text-center min-h-[80px] flex items-center justify-center">등록된 MCP 서버가 없습니다</p>
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
                            <button
                              onClick={() => isEditing ? setMcpEditing(null) : startEditMcp(s)}
                              className={`p-1 rounded transition-colors ${isEditing ? 'text-blue-600 bg-blue-50' : 'text-slate-400 hover:text-amber-600 hover:bg-amber-50'}`}
                              title="편집"
                            >
                              <Pencil size={14} />
                            </button>
                            {s.transport === 'stdio' && (
                              <button
                                onClick={() => startMcpAuth(s.name)}
                                disabled={mcpAuth?.server === s.name && mcpAuth.step === 'starting'}
                                className="text-[11px] px-2 py-1 rounded font-bold text-slate-500 hover:text-amber-600 hover:bg-amber-50 border border-slate-200 transition-colors disabled:opacity-50"
                                title="OAuth 인증"
                              >
                                인증
                              </button>
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
                                  placeholder="명령어"
                                  className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <input
                                  type="text"
                                  value={mcpEditArgs}
                                  onChange={e => setMcpEditArgs(e.target.value)}
                                  placeholder="인자 (공백 구분)"
                                  className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                              </>
                            ) : (
                              <input
                                type="text"
                                value={mcpEditUrl}
                                onChange={e => setMcpEditUrl(e.target.value)}
                                placeholder="SSE URL"
                                className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            )}
                            <div className="flex gap-1.5 justify-end">
                              <button
                                onClick={() => setMcpEditing(null)}
                                className="px-2.5 py-1 text-[11px] font-bold text-slate-500 hover:bg-slate-200 rounded transition-colors"
                              >
                                취소
                              </button>
                              <button
                                onClick={() => saveEditMcp(s)}
                                disabled={mcpEditSaving}
                                className="px-2.5 py-1 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded transition-colors"
                              >
                                {mcpEditSaving ? '저장 중...' : '저장'}
                              </button>
                            </div>
                          </div>
                        )}
                        {/* OAuth 인증 플로우 */}
                        {mcpAuth?.server === s.name && (
                          <div className="mt-1.5 border border-slate-200 rounded-lg overflow-hidden">
                            {mcpAuth.step === 'starting' && (
                              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 text-[11px] text-slate-500">
                                <Loader2 size={12} className="animate-spin" /> 인증 준비 중...
                              </div>
                            )}
                            {mcpAuth.step === 'waiting' && (
                              <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 text-[11px] text-amber-700">
                                <Loader2 size={12} className="animate-spin" />
                                <span>Google 로그인 창에서 인증을 완료하면 자동으로 처리됩니다</span>
                                {mcpAuth.authUrl && (
                                  <button onClick={() => window.open(mcpAuth.authUrl!, 'mcp-oauth', 'width=500,height=700,left=200,top=100')}
                                    className="ml-auto text-[10px] text-blue-600 hover:text-blue-800 underline whitespace-nowrap">
                                    다시 열기
                                  </button>
                                )}
                              </div>
                            )}
                            {mcpAuth.step === 'done' && (
                              <div className="flex items-center justify-between px-3 py-2 bg-green-50 text-[11px] text-green-700 font-bold">
                                <span>인증 완료!</span>
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
                <label className="text-xs sm:text-sm font-bold text-slate-700 pt-1">서버 추가</label>
                <input
                  type="text"
                  value={mcpNewName}
                  onChange={e => setMcpNewName(e.target.value)}
                  placeholder="서버 이름 (예: gmail, slack)"
                  className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setMcpNewTransport('stdio')}
                    className={`flex-1 px-3 py-1.5 text-[12px] sm:text-[13px] font-bold rounded-lg border transition-colors ${mcpNewTransport === 'stdio' ? 'border-green-500 bg-green-50 text-green-700' : 'border-slate-300 text-slate-400 hover:text-slate-600'}`}
                  >
                    stdio (로컬)
                  </button>
                  <button
                    onClick={() => setMcpNewTransport('sse')}
                    className={`flex-1 px-3 py-1.5 text-[12px] sm:text-[13px] font-bold rounded-lg border transition-colors ${mcpNewTransport === 'sse' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-400 hover:text-slate-600'}`}
                  >
                    SSE (원격)
                  </button>
                </div>
                {mcpNewTransport === 'stdio' ? (
                  <>
                    <input
                      type="text"
                      value={mcpNewCommand}
                      onChange={e => setMcpNewCommand(e.target.value)}
                      placeholder="실행 명령어 (예: npx, python)"
                      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                    <input
                      type="text"
                      value={mcpNewArgs}
                      onChange={e => setMcpNewArgs(e.target.value)}
                      placeholder="인자 (공백 구분, 예: -y @anthropic/mcp-gmail)"
                      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </>
                ) : (
                  <input
                    type="text"
                    value={mcpNewUrl}
                    onChange={e => setMcpNewUrl(e.target.value)}
                    placeholder="SSE 서버 URL (예: http://localhost:3001/sse)"
                    className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                )}
                <button
                  onClick={addMcpServer}
                  disabled={!mcpNewName.trim() || (mcpNewTransport === 'stdio' ? !mcpNewCommand.trim() : !mcpNewUrl.trim()) || mcpSaving}
                  className="w-full px-3 py-2 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors"
                >
                  {mcpSaving ? '연결 테스트 중...' : '추가'}
                </button>
                <p className="text-[10px] sm:text-xs text-slate-400 font-medium">
                  등록된 MCP 서버의 도구는 AI가 자동으로 인식하여 호출할 수 있습니다.
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
              {sysModules.filter(m => m.type === 'service').length > 0 && (
                <div>
                  <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase flex items-center gap-1.5 mb-2"><Wrench size={11} /> 서비스</p>
                  <div className="space-y-1">
                    {sysModules.filter(m => m.type === 'service').map(m => (
                      <div key={m.name} className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors group ${m.enabled === false ? 'border-slate-100 bg-slate-50/50 opacity-60' : 'border-slate-200 hover:border-blue-200 hover:bg-blue-50/50'}`}>
                        <button onClick={() => onOpenModuleSettings?.(m.name)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                          <Server size={16} className="text-emerald-500 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-slate-700">{m.name}</p>
                            <p className="text-[11px] text-slate-400 truncate">{m.description}</p>
                          </div>
                          <Settings size={14} className="text-slate-300 group-hover:text-blue-500 transition-colors shrink-0" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleModuleEnabled(m.name, m.enabled === false); }}
                          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${m.enabled !== false ? 'bg-blue-500' : 'bg-slate-300'}`}
                          title={m.enabled !== false ? '활성' : '비활성'}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${m.enabled !== false ? 'translate-x-4' : ''}`} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 모듈 */}
              {sysModules.filter(m => m.type !== 'service').length > 0 && (
                <div>
                  <p className="text-[11px] font-bold tracking-wider text-slate-400 uppercase flex items-center gap-1.5 mb-2"><Blocks size={11} /> 모듈</p>
                  <div className="space-y-1">
                    {sysModules.filter(m => m.type !== 'service').map(m => (
                      <div key={m.name} className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors group ${m.enabled === false ? 'border-slate-100 bg-slate-50/50 opacity-60' : 'border-slate-200 hover:border-blue-200 hover:bg-blue-50/50'}`}>
                        <button onClick={() => onOpenModuleSettings?.(m.name)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                          <Blocks size={16} className="text-indigo-500 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-slate-700">{m.name}</p>
                            <p className="text-[11px] text-slate-400 truncate">{m.description}</p>
                          </div>
                          <Settings size={14} className="text-slate-300 group-hover:text-blue-500 transition-colors shrink-0" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleModuleEnabled(m.name, m.enabled === false); }}
                          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${m.enabled !== false ? 'bg-blue-500' : 'bg-slate-300'}`}
                          title={m.enabled !== false ? '활성' : '비활성'}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${m.enabled !== false ? 'translate-x-4' : ''}`} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {sysModules.length === 0 && (
                <p className="text-[13px] text-slate-400 italic text-center py-8">시스템 항목이 없습니다</p>
              )}
            </div>
          )}
        </div>

        <div className="px-3 sm:px-6 py-2.5 sm:py-5 bg-slate-50 border-t border-slate-100 flex justify-end gap-2 sm:gap-3 shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-slate-600 hover:bg-slate-200 bg-slate-100 rounded-lg transition-colors"
          >
            닫기
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 sm:px-5 sm:py-2.5 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-sm"
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Capability 탭 내부 컴포넌트 ──────────────────────────────────────────────
type CapInfo = { id: string; label: string; description: string; providerCount: number };
type ProviderInfo = { moduleName: string; providerType: 'local' | 'api'; location: 'system' | 'user'; description: string };

function CapabilityTabContent() {
  const [caps, setCaps] = useState<CapInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCap, setSelectedCap] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);

  useEffect(() => {
    fetch('/api/capabilities')
      .then(r => r.json())
      .then(data => { if (data.success) setCaps(data.capabilities ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const loadDetail = async (id: string) => {
    setSelectedCap(id);
    setDetailLoading(true);
    setOrderChanged(false);
    try {
      const res = await fetch('/api/capabilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
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
    } catch {}
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
      await fetch('/api/capabilities', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedCap, settings: { providers: providers.map(p => p.moduleName) } }),
      });
      setOrderChanged(false);
    } catch {}
    finally { setSaving(false); }
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
        <label className="text-xs sm:text-sm font-bold text-slate-700">Capability 목록</label>
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium -mt-1">
          같은 기능을 수행하는 모듈들의 실행 우선순위를 관리합니다.
        </p>
        {caps.length === 0 ? (
          <p className="text-[12px] sm:text-[13px] text-slate-400 py-4 text-center">등록된 기능이 없습니다</p>
        ) : (
          <div className="flex flex-col gap-1">
            {caps.map(cap => (
              <button
                key={cap.id}
                onClick={() => loadDetail(cap.id)}
                className={`flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-colors ${
                  selectedCap === cap.id ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                }`}
              >
                <div className="min-w-0">
                  <span className="text-[13px] font-bold text-slate-700">{cap.label}</span>
                  <span className="ml-1.5 text-[11px] text-slate-400 font-mono">{cap.id}</span>
                  <p className="text-[11px] text-slate-400 truncate">{cap.description}</p>
                </div>
                <span className={`shrink-0 ml-2 text-[11px] px-2 py-0.5 rounded-full font-bold ${
                  cap.providerCount > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'
                }`}>
                  {cap.providerCount}개
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedCap && (
        <div className="flex flex-col gap-3 pt-2 border-t border-slate-100">
          {detailLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={16} className="animate-spin text-slate-400" />
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs sm:text-sm font-bold text-slate-700">
                  실행 순서 {providers.length > 1 && <span className="text-[10px] text-slate-400 font-normal ml-1">위에서부터 우선 실행</span>}
                </label>
                {providers.length === 0 ? (
                  <p className="text-[12px] text-slate-400 py-2">등록된 provider가 없습니다</p>
                ) : (
                  providers.map((p, i) => (
                    <div key={p.moduleName} className="flex items-center gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
                      {/* 순서 번호 */}
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
                      {/* 순서 변경 버튼 */}
                      {providers.length > 1 && (
                        <div className="flex flex-col gap-0.5 shrink-0">
                          <button
                            onClick={() => moveProvider(i, -1)}
                            disabled={i === 0}
                            className="p-0.5 text-slate-400 hover:text-slate-700 disabled:text-slate-200 disabled:cursor-default transition-colors"
                            title="위로"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                          </button>
                          <button
                            onClick={() => moveProvider(i, 1)}
                            disabled={i === providers.length - 1}
                            className="p-0.5 text-slate-400 hover:text-slate-700 disabled:text-slate-200 disabled:cursor-default transition-colors"
                            title="아래로"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* 순서 저장 */}
              {providers.length > 1 && orderChanged && (
                <button
                  onClick={saveOrder}
                  disabled={saving}
                  className="w-full px-3 py-2 text-[13px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors"
                >
                  {saving ? '저장 중...' : '순서 저장'}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
