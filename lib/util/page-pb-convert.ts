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
