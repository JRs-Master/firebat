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
import { withAuth } from '../../../../lib/with-api-error';

/** CLI 명령어를 --version 또는 --help 로 가볍게 실행해서 설치·로그인 여부 판정 (+ 설치 버전 파싱) */
function probeCli(command: string, timeoutMs: number = 5000): Promise<{ installed: boolean; loggedIn: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (r: { installed: boolean; loggedIn: boolean; error?: string; version?: string }) => {
      if (!resolved) { resolved = true; resolve(r); }
    };
    try {
      const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
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
          // 설치는 됨. 로그인 여부는 별도 확인 필요하지만 일단 installed=true 로 충분한 1차 신호.
          // 버전은 stdout 첫 semver 토큰 (예: "2.1.177 (Claude Code)" / "codex-cli 0.46.0").
          finish({ installed: true, loggedIn: true, version: parseSemver(stdout) });
        } else {
          finish({ installed: true, loggedIn: false, error: stderr.slice(0, 300) });
        }
      });
    } catch (e) {
      finish({ installed: false, loggedIn: false, error: (e as Error).message });
    }
  });
}

function parseSemver(s: string): string | undefined {
  const m = s.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/);
  return m?.[0];
}

/** npm 패키지명 — 업그레이드 배지의 최신 버전 조회용 (설치 안내의 `npm i -g <pkg>` 와 동일 소스) */
const NPM_PKG: Record<string, string> = {
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
};

/** npm registry 최신 버전 — 실패(네트워크·404)는 undefined = 배지 생략, 상태 확인 자체는 성공 유지 */
async function fetchLatestVersion(pkg: string, timeoutMs = 4000): Promise<string | undefined> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const j = await res.json().catch(() => null) as { version?: unknown } | null;
    return typeof j?.version === 'string' ? j.version : undefined;
  } catch {
    return undefined;
  }
}

/** semver 본체(major.minor.patch) 숫자 비교 — b 가 더 크면 양수. prerelease 는 무시(본체 같으면 0). */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  return 0;
}

/** GET /api/auth/cli?provider=claude-code|codex|gemini — 설치·로그인 상태 확인 */
export const GET = withAuth(async (req: NextRequest) => {
  const provider = req.nextUrl.searchParams.get('provider') || 'claude-code';
  const command =
    provider === 'claude-code' ? 'claude' :
    provider === 'codex' ? 'codex' :
    provider === 'gemini' ? 'gemini' :
    null;

  if (!command) {
    return NextResponse.json({ success: false, error: `알 수 없는 provider: ${provider}` }, { status: 400 });
  }

  // 설치·로그인 프로브와 npm 최신 버전 조회를 병렬로 — 최신 조회 실패는 배지만 생략(체크 성공 유지)
  const [status, latestVersion] = await Promise.all([
    probeCli(command),
    fetchLatestVersion(NPM_PKG[provider] ?? ''),
  ]);
  const updateAvailable =
    !!status.version && !!latestVersion && cmpSemver(status.version, latestVersion) > 0;
  return NextResponse.json({
    success: true,
    provider,
    command,
    installed: status.installed,
    loggedIn: status.loggedIn,
    error: status.error,
    installedVersion: status.version,
    latestVersion,
    updateAvailable,
  });
});
