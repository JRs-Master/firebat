import type { IAuthPort, IVaultPort, AuthSession } from '../ports';
import { VK_ADMIN_ID, VK_ADMIN_PASSWORD } from '../vault-keys';
import * as nodeCrypto from 'crypto';

/** API 토큰 정보 (마스킹된 힌트 + 생성일) */
export interface ApiTokenInfo {
  exists: boolean;
  hint: string | null;     // 예: fbat_a1b2****k9m3
  label?: string;
  createdAt: string | null; // ISO 8601
}

/** 세션 토큰 유효기간 — 24시간 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Brute force 방지 — IP·계정 조합당 N회 실패 시 lockMs 동안 잠금. 일반 로직, 도메인별 분기 X. */
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;       // 60초 잠금
const LOGIN_FAIL_DECAY_MS = 10 * 60 * 1000;  // 10분 무행동 시 카운터 리셋

interface LoginAttemptState {
  failCount: number;
  lockedUntil: number;     // 0 = 잠금 안 됨
  lastAttemptAt: number;
}

/** 시간 안정 문자열 비교 — id/password 비교 시 timing attack 방지.
 *  길이 비교 자체가 누설일 수 있어 padding 후 timingSafeEqual.  */
function timingSafeStringEqual(a: string, b: string): boolean {
  // 길이 다르면 padding 후 비교 (mismatch 보장 + 동일 시간).
  const max = Math.max(a.length, b.length, 1);
  const ab = Buffer.from(a.padEnd(max, '\0'));
  const bb = Buffer.from(b.padEnd(max, '\0'));
  if (ab.length !== bb.length) return false;
  const equal = nodeCrypto.timingSafeEqual(ab, bb);
  // 길이 mismatch 는 mismatch 로 처리 (timingSafeEqual 거친 후 비트마스크).
  return equal && a.length === b.length;
}

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
  /** 로그인 실패 카운트 — key 는 ip 또는 'global' (옵션 제공자가 키 선택).
   *  메모리 저장 — restart 시 리셋. 영속까지는 v1.x. */
  private loginAttempts = new Map<string, LoginAttemptState>();

  constructor(
    private readonly auth: IAuthPort,
    private readonly vault: IVaultPort,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  //  로그인/로그아웃 (세션 토큰)
  // ══════════════════════════════════════════════════════════════════════════

  /** 자격증명 검증 후 세션 토큰 발급. 실패 시 null.
   *  attemptKey: 호출자 (route handler) 가 IP 등 식별자 전달. 미전달 시 'global' (전체 합산 — 1인 운영 OK).
   *  반환 null + lockedSec: 잠겼으면 caller 가 429 응답으로 변환.
   *  순수 비교 로직: timing-safe + lock 카운터. 도메인별 특수 처리 X. */
  login(id: string, password: string, attemptKey: string = 'global'): AuthSession | { locked: true; retryAfterSec: number } | null {
    const now = Date.now();
    const state = this.loginAttempts.get(attemptKey);

    // 잠금 상태 체크
    if (state && state.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) };
    }
    // 일정 시간 무행동 시 카운터 리셋 (정상 사용자가 가끔 실수해도 영향 없음)
    if (state && now - state.lastAttemptAt > LOGIN_FAIL_DECAY_MS) {
      state.failCount = 0;
      state.lockedUntil = 0;
    }

    const creds = this.getAdminCredentials();
    const idMatch = timingSafeStringEqual(id ?? '', creds.id);
    const pwMatch = timingSafeStringEqual(password ?? '', creds.password);
    const ok = idMatch && pwMatch;

    if (ok) {
      // 성공 시 카운터 리셋
      this.loginAttempts.delete(attemptKey);
      return this.createSession('admin');
    }

    // 실패 처리 — 카운터 증가, 한도 초과 시 lockedUntil 설정
    const updated: LoginAttemptState = state ?? { failCount: 0, lockedUntil: 0, lastAttemptAt: now };
    updated.failCount += 1;
    updated.lastAttemptAt = now;
    if (updated.failCount >= LOGIN_FAIL_LIMIT) {
      updated.lockedUntil = now + LOGIN_LOCK_MS;
      updated.failCount = 0;  // 잠금 시작 시 카운터 리셋 — 잠금 해제 후 다시 5회 시도 가능
    }
    this.loginAttempts.set(attemptKey, updated);

    if (updated.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.ceil((updated.lockedUntil - now) / 1000) };
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
