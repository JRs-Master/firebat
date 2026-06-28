/**
 * Shared hub op-dispatch fetcher — the single hub-side transport for every sidebar panel.
 *
 * admin routes are RESTful (`/api/<domain>`); hub routes are op-dispatchers
 * (`POST /api/hub/<slug>/<domain>` with `{ op, ...payload }`). Each panel builds a small per-domain backend
 * object whose methods branch `hubCtx ? hubFetch(...) : <admin REST>` INSIDE the method, so the panel body
 * stays owner-agnostic (the convBackend pattern from chat). This util removes the per-panel duplicated hub
 * dispatcher (every panel re-implemented an identical one).
 */
export interface HubFetchCtx {
  slug: string;
  apiToken: string;
  sessionId: string;
}

export async function hubFetch(
  ctx: HubFetchCtx,
  domain: string,
  op: string,
  payload?: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`/api/hub/${encodeURIComponent(ctx.slug)}/${domain}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Token': ctx.apiToken,
      'X-Session-Id': ctx.sessionId,
    },
    body: JSON.stringify({ op, ...(payload ?? {}) }),
  });
  return res.json().catch(() => null);
}
