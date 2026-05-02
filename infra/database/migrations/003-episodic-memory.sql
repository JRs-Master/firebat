-- v3 — Episodic Memory (Phase 2 of 4-tier memory system)
--
-- 시간순 사건 — 자동매매 실행 / 페이지 발행 / cron trigger / 도구 호출 / 사용자 액션 등.
-- 한 번 발생하고 끝나는 사건. occurred_at 정렬이 핵심.
--
-- Entity ↔ Event m2m: 한 event 가 N entity 에 영향 가능
-- (예: '삼성전자 75000원 매수' = '삼성전자' + '자동매매봇v1' 2 entity link).

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  description     TEXT,
  who             TEXT,                            -- 'user' / 'ai' / 'cron:{jobId}' / 'sysmod:{name}' 등
  context         TEXT,                            -- JSON object (자유 메타)
  embedding       BLOB,                            -- title + description 임베딩
  source_conv_id  TEXT,
  occurred_at     INTEGER NOT NULL,                -- 실제 발생 시각 (ms epoch, 정렬 기준)
  expires_at      INTEGER,                         -- NULL = 영구
  created_at      INTEGER NOT NULL                 -- 저장 시각 (occurred_at 과 별도)
);

CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_who      ON events(who);
CREATE INDEX IF NOT EXISTS idx_events_expires  ON events(expires_at) WHERE expires_at IS NOT NULL;

-- m2m: event ↔ entity
CREATE TABLE IF NOT EXISTS event_entities (
  event_id   INTEGER NOT NULL REFERENCES events(id)   ON DELETE CASCADE,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_event_entities_entity ON event_entities(entity_id);
