import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const { prompt, config, history = [] } = await req.json();

    if (!prompt) {
      return NextResponse.json({ success: false, error: 'Command prompt is required' }, { status: 400 });
    }

    const core = getCore();
    const result = await core.requestAction(prompt, history, { model: config?.model });

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ success: false, error: `Unhandled Server Error: ${err.message}` }, { status: 500 });
  }
}
