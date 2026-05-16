#!/usr/bin/env node
/**
 * E5 임베딩 모델 prefetch — Firebat 서버 초기 설치 시 1회 자동 다운로드.
 *
 * 호출 시점: `npm install` 의 postinstall hook. 사용자 명시 호출 0.
 * 다운로드 대상: `intfloat/multilingual-e5-small` (~470MB)
 * 캐시 경로: `~/.cache/huggingface/hub/` (Rust hf-hub crate 와 100% 호환)
 *
 * 의존: Python 3 + `huggingface_hub` 패키지.
 *
 * Python 환경 자동 검출 순서 (PEP 668 정공):
 *  1. 시스템 PATH 의 `huggingface-cli` (pipx install / system install 사용자 영역)
 *  2. 옛 venv (`~/.firebat-venv/bin/huggingface-cli`)
 *  3. venv 자동 생성 + `huggingface_hub` 설치
 *
 * 실패 graceful — npm install 차단 0. fail 시 첫 채팅 시점 lazy 다운로드 폴백.
 *
 * skip 옵션:
 *   - `FIREBAT_SKIP_EMBEDDER_PREFETCH=1` — CI / dev 환경
 *   - `FIREBAT_EMBEDDER=stub` — stub embedder 사용 시
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODEL_ID = 'intfloat/multilingual-e5-small';
const CACHE_DIR = join(homedir(), '.cache/huggingface/hub', `models--${MODEL_ID.replace(/\//g, '--')}`);

// Firebat self-contained — venv 도 source root 안 생성.
// sandbox.rs 의 `<workspace>/python_modules` (sysmod deps 격리) 와 일관 패턴.
// process.cwd() = `npm install` 실행 디렉토리 (source root, 예: /opt/firebat-src).
// FIREBAT_VENV_DIR env 설정되어 있으면 override (custom workspace 환경).
const VENV_DIR = process.env.FIREBAT_VENV_DIR || join(process.cwd(), '.venv');
// huggingface_hub 0.30+ 부터 cli 이름 `huggingface-cli` → `hf` 로 변경. 옛 cli 는 deprecated.
// 두 영역 모두 시도 (새 venv = hf, 옛 venv = huggingface-cli 잔존).
const VENV_HF = join(VENV_DIR, 'bin', 'hf');
const VENV_HF_CLI_LEGACY = join(VENV_DIR, 'bin', 'huggingface-cli');

if (process.env.FIREBAT_SKIP_EMBEDDER_PREFETCH === '1') {
  console.log('[firebat-setup] FIREBAT_SKIP_EMBEDDER_PREFETCH=1 — skip');
  process.exit(0);
}
if (process.env.FIREBAT_EMBEDDER === 'stub') {
  console.log('[firebat-setup] FIREBAT_EMBEDDER=stub — skip (stub embedder 사용)');
  process.exit(0);
}

// 이미 cache 존재하면 skip (매 npm install 시점 부담 0)
if (existsSync(CACHE_DIR)) {
  console.log(`[firebat-setup] E5 cache 이미 존재 — skip (${CACHE_DIR})`);
  process.exit(0);
}

console.log(`[firebat-setup] E5 임베딩 모델 prefetch 시작 (~470MB)...`);

function check(cmd) {
  const r = spawnSync('sh', ['-c', cmd], { stdio: 'ignore' });
  return r.status === 0;
}

if (!check('python3 --version')) {
  console.warn('[firebat-setup] python3 미설치 — E5 prefetch skip. 첫 채팅 시점 lazy 다운로드 폴백.');
  process.exit(0);
}

// hf cli 검출 경로 (PEP 668 정공):
//  1. 시스템 PATH (pipx install 또는 system install 사용자 영역)
//  2. 옛 venv (.venv/bin/hf 또는 옛 huggingface-cli legacy)
//  3. venv 자동 생성 + huggingface_hub 설치
let cli = null;
if (check('hf --version')) {
  cli = 'hf';
  console.log('[firebat-setup] 시스템 hf cli 사용');
} else if (existsSync(VENV_HF)) {
  cli = VENV_HF;
  console.log(`[firebat-setup] venv hf cli 사용 (${VENV_HF})`);
} else if (existsSync(VENV_HF_CLI_LEGACY)) {
  cli = VENV_HF_CLI_LEGACY;
  console.log(`[firebat-setup] 옛 venv huggingface-cli (deprecated) 사용 — 새 hf 권장`);
} else {
  console.log(`[firebat-setup] venv 생성 + huggingface_hub 설치 (${VENV_DIR})...`);
  try {
    // python3-venv 패키지 필요 (Debian/Ubuntu) — apt install python3-venv 사전 설치 필수.
    execSync(`python3 -m venv "${VENV_DIR}"`, { stdio: 'inherit' });
    execSync(`"${VENV_DIR}/bin/pip" install --quiet huggingface_hub`, { stdio: 'inherit' });
    // huggingface_hub 0.30+ 는 새 cli `hf` 만 설치 (옛 huggingface-cli deprecated).
    cli = existsSync(VENV_HF) ? VENV_HF : VENV_HF_CLI_LEGACY;
  } catch (e) {
    console.warn(`[firebat-setup] venv 생성 실패 — E5 prefetch skip. 첫 채팅 시점 lazy 다운로드 폴백.`);
    console.warn(`  원인: ${e.message}`);
    console.warn(`  해결: sudo apt install python3-venv`);
    console.warn(`        또는: pipx install huggingface_hub (PATH 의 hf cli 자동 등록)`);
    process.exit(0);
  }
}

// 모델 다운로드
try {
  execSync(`"${cli}" download ${MODEL_ID}`, { stdio: 'inherit' });
  console.log(`[firebat-setup] E5 모델 prefetch 완료 — ${CACHE_DIR}`);
} catch (e) {
  console.warn(`[firebat-setup] E5 모델 다운로드 실패 — 첫 채팅 시점 lazy 다운로드 폴백.`);
  console.warn(`  원인: ${e.message}`);
  process.exit(0);
}
