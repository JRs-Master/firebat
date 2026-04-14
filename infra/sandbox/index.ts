import { ISandboxPort, IVaultPort } from '../../core/ports';
import { InfraResult, ModuleOutputSchema } from '../../core/types';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_RETRIES } from '../config';
import fs from 'fs';

const execAsync = promisify(exec);

// 런타임별 설치 안내
const INSTALL_GUIDES: Record<string, string> = {
  python3:  'sudo apt install python3 python3-pip',
  python:   'sudo apt install python3 python3-pip',
  node:     'sudo apt install nodejs npm  (또는 nvm: https://github.com/nvm-sh/nvm)',
  php:      'sudo apt install php php-cli && curl -sS https://getcomposer.org/installer | php',
  rustc:    'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
  cargo:    'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
  wasmtime: 'curl https://wasmtime.dev/install.sh -sSf | bash',
  wasmer:   'curl https://get.wasmer.io -sSfL | sh',
  bash:     'sudo apt install bash',
};

// Python import명 → pip 패키지명 매핑 (import명과 패키지명이 다른 경우)
const PY_IMPORT_TO_PKG: Record<string, string> = {
  bs4:        'beautifulsoup4',
  PIL:        'Pillow',
  cv2:        'opencv-python',
  sklearn:    'scikit-learn',
  yaml:       'pyyaml',
  dotenv:     'python-dotenv',
  dateutil:   'python-dateutil',
  google:     'google-generativeai',
};

export class ProcessSandboxAdapter implements ISandboxPort {
  private baseDir = process.cwd();
  private isWin = process.platform === 'win32';
  private vault?: IVaultPort;

  setVault(vault: IVaultPort) { this.vault = vault; }

  private async isAvailable(cmd: string): Promise<boolean> {
    try {
      await execAsync(this.isWin ? `where ${cmd}` : `which ${cmd}`);
      return true;
    } catch { return false; }
  }

  /** 실제로 동작하는 Python 커맨드 반환 (python3 → python → py 순으로 검증) */
  private async getWorkingPython(): Promise<string | null> {
    for (const cmd of ['python3', 'python', 'py']) {
      try {
        const { stdout, stderr } = await execAsync(`${cmd} --version`);
        const out = (stdout + stderr).toLowerCase();
        if (out.includes('python 3') || out.includes('python3')) return cmd;
      } catch { continue; }
    }
    return null;
  }

  private runtimeError(runtime: string): InfraResult<any> {
    const guide = INSTALL_GUIDES[runtime] ?? `${runtime} 설치 필요`;
    return {
      success: false,
      error: `[Runtime Missing] '${runtime}' 런타임이 설치되어 있지 않습니다.\n➜ 설치 방법: ${guide}`
    };
  }

