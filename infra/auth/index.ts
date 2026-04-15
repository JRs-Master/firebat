import type { IAuthPort, IVaultPort, AuthSession } from '../../core/ports';

const SESSION_PREFIX = 'auth:session:';

/**
 * Vault 기반 인증 어댑터
 *
 * AuthSession을 Vault에 JSON으로 저장한다.
 * 키 형식: auth:session:{token}
 */
export class VaultAuthAdapter implements IAuthPort {
  constructor(private readonly vault: IVaultPort) {}

  saveSession(session: AuthSession): boolean {
    return this.vault.setSecret(`${SESSION_PREFIX}${session.token}`, JSON.stringify(session));
  }

  getSession(token: string): AuthSession | null {
    const raw = this.vault.getSecret(`${SESSION_PREFIX}${token}`);
    if (!raw) return null;
    try {
      const session: AuthSession = JSON.parse(raw);
      // 만료 검사
      if (session.expiresAt && Date.now() > session.expiresAt) {
        this.deleteSession(token);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  deleteSession(token: string): boolean {
    return this.vault.deleteSecret(`${SESSION_PREFIX}${token}`);
  }

  listSessions(type: 'session' | 'api'): AuthSession[] {
    const keys = this.vault.listKeysByPrefix(SESSION_PREFIX);
    const sessions: AuthSession[] = [];
    for (const key of keys) {
      const raw = this.vault.getSecret(key);
      if (!raw) continue;
      try {
        const session: AuthSession = JSON.parse(raw);
        if (session.type !== type) continue;
        // 만료된 세션 자동 정리
        if (session.expiresAt && Date.now() > session.expiresAt) {
          this.vault.deleteSecret(key);
          continue;
        }
        sessions.push(session);
      } catch {}
    }
    return sessions;
  }

  deleteSessions(type: 'session' | 'api'): number {
    const keys = this.vault.listKeysByPrefix(SESSION_PREFIX);
    let count = 0;
    for (const key of keys) {
      const raw = this.vault.getSecret(key);
      if (!raw) continue;
      try {
        const session: AuthSession = JSON.parse(raw);
        if (session.type === type) {
          this.vault.deleteSecret(key);
          count++;
        }
      } catch {}
    }
    return count;
  }
}
