import { ConversationMeta } from './components/Sidebar';

export const GEMINI_MODELS = [
  { value: 'gemini-3.1-flash-lite-preview',         label: 'Gemini 3.1 Flash Lite (경량/초고속)' },
  { value: 'gemini-3-flash-preview',                label: 'Gemini 3 Flash (빠름/가성비)' },
  { value: 'gemini-3.1-pro-preview',                label: 'Gemini 3.1 Pro (고성능)' },
  { value: 'gemini-2.5-flash-lite-preview-09-2025', label: 'Gemini 2.5 Flash Lite (경량)' },
  { value: 'gemini-2.5-flash',                      label: 'Gemini 2.5 Flash (빠름/가성비)' },
  { value: 'gemini-2.5-pro',                        label: 'Gemini 2.5 Pro (높은 추론)' },
];

export type PlanAction = { type: string; description?: string; path?: string; slug?: string };
export type StepStatus = { index: number; total: number; type: string; status: 'start' | 'done' | 'error'; error?: string };

export type Message = {
  id: string;
  role: 'user' | 'system';
  content?: string;
  thoughts?: string;
  executedActions?: string[];
  data?: any;
  error?: string;
  isThinking?: boolean;
  plan?: { thoughts: string; reply: string; actions: PlanAction[]; corrId: string };
  planPending?: boolean;
  steps?: StepStatus[];
  executing?: boolean;
  suggestions?: (string | { type: 'input'; label: string; placeholder?: string } | { type: 'toggle'; label: string; options: string[]; defaults?: string[] })[];
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
  content: 'Firebat AI Agent',
  executedActions: [],
};

export function makeConv(messages: Message[] = [INIT_MESSAGE]): Conversation {
  const firstUser = messages.find(m => m.role === 'user');
  const title = firstUser?.content
    ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
    : '새 대화';
  return { id: Date.now().toString(), title, createdAt: Date.now(), messages };
}
