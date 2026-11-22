import { headers } from 'next/headers';
import { siteOrigin } from './base-url';

/**
 * The site's public origin for server components, layouts and metadata routes — `siteOrigin`
 * with this request's headers. Kept apart from lib/base-url.ts so that file never pulls
 * `next/headers` into anything else that imports it.
 */
export async function resolveSiteUrl(siteUrl?: string): Promise<string> {
  let h: Awaited<ReturnType<typeof headers>> | undefined;
  try {
    h = await headers();
  } catch {
    h = undefined; // outside a request (build) — siteOrigin falls back
  }
  return siteOrigin(siteUrl, h);
}
