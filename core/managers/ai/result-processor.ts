/**
 * ResultProcessor — AI 도구 호출 결과 축약·요약.
 *
 * AiManager 의 내부 collaborator (외부 import 금지). 순수 함수 모음.
 *
 * 책임:
 *   1. trimToolResult — Vertex 학습 데이터 저장 시 2000자 cap (파인튜닝 토큰 비용 절감).
 *   2. slimResultForLLM — 다음 turn LLM 컨텍스트로 넘길 결과 축약 (render 도구 props 탈거 등).
 *   3. aggressiveSummarize — 이전 턴 도구 결과 요약 (멀티턴 누적 비용 차단).
 *
 * 분리 이유: 순수 함수 3개라 AiManager state 의존 X. 단위 테스트 용이.
 */
import { RENDER_TOOL_MAP } from '../../../lib/render-map';

/** 학습 데이터 저장용 — 도구 결과 2000자 cap. 큰 응답은 핵심 필드만 남김. */
export function trimToolResult(result: Record<string, unknown>): Record<string, unknown> {
  const str = JSON.stringify(result);
  if (str.length <= 2000) return result;
  const trimmed: Record<string, unknown> = { success: result.success };
  if (result.error) trimmed.error = (result.error as string).slice(0, 500);
  if (result.content) trimmed.content = (result.content as string).slice(0, 1500);
  if (result.items && Array.isArray(result.items)) trimmed.items = `[${result.items.length} items]`;
  if (result.data) {
    const dataStr = JSON.stringify(result.data);
    trimmed.data = dataStr.length > 1500 ? dataStr.slice(0, 1500) + '...' : result.data;
  }
  return trimmed;
}

/**
 * LLM 컨텍스트로 들어갈 tool 결과 축약.
 *
 * @param aggressive true 면 render 외 tool (sysmod/mcp/network/execute) 결과도 요약으로 축소.
 *   멀티턴 루프에서 이전 턴 결과가 매 턴 재전송되는 걸 방지하기 위해, 현재 턴 호출 직전에
 *   이전 턴들을 aggressive=true 로 재슬림. 현재 턴 결과는 aggressive=false (AI 가 바로 써야 하므로 원본).
 */
export function slimResultForLLM(toolName: string, result: Record<string, unknown>, aggressive = false): Record<string, unknown> {
  if (!result) return result;
  // render(name, props) 디스패처: 컴포넌트별 요약 처리 — 내부 toolName 을 매핑된 render_* 로 재귀 축약
  if (toolName === 'render' && typeof result.component === 'string') {
    const comp = result.component as string;
    const invMap: Record<string, string> = Object.entries(RENDER_TOOL_MAP)
      .reduce((acc, [k, v]) => ({ ...acc, [v]: k }), {} as Record<string, string>);
    const mappedTool = invMap[comp];
    if (mappedTool) return slimResultForLLM(mappedTool, result);
    return { success: true, component: comp, summary: `${comp} 렌더 완료` };
  }
  // render_* 특별 처리: 대용량 props 탈거 + 메타만
  if (toolName === 'render_stock_chart') {
    const props = (result.props as Record<string, unknown>) || {};
    const data = Array.isArray(props.data) ? props.data as Array<Record<string, unknown>> : [];
    const closes = data.map(d => Number(d.close)).filter(n => Number.isFinite(n));
    const summary = data.length > 0
      ? `StockChart 렌더 완료 · ${props.symbol || ''} · ${data.length}개 OHLCV${closes.length ? ` · 최근 종가 ${closes[closes.length - 1]} · 최고 ${Math.max(...closes)} · 최저 ${Math.min(...closes)}` : ''}`
      : 'StockChart 렌더 완료';
    return { success: true, component: 'StockChart', summary };
  }
  if (toolName === 'render_table') {
    const props = (result.props as Record<string, unknown>) || {};
    const rows = Array.isArray(props.rows) ? (props.rows as unknown[]).length : 0;
    const headers = Array.isArray(props.headers) ? (props.headers as unknown[]).length : 0;
    return { success: true, component: 'Table', summary: `Table 렌더 완료 · ${headers}열 × ${rows}행` };
  }
  if (toolName === 'render_chart') {
    const props = (result.props as Record<string, unknown>) || {};
    const dataLen = Array.isArray(props.data) ? (props.data as unknown[]).length : 0;
    return { success: true, component: 'Chart', summary: `Chart 렌더 완료 · ${dataLen}개 포인트` };
  }
  if (toolName === 'render_iframe') {
    const len = typeof result.htmlContent === 'string' ? result.htmlContent.length : 0;
    return { success: true, component: 'Html', summary: `iframe 위젯 렌더 완료 · ${len}자` };
  }
  // 기타 render_* 도구는 component 이름 정도만 AI에 피드백
  if (RENDER_TOOL_MAP[toolName]) {
    return { success: true, component: RENDER_TOOL_MAP[toolName], summary: `${RENDER_TOOL_MAP[toolName]} 렌더 완료` };
  }
  // 그 외(sysmod_*, mcp_*, network_request, execute 등):
  // - 현재 턴: 원본 그대로 (AI 가 이번 턴 응답에서 바로 사용할 수 있도록)
  // - 이전 턴 (aggressive=true): 요약만 — 매 턴 재전송되는 대용량 데이터 차단 (비용↓)
  if (aggressive) {
    return aggressiveSummarize(result);
  }
  return result;
}

/** 이전 턴 tool 결과를 LLM 컨텍스트에서 최소 요약으로 축소.
 *  toolName 파라미터는 미사용 — 도구 종류 무관 일반 로직 (도메인별 분기 0). */
export function aggressiveSummarize(result: Record<string, unknown>): Record<string, unknown> {
  // 실패는 에러 메시지 유지 (AI 가 재시도 판단에 필요)
  if (result.success === false) {
    const err = typeof result.error === 'string' ? result.error.slice(0, 300) : 'unknown error';
    return { success: false, error: err };
  }
  // 성공: 상위 필드 키·타입·길이 정도만 노출 + 짧은 프리뷰
  const out: Record<string, unknown> = { success: true, _note: '이전 턴 결과 (원본은 축약됨). 필요시 해당 도구 재호출.' };
  const data = result.data;
  if (data && typeof data === 'object') {
    const dataStr = JSON.stringify(data);
    if (dataStr.length <= 500) {
      out.data = data; // 작으면 그대로
    } else {
      // 배열이면 길이와 첫 항목 키, 객체면 필드 키·타입 목록
      if (Array.isArray(data)) {
        const first = data[0];
        const keys = first && typeof first === 'object' ? Object.keys(first as Record<string, unknown>).slice(0, 10) : [];
        out._summary = `array length=${data.length}${keys.length ? `, item keys=[${keys.join(',')}]` : ''}`;
      } else {
        const keys = Object.keys(data as Record<string, unknown>).slice(0, 20);
        out._summary = `object keys=[${keys.join(',')}]`;
      }
      out._preview = dataStr.slice(0, 200) + '...';
    }
  } else if (typeof data === 'string') {
    out._preview = data.slice(0, 300) + (data.length > 300 ? '...' : '');
  } else if (data !== undefined) {
    out.data = data; // 숫자·boolean 등은 그대로
  }
  // 기타 상위 필드 (content, text 등) 도 짧게만
  for (const key of ['content', 'text', 'summary', 'message']) {
    const v = result[key];
    if (typeof v === 'string' && v.length > 0) {
      out[key] = v.length <= 300 ? v : v.slice(0, 300) + '...';
    }
  }
  return out;
}
