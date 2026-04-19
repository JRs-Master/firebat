import { INetworkPort, NetworkRequestOptions, NetworkResponse } from '../../core/ports';
import { InfraResult } from '../../core/types';

/**
 * 가벼운 HTTP 요청을 처리하는 네트워크 어댑터.
 * Node 18+ 내장 fetch를 사용하여 별도의 Sandbox를 열지 않고 데이터를 긁어오거나 웹훅을 쏩니다.
 */
export class FetchNetworkAdapter implements INetworkPort {
  async fetch(url: string, options?: NetworkRequestOptions): Promise<InfraResult<NetworkResponse>> {
    try {
      // http(s) 프로토콜만 허용 — file://, ftp://, data: 등은 거부
      //  · file:// 은 로컬 파일 읽기 우회 (Claude Code 가 자기 캐시 경로 접근 시도했던 사례)
      //  · data: 는 임의 바이트 로딩에 오용될 수 있음
      const lower = url.trim().toLowerCase();
      if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
        return { success: false, error: `지원하지 않는 URL 프로토콜: ${url.slice(0, 30)}... (http/https 만 허용)` };
      }
      // 내부망 접근 금지 (localhost·127.0.0.x)
      if (url.includes('127.0.0.1') || url.includes('localhost')) {
         return { success: false, error: 'Access Denied: Cannot access localhost via Core NetworkPort.' };
      }

      const fetchOpts: RequestInit = {};
      if (options?.method) fetchOpts.method = options.method;
      if (options?.headers) fetchOpts.headers = options.headers;
      if (options?.body) {
        fetchOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }

      const res = await fetch(url, fetchOpts);

      // JSON 파싱 시도, 실패 시 텍스트 리턴
      const contentType = res.headers.get('content-type') || '';
      let data: string | Record<string, unknown>;
      if (contentType.includes('application/json')) {
        data = await res.json() as Record<string, unknown>;
      } else {
        data = await res.text();
      }

      // 응답 헤더를 Record로 변환
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}` };
      }

      return { success: true, data: { status: res.status, headers: responseHeaders, data } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
