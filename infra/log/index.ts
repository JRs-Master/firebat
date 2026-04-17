import { ILogPort, LogMeta } from '../../core/ports';
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');

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

function writeToFile(filePath: string, line: string) {
  try {
    ensureLogDir();
    fs.appendFileSync(filePath, line + '\n', 'utf-8');
  } catch {
    // 파일 쓰기 실패해도 시스템은 죽으면 안 됨
  }
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
    const time = new Date().toISOString();
    const line = meta
      ? `[${time}] [DEBUG] ${message} ${JSON.stringify(meta)}`
      : `[${time}] [DEBUG] ${message}`;

    console.log(line);
    writeToFile(appLogPath(), line);
  }

  info(message: string, meta?: LogMeta): void {
    const time = new Date().toISOString();
    const line = meta
      ? `[${time}] [INFO] ${message} ${JSON.stringify(meta)}`
      : `[${time}] [INFO] ${message}`;

    console.log(line);
    writeToFile(appLogPath(), line);
  }

  warn(message: string, meta?: LogMeta): void {
    const time = new Date().toISOString();
    const line = meta
      ? `[${time}] [WARN] ${message} ${JSON.stringify(meta)}`
      : `[${time}] [WARN] ${message}`;

    console.warn(line);
    writeToFile(appLogPath(), line);
  }

  error(message: string, meta?: LogMeta): void {
    const time = new Date().toISOString();
    const line = meta
      ? `[${time}] [ERROR] ${message} ${JSON.stringify(meta)}`
      : `[${time}] [ERROR] ${message}`;

    console.error(line);
    writeToFile(appLogPath(), line);
  }
}
