---
inclusion: always
---

# ompweb — Dev Workflow & Build (memory)

## Commands
- `npm run dev` — dev server on `127.0.0.1:30178` (uses request-peer preload).
- `npm run dev:lan` — bind `0.0.0.0` for LAN.
- `tsc --noEmit` (or `npm run typecheck`) — typecheck.
- `npm run lint` — eslint.
- `npm test` — runs `scripts/audit-client-api.mjs --check` then node `--test` over the many `*.test.mjs` across `lib/`, `lib/omp/`, `lib/contracts/`, `components/**`, `hooks/`, `bin/`, `desktop/`.
- `npm run build` — `next build --webpack` + `scripts/postbuild-static.mjs`. **Never run `next build` during dev** — it pollutes `.next/` and breaks `npm run dev`.
- `npm run release:check` — typecheck + lint + test + build.
- Rust host: workspace in `crates/` (`cargo` build); staged via `npm run host:build` / `host:stage`.
- Desktop (Electron): `npm run desktop:start`, `desktop:build:win`, etc.

## Platform
- Dev environment is **Windows / PowerShell**. Use `;` not `&&`; `$env:VAR` not `%VAR%`.
- Node engine requirement: `>=22.19.0`.

## Testing conventions
- Tests are `.mjs` using node's built-in `node:test` (`--experimental-strip-types`), colocated next to source.
- `scripts/audit-client-api.mjs` + `scripts/client-api-allowlist.json` enforce the client→API call inventory; keep `docs/refactor/.../api-call-inventory.*` and the allowlist in sync when adding client API calls (recent commits 7e86cd6, d9291dc did this).
- Do NOT add tests unless requested, but existing areas have strong regression coverage — follow it.

## Git
- Active branch: `custom/stable-prod` (tracks `origin/custom/stable-prod`).
- Commit style: conventional commits with scopes, e.g. `feat(composer):`, `fix(terminal):`, `chore(release):`.
