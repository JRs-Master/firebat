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
import type { IDatabasePort } from '../ports';
import type { InfraResult } from '../types';
import { embed, cosine, float32ToBuffer, bufferToFloat32 } from '../../infra/llm/embedder';
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
}

const CONTENT_PREVIEW_MAX = 500;

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
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
  constructor(private readonly db: IDatabasePort) {}

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

  async save(owner: string, id: string, title: string, messages: unknown[], createdAt?: number): Promise<InfraResult<void>> {
    const now = Date.now();
    const created = createdAt ?? now;
    const messagesJson = JSON.stringify(messages ?? []);
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
    this.syncEmbeddings(owner, id, messages ?? []).catch(() => {});
    return { success: true };
  }

  async delete(owner: string, id: string): Promise<InfraResult<void>> {
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
      const hash = sha1(parsed.text);
      keepIdx.add(i);
      if (existing.get(i) === hash) continue; // 변경 없음

      // 임베딩 생성 (실패 시 스킵)
      try {
        const vec = await embed(parsed.text);
        const preview = parsed.text.slice(0, CONTENT_PREVIEW_MAX);
        const blob = float32ToBuffer(vec);
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

    // 배열 길이 줄어 사라진 msg_idx 제거
    for (const idx of existing.keys()) {
      if (!keepIdx.has(idx)) {
        await this.db.query(`DELETE FROM conversation_embeddings WHERE conv_id = ? AND msg_idx = ?`, [convId, idx]);
      }
    }
  }

  /**
   * 과거 대화 검색 — 쿼리 임베딩 ↔ 저장된 메시지 임베딩 cosine similarity
   * @param currentConvId 현재 활성 대화 ID. 같은 conv의 결과는 점수 +0.2 부스트 (우선 노출)
   */
  async searchHistory(
    owner: string,
    query: string,
    opts: { currentConvId?: string; limit?: number; withinDays?: number; minScore?: number } = {},
  ): Promise<InfraResult<HistorySearchMatch[]>> {
    const { currentConvId, limit = 5, withinDays = 60, minScore = 0.25 } = opts;
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
    try { qVec = await embed(query); }
    catch (e: any) { return { success: false, error: `임베딩 실패: ${e.message}` }; }

    const scored: HistorySearchMatch[] = rows.map(r => {
      const vec = bufferToFloat32(r.embedding);
      let score = cosine(qVec, vec);
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
    return { success: true, data: filtered };
  }
}
