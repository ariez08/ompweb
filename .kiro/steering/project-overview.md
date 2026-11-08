---
inclusion: always
---

# ompweb — Project Overview (memory)

Local, browser-based workspace for the **oh-my-pi (`omp`)** coding agent.
npm package + CLI: `@37chengshan/ompweb` (bin `ompweb`). Current version: **5.2.0**.
Downstream of `agegr/pi-web` (MIT), maintained as an OMP-focused fork.

## Core product principles (from DESIGN.md)
1. **OMP stays authoritative** — sessions, credentials, providers, agent behavior belong to the installed `omp` CLI. No parallel data format or credential store.
2. **Local-first** — server binds `127.0.0.1` by default; remote access is explicit opt-in behind HTTPS/trusted network.
3. **Node-first install** — users install Node 22.19+ and OMP, then `npx ompweb@latest`. ompweb never requires Bun for its own runtime.
4. **Native compatibility over imitation** — prefer OMP CLI + documented on-disk formats over copied SDK internals.
5. **Calm, capable workspace** — never hide agent state; not a general remote-control plane.

## The locked CLI boundary (critical)
- ompweb **never imports `@oh-my-pi/*` or `@earendil-works/*`** — those are Bun-only TypeScript and break in Node/Next.
- Live agent work goes through a spawned `omp --mode rpc-ui` child (NDJSON over stdio), one process per active session.
- Session browsing is **pure-Node** parsing of `.jsonl` files — no child process needed.
- RPC negotiates v2 when advertised, reassembles chunked frames, stays v1-compatible.

## Runtime shape
```
Browser  ──HTTP/SSE──▶  ompweb (Next.js 16 on Node)
                          ├─ reads native OMP session files + selected config
                          ├─ serves allow-listed project files
                          └─ spawns `omp --mode rpc-ui` per active session (NDJSON stdio)
                                        ▼  installed OMP CLI + ~/.omp/agent state
```

## Default addresses / env
- Dev server: `127.0.0.1:30178` (`npm run dev`). Prod `start`: `30177`.
- Config env prefix `OMP_WEB_*`: `OMP_WEB_HOSTNAME`, `OMP_WEB_NO_OPEN`, `OMP_WEB_PASSWORD`, `OMP_WEB_OMP_BIN`.
- Respects `PI_CODING_AGENT_DIR`, profiles, and OMP directory conventions.
- The dev server needs the `omp` binary on PATH (or `OMP_WEB_OMP_BIN`).

## Non-goals
- Reimplementing OMP / its provider registry / credential DB.
- Embedding Bun-only SDK packages in Node.
- Internet-facing multi-user service; unrestricted filesystem browsing; arbitrary browser-triggered host tools.
