/**
 * CONDITION 평가 — pipeline CONDITION step + cron oneShot 자동 취소 양쪽에서 사용.
 *
 * 이전엔 task-manager.ts + schedule-manager.ts 에 inline 중복 구현.
 * 두 구현 사이에 미묘한 차이 (bothNumeric 가드·비숫자 `<` 처리·exists 의 빈 문자열) 가 있어
 * 자동매매 운영 시 silent inconsistency 위험. 일반 로직으로 단일화.
 *
 * 안전 정책 (자동매매 컨텍스트 우선):
 *   - 비숫자 `<`/`<=`/`>`/`>=` 는 false 반환 (string compare 안 함 — undefined 동작 회피)
 *   - 빈 문자열은 'exists' 에서 not exists 로 간주 (빈 응답 = 데이터 없음)
 *   - 양쪽이 number 로 변환 가능하면 숫자 비교 (string equality 우선 검사 안 함)
 *
 * BIBLE 호환: pure 함수 (의존성 0). core/utils/ 위치 — Core·Manager 양쪽에서 import.
 */

export type ConditionOp =
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | 'includes' | 'not_includes'
  | 'exists' | 'not_exists';

/** CONDITION 비교 — actual vs expected 를 op 로 평가.
 *  expected 미지정 (exists / not_exists) 시 actual 만 검사. */
export function evaluateCondition(
  actual: unknown,
  op: ConditionOp | string,
  expected?: unknown,
): boolean {
  // exists / not_exists 는 expected 무관 — actual 만 검사
  if (op === 'exists') {
    return actual !== undefined && actual !== null && actual !== '';
  }
  if (op === 'not_exists') {
    return actual === undefined || actual === null || actual === '';
  }

  // 숫자 변환 시도 — 양쪽 모두 numeric 일 때만 numeric 비교 적용
  const numActual = Number(actual);
  const numExpected = Number(expected);
  const bothNumeric =
    !isNaN(numActual) &&
    !isNaN(numExpected) &&
    actual !== '' &&
    actual !== null &&
    actual !== undefined &&
    expected !== '' &&
    expected !== null &&
    expected !== undefined;

  switch (op) {
    case '==':
      return bothNumeric ? numActual === numExpected : String(actual) === String(expected);
    case '!=':
      return bothNumeric ? numActual !== numExpected : String(actual) !== String(expected);
    case '<':
      return bothNumeric ? numActual < numExpected : false;
    case '<=':
      return bothNumeric ? numActual <= numExpected : false;
    case '>':
      return bothNumeric ? numActual > numExpected : false;
    case '>=':
      return bothNumeric ? numActual >= numExpected : false;
    case 'includes':
      return String(actual).includes(String(expected));
    case 'not_includes':
      return !String(actual).includes(String(expected));
    default:
      return false;
  }
}
