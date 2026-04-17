/**
 * SQLite Client for Bun runtime — uses bun:sqlite (built-in, no native module).
 *
 * This file is used ONLY for the .mcpb binary bundle (bun build --compile).
 * The npm package uses client.ts with better-sqlite3 instead.
 *
 * Schema is embedded as a string constant so the compiled binary doesn't need
 * to read from the filesystem at runtime.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';

// Schema embedded at build time — no filesystem dependency.
const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT, project TEXT, summary TEXT, tasks_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, date TEXT NOT NULL DEFAULT (datetime('now')),
  title TEXT NOT NULL, decision TEXT NOT NULL, alternatives TEXT,
  reasoning TEXT NOT NULL, project TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.7, source TEXT,
  verified INTEGER NOT NULL DEFAULT 0, verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
CREATE INDEX IF NOT EXISTS idx_decisions_date ON decisions(date DESC);

CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY, date TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT NOT NULL, content TEXT NOT NULL, project TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]', usage_count INTEGER NOT NULL DEFAULT 0,
  last_used TEXT, confidence REAL NOT NULL DEFAULT 0.7, source TEXT,
  verified INTEGER NOT NULL DEFAULT 0, verified_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT, importance REAL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  memory_type TEXT NOT NULL DEFAULT 'semantic'
);
CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON learnings(category);
CREATE INDEX IF NOT EXISTS idx_learnings_date ON learnings(date DESC);
CREATE INDEX IF NOT EXISTS idx_learnings_archived ON learnings(archived);
CREATE INDEX IF NOT EXISTS idx_learnings_lifecycle ON learnings(lifecycle_state);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, entity_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary TEXT, confidence REAL NOT NULL DEFAULT 0.7,
  UNIQUE(name, entity_type)
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS entity_observations (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  content TEXT NOT NULL, source TEXT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  valid_from TEXT NOT NULL DEFAULT (datetime('now')), valid_to TEXT,
  confidence REAL NOT NULL DEFAULT 0.7,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obs_entity ON entity_observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_obs_valid_to ON entity_observations(valid_to);

CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_entity_id, to_entity_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_rel_from ON entity_relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON entity_relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON entity_relations(relation_type);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  content_id UNINDEXED, content_type UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2'
);

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

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON entity_observations BEGIN
  INSERT INTO search_fts(content_id, content_type, title, body)
  VALUES (new.id, 'observation', (SELECT name FROM entities WHERE id = new.entity_id), new.content);
END;
CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON entity_observations BEGIN
  DELETE FROM search_fts WHERE content_id = old.id AND content_type = 'observation';
END;

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

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('first_run_at', datetime('now'));
`;

export function getDefaultDbPath(): string {
  if (process.env.MEMORY_DB_PATH) return resolve(process.env.MEMORY_DB_PATH);

  const home = homedir();
  const os = platform();
  const base =
    os === 'darwin'
      ? join(home, 'Library', 'Application Support', 'local-memory-mcp')
      : os === 'win32'
        ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'local-memory-mcp')
        : join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'local-memory-mcp');

  return join(base, 'memory.sqlite');
}

let dbInstance: Database | null = null;

export function getDb(): Database {
  if (dbInstance) return dbInstance;

  const dbPath = getDefaultDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

export function newId(): string {
  return crypto.randomUUID();
}

export function escapeFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (tokens.length === 0) return '""';
  return tokens.join(' OR ');
}
