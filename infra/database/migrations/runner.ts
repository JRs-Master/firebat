/**
 * DB 마이그레이션 runner — 스키마 버전 추적 + 자동 적용
 *
 * 동작:
 *   1. `_db_version` 테이블 (version PRIMARY KEY, applied_at) 자동 생성
 *   2. 현재 버전 조회 → 미설정이면 v1 으로 bootstrap (existing DB 보호)
 *      - `initialize()` 가 이미 v1 baseline 스키마 만듦 (CREATE IF NOT EXISTS + ALTER 패턴)
 *      - 즉 v1 SQL 파일 자체는 없음 — initialize() 가 implicit v1
 *   3. `migrations/NNN-name.sql` 파일 읽어 currentVersion 보다 큰 것만 순차 적용
 *      - 트랜잭션 보호 — 파일 안 SQL 도중 실패 시 전체 rollback + version 미기록
 *      - 적용 성공 시 `_db_version` 에 row 추가
 *
 * 새 스키마 변경 시 (v2 부터):
 *   1. `infra/database/migrations/002-add-xxx.sql` 파일 추가
 *   2. SQL 작성 (idempotent 권장: CREATE INDEX IF NOT EXISTS, ALTER TABLE ... 등)
 *   3. 부팅 시 자동 적용
 *
 * 일방향 (up only) — down rollback 없음. 외부 사용자 단순화 우선.
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import type { ILogPort } from '../../../core/ports';

/** 파일명 prefix 검증 — `001-name.sql` 형태만 인식. 일반 정규식, 도구별 enum X */
const MIGRATION_FILE_RE = /^(\d{3})-.+\.sql$/;

/** Bootstrap 버전 — initialize() 가 만드는 baseline 스키마. 첫 도입 시 implicit */
const IMPLICIT_BASELINE_VERSION = 1;

/** 마이그레이션 파일 디렉토리 — 컴파일된 dist 환경에서도 동일 위치 (이 파일과 같은 dir) */
const MIGRATIONS_DIR = path.join(__dirname);

interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

/** _db_version 테이블 신규 생성 + bootstrap 처리 */
function ensureVersionTable(db: Database.Database, log: ILogPort): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _db_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const row = db.prepare('SELECT MAX(version) as version FROM _db_version').get() as { version: number | null };
  const currentVersion = row?.version ?? 0;

  if (currentVersion === 0) {
    // 첫 도입 — existing DB 든 fresh 든 initialize() 가 baseline 스키마 만들어 둔 상태.
    // v1 으로 bootstrap 해서 향후 v2+ 마이그레이션만 자연 적용.
    db.prepare('INSERT INTO _db_version (version, applied_at) VALUES (?, ?)')
      .run(IMPLICIT_BASELINE_VERSION, Date.now());
    log.info(`[DB Migration] _db_version 신설 — bootstrap v${IMPLICIT_BASELINE_VERSION}`);
    return IMPLICIT_BASELINE_VERSION;
  }
  return currentVersion;
}

/** 디렉토리에서 마이그레이션 파일 로드. 파일명 prefix 순으로 정렬 */
function loadMigrationFiles(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  const entries = fs.readdirSync(MIGRATIONS_DIR);
  const files: MigrationFile[] = [];

  for (const filename of entries) {
    const match = MIGRATION_FILE_RE.exec(filename);
    if (!match) continue; // README.md / runner.ts 등 무시

    const version = parseInt(match[1], 10);
    const fullPath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(fullPath, 'utf-8').trim();
    if (!sql) continue; // 빈 파일 무시

    files.push({ version, filename, sql });
  }

  files.sort((a, b) => a.version - b.version);
  return files;
}

/** 외부 진입점 — boot.ts 또는 SqliteDatabaseAdapter.initialize() 후 호출.
 *  log 는 옵션 — 없으면 console 으로 fallback (테스트 호환). */
export function runMigrations(db: Database.Database, log?: ILogPort): void {
  const logger: ILogPort = log ?? {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
    debug: () => {},
    setDebug: () => {},
  };

  const currentVersion = ensureVersionTable(db, logger);
  const files = loadMigrationFiles();
  const pending = files.filter(f => f.version > currentVersion);

  if (pending.length === 0) {
    logger.debug?.(`[DB Migration] 적용할 마이그레이션 없음 (현재 v${currentVersion})`);
    return;
  }

  logger.info(`[DB Migration] ${pending.length}개 마이그레이션 적용 시작 (v${currentVersion} → v${pending[pending.length - 1].version})`);

  for (const mig of pending) {
    try {
      // 트랜잭션 — SQL 적용과 version 기록 atomic 처리
      const tx = db.transaction(() => {
        db.exec(mig.sql);
        db.prepare('INSERT INTO _db_version (version, applied_at) VALUES (?, ?)')
          .run(mig.version, Date.now());
      });
      tx();
      logger.info(`[DB Migration] ✓ v${mig.version} 적용 (${mig.filename})`);
    } catch (err: any) {
      // 한 마이그레이션 실패 시 즉시 중단 — 다음 단계는 스키마 의존 가능
      logger.error(`[DB Migration] ✗ v${mig.version} 실패 (${mig.filename}): ${err.message}`);
      throw new Error(`Migration ${mig.filename} failed: ${err.message}`);
    }
  }
}
