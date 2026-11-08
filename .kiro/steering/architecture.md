---
inclusion: always
---

# ompweb — Architecture & Subsystems (memory)

Next.js 16 (React 19, App Router) + Node server. Three-layer repo:
Next.js app (`app/`, `components/`, `hooks/`, `lib/`) · Rust host (`crates/`) · Electron desktop (`desktop/`).

## Shared OMP foundations — `lib/omp/`
- `paths.ts` — Node port of omp directory resolution (`~/.omp/agent`, profiles, XDG, session-dir slugs).
- `omp-cli.ts` / `host-bin.ts` — locate/probe installed `omp` binary (`resolveOmpBin`, version).
- `rpc-process.ts`, `rpc-frame.ts`, `rpc-utility.ts` — process + NDJSON protocol (chunked-frame reassembly, v1/v2).
- `rust-rpc-process.ts` / `host-client.ts` — talk to the Rust `ompweb-host` binary.
- `session-files.ts` — mtime-keyed session directory walk cache.
- `profile-*.ts` — multi-profile isolation (per-tab via sessionStorage/cookie).
- `agents-service.ts`, `models-config.ts`, `model-roles.ts`, `mcp-config.ts`, `settings-config.ts`, `archive.ts`, `updates.ts`.

## Key lib modules
- `rpc-manager.ts` — session registry + `startRpcSession()`. Keyed in a **`globalThis`** registry so it survives Next hot-reload (a plain module Map does not). Idle sessions disposed on timeout; concurrent starts share one start promise. Also drives `/api/agent/running/events` SSE and background-jobs.
- `session-reader.ts` — `.jsonl` parsing, path cache, `buildSessionContext`. 30s TTL list cache.
- `normalize.ts` — `normalizeToolCalls()` reconciles file format `{type,id,name,arguments}` vs `ToolCallContent {toolCallId,toolName,input}`. Called on file load AND streaming.
- `background-jobs.ts` — observational background bash/eval job tracking (Jobs view).
- `worktree.ts`, `project-registry.ts`, `project-ordering.ts` — projects/worktrees sidebar model.
- `file-access.ts` — allow-listed file roots (session cwds, resolved project roots, `~/omp-cwd-*`, explicit `allowFileRoot()`). `/api/files` is NOT a general FS browser.
- `remote-protocol/`, `relay/`, `remote-pairing*.ts` — remote access / pairing / relay transport (WS).
- `terminal-*.ts` — PTY/terminal session management (backed by Rust host PTY).
- `stt*.ts` — speech-to-text jobs. `capabilities-*.ts` — custom capability presets.
- `web-auth.ts` — password sign-in (HTTP-only signed cookie, 30-day); `request-security.ts` — origin checks.

## API routes — `app/api/`
agent (new/[id]/events/running/bash-output/jobs), sessions (+ context/export/attachments/subagents), auth, capabilities, cwd, default-cwd, diagnostics, files, git, github, mcp, models/models-config/model-roles, native-settings/omp-settings, omp-update/app-update/omp-version, pair, plugins, profile/profiles, provider-usage/providers/usage/usage-summary, proxy/browser-proxy, reveal, scripts, skills, stt, terminal, web-auth, worktrees, health.

## Rust host — `crates/` (workspace, `ompweb-host` v0.1.0)
User-scoped host binary. Members: `ompweb-protocol`, `ompweb-storage`, `ompweb-host`.
Deps intentionally minimal; gated by ADR "doors": `portable-pty` (cross-platform PTY), `tokio` + `tokio-tungstenite` + `futures-util` (Rust WS RemoteRuntime), `getrandom`. Migrates PTY and remote-runtime domains out of Node.

## Security contract (enforce)
- Loopback-only by default; non-loopback is explicit opt-in.
- `OMP_WEB_PASSWORD` gates every route; exposed deploys need HTTPS reverse proxy/VPN.
- API requests origin-checked. OMP RPC host tools deliberately NOT registered (no browser→host arbitrary exec).
- File APIs restricted + path-canonicalized against traversal/symlink escape.
- Secrets / raw API keys / `agent.db` contents never appear in responses, logs, or browser.

## Two kinds of branching (don't confuse)
- **Fork** (Fork button): new independent `.jsonl` file, shown as child via `parentSession` header.
- **In-session branch** (Continue/BranchNavigator): navigates entry tree within same file (shared `parentId`), via `/api/sessions/[id]/context?leafId=`.

## Session file format v3
`~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Line 1 = fixed 256-byte padded `title` slot (older pi files lack it → `session` header is line 1). Entries form `(id,parentId)` tree. Large payloads externalized to blob store `~/.omp/agent/blobs`. Readers must tolerate unknown entry types.
