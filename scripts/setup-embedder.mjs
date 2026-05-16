#!/usr/bin/env node
/**
 * E5 임베딩 모델 prefetch — Firebat 서버 초기 설치 시 1회 자동 다운로드.
 *
 * 호출 시점: `npm install` 의 postinstall hook. 사용자 명시 호출 0.
 * 다운로드 대상: `intfloat/multilingual-e5-small` (~470MB)
 * 캐시 경로: `~/.cache/huggingface/hub/` (Rust hf-hub crate 와 100% 호환)
 *
 * 의존: Python 3 + `huggingface_hub` 패키지. Vultr 같은 서버 환경은 Python 박혀있음
 * (sysmod yfinance / kma-weather / 등 의존).
 *
 * 실패 graceful — npm install 차단 0. fail 시 첫 채팅 시점 lazy 다운로드 폴백.
 *
 * skip 옵션:
 *   - 환경 변수 `FIREBAT_SKIP_EMBEDDER_PREFETCH=1` 박혀있으면 skip (CI / dev 환경 용)
 *   - 환경 변수 `FIREBAT_EMBEDDER=stub` 박혀있으면 skip (stub embedder 사용 시)
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODEL_ID = 'intfloat/multilingual-e5-small';
const CACHE_DIR = join(homedir(), '.cache/huggingface/hub', `models--${MODEL_ID.replace(/\//g, '--')}`);

if (process.env.FIREBAT_SKIP_EMBEDDER_PREFETCH === '1') {
  console.log('[firebat-setup] FIREBAT_SKIP_EMBEDDER_PREFETCH=1 — skip');
  process.exit(0);
}
if (process.env.FIREBAT_EMBEDDER === 'stub') {
  console.log('[firebat-setup] FIREBAT_EMBEDDER=stub — skip (stub embedder 사용)');
  process.exit(0);
}

// 이미 cache 박혀있으면 skip (매 npm install 시점 부담 0)
if (existsSync(CACHE_DIR)) {
  console.log(`[firebat-setup] E5 cache 이미 존재 — skip (${CACHE_DIR})`);
  process.exit(0);
}

console.log(`[firebat-setup] E5 임베딩 모델 prefetch 시작 (~470MB)...`);

// Python 3 + huggingface_hub 패키지 존재 확인
function check(cmd) {
  const r = spawnSync('sh', ['-c', cmd], { stdio: 'ignore' });
  return r.status === 0;
}

if (!check('python3 --version')) {
  console.warn('[firebat-setup] python3 미설치 — E5 prefetch skip. 첫 채팅 시점 lazy 다운로드 폴백.');
  process.exit(0);
}

if (!check('python3 -c "import huggingface_hub"')) {
  console.log('[firebat-setup] huggingface_hub 패키지 설치 중...');
  try {
    // root user 면 --user 박지 X, 그 외 --user 박음 (graceful detection)
    const userFlag = process.getuid && process.getuid() === 0 ? '' : '--user';
    execSync(`pip3 install --quiet ${userFlag} huggingface_hub`, { stdio: 'inherit' });
  } catch (e) {
    console.warn(`[firebat-setup] huggingface_hub 설치 실패 — E5 prefetch skip. 첫 채팅 시점 lazy 다운로드 폴백.`);
    console.warn(`  원인: ${e.message}`);
    process.exit(0);
  }
}

// 모델 다운로드 — `huggingface-cli download` 또는 `python -m huggingface_hub.commands.huggingface_cli download`
try {
  // 표준 cli 우선 시도
  let cliPath = 'huggingface-cli';
  if (!check('huggingface-cli --help')) {
    cliPath = 'python3 -m huggingface_hub.commands.huggingface_cli';
  }
  execSync(`${cliPath} download ${MODEL_ID}`, { stdio: 'inherit' });
  console.log(`[firebat-setup] E5 모델 prefetch 완료 — ${CACHE_DIR}`);
} catch (e) {
  console.warn(`[firebat-setup] E5 모델 다운로드 실패 — 첫 채팅 시점 lazy 다운로드 폴백.`);
  console.warn(`  원인: ${e.message}`);
  process.exit(0);
}