  /** module.json의 secrets 배열을 읽어 Vault에서 값을 가져와 env 객체로 반환 */
  private loadSecretsEnv(moduleDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    if (!this.vault) return env;
    const manifestPath = path.join(moduleDir, 'module.json');
    if (!fs.existsSync(manifestPath)) return env;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const secrets: string[] = manifest.secrets ?? [];
      for (const name of secrets) {
        const value = this.vault.getSecret(`user:${name}`);
        if (value) env[name] = value;
      }
    } catch {}
    return env;
  }

  /** 프로세스 실행 후 stdout 파싱 결과 반환 */
  private runProcess(command: string, args: string[], payload: any, timeoutMs: number, secretsEnv?: Record<string, string>): Promise<InfraResult<any>> {
    return new Promise((resolve) => {
      // UTF-8 강제: Windows에서 Python stdin/stdout이 cp949로 처리되는 것을 방지
      const env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...(secretsEnv ?? {}),
      };
      const child = execFile(command, args, { timeout: timeoutMs, env }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed) {
            return resolve({ success: false, error: `[TIMEOUT] 최대 실행 시간(${timeoutMs / 1000}초) 초과.` });
          }
          return resolve({ success: false, error: `[CRASH] ${stderr || error.message}` });
        }
        try {
          const outputStr = stdout.trim().split('\n').pop() || '';
          const parsed = JSON.parse(outputStr);
          const valRes = ModuleOutputSchema.safeParse(parsed);
          if (!valRes.success) {
            return resolve({ success: false, error: `Protocol Violation: 모듈이 규격에 맞지 않는 JSON을 반환했습니다. Dump: ${stdout}` });
          }
          return resolve({ success: true, data: valRes.data });
        } catch {
          return resolve({ success: false, error: `Protocol Violation: stdout에 유효한 JSON이 없습니다. Dump: ${stdout}` });
        }
      });

      if (child.stdin) {
        child.stdin.write(JSON.stringify({ correlationId: `run-${Date.now()}`, data: payload || {} }) + '\n');
        child.stdin.end();
      }
    });
  }

  /**
   * module.json이 있으면 선제적으로 packages 설치
   * 에러-감지 방식보다 빠르고 예측 가능
   */
  private async preInstallFromManifest(moduleDir: string): Promise<void> {
    const manifestPath = path.join(moduleDir, 'module.json');
    if (!fs.existsSync(manifestPath)) return;

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch { return; }

    const packages: string[] = manifest.packages ?? [];
    if (!packages.length) return;

    const runtime: string = manifest.runtime ?? 'python';

    if (runtime === 'python') {
      const py = await this.getWorkingPython();
      if (!py) return;
      const pip = (await this.isAvailable('pip3')) ? 'pip3'
                : (await this.isAvailable('pip'))  ? 'pip'
                : `${py} -m pip`;
      for (const pkg of packages) {
        await execAsync(`${pip} install ${pkg} --quiet`).catch(() => {});
      }
    } else if (runtime === 'node') {
      for (const pkg of packages) {
        await execAsync(`npm install ${pkg} --prefix "${moduleDir}" --quiet`).catch(() => {});
      }
    }
  }

  /**
   * 실행 → 패키지 누락 감지 → 자동 설치 → 재시도 (module.json 없는 모듈의 안전망)
   * AI는 의존성을 몰라도 됨. Infra가 전담 처리.
   */
  private async executeWithAutoInstall(
    command: string, args: string[], moduleDir: string,
    inputData: any, timeoutMs: number
  ): Promise<InfraResult<any>> {
    const MAX_RETRIES = SANDBOX_MAX_RETRIES;
    const secretsEnv = this.loadSecretsEnv(moduleDir);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await this.runProcess(command, args, inputData, timeoutMs, secretsEnv);

      // 완전한 성공 (모듈도 success: true)
      if (result.success && result.data?.success !== false) return result;

      // 크래시 에러 또는 모듈이 내부에서 잡아서 반환한 에러 모두 감지
      const err = !result.success
        ? (result.error || '')
        : (result.data?.error || '');

      // Python 패키지 누락 감지 → pip 자동 설치 (시스템 런타임인 playwright는 제외)
      const pyMissing = err.match(/No module named '?([^'\s]+)'?/);
      if (pyMissing && attempt < MAX_RETRIES - 1) {
        const importName = pyMissing[1].split('.')[0];
        if (importName === 'playwright') {
          // playwright는 시스템 의존성 — 위 런타임 체크에서 처리됨
        } else {
          const pkgName = PY_IMPORT_TO_PKG[importName] ?? importName;
          const pip = (await this.isAvailable('pip3')) ? 'pip3' : (await this.isAvailable('pip')) ? 'pip' : 'py -m pip';
          await execAsync(`${pip} install ${pkgName} --quiet`).catch(() => {});
          continue;
        }
      }

      // Node.js 패키지 누락 감지 → npm 자동 설치
      const jsMissing = err.match(/Cannot find module '?([^'\s"]+)'?/);
      if (jsMissing && attempt < MAX_RETRIES - 1) {
        const pkg = jsMissing[1];
        if (!pkg.startsWith('.') && !pkg.startsWith('/')) {
          await execAsync(`npm install ${pkg} --prefix "${moduleDir}" --quiet`).catch(() => {});
          continue;
        }
      }

      // Playwright 브라우저/패키지 미설치 → 런타임 에러로 처리 (자동 설치 안 함)
      if (/Executable doesn't exist|No module named 'playwright'|BrowserType\.launch/i.test(err)) {
        const py = await this.getWorkingPython() ?? 'python3';
        return {
          success: false,
          error: `[Runtime Missing] Playwright가 설치되어 있지 않습니다.\n➜ 서버에서 한 번만 실행: ${py} -m pip install playwright && ${py} -m playwright install chromium`
        };
      }

      // PHP 패키지 누락 — composer가 필요하므로 composer.json 필요 안내
      if (/Class .* not found|require_once/i.test(err) && attempt < MAX_RETRIES - 1) {
        const composerJson = path.join(moduleDir, 'composer.json');
        if (fs.existsSync(composerJson)) {
          await execAsync(`composer install --working-dir="${moduleDir}" --quiet`).catch(() => {});
          continue;
        }
      }

      // 패키지 누락이 아닌 다른 에러 — 자동 설치 불가, 그대로 반환
      return result;
    }

    return { success: false, error: '[Auto-Install Failed] 패키지 자동 설치 후에도 실행에 실패했습니다.' };
  }

  /** 실행 경로가 허용 영역 안인지 확인 (../ traversal 방어) */
  private canExecute(targetPath: string): boolean {
    const resolved = path.resolve(this.baseDir, targetPath);
    const userModules = path.resolve(this.baseDir, 'user/modules');
    const systemModules = path.resolve(this.baseDir, 'system/modules');
    return resolved.startsWith(userModules + path.sep) || resolved.startsWith(systemModules + path.sep);
  }

  async execute(targetPath: string, inputData: any): Promise<InfraResult<any>> {
    // 페이지 URL (크론 페이지 알림용) — 파일 실행이 아니므로 경로 검증 스킵
    if (!targetPath.startsWith('/') && !this.canExecute(targetPath)) {
      return { success: false, error: `[Kernel Block] 허용되지 않은 실행 경로입니다: ${targetPath}` };
    }

    // 디렉토리 경로인 경우 module.json → entry 또는 index.* 자동 탐색
    let resolvedPath = targetPath;
    const absCheck = path.resolve(this.baseDir, targetPath);
    try {
      const stat = fs.statSync(absCheck);
      if (stat.isDirectory()) {
        const manifestPath = path.join(absCheck, 'module.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.entry) {
            resolvedPath = path.join(targetPath, manifest.entry);
          }
        }
        // module.json에 entry가 없으면 index.* 탐색
        if (resolvedPath === targetPath) {
          for (const candidate of ['index.mjs', 'index.js', 'index.py', 'index.php', 'index.sh']) {
            if (fs.existsSync(path.join(absCheck, candidate))) {
              resolvedPath = path.join(targetPath, candidate);
              break;
            }
          }
        }
        if (resolvedPath === targetPath) {
          return { success: false, error: `모듈 디렉토리에 실행 가능한 엔트리포인트를 찾을 수 없습니다: ${targetPath}` };
        }
      }
    } catch {}

    const timeoutMs    = SANDBOX_TIMEOUT_MS;
    const absolutePath = path.resolve(this.baseDir, resolvedPath);
    const moduleDir    = path.dirname(absolutePath);
    const ext          = path.extname(resolvedPath).toLowerCase();

    let command = '';
    let args: string[] = [absolutePath];

    try {
      if (ext === '.py') {
        const py = await this.getWorkingPython();
        if (!py) return this.runtimeError('python3');
        command = py;

      } else if (ext === '.js' || ext === '.mjs') {
        if (!await this.isAvailable('node')) return this.runtimeError('node');
        command = 'node';

      } else if (ext === '.php') {
        if (!await this.isAvailable('php')) return this.runtimeError('php');
        command = 'php';

      } else if (ext === '.rs') {
        const cargoToml = path.join(moduleDir, 'Cargo.toml');
        if (fs.existsSync(cargoToml)) {
          if (!await this.isAvailable('cargo')) return this.runtimeError('cargo');
          command = 'cargo';
          args = ['run', '--manifest-path', cargoToml, '--quiet'];
        } else {
          if (!await this.isAvailable('rustc')) return this.runtimeError('rustc');
          const outBin = path.join(moduleDir, '_firebat_bin' + (this.isWin ? '.exe' : ''));
          await execAsync(`rustc "${absolutePath}" -o "${outBin}"`);
          command = outBin;
          args = [];
        }

      } else if (ext === '.wasm') {
        const runtime = (await this.isAvailable('wasmtime')) ? 'wasmtime'
                      : (await this.isAvailable('wasmer'))   ? 'wasmer'
                      : null;
        if (!runtime) return this.runtimeError('wasmtime');
        command = runtime;

      } else if (ext === '.sh') {
        if (!await this.isAvailable('bash')) return this.runtimeError('bash');
        command = 'bash';

      } else {
        return { success: false, error: `Sandbox Blocked: 지원하지 않는 확장자 (${ext}). 지원: .py .js .mjs .php .rs .wasm .sh` };
      }

    } catch (compileErr: any) {
      return { success: false, error: `[Compile Error] ${compileErr.message}` };
    }

    await this.preInstallFromManifest(moduleDir);
    return this.executeWithAutoInstall(command, args, moduleDir, inputData, timeoutMs);
  }
}
