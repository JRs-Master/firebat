/**
 * ConversationManager — 관리자 채팅 대화를 DB에 저장/조회
 *
 * admin 계정은 다기기 동기화를 위해 대화를 conversations 테이블에 보관.
 * demo 등 다른 역할은 이 매니저를 사용하지 않고 클라이언트 localStorage만 사용.
 */
import type { IDatabasePort } from '../ports';
import type { InfraResult } from '../types';

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord extends ConversationSummary {
  messages: unknown[];
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
    return { success: true };
  }

  async delete(owner: string, id: string): Promise<InfraResult<void>> {
    const res = await this.db.query(
      `DELETE FROM conversations WHERE owner = ? AND id = ?`,
      [owner, id],
    );
    if (!res.success) return { success: false, error: res.error };
    return { success: true };
  }
}
