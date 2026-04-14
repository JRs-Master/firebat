/**
 * Node.js 런타임 전용 bootstrap — instrumentation.ts에서 조건부로 import됩니다.
 * Edge Runtime에서는 절대 로드되지 않습니다.
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
