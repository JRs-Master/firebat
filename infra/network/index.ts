import { INetworkPort, NetworkRequestOptions, NetworkResponse } from '../../core/ports';
import { InfraResult } from '../../core/types';

/**
 * 가벼운 HTTP 요청을 처리하는 네트워크 어댑터.
 * Node 18+ 내장 fetch를 사용하여 별도의 Sandbox를 열지 않고 데이터를 긁어오거나 웹훅을 쏩니다.
 */
export class FetchNetworkAdapter implements INetworkPort {
  async fetch(url: string, options?: NetworkRequestOptions): Promise<InfraResult<NetworkResponse>> {
    try {
      // 보안 추가 방어: 내부망 접근 금지 (127.0.0.x 등 방어 로직 추가 가능)
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
