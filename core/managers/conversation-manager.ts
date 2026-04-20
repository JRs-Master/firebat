/**
 * ConversationManager — 관리자 채팅 대화를 DB에 저장/조회
 *
 * admin 계정은 다기기 동기화를 위해 대화를 conversations 테이블에 보관.
 * demo 등 다른 역할은 이 매니저를 사용하지 않고 클라이언트 localStorage만 사용.
 *
 * 추가: 메시지 단위 벡터 임베딩으로 과거 대화 search_history 도구 지원.
 * - 저장 시 변경된 메시지만 임베딩 (content_hash 비교)
 * - 메시지 삭제 시 해당 msg_idx 이상 row 제거
 * - 검색 시 owner + 현재 대화 우선 부스트
 */
import type { IDatabasePort, IEmbedderPort } from '../ports';
import type { InfraResult } from '../types';
import crypto from 'crypto';

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord extends ConversationSummary {
  messages: unknown[];
}

export interface HistorySearchMatch {
  convId: string;
  convTitle?: string;
  msgIdx: number;
  role: string;
  contentPreview: string;
  createdAt: number;
  score: number;
  /** includeBlocks=true 시 AI 메시지의 원본 blocks 반환 (component/html 블록의 props·htmlContent 포함).
   *  AI 가 과거 차트·표 데이터를 재조회 없이 재활용할 때 사용. */
  blocks?: unknown[];
}

const CONTENT_PREVIEW_MAX = 500;

function sha1(embedVersion: string, s: string): string {
  // 임베딩 모델 버전을 해시에 섞어서 모델 교체 시 기존 저장분 전체 재임베딩 유도
  return crypto.createHash('sha1').update(`${embedVersion}:${s}`, 'utf8').digest('hex');
}

/** 메시지 객체에서 검색 가능한 텍스트 추출 */
function messageToText(msg: unknown): { role: string; text: string } | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  const role = typeof m.role === 'string' ? m.role : 'unknown';
  // content (최우선) + 안 되면 content에서 데이터 제외한 blocks.text
  let text = '';
  if (typeof m.content === 'string' && m.content.trim()) {
    text = m.content;
  } else if (m.data && typeof m.data === 'object') {
    const blocks = (m.data as Record<string, unknown>).blocks;
    if (Array.isArray(blocks)) {
      text = blocks
        .filter(b => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
        .map(b => (b as Record<string, unknown>).text)
        .filter(t => typeof t === 'string')
        .join('\n');
    }
  }
  if (!text.trim()) return null;
  // 시스템 메시지·진행 중·에러만 있는 메시지는 스킵
  if (role === 'unknown') return null;
  return { role, text };
}

export class ConversationManager {
  constructor(
    private readonly db: IDatabasePort,
    private readonly embedder: IEmbedderPort,
  ) {}

  async list(owner: string): Promise<InfraResult<ConversationSummary[]>> {
    const res = await this.db.query(
      `SELECT id, title, created_at as createdAt, updated_at as updatedAt
       FROM conversations WHERE owner = ? ORDER BY updated_at DESC`,
      [owner],
    );
    if (!res.success) return { success: false, error: res.error };
    const rows = (res.data ?? []) as Array<{ id: string; title: string; createdAt: number; updatedAt: number }>;
    return { success: true, data: rows };
  }

  async get(owner: string, id: string): Promise<InfraResult<ConversationRecord>> {
    const res = await this.db.query(
      `SELECT id, title, messages, created_at as createdAt, updated_at as updatedAt
       FROM conversations WHERE owner = ? AND id = ?`,
      [owner, id],
    );
    if (!res.success) return { success: false, error: res.error };
    const rows = (res.data ?? []) as Array<{ id: string; title: string; messages: string; createdAt: number; updatedAt: number }>;
    if (rows.length === 0) return { success: false, error: 'Conversation not found' };
    const r = rows[0];
    let messages: unknown[] = [];
    try { messages = JSON.parse(r.messages); } catch { messages = []; }
    return { success: true, data: { id: r.id, title: r.title, messages, createdAt: r.createdAt, updatedAt: r.updatedAt } };
  }

