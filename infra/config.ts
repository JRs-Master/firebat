/**
 * Infra 공통 설정 상수
 *
 * 모든 인프라 어댑터가 참조하는 설정값을 한 곳에 모아 관리한다.
 * 환경변수가 있으면 우선 사용하고, 없으면 기본값 폴백.
 *
 * Core는 이 파일을 import하지 않는다 (인프라 내부 전용).
 */
import path from 'path';

// ── 데이터 저장 경로 ─────────────────────────────────────────────────
export const DATA_DIR = process.env.FIREBAT_DATA_DIR || 'data';
export const DB_PATH = path.join(DATA_DIR, 'app.db');
export const CRON_JOBS_FILE = path.resolve(DATA_DIR, 'cron-jobs.json');
export const CRON_LOGS_FILE = path.resolve(DATA_DIR, 'cron-logs.json');
export const CRON_NOTIFY_FILE = path.resolve(DATA_DIR, 'cron-notify.json');

// ── LLM ──────────────────────────────────────────────────────────────
export const DEFAULT_MODEL = 'gemini-3-flash-preview';
export const DEFAULT_VERTEX_LOCATION = 'us-central1';
export const LLM_TIMEOUT_MS = 60_000;
export const LLM_TEMPERATURE_JSON = 0.2;    // JSON 응답 (ask)
export const LLM_TEMPERATURE_TEXT = 0.3;    // 텍스트 응답 (askText)

// ── 샌드박스 ─────────────────────────────────────────────────────────
export const SANDBOX_TIMEOUT_MS = 30_000;
export const SANDBOX_MAX_RETRIES = 3;

// ── 크론 ─────────────────────────────────────────────────────────────
export const CRON_MAX_LOGS = 200;
export const CRON_DEFAULT_TIMEZONE = 'Asia/Seoul';
export const CRON_RECENT_NOTIFY_MS = 30_000; // 최근 알림 필터 기간

// ── 도메인 (SEO, OG 등 외부 노출용) ─────────────────────────────────
export const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://firebat.co.kr';
