---
inclusion: manual
---

# ompweb — Recent Changes Snapshot (memory, as of v5.2.0 / 2026-11)

Branch `custom/stable-prod` @ `d9291dc`. Working tree clean. Recent work clusters:

## Jobs / background work
- `06243e1` feat(right-panel): observational **Jobs view** for background bash/eval jobs — added `lib/background-jobs.ts`, `components/panels/JobsPanel.tsx`, `/api/sessions/[id]/attachments`, i18n entries, Rust host `command_service.rs`/`pty_service.rs` tweaks.
- `7e86cd6` / `d9291dc` chore: kept `api-call-inventory` + `client-api-allowlist.json` in sync after Jobs view.
- `d9291dc` fix: preserve chat scroll when expanding tool calls (`useAgentSession`, `ChatWindow`, `rpc-manager`).

## Terminal / composer
- `ba63bdd` fix(terminal): keep PTYs alive when drawer hides; confirm tab close.
- `fba9b69` feat(composer): spontaneous **Steer** and **Queue** buttons + shortcut toggle during active run.

## Profiles / sessions / reliability
- `e277ff5` feat(profile): tab-scoped profile isolation via sessionStorage + transparent interceptor.
- `1620a3c` feat(profiles): Web UI Profile Manager + custom capabilities presets.
- `2e8f534` limit cross-profile session list to 5 most recent.
- `8c0ee56` fix(session): resolve `waiting_model` freeze, profile context leak, state timeouts.
- `9cb9407` / `d06d954` / `54590b5` fix(session/cli-lock): accurate active-CLI-session detection via collab-hosts registry; attribute CLI locks only from explicit `--resume` ids.
- `c180b04` perf: eliminate session reload lag, throttle startup subprocesses.
- `880bc33` feat(shell): resizable right workbench rail; persist custom tools/MCP across reloads.

## Models / UI
- `b3c387f`/`1be8282`/`f9fb87a` 2-section model picker in chat & settings, portal role picker, auto-save model roles, security hardening.
- `e592063`/`d988427`/`54df73a` i18n: interactive update toast, translate remaining Chinese strings (McpConfig, Settings, diagnostics, theme, boot skeleton, motion).
- `9017964` fix(diagnostics): mount status popover via portal to escape sidebar stacking context.
- `92ad8bc` feat(branches): fork-lineage section in BranchNavigator (parent link + child fork list).
- `2c759af` chore(release): bump to 5.2.0, show version in sidebar footer.

## Takeaways
- Heavy recent investment in: multi-profile isolation, background Jobs observability, terminal PTY lifecycle, session-lock correctness, and i18n (en/ja/zh-CN).
- When touching client→API calls, remember the audit allowlist + api-call-inventory sync step.
