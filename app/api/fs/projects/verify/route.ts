/**
 * 프로젝트 비밀번호 검증 API (비인증 사용자용)
 *
 * POST /api/fs/projects/verify — 프로젝트 비밀번호 확인
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyProjectPassword } from '../../../../../lib/api-gen/project';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { project, password } = body;

  if (!project || !password) {
    return NextResponse.json({ success: false, error: 'project, password 필수' }, { status: 400 });
  }

  const res = await verifyProjectPassword({ project, password });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, verified: res.data });
}
