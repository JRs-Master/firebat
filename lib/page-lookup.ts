/**
 * A page lookup has three answers, not two: it is here, it is not here, and we could not ask.
 *
 * Folding the third into the second is the bug this exists to prevent. `/<slug>` falls back when a
 * page is absent — to the redirect table, then to a project of the same name, then to a hub — so a
 * lookup that failed because the core was restarting used to render **a different page**, with no
 * error anywhere. Measured 2026-09-11: `/sixty` served the site catalogue instead of the app, and
 * the only reason it had somewhere to land was that a project happened to share the slug. Without
 * that coincidence it would have been a 404, which is wrong in a quieter way.
 *
 * `NOT_FOUND` is the only code that means absence — [page.rs](core/src/grpc/page.rs) answers a
 * missing slug with exactly that. `UNAVAILABLE`, `DEADLINE_EXCEEDED` and `INTERNAL` mean the
 * question did not get answered, and a page that cannot be looked up must not be reported as one
 * that does not exist.
 */
import type { RpcResult } from './api-gen/types';

/** The lookup itself failed — the page's existence is unknown, not settled. */
export class PageLookupUnavailable extends Error {
  readonly code: string;
  constructor(what: string, code: string, message: string) {
    super(`${what} could not be looked up (${code}): ${message}`);
    this.name = 'PageLookupUnavailable';
    this.code = code;
  }
}

/**
 * The record, or `null` when the lookup answered that there is none.
 *
 * Throws for every other failure, so callers cannot accidentally treat "we could not ask" as
 * "there is nothing here" — the shape is what enforces it, not a comment asking them to remember.
 */
export function pageOrAbsent<T>(res: RpcResult<T>, what: string): T | null {
  if (res.ok) return res.data ?? null;
  if (res.code === 'NOT_FOUND') return null;
  throw new PageLookupUnavailable(what, res.code, res.message);
}
