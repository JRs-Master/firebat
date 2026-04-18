import { ConversationMeta } from './components/Sidebar';

export const AI_MODELS = [
  // OpenAI (Responses API)
  { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano (초경량/저렴)' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini (OpenAI 가성비)' },
  { value: 'gpt-5.4',      label: 'GPT-5.4 (OpenAI 고품질)' },
  // Google AI Studio (OpenAI-compat)
  { value: 'gemini-3-flash-preview',          label: 'Gemini 3 Flash (AI Studio)' },
  { value: 'gemini-3.1-flash-lite-preview',   label: 'Gemini 3.1 Flash Lite (AI Studio)' },
  { value: 'gemini-3.1-pro-preview',          label: 'Gemini 3.1 Pro (AI Studio)' },
  // Google Vertex AI (Service Account)
  { value: 'gemini-3-flash-preview-vertex',          label: 'Gemini 3 Flash (Vertex)' },
  { value: 'gemini-3.1-flash-lite-preview-vertex',   label: 'Gemini 3.1 Flash Lite (Vertex)' },
  { value: 'gemini-3.1-pro-preview-vertex',          label: 'Gemini 3.1 Pro (Vertex)' },
  // Anthropic
  { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 (저렴/빠름)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (균형)' },
  { value: 'claude-opus-4-7',   label: 'Claude Opus 4.7 (최고급)' },
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
  if (model.startsWith('gpt-')) return 'reasoning';           // OpenAI reasoning.effort
  if (model.startsWith('claude-')) return 'extendedThinking'; // Anthropic enabled/disabled
  if (model.startsWith('gemini-')) {
    if (model.includes('flash-lite')) return null;            // Lite는 thinking 미지원
    return 'thinking';                                         // Gemini thinkingLevel
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

export type PlanAction = { type: string; description?: string; path?: string; slug?: string };
export type StepStatus = { index: number; total: number; type: string; status: 'start' | 'done' | 'error'; error?: string; description?: string };

export type PendingAction = {
  planId: string;
  name: string;
  summary: string;
  args?: Record<string, unknown>;
  status?: 'pending' | 'approved' | 'rejected';
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
  plan?: { thoughts: string; reply: string; actions: PlanAction[]; corrId: string };
  planPending?: boolean;
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
  return { id: Date.now().toString(), title, createdAt: Date.now(), messages };
}
