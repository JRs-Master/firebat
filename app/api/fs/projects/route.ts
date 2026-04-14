import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

export async function GET() {
  const projects = await getCore().scanProjects();
  return NextResponse.json({ success: true, projects });
}

export async function DELETE(request: Request) {
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
