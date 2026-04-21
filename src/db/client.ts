/**
 * SQLite Client — better-sqlite3 wrapper with schema bootstrap.
 *
 * Single-user, single-file. The database lives at:
 *   macOS:   ~/Library/Application Support/local-memory-mcp/memory.sqlite
 *   Linux:   ~/.local/share/local-memory-mcp/memory.sqlite
 *   Windows: %APPDATA%\local-memory-mcp\memory.sqlite
 *
 * Override via MEMORY_DB_PATH env var.
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = getDefaultDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // 5s lock-wait protects us when multiple MCP clients (e.g. Claude Desktop +
  // Claude Code sharing the same file) race on the same SQLite. Without this
  // any SQLITE_BUSY short-circuits the request instead of waiting briefly.
  db.pragma('busy_timeout = 5000');

  // Bootstrap schema — idempotent because of IF NOT EXISTS
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ─── Helpers ─────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * Generate a short ID — we use crypto.randomUUID but keep it as the full UUID
 * for collision safety across millions of records.
 */
export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Escape a user query string for FTS5 MATCH.
 * FTS5 has special operators: " ^ $ + - & | ( ) and treats quotes specially.
 * We wrap each token in double quotes and OR them together so multi-word
 * queries return results that match ANY token. bm25 ranking ensures documents
 * matching more tokens score higher.
 */
export function escapeFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (tokens.length === 0) return '""';
  return tokens.join(' OR ');
}
