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
