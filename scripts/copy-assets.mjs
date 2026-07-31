/**
 * Copy the SQL assets tsc does not emit, then mark the stdio entrypoint
 * executable for the `bin` field.
 *
 * Replaces the `cp` / `mkdir -p` / `chmod` chain that used to live in the
 * build script. npm runs scripts through cmd.exe on Windows, where none of
 * those commands exist, so `npm run build` failed at the first `cp` after tsc
 * had already emitted dist/ — leaving a dist without schema.sql, which then
 * fails to bootstrap a fresh database.
 */
import { chmodSync, cpSync, mkdirSync, readdirSync } from 'node:fs';

mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/schema.sql', 'dist/db/schema.sql');

for (const file of readdirSync('src/db/migrations').filter((n) => n.endsWith('.sql'))) {
  cpSync(`src/db/migrations/${file}`, `dist/db/migrations/${file}`);
}

// No-op on Windows beyond the read-only bit, which is what we want.
chmodSync('dist/server.js', 0o755);
