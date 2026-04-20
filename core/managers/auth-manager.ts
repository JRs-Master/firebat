import type { IAuthPort, IVaultPort, AuthSession } from '../ports';
import { VK_ADMIN_ID, VK_ADMIN_PASSWORD } from '../vault-keys';

/** API 토큰 정보 (마스킹된 힌트 + 생성일) */
export interface ApiTokenInfo {
  exists: boolean;
  hint: string | null;     // 예: fbat_a1b2****k9m3
  label?: string;
  createdAt: string | null; // ISO 8601
}

/** 세션 토큰 유효기간 — 24시간 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Auth Manager — 통합 인증/토큰 관리
 *
 * - 로그인/로그아웃 (세션 토큰, 만료 있음)
 * - API 토큰 생성/검증/폐기 (MCP 등, 만료 없음)
 * - 관리자 자격증명 변경
 *
 * 인프라: IAuthPort (세션 저장), IVaultPort (자격증명 저장)
 */
export class AuthManager {
  constructor(
    private readonly auth: IAuthPort,
    private readonly vault: IVaultPort,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  //  로그인/로그아웃 (세션 토큰)
  // ══════════════════════════════════════════════════════════════════════════

  /** 자격증명 검증 후 세션 토큰 발급. 실패 시 null */
  login(id: string, password: string): AuthSession | null {
    const creds = this.getAdminCredentials();
    if (id === creds.id && password === creds.password) {
      return this.createSession('admin');
    }
    return null;
  }

  /** 세션 토큰 검증 — 유효한 세션 반환, 실패 시 null */
  validateSession(token: string): AuthSession | null {
    if (!token) return null;
    const session = this.auth.getSession(token);
    if (!session || session.type !== 'session') return null;
    return session;
  }

  /** 로그아웃 — 세션 삭제 */
  logout(token: string): boolean {
    return this.auth.deleteSession(token);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  API 토큰 (MCP 등, 만료 없음)
  // ══════════════════════════════════════════════════════════════════════════

  /** 새 API 토큰 생성. 기존 API 토큰 전부 폐기 후 새로 발급. 원본 1회 반환 */
  generateApiToken(label?: string): string {
    // 기존 API 토큰 전부 삭제
    this.auth.deleteSessions('api');

    const token = this.generateToken('fbat_');
    const session: AuthSession = {
      token,
      type: 'api',
      role: 'admin',
      label: label || 'MCP API',
      createdAt: Date.now(),
      // expiresAt 없음 = 영구
    };
    this.auth.saveSession(session);
    return token;
  }

  /** API 토큰 검증 */
  validateApiToken(token: string): AuthSession | null {
    if (!token) return null;
    const session = this.auth.getSession(token);
    if (!session || session.type !== 'api') return null;
    return session;
  }

  /** API 토큰 폐기 (전부) */
  revokeApiTokens(): number {
    return this.auth.deleteSessions('api');
  }

  /** API 토큰 정보 (마스킹) */
  getApiTokenInfo(): ApiTokenInfo {
    const sessions = this.auth.listSessions('api');
    if (sessions.length === 0) return { exists: false, hint: null, createdAt: null };
    const s = sessions[0];
    const hint = s.token.length > 12
      ? `${s.token.slice(0, 8)}****${s.token.slice(-4)}`
      : '****';
    return {
      exists: true,
      hint,
      label: s.label,
      createdAt: new Date(s.createdAt).toISOString(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  통합 토큰 검증 (세션 + API 모두)
  // ══════════════════════════════════════════════════════════════════════════

  /** 모든 종류의 토큰 검증 — 유효한 세션 반환 */
  validateToken(token: string): AuthSession | null {
    if (!token) return null;
    return this.auth.getSession(token);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  관리자 자격증명
  // ══════════════════════════════════════════════════════════════════════════

  getAdminCredentials(): { id: string; password: string } {
    const id       = this.vault.getSecret(VK_ADMIN_ID)       ?? process.env.FIREBAT_ADMIN_ID       ?? 'admin';
    const password = this.vault.getSecret(VK_ADMIN_PASSWORD) ?? process.env.FIREBAT_ADMIN_PASSWORD ?? 'admin';
    return { id, password };
  }

  setAdminCredentials(newId?: string, newPassword?: string): void {
    if (newId)       this.vault.setSecret(VK_ADMIN_ID, newId);
    if (newPassword) this.vault.setSecret(VK_ADMIN_PASSWORD, newPassword);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Private
  // ══════════════════════════════════════════════════════════════════════════

  private createSession(role: 'admin'): AuthSession {
    const session: AuthSession = {
      token: this.generateToken('fbat_'),
      type: 'session',
      role,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.auth.saveSession(session);
    return session;
  }

  private generateToken(prefix: string): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}${hex}`;
  }
}