  /**
   * 메시지 ID 기준 union merge 저장:
   *  - 기존 DB 메시지와 incoming 을 m.id 로 합집합
   *  - 동일 id 존재 시 incoming 쪽 우선 (예: 스트리밍 중 블록 업데이트)
   *  - id 없는 메시지는 그대로 append (구버전 호환)
   *  - PC와 모바일이 동시에 서로 다른 메시지를 보내도 양쪽 다 보존됨
   */
  async save(owner: string, id: string, title: string, messages: unknown[], createdAt?: number): Promise<InfraResult<void>> {
    const now = Date.now();
    const created = createdAt ?? now;
    const incoming = messages ?? [];

    // 기존 messages 읽기 (있으면 merge, 없으면 신규)
    const existingRes = await this.db.query(
      `SELECT messages FROM conversations WHERE id = ? AND owner = ?`,
      [id, owner],
    );
    let mergedMessages: unknown[] = incoming;
    if (existingRes.success && existingRes.data && existingRes.data.length > 0) {
      try {
        const existing = JSON.parse((existingRes.data[0].messages as string) || '[]') as unknown[];
        mergedMessages = this.unionMergeMessages(existing, incoming);
      } catch { /* 파싱 실패 시 incoming 그대로 사용 */ }
    }

    const messagesJson = JSON.stringify(mergedMessages);
    const res = await this.db.query(
      `INSERT INTO conversations (id, owner, title, messages, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         messages = excluded.messages,
         updated_at = excluded.updated_at`,
      [id, owner, title, messagesJson, created, now],
    );
    if (!res.success) return { success: false, error: res.error };

    // 메시지 임베딩 업서트 (변경·신규만) — 실패해도 저장 자체는 성공으로 반환
    this.syncEmbeddings(owner, id, mergedMessages).catch(() => {});
    return { success: true };
  }

  /**
   * 메시지 ID 기준 union merge — 동일 id 는 incoming 우선.
   * merge 후 id 의 timestamp 로 시간순 정렬 — 다기기 out-of-order 저장 시 순서 꼬임 방지.
   * (id 형식: "u-${Date.now()}" / "s-${Date.now()}" / "system-init" 등)
   */
  private unionMergeMessages(existing: unknown[], incoming: unknown[]): unknown[] {
    const getId = (m: unknown): string | null => {
      if (!m || typeof m !== 'object') return null;
      const id = (m as Record<string, unknown>).id;
      return typeof id === 'string' && id ? id : null;
    };
    // id 의 숫자 부분 (timestamp) 추출 — "u-1776559416890" → 1776559416890
    const getTs = (id: string | null): number => {
      if (!id) return 0;
      const m = id.match(/(\d{10,})/);
      return m ? parseInt(m[1], 10) : 0;
    };
    // 모든 메시지 union (같은 id 면 incoming 우선)
    const byId = new Map<string, unknown>();
    const noIdMsgs: unknown[] = [];
    for (const m of existing) {
      const mid = getId(m);
      if (mid) byId.set(mid, m);
      else noIdMsgs.push(m);
    }
    for (const m of incoming) {
      const mid = getId(m);
      if (mid) byId.set(mid, m);
      else if (!noIdMsgs.includes(m)) noIdMsgs.push(m);
    }
    // timestamp 순으로 정렬 (id 에 ts 없으면 맨 앞/뒤 배치)
    const withId = Array.from(byId.entries())
      .map(([id, msg]) => ({ id, msg, ts: getTs(id) }))
      .sort((a, b) => a.ts - b.ts)
      .map(x => x.msg);
    // id 없는 메시지는 그대로 뒤에 (순서 불확실하지만 보존)
    return [...withId, ...noIdMsgs];
  }

  async delete(owner: string, id: string): Promise<InfraResult<void>> {
    // tombstone 기록 먼저 — 이후 오는 stale POST 를 서버에서 거부할 근거
    await this.db.query(
      `INSERT INTO deleted_conversations (id, owner, deleted_at) VALUES (?, ?, ?)
       ON CONFLICT(id, owner) DO UPDATE SET deleted_at = excluded.deleted_at`,
      [id, owner, Date.now()],
    );
    const res = await this.db.query(
      `DELETE FROM conversations WHERE owner = ? AND id = ?`,
      [owner, id],
    );
    if (!res.success) return { success: false, error: res.error };
    // 임베딩도 함께 정리
    await this.db.query(`DELETE FROM conversation_embeddings WHERE conv_id = ? AND owner = ?`, [id, owner]);
    return { success: true };
  }

