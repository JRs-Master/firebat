import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../lib/with-api-error';
import { loadSettings, saveSettings } from '../../../lib/settings-io';

/** GET /api/settings — admin (global) settings. Owner-scoped variant = /api/hub/[slug]/settings. */
export const GET = withAuth(async (_req: NextRequest) => {
  return NextResponse.json(await loadSettings());
});

/** PATCH /api/settings — persist admin (global) settings. */
export const PATCH = withAuth(async (req: NextRequest) => {
  await saveSettings(await req.json());
  return NextResponse.json({ success: true });
});
