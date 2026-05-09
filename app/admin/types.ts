import { ConversationMeta } from './components/Sidebar';

// Rust core 의 builtin_models() 설정된 거 1:1 — 운영 시점에 Vault API 키 설정하면 활성.
// AI 어시스턴트 보조용 (잼민이 Flash Lite) 는 별도 list (AI Assistant 모델 풀) — carousel 노출 X.
export const AI_MODELS = [
  // Anthropic API
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  // OpenAI Responses API
  { value: 'gpt-5', label: 'GPT-5' },
  // Google Gemini API
  { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  // Google Vertex AI
  { value: 'vertex-gemini-3-pro', label: 'Gemini 3 Pro (Vertex)' },
  // CLI (구독 기반)
  { value: 'cli-claude-code', label: 'Claude Code CLI' },
  { value: 'cli-codex', label: 'Codex CLI' },
  { value: 'cli-gemini', label: 'Gemini CLI' },
];
// 기존 이름 호환을 위한 alias
export const GEMINI_MODELS = AI_MODELS;

// 통합 Thinking/Reasoning 레벨 (none/minimal/low/medium/high/xhigh/max)
export const THINKING_LEVELS = [
  { value: 'none',    label: 'None (추론 없음, 최저 지연)' },
  { value: 'minimal', label: 'Minimal (최소, 빠름)' },
  { value: 'low',     label: 'Low (낮음)' },
  { value: 'medium',  label: 'Medium (중간, 기본)' },
  { value: 'high',    label: 'High (높음)' },
  { value: 'xhigh',   label: 'Extra High (더 높음)' },
  { value: 'max',     label: 'Max (최대 예산)' },
];

/** 모델 thinking 지원 종류 — null이면 Thinking 옵션 UI 비노출 */
export type ThinkingKind = 'reasoning' | 'thinking' | 'extendedThinking' | null;

export function getThinkingKind(model: string): ThinkingKind {
  if (model.startsWith('gpt-')) return 'reasoning';              // OpenAI reasoning.effort
  if (model.startsWith('claude-')) return 'extendedThinking';    // Anthropic enabled/disabled
  if (model.startsWith('cli-claude-code')) return 'extendedThinking'; // Claude Code CLI --effort
  if (model.startsWith('cli-codex')) return 'reasoning';          // Codex CLI --config model_reasoning_effort
  if (model.startsWith('cli-gemini')) return null;                // Gemini CLI 는 thinking 플래그 미지원 (CLI 내부 자동)
  if (model.startsWith('gemini-')) {
    if (model.includes('flash-lite')) return null;                // Lite는 thinking 미지원
    return 'thinking';                                             // Gemini thinkingLevel
  }
  return null;
}

/** 각 종류별 허용 레벨 필터 */
export function filterThinkingLevels(kind: ThinkingKind): { value: string; label: string }[] {
  if (!kind) return [];
  // OpenAI reasoning.effort: minimal/low/medium/high + xhigh(gpt-5.4+) + none(끄기)
  if (kind === 'reasoning') return THINKING_LEVELS.filter(l => l.value !== 'max');
  // Gemini thinkingLevel: minimal/low/medium/high
  if (kind === 'thinking') return THINKING_LEVELS.filter(l => ['minimal', 'low', 'medium', 'high'].includes(l.value));
  // Claude extended thinking: budget_tokens로 제어 — low/medium/high/xhigh/max 로 맵핑
  return THINKING_LEVELS.filter(l => ['low', 'medium', 'high', 'xhigh', 'max'].includes(l.value));
}

export type StepStatus = { index: number; total: number; type: string; status: 'start' | 'done' | 'error'; error?: string; description?: string };

export type PendingAction = {
  planId: string;
  name: string;
  summary: string;
  args?: Record<string, unknown>;
  status?: 'pending' | 'approved' | 'rejected' | 'past-runat' | 'error';
  originalRunAt?: string; // PAST_RUNAT 상태일 때 원래 예약 시각
  errorMessage?: string;  // status==='error'일 때 실패 사유
};

export type Message = {
  id: string;
  role: 'user' | 'system';
  content?: string;
  thoughts?: string;
  executedActions?: string[];
  data?: any;
  error?: string;
  isThinking?: boolean;
  thinkingText?: string;
  streaming?: boolean;
  pendingActions?: PendingAction[];
  steps?: StepStatus[];
  executing?: boolean;
  statusText?: string;
  suggestions?: (string | { type: 'input'; label: string; placeholder?: string } | { type: 'toggle'; label: string; options: string[]; defaults?: string[] })[];
  image?: string;
};

export type Conversation = ConversationMeta & { messages: Message[] };

export type McpServer = {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
};

export const INIT_MESSAGE: Message = {
  id: 'system-init',
  role: 'system',
  content: '',
  executedActions: [],
};

export function makeConv(messages: Message[] = [INIT_MESSAGE]): Conversation {
  const firstUser = messages.find(m => m.role === 'user');
  const title = firstUser?.content
    ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
    : '새 대화';
  const now = Date.now();
  return { id: now.toString(), title, createdAt: now, updatedAt: now, messages };
}
