import { unBigInt } from '../api-gen/_unbigint';

/**
 * Was this stream torn down on purpose?
 *
 * The stop button (Ai.CancelTurn) ends the gRPC stream with h2 CANCEL, and the relay's iterator
 * surfaces that as a ConnectError reading "[canceled] http/2 stream closed with error code
 * CANCEL (0x8)" — transport plumbing, shown verbatim in a red chat bubble (2026-08-10, user).
 * A cancellation the user asked for is not an error and deserves silence: the client already
 * painted its own "stopped" state the moment the button was pressed.
 */
export function isCancelledStream(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\[canceled\]|CANCEL \(0x8\)|code.*canceled/i.test(msg);
}

export type SseSend = (event: string, data: unknown) => void;

/** Parsed final AiResponse from the gRPC result event (mirrors the AiResponse wire shape). */
export interface ChatRelayResult {
  success?: boolean;
  reply?: string;
  executedActions?: unknown;
  toolResults?: unknown;
  libraryHits?: unknown;
  blocks?: unknown;
  suggestions?: unknown;
  pendingActions?: unknown;
  buildSession?: unknown;
  data?: unknown;
  error?: string;
  [k: string]: unknown;
}

/**
 * Shared SSE relay for both chat surfaces — admin (`/api/chat/stream`) and hub
 * (`/api/hub/[slug]/chat`). Consumes the gRPC stream (chunk / step / result / error) and
 * emits the browser SSE events. The result event's `data` is the Rust canonical message-data
 * (AiResponse::message_data_json) — forwarded verbatim, never re-derived (that re-derivation
 * was the buildSession/libraryHits drift between the two paths). Returns the parsed final
 * result so the caller can persist: admin saves to the conversations table, hub persists
 * Rust-side (append_system_message) so it discards the return.
 *
 * Surface-specific concerns stay in the route: auth (session vs api-token+origin), which RPC
 * to open, opts construction, keepalive/abort wiring, and error sentinels (hub's
 * UNAUTHORIZED_ORIGIN ad response).
 */
export async function relayChatStream(
  aiStream: AsyncIterable<unknown>,
  send: SseSend,
): Promise<ChatRelayResult | null> {
  let finalResult: ChatRelayResult | null = null;
  let stepIndex = 0;

  for await (const ev of aiStream) {
    const evt = unBigInt(ev) as { event?: { case?: string; value?: any } };
    const oneof = evt?.event;
    if (!oneof) continue;
    if (oneof.case === 'chunk') {
      const v = oneof.value;
      send('chunk', { type: v.eventType, content: v.content });
    } else if (oneof.case === 'step') {
      const v = oneof.value;
      send('step', {
        index: stepIndex,
        type: v.name,
        status: v.status,
        description: v.description ?? v.name,
        error: v.errorMessage ?? undefined,
      });
      if (v.status !== 'start') stepIndex++;
    } else if (oneof.case === 'result') {
      try {
        finalResult = JSON.parse(oneof.value.rawJson);
      } catch (e) {
        send('error', { error: `result JSON 파싱 실패: ${(e as Error).message}` });
      }
    } else if (oneof.case === 'error') {
      send('error', { error: oneof.value.errorMessage });
    }
  }

  if (finalResult) {
    const result = finalResult;
    // Canonical `data` from Rust — used verbatim. Fallback {} only for an older core without it.
    const data: Record<string, unknown> =
      result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : {};
    send('result', {
      success: result.success !== false,
      reply: typeof result.reply === 'string' ? result.reply : '',
      executedActions: result.executedActions,
      toolResults: result.toolResults,
      libraryHits: result.libraryHits,
      data,
      suggestions: result.suggestions,
      error: typeof result.error === 'string' ? result.error : undefined,
    });
  }
  return finalResult;
}
