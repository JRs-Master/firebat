# DB 마이그레이션

스키마 변경 시 사용. 부팅 시 자동 적용되어 모든 사용자 DB 동기화.

## 작동 원리

1. `_db_version` 테이블이 현재 스키마 버전 추적
2. 부팅 시 `runner.ts` 가 `migrations/NNN-name.sql` 파일 검색
3. 현재 버전보다 큰 파일만 순차 적용 (트랜잭션 보호)
4. 적용 성공 시 `_db_version` row 추가

**v1 = implicit baseline** — 처음 도입 시점 (initialize() 가 만드는 스키마). SQL 파일 없음. 새 변경은 v2 부터.

## 새 마이그레이션 추가

스키마 변경 (컬럼 추가, 인덱스 추가, 새 테이블 등) 시:

1. 다음 사용 가능한 버전 번호 확인 (예: `_db_version` 최댓값 + 1)
2. `infra/database/migrations/NNN-짧은이름.sql` 파일 생성
   - NNN = 3자리 zero-padding (002, 003, ...)
   - 짧은이름 = 변경 요약 (예: `add-user-prefs`, `index-conversation-owner`)
3. SQL 작성 — **idempotent 권장** (재시도 안전)
4. commit + push → 서버 `git pull && pm2 restart firebat` 시 자동 적용

## 예시

**`002-add-user-prefs.sql`** — 사용자 선호도 컬럼:
```sql
ALTER TABLE conversations ADD COLUMN user_prefs TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_prefs ON conversations(user_prefs);
```

**`003-add-feedback-table.sql`** — 신규 테이블:
```sql
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  comment    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at DESC);
```

## 주의사항

- **일방향 (up only)** — down rollback 없음. 외부 사용자 단순화 우선
- **트랜잭션 보호** — 한 SQL 도중 실패하면 전체 rollback + version 미기록 → 다음 부팅 때 다시 시도
- **테스트** — production 배포 전 dev 환경 (별도 DB) 에서 검증
- **백업** — 마이그레이션 적용 전 `data/app.db` 백업 권장 (기존 backup.sh 활용)
- **컬럼 삭제·이름 변경** — SQLite 제약 → 12-step 절차 (https://www.sqlite.org/lang_altertable.html). 가급적 회피, 새 컬럼 추가로 우회

## 디버깅

마이그레이션 적용 로그:
```
[DB Migration] _db_version 신설 — bootstrap v1
[DB Migration] 1개 마이그레이션 적용 시작 (v1 → v2)
[DB Migration] ✓ v2 적용 (002-add-user-prefs.sql)
```

실패 시:
```
[DB Migration] ✗ v2 실패 (002-add-user-prefs.sql): ...
```
→ 부팅 자체 실패 — SQL 수정 후 재배포.

현재 버전 직접 확인:
```bash
sqlite3 data/app.db "SELECT * FROM _db_version ORDER BY version DESC"
```
