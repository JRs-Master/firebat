import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const projects = await getCore().scanProjects();
  return NextResponse.json({ success: true, projects });
}

/** PATCH — 프로젝트 visibility 설정 */
export async function PATCH(request: NextRequest) {
  const auth = requireAuth(request);
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const { project, visibility, password } = body;

  if (!project) {
    return NextResponse.json({ success: false, error: 'project 필수' }, { status: 400 });
  }
  if (!visibility || !['public', 'password', 'private'].includes(visibility)) {
    return NextResponse.json({ success: false, error: 'visibility는 public, password, private 중 하나' }, { status: 400 });
  }
  if (visibility === 'password' && !password) {
    return NextResponse.json({ success: false, error: 'password 모드에서는 비밀번호 필수' }, { status: 400 });
  }

  const result = getCore().setProjectVisibility(project, visibility, password);
  return NextResponse.json(result);
}

export async function DELETE(request: NextRequest) {
  const auth = requireAuth(request);
  if (isAuthError(auth)) return auth;
  const project = new URL(request.url).searchParams.get('project');
  if (!project) {
    return NextResponse.json({ success: false, error: 'project 파라미터가 필요합니다.' }, { status: 400 });
  }

  const result = await getCore().deleteProject(project);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 404 });
  }
  return NextResponse.json({ success: true, deleted: result.data });
}
