import { ConversationMeta } from './components/Sidebar';

// AI 모델 list 는 Rust core::llm::config::builtin_models() 단일 source.
// frontend 는 GET /api/settings 응답의 aiModels 배열을 useAiModels hook 으로 받음.
// 옛 hardcoded AI_MODELS / GEMINI_MODELS 통째 폐기 (2026-05-10) — duplicate 청산.
//
// Thinking 모드 — 옛 THINKING_LEVELS / getThinkingKind / filterThinkingLevels (hardcoded prefix
// 기반) 폐기 (2026-05-13). 각 모델 entry 의 `thinking` 필드 (JSON registry single source) 사용.
// frontend: `model.thinking?.kind` + `model.thinking?.levels[i].labels[lang]`.

/** 모델 thinking 지원 종류 — Rust LlmModelConfig.thinking.kind 와 1:1. */
export type ThinkingKind = 'reasoning' | 'thinking' | 'extendedThinking';

export type StepStatus = { index: number; total: number; type: string; status: 'start' | 'done' | 'error'; error?: string; description?: string };

export type PendingAction = {
  planId: string;
  name: string;
  summary: string;
  args?: Record<string, unknown>;
  status?: 'pending' | 'approved' | 'rejected' | 'past-runat' | 'error';
  originalRunAt?: string; // PAST_RUNAT 상태일 때 원래 예약 시각
  errorMessage?: string;  // status==='error'일 때 실패 사유
  createdAt?: number;     // 생성 시각(epoch ms) — 수신 시 stamp, 30일 경과 시 카드에 만료 표시
};

export type ToolResultSummary = {
  name: string;
  success: boolean;
  error?: string;
  input?: Record<string, unknown>;
};

/**
 * Library Phase 1 단계 8.4 (2026-05-17) — RetrievalEngine 매칭 hit metadata.
 * 답변 본문에 출처 표기 하지 말라는 시스템 prompt 룰과 짝. 메시지 아래 SourceTags
 * 뱃지로 노출 + 클릭 → LibrarySourceModal 안 원본 표시.
 */
export type LibrarySourceHit = {
  sourceId: string;
  sourceName: string;
  referenceId: string;
  referenceName: string;
  chunkId: string;
  chunkIndex: number;
  content: string;
  pageNumber?: number;
  score: number;
};

export type Message = {
  id: string;
  role: 'user' | 'system';
  content?: string;
  thoughts?: string;
  executedActions?: string[];
  toolResults?: ToolResultSummary[];
  libraryHits?: LibrarySourceHit[];
  data?: any;
  error?: string;
  isThinking?: boolean;
  thinkingText?: string;
  streaming?: boolean;
  pendingActions?: PendingAction[];
  steps?: StepStatus[];
  executing?: boolean;
  statusText?: string;
  suggestions?: (string | { type: 'input'; label: string; placeholder?: string } | { type: 'toggle'; label: string; options: string[]; defaults?: string[]; single?: boolean })[];
  pickedSuggestion?: string; // 칩 픽 시 그 텍스트 — 잠금 강조 + 과거 빌드 슬라이드 표시용 (consumeSuggestions 대신 lockSuggestion 이 설정)
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
  // 옛 id=now.toString() 폐기 — Date.now() 충돌 시 deleted_conversations tombstone
  // 과 매칭 → POST /api/conversations 409 false positive. 2026-05-14 fix.
  // 운영 환경 옛 데이터의 tombstone (permanent_delete 후에도 다기기 stale POST 차단 위해 보존)
  // 과 우연 충돌 방지 — Date.now() + random 4 hex (crypto.randomUUID() 폴백).
  const id = `conv-${now}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, title, createdAt: now, updatedAt: now, messages };
}
