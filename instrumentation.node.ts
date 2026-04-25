/**
 * Node.js 런타임 전용 bootstrap — instrumentation.ts에서 조건부로 import됩니다.
 * Edge Runtime에서는 절대 로드되지 않습니다.
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// SIGTERM / SIGINT graceful shutdown — Core 작업 완료 대기 + Cost flush.
// PM2 ecosystem.config.js 의 kill_timeout=30s 와 호환 (Core 는 25s, 5s 여유).
// 멱등 — 같은 프로세스에서 한 번만 등록.
const __gShut = globalThis as unknown as { __firebatShutdownWired?: boolean };
if (!__gShut.__firebatShutdownWired) {
  __gShut.__firebatShutdownWired = true;
  let shuttingDown = false;
  const handler = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Firebat] ${sig} 수신 — graceful shutdown 시작`);
    try {
      const { getCore } = await import('./lib/singleton');
      await getCore().gracefulShutdown(25_000);
    } catch (err) {
      console.warn('[Firebat] shutdown 실패:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void handler('SIGTERM'); });
  process.on('SIGINT', () => { void handler('SIGINT'); });
}

async function run(cmd: string): Promise<boolean> {
  try { await execAsync(cmd); return true; } catch { return false; }
}

async function getWorkingPython(): Promise<string | null> {
  for (const cmd of ['python3', 'python', 'py']) {
    try {
      const { stdout, stderr } = await execAsync(`${cmd} --version`);
      if ((stdout + stderr).toLowerCase().includes('python 3')) return cmd;
    } catch { continue; }
  }
  return null;
}

export async function setupSystemDependencies() {
  console.log('[Firebat] System bootstrap starting (background)...');

  const py = await getWorkingPython();
  if (!py) {
    console.warn('[Firebat] Python3 not found. browser-scrape system module unavailable.');
    return;
  }

  const playwrightOk = await run(`${py} -c "import playwright"`);
  if (!playwrightOk) {
    console.log('[Firebat] Installing playwright package...');
    const installed = await run(`${py} -m pip install playwright --quiet`);
    if (!installed) {
      console.warn('[Firebat] Failed to install playwright package.');
      return;
    }
  }

  const chromiumOk = await run(
    `${py} -c "import os; from playwright.sync_api import sync_playwright; pw=sync_playwright().start(); path=pw.chromium.executable_path; pw.stop(); assert os.path.exists(path), 'not found'"`
  );
  if (!chromiumOk) {
    console.log('[Firebat] Installing Playwright Chromium...');
    const installed = await run(`${py} -m playwright install chromium`);
    if (!installed) {
      console.warn('[Firebat] Failed to install Playwright Chromium.');
    } else {
      console.log('[Firebat] Playwright Chromium installed successfully.');
    }
  }

  console.log('[Firebat] System bootstrap complete.');
}
