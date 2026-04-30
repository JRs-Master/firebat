/**
 * render_* 도구 이름 → 컴포넌트 타입 매핑 단일 source.
 *
 * AI 가 render_table / render_chart / render_alert 등 호출 시
 * 어떤 컴포넌트로 렌더할지 결정. mcp/internal-server.ts 의 makeRender 호출과 매칭됨.
 *
 * 이전: ai-manager / cli-gemini / cli-claude-code / cli-codex
 *      4군데에 동일 매핑 hardcoded → 새 컴포넌트 추가 시 네 군데 수정.
 * 변경: 이 파일 한 곳만 수정 → 자동 반영.
 */

export const RENDER_TOOL_MAP: Record<string, string> = {
  render_stock_chart: 'StockChart',
  render_table: 'Table',
  render_alert: 'Alert',
  render_callout: 'Callout',
  render_badge: 'Badge',
  render_progress: 'Progress',
  render_header: 'Header',
  render_text: 'Text',
  render_list: 'List',
  render_divider: 'Divider',
  render_countdown: 'Countdown',
  render_chart: 'Chart',
  render_image: 'Image',
  render_card: 'Card',
  render_grid: 'Grid',
  render_metric: 'Metric',
  render_timeline: 'Timeline',
  render_compare: 'Compare',
  render_key_value: 'KeyValue',
  render_status_badge: 'StatusBadge',
  render_map: 'Map',
  render_diagram: 'Diagram',
  render_math: 'Math',
  render_code: 'Code',
  render_slideshow: 'Slideshow',
  render_lottie: 'Lottie',
  render_network: 'Network',
};

/** 변형 매칭 helper — AI 가 다양한 형태로 호출해도 자동 정규화.
 *  - 'render_table' (정확) → 'render_table'
 *  - 'render-table' (kebab) → 'render_table'
 *  - 'table' (접두사 누락) → 'render_table'
 *  - 'mcp_firebat_render_table' (Gemini CLI prefix) → 'render_table' (먼저 prefix 제거 필요)
 */
export function normalizeRenderName(name: string): string | null {
  if (!name) return null;
  const stripped = name.trim();
  // 정확 매칭
  if (RENDER_TOOL_MAP[stripped]) return stripped;
  // kebab → snake
  const snake = stripped.replace(/-/g, '_');
  if (RENDER_TOOL_MAP[snake]) return snake;
  // render_ 접두사 누락 시 자동 추가
  if (RENDER_TOOL_MAP[`render_${snake}`]) return `render_${snake}`;
  return null;
}
