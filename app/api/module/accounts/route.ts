import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { ApiError } from '../../../../lib/api-error';
import { getAccounts, saveAccount, deleteAccount } from '../../../../lib/api-gen/module';

/**
 * Broker accounts for one module. App keys are issued per account, so a module that declares
 * `accounts` holds several credential sets; this is the registry over them. Credential values are
 * write-only — GET returns only whether each slot is filled.
 */

function moduleOf(req: NextRequest): string {
  const module = req.nextUrl.searchParams.get('module');
  if (!module) throw new ApiError(400, '모듈 이름이 필요합니다.');
  return module;
}

/** GET /api/module/accounts?module=kiwoom */
export const GET = withAuth(async (req: NextRequest) => {
  const res = await getAccounts({ module: moduleOf(req) });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, accounts: res.data });
});

/** POST /api/module/accounts — { module, account, credentials?, makePrimary? } */
export const POST = withAuth(async (req: NextRequest) => {
  const { module, account, credentials, makePrimary } = await req.json();
  if (!module || typeof module !== 'string') throw new ApiError(400, '모듈 이름이 필요합니다.');
  if (!account?.id) throw new ApiError(400, '계좌 별칭이 필요합니다.');
  const res = await saveAccount({
    module,
    accountJson: JSON.stringify(account),
    credentialsJson: JSON.stringify(credentials ?? {}),
    makePrimary: !!makePrimary,
  });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 400 });
});

/** DELETE /api/module/accounts?module=kiwoom&id=main */
export const DELETE = withAuth(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) throw new ApiError(400, '계좌 별칭이 필요합니다.');
  const res = await deleteAccount({ module: moduleOf(req), id });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 400 });
});
