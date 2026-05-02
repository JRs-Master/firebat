-- v2 — Entity Memory (Phase 1 of 4-tier memory system)
--
-- 종목·인물·프로젝트·이벤트 단위 entity 추적 + linked facts (timeline).
-- 단기 대화(conversations) 와 별도 — 대화 끝나도 보존되는 정제된 사실.
--
-- 4-tier 구조:
--   - Short-term: conversations (이미 박힘)
--   - Episodic: events (Phase 2)
--   - Entity: entities + entity_facts (Phase 1, 이 마이그레이션)
--   - Contextual: RetrievalEngine 통합 검색 (Phase 5)

CREATE TABLE IF NOT EXISTS entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  aliases         TEXT    NOT NULL DEFAULT '[]',  -- JSON array
  metadata        TEXT,                            -- JSON object (자유 메타)
  embedding       BLOB,                            -- name + aliases 임베딩
  source_conv_id  TEXT,
  first_seen      INTEGER NOT NULL,
  last_updated    INTEGER NOT NULL,
  UNIQUE(name, type)                               -- 같은 name+type 은 1개만 (upsert)
);

CREATE INDEX IF NOT EXISTS idx_entities_name        ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_type        ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_lastupdated ON entities(last_updated DESC);

CREATE TABLE IF NOT EXISTS entity_facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content         TEXT    NOT NULL,
  fact_type       TEXT,                            -- 'recommendation' / 'transaction' / ... 자유
  occurred_at     INTEGER,                         -- event 발생 시각 (content 내 날짜, ms epoch)
  tags            TEXT    NOT NULL DEFAULT '[]',   -- JSON array
  embedding       BLOB,                            -- content 임베딩
  source_conv_id  TEXT,
  expires_at      INTEGER,                         -- NULL = 영구
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facts_entity      ON entity_facts(entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_factype     ON entity_facts(fact_type);
CREATE INDEX IF NOT EXISTS idx_facts_occurred    ON entity_facts(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_created     ON entity_facts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_expires     ON entity_facts(expires_at) WHERE expires_at IS NOT NULL;
