/**
 * Backward-compat re-export. 정의는 lib/redactor.ts 로 이동 (Core / infra 양쪽에서 import 가능).
 * 신규 코드는 lib/redactor 직접 import 권장.
 */
export { redactString, redactMeta } from '../../lib/redactor';
