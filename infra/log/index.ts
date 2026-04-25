import { ILogPort, LogMeta } from '../../core/ports';
import fs from 'fs';
import path from 'path';
import { redactString, redactMeta } from '../security/token-redactor';
import { LOG_RETENTION_DAYS } from '../config';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');

/** 일별 로그 파일 GC — LOG_RETENTION_DAYS 보다 오래된 app-*.log / training-*.jsonl 삭제.
 *  파일명에 박힌 날짜로 판정 (mtime 보다 안정적). 일반 로직 — 패턴 매칭으로 모든 일별 파일 균일 처리. */
function gcOldLogs(): void {
  if (!fs.existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400 * 1000;
  const dailyPattern = /^(app|training)-(\d{4}-\d{2}-\d{2})\.(log|jsonl)$/;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(LOG_DIR)) {
      const m = dailyPattern.exec(name);
      if (!m) continue;
      const dateStr = m[2];  // YYYY-MM-DD
      const fileTime = new Date(dateStr + 'T00:00:00Z').getTime();
      if (Number.isFinite(fileTime) && fileTime < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, name)); removed++; } catch {}
      }
    }
  } catch {}
  if (removed > 0) {
    // 콘솔만 — 로그 파일에 쓰면 GC 결과가 다시 GC 대상이 됨 (소량이라 OK 지만 cleanliness)
    console.log(`[Firebat] 로그 GC: ${removed}개 일별 파일 정리 (보존 ${LOG_RETENTION_DAYS}일)`);
  }
}

// 부팅 시 1회 + 24시간 마다 — Node 단일 프로세스라 module load 시 한 번만 등록.
const __logGcG = globalThis as unknown as { __firebatLogGcWired?: boolean };
if (!__logGcG.__firebatLogGcWired) {
  __logGcG.__firebatLogGcWired = true;
  // 부팅 직후 lazy 실행 (서버 시작 지연 0)
  setTimeout(gcOldLogs, 30_000).unref?.();
  const dailyTimer = setInterval(gcOldLogs, 24 * 60 * 60 * 1000);
  dailyTimer.unref?.();
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function dateStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function appLogPath() {
  return path.join(LOG_DIR, `app-${dateStr()}.log`);
}

function trainingLogPath() {
  return path.join(LOG_DIR, `training-${dateStr()}.jsonl`);
}

function writeToFile(filePath: string, line: string) {
  try {
    ensureLogDir();
    fs.appendFileSync(filePath, line + '\n', 'utf-8');
  } catch {
    // 파일 쓰기 실패해도 시스템은 죽으면 안 됨
  }
}

// 학습 데이터 감지용 접두사 (AI 관리자가 기록)
const TRAINING_PREFIXES = ['[USER_AI_TRAINING]', '[CORE_AI_TRAINING]'];

function isTraining(message: string): boolean {
  return TRAINING_PREFIXES.some(p => message.includes(p));
}

function extractTrainingJson(message: string): string | null {
  for (const prefix of TRAINING_PREFIXES) {
    const idx = message.indexOf(prefix);
    if (idx !== -1) {
      const raw = message.slice(idx + prefix.length).trim();
      try {
        const parsed = JSON.parse(raw);
        // contents 형식이면 그대로 저장 (Vertex AI 파인튜닝 호환)
        if (parsed.contents && Array.isArray(parsed.contents)) {
          return JSON.stringify(parsed);
        }
        // 레거시: _prefix 붙여서 저장
        return JSON.stringify({ _prefix: prefix.replace(/[\[\]]/g, ''), ...parsed });
      } catch {
        return JSON.stringify({ _prefix: prefix.replace(/[\[\]]/g, ''), _raw: raw });
      }
    }
  }
  return null;
}

/**
 * 파일 기반 로그 어댑터
 *
 * - 일반 로그: data/logs/app-YYYY-MM-DD.log
 * - 콘솔 출력 병행
 */
export class ConsoleLogAdapter implements ILogPort {
  private debugEnabled = false;

  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  debug(message: string, meta?: LogMeta): void {
    if (!this.debugEnabled) return;
    const safeMsg = redactString(message);
    const safeMeta = meta ? redactMeta(meta) : undefined;
    const time = new Date().toISOString();
    const line = safeMeta
      ? `[${time}] [DEBUG] ${safeMsg} ${JSON.stringify(safeMeta)}`
      : `[${time}] [DEBUG] ${safeMsg}`;

    console.log(line);
    writeToFile(appLogPath(), line);
  }

  info(message: string, meta?: LogMeta): void {
    const time = new Date().toISOString();

    if (isTraining(message)) {
      // Training JSONL 은 마스킹 후 별도 파일.
      const jsonLine = extractTrainingJson(message);
      if (jsonLine) {
        // JSONL 본문도 토큰 마스킹 — 파인튜닝 데이터 누설 방지.
        try {
          const obj = JSON.parse(jsonLine);
          writeToFile(trainingLogPath(), JSON.stringify(redactMeta(obj)));
        } catch {
          writeToFile(trainingLogPath(), redactString(jsonLine));
        }
      }
      // 콘솔에는 short 메시지만 (raw training JSON 노출 X).
      console.log(`[${time}] [INFO] [training data captured]`);
      return;
    }

    const safeMsg = redactString(message);
    const safeMeta = meta ? redactMeta(meta) : undefined;
    const line = safeMeta
      ? `[${time}] [INFO] ${safeMsg} ${JSON.stringify(safeMeta)}`
      : `[${time}] [INFO] ${safeMsg}`;

    console.log(line);
    writeToFile(appLogPath(), line);
  }

  warn(message: string, meta?: LogMeta): void {
    const safeMsg = redactString(message);
    const safeMeta = meta ? redactMeta(meta) : undefined;
    const time = new Date().toISOString();
    const line = safeMeta
      ? `[${time}] [WARN] ${safeMsg} ${JSON.stringify(safeMeta)}`
      : `[${time}] [WARN] ${safeMsg}`;

    console.warn(line);
    writeToFile(appLogPath(), line);
  }

  error(message: string, meta?: LogMeta): void {
    const safeMsg = redactString(message);
    const safeMeta = meta ? redactMeta(meta) : undefined;
    const time = new Date().toISOString();
    const line = safeMeta
      ? `[${time}] [ERROR] ${safeMsg} ${JSON.stringify(safeMeta)}`
      : `[${time}] [ERROR] ${safeMsg}`;

    console.error(line);
    writeToFile(appLogPath(), line);
  }
}
