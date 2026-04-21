-- local-memory-mcp — SQLite Schema
-- better-sqlite3 + FTS5 (built-in). Zero external services.
--
-- Design principles:
--   1. Single-user: no tenant_id, no auth. One SQLite file = one user.
--   2. FTS5 for full-text search across learnings/decisions/entity observations.
--   3. Trigram-like fuzzy via LIKE + FTS5 NEAR/OR fallback.
--   4. Bi-temporal for entity observations (validFrom/validTo).
--   5. No embeddings in v1 — keyword + FTS5 is enough. Embeddings added later via fastembed-rs.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ─── SESSIONS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  project     TEXT,
  summary     TEXT,
  tasks_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

-- ─── DECISIONS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL DEFAULT (datetime('now')),
  title         TEXT NOT NULL,
  decision      TEXT NOT NULL,
  alternatives  TEXT,
  reasoning     TEXT NOT NULL,
  project       TEXT,
  tags_json     TEXT NOT NULL DEFAULT '[]',
  confidence    REAL NOT NULL DEFAULT 0.7,
  source        TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  verified_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
CREATE INDEX IF NOT EXISTS idx_decisions_date ON decisions(date DESC);

-- ─── LEARNINGS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS learnings (
  id              TEXT PRIMARY KEY,
  date            TEXT NOT NULL DEFAULT (datetime('now')),
  category        TEXT NOT NULL,
  content         TEXT NOT NULL,
  project         TEXT,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  usage_count     INTEGER NOT NULL DEFAULT 0,
  last_used       TEXT,
  confidence      REAL NOT NULL DEFAULT 0.7,
  source          TEXT,
  verified        INTEGER NOT NULL DEFAULT 0,
  verified_at     TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT,
  importance      REAL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  memory_type     TEXT NOT NULL DEFAULT 'semantic'  -- 'episodic' | 'semantic'
);
CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE INDEX IF NOT EXISTS idx_learnings_date ON learnings(date DESC);
CREATE INDEX IF NOT EXISTS idx_learnings_archived ON learnings(archived);
CREATE INDEX IF NOT EXISTS idx_learnings_lifecycle ON learnings(lifecycle_state);

-- ─── ENTITIES (Knowledge Graph Nodes) ────────────────
CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  summary       TEXT,
  confidence    REAL NOT NULL DEFAULT 0.7,
  UNIQUE(name, entity_type)
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

-- ─── ENTITY OBSERVATIONS (Bi-temporal facts about entities) ───
CREATE TABLE IF NOT EXISTS entity_observations (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  source      TEXT,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  valid_from  TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to    TEXT,
  confidence  REAL NOT NULL DEFAULT 0.7,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obs_entity ON entity_observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_obs_valid_to ON entity_observations(valid_to);

-- ─── ENTITY RELATIONS (Knowledge Graph Edges) ───────
CREATE TABLE IF NOT EXISTS entity_relations (
  id             TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL,
  weight         REAL NOT NULL DEFAULT 1.0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON entity_relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON entity_relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON entity_relations(relation_type);

-- ─── FULL-TEXT SEARCH (FTS5) ─────────────────────────
-- One unified FTS5 table across all searchable content.
-- content_type discriminates: 'learning' | 'decision' | 'entity' | 'observation'
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  content_id UNINDEXED,
  content_type UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Triggers to keep FTS5 in sync with learnings
CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'learning', new.category, new.content);
END;
CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'learning';
END;
CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'learning';
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'learning', new.category, new.content);
END;

-- Triggers for decisions
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'decision', new.title, new.decision || ' ' || new.reasoning);
END;
CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'decision';
END;
CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'decision';
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'decision', new.title, new.decision || ' ' || new.reasoning);
END;

-- Triggers for entity observations
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON entity_observations BEGIN
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'observation', (SELECT name FROM entities WHERE id = new.entity_id), new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON entity_observations BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'observation';
END;
-- Observation UPDATE trigger: refresh the FTS5 entry when content changes.
-- Without this, editing an observation's content leaves a stale FTS row
-- pointing at the old text — every future search would miss the new content
-- until the row was deleted and re-inserted. We don't currently expose an
-- "edit observation" path, but defence in depth: the trigger set stays
-- symmetric with the learnings/decisions/entities tables.
CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON entity_observations BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'observation';
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'observation', (SELECT name FROM entities WHERE id = new.entity_id), new.content);
END;

-- Triggers for entities themselves (searchable by name + summary)
CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'entity', new.name, COALESCE(new.summary, '') || ' ' || new.entity_type);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'entity';
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'entity';
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'entity', new.name, COALESCE(new.summary, '') || ' ' || new.entity_type);
END;

-- ─── META TABLE (version, settings, first_run_at) ───
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('first_run_at', datetime('now'));
