import { NextRequest, NextResponse } from 'next/server';
import {
  scanProjects,
  rename as renameProject,
  setVisibility as setProjectVisibility,
  deleteProject,
} from '../../../../lib/api-gen/project';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async () => {
  const res = await scanProjects();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, projects: res.data });
});

/** PATCH — action 분기: rename (일괄 slug 변경) 또는 visibility 설정 (기본) */
export const PATCH = withAuth(async (request: NextRequest) => {
  const body = await request.json();
  const { action, project } = body as { action?: string; project?: string };

  if (!project) {
    return NextResponse.json({ success: false, error: 'project 필수' }, { status: 400 });
  }

  // 액션: rename — { action:'rename', project, newName, setRedirect? }
  if (action === 'rename') {
    const { newName } = body as { newName?: string; setRedirect?: boolean };
    if (!newName) return NextResponse.json({ success: false, error: 'newName 필수' }, { status: 400 });
    const res = await renameProject({ oldName: project, newName });
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 400 });
    return NextResponse.json({ success: true, data: res.data });
  }

  // 기본: visibility 설정
  const { visibility, password } = body as { visibility?: string; password?: string };
  if (!visibility || !['public', 'password', 'private'].includes(visibility)) {
    return NextResponse.json({ success: false, error: 'visibility는 public, password, private 중 하나' }, { status: 400 });
  }
  if (visibility === 'password' && !password) {
    return NextResponse.json({ success: false, error: 'password 모드에서는 비밀번호 필수' }, { status: 400 });
  }

  const res = await setProjectVisibility({ project, visibility, password });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const project = new URL(request.url).searchParams.get('project');
  if (!project) {
    return NextResponse.json({ success: false, error: 'project 파라미터가 필요합니다.' }, { status: 400 });
  }
  const res = await deleteProject({ value: project });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 404 });
  }
  return NextResponse.json({ success: true });
});
