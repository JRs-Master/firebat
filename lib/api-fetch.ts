/**
 * Typed fetch wrapper — Phase 7 정공 (2026-05-13).
 *
 * 옛 raw fetch + JSON parse + 에러 처리 boilerplate (~73곳) 통합.
 *
 * 특징:
 *  - typed return (제너릭 T)
 *  - HTTP 에러 자동 throw (React Query 의 error state 자연 동작)
 *  - JSON 자동 parse
 *  - logger 통합 (Phase 2 logger.error)
 *
 * 사용 패턴:
 *   import { apiGet, apiPost } from '@/lib/api-fetch';
 *
 *   const data = await apiGet<{ pages: Page[] }>('/api/pages');
 *   const result = await apiPost<{ success: boolean }>('/api/pages', { slug, spec });
 *
 * React Query 사용 시:
 *   useQuery({ queryKey: ['pages'], queryFn: () => apiGet<...>('/api/pages') });
 */

import { logger } from './util/logger';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiFetchOpts extends RequestInit {
  /** body 자동 JSON.stringify. raw body 필요 시 RequestInit.body 직접 set + jsonBody 미지정. */
  jsonBody?: unknown;
  /** logger category — 기본 'api'. 호출 site 명시 권장 (예: 'sidebar' / 'cron'). */
  category?: string;
}

/**
 * 세션 만료 → 로그인 페이지로. 옛엔 401 을 그냥 에러 메시지("권한 없음")로 띄워, 사용자가
 * 왜 안 되는지 모른 채 채팅·설정에서 막혔다(2026-07-29 지적). 만료는 오류가 아니라 **상태**라
 * 화면이 그 상태로 가야 한다.
 *
 * 리디렉션하지 않는 경우: ① 서버 사이드 ② 이미 로그인 화면 ③ **hub** — hub 는 토큰 인증이라
 * 방문자를 admin 로그인으로 보내면 안 된다. `next` 로 돌아올 위치를 남긴다.
 *
 * hub 판정은 **지금 보고 있는 화면**으로 한다. 옛 판정은 URL 이 `/api/hub/` 인지였는데, hub 콘솔은
 * admin 콘솔과 같은 컴포넌트라 admin 전용 라우트를 부르는 순간 그 검사를 비켜 간다 — 2026-08-05,
 * 승인 대기 뱃지가 hub 에서 20초마다 `/api/plan/pending` 을 불러 방문자를 로그인 화면으로 튕겼다.
 * 그 호출 자체를 안 하게 막는 게 1차 수정이고, 이건 **다음 것도 같은 식으로 못 새게** 하는 쪽이다:
 * hub 화면에 있는 사람은 무엇이 401 을 내든 admin 로그인으로 가지 않는다.
 */
export function redirectToLoginIfExpired(url: string, status: number): boolean {
  if (status !== 401) return false;
  if (typeof window === 'undefined') return false;
  if (url.includes('/api/hub/')) return false;
  const here = window.location.pathname;
  if (here === '/hub' || here.startsWith('/hub/')) return false;
  if (here.startsWith('/login')) return false;
  const next = encodeURIComponent(here + window.location.search);
  window.location.assign(`/login?next=${next}`);
  return true;
}

async function apiFetch<T>(url: string, opts: ApiFetchOpts = {}): Promise<T> {
  const { jsonBody, category = 'api', body: rawBody, ...init } = opts;
  const headers = new Headers(init.headers);
  if (jsonBody !== undefined) headers.set('Content-Type', 'application/json');
  const body = jsonBody !== undefined ? JSON.stringify(jsonBody) : rawBody;

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, body });
  } catch (err) {
    logger.error(category, `fetch 네트워크 실패 (${url})`, err);
    throw new ApiError(
      err instanceof Error ? err.message : '네트워크 실패',
      0,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    logger.error(category, `response body read 실패 (${url})`, err);
    throw new ApiError('응답 본문 읽기 실패', response.status);
  }

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // JSON 아닌 응답 — raw text 그대로 (T = string 케이스)
    parsed = text;
  }

  if (!response.ok) {
    // 만료면 여기서 화면이 떠난다 — 아래 throw 는 이동 전 잔여 처리를 위해 그대로 둔다.
    redirectToLoginIfExpired(url, response.status);
    const errorMsg =
      (parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string')
        ? parsed.error
        : `HTTP ${response.status}`;
    throw new ApiError(errorMsg, response.status, parsed);
  }

  return parsed as T;
}

/** GET — query string 은 lib/util/url.ts::buildPath 또는 직접 URL 작성. */
export function apiGet<T>(url: string, opts?: ApiFetchOpts): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: 'GET' });
}

export function apiPost<T>(url: string, jsonBody?: unknown, opts?: ApiFetchOpts): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: 'POST', jsonBody });
}

export function apiPut<T>(url: string, jsonBody?: unknown, opts?: ApiFetchOpts): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: 'PUT', jsonBody });
}

export function apiPatch<T>(url: string, jsonBody?: unknown, opts?: ApiFetchOpts): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: 'PATCH', jsonBody });
}

export function apiDelete<T = void>(url: string, opts?: ApiFetchOpts): Promise<T> {
  return apiFetch<T>(url, { ...opts, method: 'DELETE' });
}
