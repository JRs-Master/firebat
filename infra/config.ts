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
export const LLM_TIMEOUT_MS = 120_000;
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

// ── AI ──────────────────────────────────────────────────────────────────
export const AI_HISTORY_WINDOW_SIZE = 8;
export const AI_MAX_TOOL_TURNS = 10;
export const AI_MAX_RETRIES = 3;
export const AI_STRING_PREVIEW_LENGTH = 120;

// ── 모듈 ────────────────────────────────────────────────────────────────
export const MODULE_ENTRY_POINTS = ['main.py', 'index.js', 'index.mjs', 'main.php', 'main.sh'];

// ── 인증 ────────────────────────────────────────────────────────────────
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

// ── Plan 캐시 ───────────────────────────────────────────────────────────
export const PLAN_CACHE_EXPIRE_MS = 10 * 60 * 1000;
export const PLAN_CACHE_MAX_SIZE = 200;
export const PLAN_UI_RENDER_DELAY_MS = 100;

// ── SEO 기본값 ─────────────────────────────────────────────────────────
export const DEFAULT_ROBOTS_TXT = 'User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin';
export const DEFAULT_SITE_TITLE = 'Firebat';
export const DEFAULT_SITE_DESCRIPTION = 'Just Imagine. Firebat Runs.';
export const DEFAULT_OG_BG_COLOR = '#f8fafc';
export const DEFAULT_OG_ACCENT_COLOR = '#2563eb';
export const DEFAULT_OG_DOMAIN = 'firebat.co.kr';
export const DEFAULT_JSONLD_ORG = 'Firebat';

// ── OAuth ───────────────────────────────────────────────────────────────
export const DEFAULT_OAUTH_TOKEN_EXPIRY_SECONDS = 3600;