  /**
   * CLI 모드 세션 ID 조회 (현재 모델 매칭 시에만 반환 — 모델 바뀌면 null)
   */
  async getCliSession(id: string, currentModel: string): Promise<{ sessionId: string; model: string } | null> {
    const res = await this.db.query(
      `SELECT cli_session_id as sessionId, cli_model as model FROM conversations WHERE id = ?`,
      [id],
    );
    if (!res.success || !res.data || res.data.length === 0) return null;
    const r = res.data[0] as { sessionId: string | null; model: string | null };
    if (!r.sessionId || !r.model) return null;
    if (r.model !== currentModel) return null; // 모델 바뀌면 세션 무효
    return { sessionId: r.sessionId, model: r.model };
  }

  /** CLI 세션 ID 저장 (첫 호출 시 핸들러가 캡처한 session_id 를 영속화) */
  async setCliSession(id: string, sessionId: string, model: string): Promise<void> {
    await this.db.query(
      `UPDATE conversations SET cli_session_id = ?, cli_model = ? WHERE id = ?`,
      [sessionId, model, id],
    );
  }

  /** CLI 세션 초기화 (모델 변경·오류 시) */
  async clearCliSession(id: string): Promise<void> {
    await this.db.query(
      `UPDATE conversations SET cli_session_id = NULL, cli_model = NULL WHERE id = ?`,
      [id],
    );
  }

  /** 삭제 기록 여부 확인 — POST (save) 진입 시 tombstone 체크용 */
  async isDeleted(owner: string, id: string): Promise<boolean> {
    const res = await this.db.query(
      `SELECT 1 FROM deleted_conversations WHERE owner = ? AND id = ? LIMIT 1`,
      [owner, id],
    );
    return !!(res.success && res.data && res.data.length > 0);
  }

  /**
   * 메시지 배열과 기존 임베딩 비교 → 변경·신규만 재임베딩, 제거된 인덱스는 삭제
   */
  private async syncEmbeddings(owner: string, convId: string, messages: unknown[]): Promise<void> {
    // 기존 행 로드
    const existingRes = await this.db.query(
      `SELECT msg_idx as msgIdx, content_hash as contentHash FROM conversation_embeddings WHERE conv_id = ? AND owner = ?`,
      [convId, owner],
    );
    if (!existingRes.success) return;
    const existing = new Map<number, string>();
    for (const r of (existingRes.data ?? []) as Array<{ msgIdx: number; contentHash: string }>) {
      existing.set(r.msgIdx, r.contentHash);
    }

    const now = Date.now();
    const keepIdx = new Set<number>();

    for (let i = 0; i < messages.length; i++) {
      const parsed = messageToText(messages[i]);
      if (!parsed) continue;
      const hash = sha1(this.embedder.version, parsed.text);
      keepIdx.add(i);
      if (existing.get(i) === hash) continue; // 변경 없음

      // 임베딩 생성 (실패 시 스킵) — 저장된 메시지는 passage 프리픽스
      try {
        const vec = await this.embedder.embedPassage(parsed.text);
        const preview = parsed.text.slice(0, CONTENT_PREVIEW_MAX);
        const blob = this.embedder.float32ToBuffer(vec);
        await this.db.query(
          `INSERT INTO conversation_embeddings (conv_id, owner, msg_idx, role, content_hash, content_preview, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(conv_id, msg_idx) DO UPDATE SET
             role = excluded.role,
             content_hash = excluded.content_hash,
             content_preview = excluded.content_preview,
             embedding = excluded.embedding,
             created_at = excluded.created_at`,
          [convId, owner, i, parsed.role, hash, preview, blob, now],
        );
      } catch { /* 임베딩 실패 시 해당 메시지 스킵 */ }
    }

    // 배열 길이 줄어 사라진 msg_idx 제거 (한 쿼리로 일괄 삭제)
    const toDelete = [...existing.keys()].filter(idx => !keepIdx.has(idx));
    if (toDelete.length > 0) {
      const placeholders = toDelete.map(() => '?').join(',');
      await this.db.query(
        `DELETE FROM conversation_embeddings WHERE conv_id = ? AND msg_idx IN (${placeholders})`,
        [convId, ...toDelete],
      );
    }
  }

