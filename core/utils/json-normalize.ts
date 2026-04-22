/**
 * JSON 정규화 유틸 — 이중·삼중 인코딩, 레거시 손상 데이터 자동 복구.
 *
 * 왜 필요한가:
 * - 같은 JSON 데이터가 경로마다 다른 타입으로 전달됨 (API object / MCP string / DB string)
 * - 중간에 JSON.stringify 가 두 번 호출되면 "{\"key\":...}" 로 double-encoding 발생
 * - 개별 호출 지점에서 `typeof === 'string'` 방어하는 건 하드코딩 중복
 *
 * 해법: 모든 JSON 경계에서 이 유틸을 호출 — 단일 source 로 정규화 규칙 관리.
 *
 * 적용 지점:
 * - Core facade (savePage 등): 외부 입력을 canonical 문자열로 정규화 후 infra 에 전달
 * - Infra adapter (getPage 등): DB 에서 꺼낸 값에 과거 손상 흔적 있으면 자동 복구
 * - Frontend FileEditor: 로드 시 display 용 안전 파싱
 */

/**
 * 값이 객체가 될 때까지 최대 maxDepth 회 JSON.parse 반복.
 *
 * - 이미 객체면 그대로 반환
 * - JSON 문자열이면 parse
 * - double-encoded 면 2번 parse
 * - 실패하면 throw
 *
 * @throws Error 정규 JSON 아니면
 */
export function unwrapJson<T = unknown>(value: unknown, maxDepth = 3): T {
  let v: unknown = value;
  for (let i = 0; i < maxDepth; i++) {
    if (typeof v !== 'string') break;
    try {
      v = JSON.parse(v);
    } catch {
      throw new Error(`Invalid JSON at unwrap depth ${i}: ${typeof value === 'string' ? value.slice(0, 80) : typeof value}`);
    }
  }
  if (typeof v === 'string') {
    throw new Error(`unwrapJson exceeded maxDepth=${maxDepth}, still string`);
  }
  return v as T;
}

/**
 * 입력을 object 로 정규화한 후 canonical JSON 문자열로 직렬화.
 *
 * 저장 경로 (DB insert 등) 에서 사용 — double-encoding 원천 차단.
 * 입력이 string 이어도 한 번 parse 후 re-stringify 하므로 결과는 항상 정상 JSON.
 *
 * @throws Error 정규 JSON 아니면
 */
export function canonicalJson(value: unknown): string {
  const obj = unwrapJson(value);
  return JSON.stringify(obj);
}

/**
 * unwrap 시도, 실패하면 null 반환 (조용히).
 *
 * Display / 선택적 파싱 용도 — 파싱 실패해도 UI 깨지면 안 되는 지점에서 사용.
 */
export function tryUnwrapJson<T = unknown>(value: unknown, maxDepth = 3): T | null {
  try { return unwrapJson<T>(value, maxDepth); }
  catch { return null; }
}
