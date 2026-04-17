# Contributing

Issues and pull requests welcome.

## Local Development

```bash
git clone https://github.com/studiomeyer-io/local-memory-mcp.git
cd local-memory-mcp
npm install
npm run dev    # starts server with tsx watch
npm test       # runs vitest
npm run build  # compiles TypeScript
```

Test manually:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node dist/server.js
```

## Pull Requests

- One feature or fix per PR
- Include tests for new tools
- Run `npm test` and `npm run build` before submitting
- Keep PRs small and focused

## Commit Messages

Format: `type: short description`

Types: `feat`, `fix`, `docs`, `chore`, `test`