  /**
   * 과거 대화 검색 — 쿼리 임베딩 ↔ 저장된 메시지 임베딩 cosine similarity
   * @param currentConvId 현재 활성 대화 ID. 같은 conv의 결과는 점수 +0.2 부스트 (우선 노출)
   */
  async searchHistory(
    owner: string,
    query: string,
    opts: { currentConvId?: string; limit?: number; withinDays?: number; minScore?: number; includeBlocks?: boolean } = {},
  ): Promise<InfraResult<HistorySearchMatch[]>> {
    const { currentConvId, limit = 5, withinDays = 60, minScore = 0.25, includeBlocks = false } = opts;
    if (!query.trim()) return { success: true, data: [] };

    const cutoff = Date.now() - withinDays * 86400000;
    const rowsRes = await this.db.query(
      `SELECT e.conv_id as convId, c.title as convTitle, e.msg_idx as msgIdx, e.role, e.content_preview as contentPreview, e.embedding, e.created_at as createdAt
       FROM conversation_embeddings e LEFT JOIN conversations c ON c.id = e.conv_id
       WHERE e.owner = ? AND e.created_at >= ?`,
      [owner, cutoff],
    );
    if (!rowsRes.success) return { success: false, error: rowsRes.error };
    const rows = (rowsRes.data ?? []) as Array<{ convId: string; convTitle: string; msgIdx: number; role: string; contentPreview: string; embedding: Buffer; createdAt: number }>;
    if (rows.length === 0) return { success: true, data: [] };

    let qVec: Float32Array;
    try { qVec = await this.embedder.embedQuery(query); }
    catch (e: any) { return { success: false, error: `임베딩 실패: ${e.message}` }; }

    const scored: HistorySearchMatch[] = rows.map(r => {
      const vec = this.embedder.bufferToFloat32(r.embedding);
      let score = this.embedder.cosine(qVec, vec);
      if (currentConvId && r.convId === currentConvId) score += 0.2; // 현재 대화 부스트
      return {
        convId: r.convId,
        convTitle: r.convTitle,
        msgIdx: r.msgIdx,
        role: r.role,
        contentPreview: r.contentPreview,
        createdAt: r.createdAt,
        score,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const filtered = scored.filter(s => s.score >= minScore).slice(0, limit);

    // includeBlocks: 매칭된 메시지의 원본 blocks 로드 (component/html 블록의 props 포함)
    if (includeBlocks && filtered.length > 0) {
      // conv 단위로 묶어서 한 번에 로드 (같은 conv 의 여러 msg 있을 때 중복 조회 방지)
      const byConv = new Map<string, HistorySearchMatch[]>();
      for (const m of filtered) {
        const arr = byConv.get(m.convId) ?? [];
        arr.push(m);
        byConv.set(m.convId, arr);
      }
      for (const [convId, matches] of byConv) {
        const convRes = await this.db.query(
          `SELECT messages FROM conversations WHERE id = ? AND owner = ?`,
          [convId, owner],
        );
        if (!convRes.success || !convRes.data || convRes.data.length === 0) continue;
        try {
          const messages = JSON.parse((convRes.data[0].messages as string) || '[]') as unknown[];
          for (const m of matches) {
            const msg = messages[m.msgIdx] as Record<string, unknown> | undefined;
            if (msg && msg.data && typeof msg.data === 'object') {
              const blocks = (msg.data as Record<string, unknown>).blocks;
              if (Array.isArray(blocks)) m.blocks = blocks;
            }
          }
        } catch { /* 파싱 실패 시 blocks 없이 반환 */ }
      }
    }

    return { success: true, data: filtered };
  }
}
