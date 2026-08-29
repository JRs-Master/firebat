import { NextRequest, NextResponse } from 'next/server';
import {
  scanProjects,
  rename as renameProject,
  setVisibility as setProjectVisibility,
  deleteProject,
  getConfig as getProjectConfig,
  setConfig as setProjectConfig,
} from '../../../../lib/api-gen/project';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async (request: NextRequest) => {
  // ?project=<name> — that project's theme override (`user/projects/<name>/config.json`).
  // Absent file = no override, which is `{}` rather than an error: a project that has never been
  // themed is the normal case, not a missing one.
  const only = new URL(request.url).searchParams.get('project');
  if (only) {
    const cfg = await getProjectConfig({ project: only });
    return NextResponse.json({ success: true, config: cfg.ok ? (cfg.data ?? {}) : {} });
  }
  const res = await scanProjects({});
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
    const { newName, setRedirect } = body as { newName?: string; setRedirect?: boolean };
    if (!newName) return NextResponse.json({ success: false, error: 'newName 필수' }, { status: 400 });
    const res = await renameProject({ oldName: project, newName, setRedirect: setRedirect !== false });
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 400 });
    return NextResponse.json({ success: true, data: res.data });
  }

  // 액션: config — 프로젝트 테마 override 저장. 빈 객체 = override 없음(상속으로 되돌림).
  if (action === 'config') {
    const { config } = body as { config?: unknown };
    if (config === undefined || config === null || typeof config !== 'object') {
      return NextResponse.json({ success: false, error: 'config는 객체여야 합니다.' }, { status: 400 });
    }
    const res = await setProjectConfig({ project, configJson: JSON.stringify(config) });
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    return NextResponse.json({ success: true });
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
  const res = await deleteProject({ project });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 404 });
  }
  return NextResponse.json({ success: true });
});
