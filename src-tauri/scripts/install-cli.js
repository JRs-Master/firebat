#!/usr/bin/env node
/**
 * install-cli.js — 첫 실행 시 격리 LLM CLI 설치 스크립트.
 *
 * Phase D self-installed Tauri 환경에서 Claude Code / Codex / Gemini CLI 를 사용자 PC 의
 * 시스템 npm 과 격리해 설치. Firebat 데이터 디렉토리 안에 자체 node_modules 박음.
 *
 * 격리 디렉토리:
 *   - default: ~/.firebat/cli-modules/  (또는 %APPDATA%\firebat\cli-modules)
 *   - portable USB: FIREBAT_DATA_DIR env 박힌 경우 그 dir 의 cli-modules
 *
 * 설치 패키지 (사용자 선택 — 기본 3개 모두):
 *   - @anthropic-ai/claude-code (Claude Pro/Max 구독 OAuth)
 *   - @openai/codex-cli (ChatGPT Plus/Pro 구독)
 *   - @google/gemini-cli (Google AI Pro 구독)
 *
 * 사용:
 *   node install-cli.js            # 3개 모두 설치
 *   node install-cli.js claude     # claude-code 만
 *   node install-cli.js codex gemini  # 2개
 *
 * 사후 사용:
 *   - PATH 에 `<data_dir>/cli-modules/node_modules/.bin` 추가 (Tauri main.rs 의 spawn env 가 박음)
 *   - 사용자가 `claude` / `codex` / `gemini` 명령어 실행 가능
 *
 * 에러 핸들링:
 *   - npm 미설치 → 사용자한테 Node.js 20+ 설치 안내
 *   - 설치 실패 → 부분 설치도 OK (앱 자체는 계속 동작, CLI 미사용 fallback)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── 격리 디렉토리 결정 ───────────────────────────────────────────────────────
function resolveDataDir() {
  if (process.env.FIREBAT_DATA_DIR) {
    return process.env.FIREBAT_DATA_DIR;
  }
  // OS 별 default — Tauri main.rs 의 resolve_data_dir 와 동일 로직
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'firebat');
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, '.firebat');
  }
  return path.join(process.cwd(), 'firebat-data');
}

const DATA_DIR = resolveDataDir();
const CLI_DIR = path.join(DATA_DIR, 'cli-modules');

// ── 패키지 매핑 ──────────────────────────────────────────────────────────────
const PACKAGES = {
  claude: {
    name: '@anthropic-ai/claude-code',
    bin: 'claude',
    description: 'Claude Code CLI — Anthropic 공식 (Claude Pro/Max 구독)',
  },
  codex: {
    name: '@openai/codex-cli',
    bin: 'codex',
    description: 'Codex CLI — OpenAI 공식 (ChatGPT Plus/Pro 구독)',
  },
  gemini: {
    name: '@google/gemini-cli',
    bin: 'gemini',
    description: 'Gemini CLI — Google 공식 (Google AI Pro 구독)',
  },
};

function ensureNpm() {
  try {
    execSync('npm --version', { stdio: 'pipe' });
  } catch (e) {
    console.error('npm 이 PATH 에 없음. Node.js 20+ 설치 필요: https://nodejs.org/');
    process.exit(1);
  }
}

function ensureCliDir() {
  if (!fs.existsSync(CLI_DIR)) {
    fs.mkdirSync(CLI_DIR, { recursive: true });
  }
  // package.json 박음 (npm install 의 prerequisite)
  const pkgJson = path.join(CLI_DIR, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(
      pkgJson,
      JSON.stringify(
        {
          name: 'firebat-cli-modules',
          version: '0.0.1',
          description: 'Firebat 격리 LLM CLI 디렉토리 (Phase D self-installed)',
          private: true,
          dependencies: {},
        },
        null,
        2,
      ),
    );
  }
}

function installPackage(key) {
  const pkg = PACKAGES[key];
  if (!pkg) {
    console.warn(`알 수 없는 CLI: ${key} (지원: claude / codex / gemini)`);
    return false;
  }
  console.log(`\n→ ${pkg.description}`);
  console.log(`  → npm install ${pkg.name} ...`);
  try {
    execSync(`npm install --prefix "${CLI_DIR}" "${pkg.name}"`, {
      stdio: 'inherit',
      cwd: CLI_DIR,
    });
    console.log(`  ✓ ${pkg.name} 설치 완료`);
    return true;
  } catch (e) {
    console.error(`  ✗ ${pkg.name} 설치 실패: ${e.message}`);
    return false;
  }
}

function main() {
  console.log('Firebat — Phase D self-installed CLI 격리 설치');
  console.log(`데이터 디렉토리: ${DATA_DIR}`);
  console.log(`CLI 격리 디렉토리: ${CLI_DIR}`);

  ensureNpm();
  ensureCliDir();

  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : Object.keys(PACKAGES);

  let installed = 0;
  let failed = 0;
  for (const key of targets) {
    if (installPackage(key)) installed += 1;
    else failed += 1;
  }

  console.log(`\n설치 완료 — 성공 ${installed} / 실패 ${failed}`);
  if (installed > 0) {
    const binDir = path.join(CLI_DIR, 'node_modules', '.bin');
    console.log(`\nPATH 에 추가:\n  ${binDir}`);
    console.log('\nTauri 앱이 자동으로 spawn 시 PATH 에 prepend (FIREBAT_CLI_BIN env 박음).');
  }
  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { PACKAGES, resolveDataDir };
