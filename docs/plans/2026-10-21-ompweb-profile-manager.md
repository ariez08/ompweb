# OmpWeb — Web UI Profile Manager

| | |
|---|---|
| **Target Worktree** | `C:\CodeAgent\ompweb-beta` (`beta/multi-profile-live`) |
| **Baseline** | `d06d954` (`custom/stable-prod` parity) |
| **Status** | Implemented (localized en/ja/zh-CN, verified live on 30179) |
| **Port** | 30179 (Beta Dev/Staging) |

---

## 1. Problem & Goals

OMP supports multi-profile layouts (`~/.omp/agent` for default, and `~/.omp/profiles/<name>/agent` for named profiles), each with its own `config.yml`, `models.yml`, `mcp.json`, `AGENTS.md`, `RULES.md`, and sessions.
Currently in ompweb:
1. Profiles are only discovered read-only.
2. Creating, duplicating, or configuring a profile requires CLI commands (`omp --profile <name>`) or manual filesystem operations.
3. Users need a complete Web UI Profile Manager to:
   - View all profiles and their configurations (model roles, MCP servers, AGENTS.md/RULES.md).
   - Create new profiles from templates or by cloning existing profiles.
   - Edit profile configurations directly in the UI.
   - Delete obsolete non-default profiles safely.
   - Switch active profiles with a single click.

---

## 2. Technical Architecture

### A. Backend (`lib/omp/profile-manager.ts` & API Routes)
- **Profile Discovery & Validation**:
  - Profile name regex: `^[a-zA-Z0-9_-]{1,32}$`.
  - Disallowed names: `"default"` (reserved), existing profile names.
- **Creation / Cloning**:
  - Target agent directory: `~/.omp/profiles/<name>/agent/`.
  - If `copyFrom` specified: copies `config.yml`, `models.yml`, `mcp.json`, `AGENTS.md`, `RULES.md` from the source profile.
  - If new: creates default template files (`config.yml` with standard roles, empty/minimal `mcp.json`, starter `AGENTS.md`).
- **Inspection & Editing**:
  - `GET /api/profiles/[profile]`: loads profile files (`config.yml`, `models.yml`, `mcp.json`, `AGENTS.md`, `RULES.md`) and summary stats.
  - `PUT /api/profiles/[profile]`: writes changes back to the respective profile files.
  - `DELETE /api/profiles/[profile]`: deletes the profile folder (guard: non-default, non-active).

### B. Frontend (`components/ProfileManager.tsx` & Settings Integration)
- **Settings Tab Integration**:
  - New tab in `SettingsTabs.tsx`: `profiles` with `Layers` icon.
  - Rendered in `SettingsConfig.tsx` when `activeTab === "profiles"`.
- **Sidebar Integration**:
  - In `ProfileSwitcher.tsx`, add an icon button to open the Profile Manager directly.
  - Always render `ProfileSwitcher` (even with 1 profile) so users can easily discover and create profiles.
- **UI Structure**:
  - **Profiles List**: Grid of profile cards showing active status, model count, session count, MCP count, and action buttons.
  - **Create Modal / Drawer**: Form with name input and clone source selector.
  - **Profile Details / Editor**: Tabbed editor for Model Roles, MCP Servers, Personality & Rules (`AGENTS.md`/`RULES.md`), and raw YAML/JSON.

---

## 3. Verification & Safety Gates
1. Run `bun run typecheck` (or `npm run typecheck`).
2. Run `node scripts/audit-client-api.mjs --update-allowlist` and `--check`.
3. Launch beta on port 30179 and test live:
   - Create new profile `test-dev`.
   - Edit its `AGENTS.md` and `config.yml`.
   - Switch to `test-dev`.
   - Switch back to `default` and delete `test-dev`.
