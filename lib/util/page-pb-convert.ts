/**
 * Page PB <-> 도메인 변환 — proto 의 bigint epoch (i64) → ISO string 으로 변환 후
 * 옛 PageListItem shape 으로 매핑. Caller migration (Phase E) 안 공통 helper.
 *
 * proto schema:
 *   PageListItemPb: { slug, status, project?, visibility?, title?, updatedAt: bigint, createdAt: bigint, ... }
 *
 * 도메인 (lib/types/firebat-types.ts):
 *   PageListItem: { slug, title, status, project?, visibility?, updatedAt?: string, createdAt?: string, ... }
 *
 * Rust 가 epoch ms (i64) 으로 전송 — 0 이면 미설정 의미 (undefined 로 매핑).
 */
import type { PageListItem } from '../types/firebat-types';
import type { PageListItemPb, PageRecordPb } from '../proto-gen/firebat_pb';
import { safeJsonParse } from './json';

function epochToIso(value: bigint | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  try { return new Date(ms).toISOString(); } catch { return undefined; }
}

export function toPageListItem(pb: PageListItemPb): PageListItem {
  return {
    slug: pb.slug,
    title: pb.title ?? pb.slug,
    status: pb.status,
    project: pb.project,
    visibility: (pb.visibility as PageListItem['visibility']) ?? undefined,
    updatedAt: epochToIso(pb.updatedAt),
    createdAt: epochToIso(pb.createdAt),
    featuredImage: pb.featuredImage,
    excerpt: pb.excerpt,
  };
}

/**
 * PageRecordPb → 옛 PageSpec shape. spec JSON parse 후 record meta 합성.
 *
 * 옛 caller 가 `result.data.head`, `result.data.body`, `result.data._visibility`,
 * `result.data._createdAt` 패턴 사용 — spec 내부 + record 메타 합쳐 반환.
 */
export interface ParsedPageSpec {
  slug: string;
  spec: Record<string, unknown>;
  head: Record<string, any>;
  body: any[];
  project?: string;
  status: string;
  /** spec.head 까지 inline + 옛 호환 필드 */
  [key: string]: any;
}

export function parsePageRecord(pb: PageRecordPb): ParsedPageSpec {
  const parsed = (safeJsonParse<Record<string, any>>(pb.spec, {}) ?? {}) as Record<string, any>;
  return {
    ...parsed,
    slug: pb.slug,
    spec: parsed,
    head: parsed.head ?? {},
    body: Array.isArray(parsed.body) ? parsed.body : [],
    project: pb.project ?? parsed.project,
    status: pb.status,
    _visibility: pb.visibility ?? parsed._visibility,
    _createdAt: epochToIso(pb.createdAt) ?? parsed._createdAt,
    _updatedAt: epochToIso(pb.updatedAt) ?? parsed._updatedAt,
  };
}

/**
 * inner PageSpec 추출 + double-wrap 복구 — 단일 진실 헬퍼(조회·저장 공용).
 * spec 값이 (1) string-of-JSON 이거나 (2) PageRecordPb 통째가 직렬화된 형태
 * (`$typeName` 포함 또는 `slug`+`status`+문자열 `spec`)면 안쪽 진짜 PageSpec 까지 벗긴다.
 * clean PageSpec(`{head, body}`)은 그대로 반환(no-op) — top-level 에 문자열 `spec` 필드가
 * 없으므로 오탐 0. 다중 wrap 도 최대 4겹까지 복구.
 */
function looksLikePageRecord(o: unknown): o is Record<string, unknown> {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  if (typeof r.spec !== 'string') return false;
  const tn = r.$typeName;
  return (typeof tn === 'string' && tn.includes('PageRecord'))
    || (typeof r.slug === 'string' && 'status' in r);
}

export function unwrapPageSpec(raw: unknown): Record<string, unknown> {
  let cur: unknown = typeof raw === 'string' ? safeJsonParse<unknown>(raw, {}) : raw;
  for (let i = 0; i < 4 && looksLikePageRecord(cur); i++) {
    cur = safeJsonParse<unknown>((cur as Record<string, unknown>).spec as string, {});
  }
  return (cur && typeof cur === 'object' && !Array.isArray(cur)) ? (cur as Record<string, unknown>) : {};
}
