# Contributing

Thanks for your interest in improving seo-tools-mcp!

## Prerequisites

- Node.js ≥ 20 (see [.nvmrc](.nvmrc))
- [pnpm](https://pnpm.io) (`corepack enable` then `corepack use pnpm`)

## Setup

```bash
git clone https://github.com/antohins/seo-tools-mcp.git && cd seo-tools-mcp
pnpm install
pnpm build        # shared (tsc) → servers (tsup bundle)
```

## Checks (run before opening a PR)

```bash
pnpm typecheck    # types across all workspaces
pnpm test         # unit tests (vitest, no network)
```

`pnpm test:live` runs an end-to-end smoke against the real provider APIs — it needs
credentials in `~/.config/seo-tools-mcp/.env` and is **not** run in CI. Optional, but
handy when touching request/auth logic.

## Project layout

- `shared/` — shared library (`@seo-tools/shared`, private, bundled into each server):
  HTTP client with retries, env/config, auth-tools factory, Yandex OAuth, region map.
- `servers/<name>/` — one MCP server per provider. Pure, testable logic lives in
  small modules (`paginate.ts`, `filters.ts`, `parse.ts`); `index.ts` wires tools.
- `tests/` — vitest unit tests (import source directly), plus `tests/live/` opt-in smoke.

Keep new pure logic in a module (not inline in `index.ts`) so it can be unit-tested —
importing `index.ts` boots the stdio server.

## Guidelines

- **Read-only by design.** These servers never mutate provider data — keep it that way.
- **No secrets in code, logs, or tests.** URLs are masked before logging (`maskUrl`);
  don't print raw tokens/keys. Never commit `.env` or real credentials.
- Add or update tests for behavior changes; `pnpm test` must stay green.
- Match the surrounding style (comments in Russian are fine — the codebase mixes both).

## Pull requests

1. Branch off `main`.
2. Make the change + tests; run `pnpm typecheck && pnpm test`.
3. Open a PR describing the change and how you verified it. CI (build + typecheck +
   test) must pass.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
