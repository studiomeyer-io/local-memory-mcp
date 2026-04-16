/**
 * Minimal logger that writes to stderr only.
 *
 * CRITICAL: stdout is reserved for MCP JSON-RPC. Anything logged to stdout
 * will break the protocol and Claude Desktop will fail to connect. All log
 * output MUST go to stderr.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: Level = (process.env.MEMORY_LOG_LEVEL as Level) || 'info';

function shouldLog(level: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

function write(level: Level, msg: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const line =
    meta !== undefined
      ? `[${level}] ${msg} ${JSON.stringify(meta)}`
      : `[${level}] ${msg}`;
  process.stderr.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write('debug', msg, meta),
  info: (msg: string, meta?: unknown) => write('info', msg, meta),
  warn: (msg: string, meta?: unknown) => write('warn', msg, meta),
  error: (msg: string, meta?: unknown) => write('error', msg, meta),
  logError: (msg: string, err: unknown) => {
    const detail = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err;
    write('error', msg, detail);
  },
};
