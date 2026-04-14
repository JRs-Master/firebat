import { INetworkPort } from '../../core/ports';
import { InfraResult } from '../../core/types';

/**
 * 가벼운 HTTP 요청을 처리하는 네트워크 어댑터.
 * Node 18+ 내장 fetch를 사용하여 별도의 Sandbox를 열지 않고 데이터를 긁어오거나 웹훅을 쏩니다.
 */
export class FetchNetworkAdapter implements INetworkPort {
  async fetch(url: string, options?: any): Promise<InfraResult<any>> {
    try {
      // 보안 추가 방어: 내부망 접근 금지 (127.0.0.x 등 방어 로직 추가 가능)
      if (url.includes('127.0.0.1') || url.includes('localhost')) {
         return { success: false, error: 'Access Denied: Cannot access localhost via Core NetworkPort.' };
      }

      const res = await fetch(url, options);
      
      // JSON 파싱 시도, 실패 시 텍스트 리턴
      const contentType = res.headers.get('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }

      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}: ${JSON.stringify(data)}` };
      }

      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
