# Agent Guidelines

## Workflow

1. **Read before writing.** Understand the existing code, tests, and architecture before making changes. Start with `README.md`, then the files relevant to the task.
2. **Make focused changes.** Do not reformat unrelated code, rename variables, or "improve" things outside the scope of the task.
3. **Add or update tests.** Every behavioural change should have corresponding test coverage. Run `npm test` before committing.
4. **Run validation.** Always run `npm test` and `npm run typecheck` before pushing. If either fails, fix the issue before committing.
5. **Commit checkpoints.** For longer tasks, commit and push coherent checkpoints rather than waiting until the end. Each commit should leave the codebase in a working state.
6. **Do not merge.** Create or update a pull request targeting `main`. Let a human review and merge.

## Code Style

- Follow the existing patterns in the codebase. Do not introduce new dependencies without justification.
- Keep comments concise and explain *why*, not *what*.
- Use the existing logger (`pino`) for all logging. Never `console.log`.
- Environment-driven configuration via `zod` schemas. No config files.

## Testing

- Tests use `vitest`. Run `npm test` for the full suite.
- Mock external dependencies (mnemonic, MongoDB, HTTP) — never hit real services in tests.
- Each test file should be self-contained with its own fixtures.

## Architecture Notes

- `src/proxy/handler.ts` — the request path; where memory recall and injection happen.
- `src/memory/service.ts` — the shared core for both the proxy and MCP endpoint.
- `src/mnemonic/client.ts` — the MCP client with read/write queue separation.
- `src/cache.ts` — TTL cache with hit/miss tracking.
- `src/telemetry.ts` — Langfuse telemetry (noop when credentials are missing).
- `src/config.ts` — all configuration, env-driven via zod.