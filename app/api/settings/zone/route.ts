import { NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getTimezone } from '../../../../lib/api-gen/settings';

/**
 * GET /api/settings/zone?zone=America/New_York
 *
 * What a zone is doing right now — does it observe summer time, is it on it at this moment, what
 * offset is in force. Core answers, using the same zone rules the scheduler evaluates against; a
 * browser-side copy would be a second answer waiting to disagree with the first.
 *
 * Without `zone` it describes the configured one, which is what the panels read.
 */
export const GET = withAuth(async (req) => {
  const zone = new URL(req.url).searchParams.get('zone') ?? undefined;
  const res = await getTimezone(zone ? { zone } : {});
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({
    success: true,
    timezone: res.data.timezone,
    clock: res.data.clock ?? null,
  });
});
