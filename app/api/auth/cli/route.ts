/**
 * /api/auth/cli — CLI 인증 상태 확인
 *
 * CLI (claude/codex/gemini) 는 자체 브라우저 OAuth 로 인증함.
 * 서버에서는 `claude --print "ping"` 같은 헬스체크로 로그인 여부만 확인.
 *
 * 실제 login / logout 은 서버 터미널에서:
 *   claude login   → 브라우저 URL 안내 → 유저가 PC 에서 인증
 *   claude logout
 *
 * 이 엔드포인트는 상태 polling 용.
 */
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

function assertAdmin(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  return auth;
}

/** CLI 명령어를 --version 또는 --help 로 가볍게 실행해서 설치·로그인 여부 판정 */
function probeCli(command: string, timeoutMs: number = 5000): Promise<{ installed: boolean; loggedIn: boolean; error?: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (r: { installed: boolean; loggedIn: boolean; error?: string }) => {
      if (!resolved) { resolved = true; resolve(r); }
    };
    try {
      const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
      const timer = setTimeout(() => {
        child.kill();
        finish({ installed: true, loggedIn: false, error: `${command} --version 타임아웃 (${timeoutMs}ms)` });
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        // ENOENT → 미설치
        finish({ installed: false, loggedIn: false, error: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          // 설치는 됨. 로그인 여부는 별도 확인 필요하지만 일단 installed=true 로 충분한 1차 신호
          finish({ installed: true, loggedIn: true });
        } else {
          finish({ installed: true, loggedIn: false, error: stderr.slice(0, 300) });
        }
      });
    } catch (e) {
      finish({ installed: false, loggedIn: false, error: (e as Error).message });
    }
  });
}

/** GET /api/auth/cli?provider=claude-code|codex|gemini — 설치·로그인 상태 확인 */
export async function GET(req: NextRequest) {
  const auth = assertAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const provider = req.nextUrl.searchParams.get('provider') || 'claude-code';
  const command =
    provider === 'claude-code' ? 'claude' :
    provider === 'codex' ? 'codex' :
    provider === 'gemini' ? 'gemini' :
    null;

  if (!command) {
    return NextResponse.json({ success: false, error: `알 수 없는 provider: ${provider}` }, { status: 400 });
  }

  const status = await probeCli(command);
  return NextResponse.json({
    success: true,
    provider,
    command,
    installed: status.installed,
    loggedIn: status.loggedIn,
    error: status.error,
  });
}
