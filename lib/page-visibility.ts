/**
 * 페이지 visibility 해석 — 페이지 자체(_visibility) → 프로젝트 상속 → 기본 public.
 * 발행 페이지 RSC(page.tsx)와 공개 라이브 스트림 게이트(/api/page-stream)가 공유하는
 * 단일 정책 — 두 곳에 복붙하면 게이트 drift(한쪽만 조여짐)가 생기는 클래스라 여기 한 곳.
 */
import { getVisibility as getProjectVisibility } from './api-gen/project';

export async function resolvePageVisibility(spec: {
  _visibility?: string;
  project?: string;
}): Promise<'public' | 'password' | 'private'> {
  const pageVis = spec._visibility;
  if (pageVis === 'private' || pageVis === 'password') return pageVis;
  if (spec.project) {
    const visRes = await getProjectVisibility({ project: spec.project });
    const projectVis = visRes.ok ? visRes.data : undefined;
    if (projectVis === 'private' || projectVis === 'password') return projectVis;
  }
  return 'public';
}
