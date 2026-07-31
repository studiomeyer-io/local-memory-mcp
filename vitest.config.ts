import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Deterministic 384-dim token-hash vectors instead of pulling the 120 MB
    // multilingual-e5-small model into every run. Set here rather than as a
    // shell prefix on the npm script so the suite also runs on Windows, where
    // npm executes scripts through cmd.exe and `VAR=1 cmd` is a syntax error.
    env: { MEMORY_EMBED_MOCK: '1' },
  },
});
