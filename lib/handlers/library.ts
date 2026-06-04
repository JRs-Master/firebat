/**
 * Library op → RPC 매핑 (admin·hub 공유 단일 소스).
 *
 * admin 라우트(/api/library/[op]) 와 hub 라우트(/api/hub/[slug]/library) 가 둘 다 이 함수를 통해
 * RPC 를 호출 → op→RPC 매핑이 한 곳. 새 op 추가 시 한 곳만 고치면 둘 다 적용 (drift 차단).
 *
 * `owner` 는 호출처가 결정: admin = 'admin' / hub = `hub:<instance>:<session>`.
 * 소유권 가드(방문자가 남의 reference 접근 차단)는 hub 라우트가 dispatch **전에** 수행 —
 * 본 함수는 순수 RPC 매핑이라 인증/스코프 정책을 모른다 (관심사 분리).
 */
import {
  createReference,
  listReferences,
  deleteReference,
  uploadSource,
  listSources,
  getSource,
  deleteSource,
  reextractSource,
  search,
} from '../api-gen/library';

export type LibraryDispatchResult = { ok: true; data: unknown } | { ok: false; message: string };

export async function libraryOpDispatch(
  op: string,
  args: Record<string, unknown> | null | undefined,
  owner: string,
): Promise<LibraryDispatchResult> {
  const a = args ?? {};
  switch (op) {
    case 'list-references':
      return listReferences({ owner });
    case 'create-reference':
      return createReference({
        name: String(a.name ?? ''),
        description: String(a.description ?? ''),
        owner,
      });
    case 'delete-reference':
      return deleteReference({ id: String(a.id ?? '') });
    case 'list-sources':
      return listSources({ referenceId: String(a.referenceId ?? '') });
    case 'get-source':
      return getSource({ id: String(a.id ?? '') });
    case 'delete-source':
      return deleteSource({ id: String(a.id ?? '') });
    case 'reextract-source':
      return reextractSource({
        sourceId: String(a.sourceId ?? ''),
        precise: !!a.precise,
        qualityBoost: !!a.qualityBoost,
      });
    case 'upload-text-source':
      return uploadSource({
        referenceId: String(a.referenceId ?? ''),
        name: String(a.name ?? ''),
        sourceType: 'text',
        inlineText: String(a.inlineText ?? ''),
      });
    case 'search':
      return search({
        owner,
        query: String(a.query ?? ''),
        referenceIds: Array.isArray(a.referenceIds) ? a.referenceIds.map(String) : [],
        topK: typeof a.topK === 'number' ? BigInt(a.topK) : BigInt(0),
      });
    default:
      return { ok: false, message: `지원되지 않는 op: ${op}` };
  }
}
