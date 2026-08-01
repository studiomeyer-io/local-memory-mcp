/**
 * Every carrier of the release version must agree with package.json.
 *
 * v2.4.0 shipped with THREE diverging versions at once: package.json said
 * 2.4.0, the MCP handshake advertised a hardcoded 2.3.0 from server.ts, and
 * the MCPB manifest still said 2.2.0 — so npm, connected clients, and Claude
 * Desktop bundles each reported a different version of the same code
 * (third-model review finding, 2026-08-01). server.ts now reads package.json
 * at boot and build-mcpb.sh syncs the manifest before packing; this test
 * pins every carrier so the next added one must be registered here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf-8'));

describe('release version consistency', () => {
  const pkgVersion: string = read('package.json').version;

  it('server.json (MCP Registry) matches package.json in both spots', () => {
    const serverJson = read('server.json');
    expect(serverJson.version).toBe(pkgVersion);
    for (const p of serverJson.packages ?? []) {
      expect(p.version, `server.json packages[] entry for ${p.identifier ?? '?'}`).toBe(pkgVersion);
    }
  });

  it('mcpb manifest matches package.json', () => {
    // build-mcpb.sh re-syncs this at pack time; the checked-in file must
    // still be right so a locally built bundle is right WITHOUT the script.
    expect(read('mcpb-build/manifest.json').version).toBe(pkgVersion);
  });

  it('package-lock.json matches package.json (both carriers)', () => {
    const lock = read('package-lock.json');
    expect(lock.version).toBe(pkgVersion);
    expect(lock.packages['']?.version).toBe(pkgVersion);
  });

  it('server.ts advertises the package.json version (no hardcoded literal)', () => {
    const src = readFileSync(join(root, 'src/server.ts'), 'utf-8');
    // Either quote style — a double-quoted hardcode must fail this too.
    expect(src).not.toMatch(/SERVER_VERSION\s*=\s*["'][0-9]/);
    expect(src).toContain("join(here, '../package.json')");
  });

  it('the mcpb bundle ships package.json so the version probe resolves', () => {
    // server.js reads '../package.json' relative to itself; in the bundle
    // that is the bundle root, which build-mcpb.sh must populate. A 2.4.1
    // iteration missed this and the bundle crashed at import time.
    const script = readFileSync(join(root, 'scripts/build-mcpb.sh'), 'utf-8');
    expect(script).toContain('cp package.json mcpb-build/');
  });
});
