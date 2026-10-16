/**
 * Profile discovery + per-request profile context (multi-profile live, Opsi C).
 *
 * A profile name reaching ompweb from a cookie/query is untrusted input. It is
 * never turned into a filesystem root directly: `resolveProfileContext`
 * validates it against the profiles that actually exist on disk under
 * `~/.omp/profiles` (plus the implicit `default`), then derives every path
 * through the scope-parameterized helpers in paths.ts so PI_CONFIG_DIR,
 * PI_CODING_AGENT_DIR precedence and the opt-in XDG layout stay correct.
 *
 * Resolution is pure and synchronous; counting is the caller's job (async,
 * per-domain) so this module never imports the session/model readers.
 */
import { readdirSync, statSync } from "fs";
import * as path from "path";
import {
  type PathScope,
  activeProfile,
  envScope,
  getAgentDir,
  getArchivedSessionsDir,
  getBlobsDir,
  getConfigRoot,
  getModelsConfigPath,
  getSessionsDir,
  getSettingsPath,
  getUserAgentsDir,
  getUserSkillsDir,
  normalizeProfileName,
} from "./paths";

/** Canonical key for the implicit profile (`~/.omp/agent`). */
export const DEFAULT_PROFILE = "default";

export interface ProfileContext {
  /** Canonical key: the profile name, or `"default"`. Safe as a map key. */
  key: string;
  /** Display name; `"default"` for the implicit profile. */
  profile: string;
  /** True for the implicit `~/.omp/agent` profile. */
  isDefault: boolean;
  /** Raw scope handed to paths.ts helpers; what a spawned host should inherit. */
  scope: PathScope;
  configRoot: string;
  agentDir: string;
  sessionsDir: string;
  archivedSessionsDir: string;
  blobsDir: string;
  settingsPath: string;
  modelsConfigPath: string;
  userSkillsDir: string;
  userAgentsDir: string;
  /** ompweb-owned event journal for this profile (never shared). */
  runtimeDbPath: string;
}

/** Environment for a spawned ompweb-host / omp child pinned to this profile.
 * OMP_PROFILE is set explicitly (empty string selects the default profile
 * rather than inheriting PI_PROFILE) and PI_PROFILE is cleared so a stale
 * legacy value cannot override the pin. */
export function hostEnvFor(ctx: ProfileContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OMP_PROFILE: ctx.isDefault ? "" : ctx.profile,
    PI_PROFILE: "",
    PI_CODING_AGENT_DIR: ctx.agentDir,
    OMPWEB_RUNTIME_DB: ctx.runtimeDbPath,
  };
}

function buildContext(profile: string, scope: PathScope): ProfileContext {
  return {
    key: profile,
    profile,
    isDefault: profile === DEFAULT_PROFILE,
    scope,
    configRoot: getConfigRoot(scope),
    agentDir: getAgentDir(scope),
    sessionsDir: getSessionsDir(scope),
    archivedSessionsDir: getArchivedSessionsDir(scope),
    blobsDir: getBlobsDir(scope),
    settingsPath: getSettingsPath(scope),
    modelsConfigPath: getModelsConfigPath(scope),
    userSkillsDir: getUserSkillsDir(scope),
    userAgentsDir: getUserAgentsDir(scope),
    runtimeDbPath: path.join(getAgentDir(scope), "ompweb", "runtime.db"),
  };
}

/** Context for the profile this process was launched with (env-derived). */
export function defaultProfileContext(): ProfileContext {
  const scope = envScope();
  return buildContext(activeProfile(scope) ?? DEFAULT_PROFILE, scope);
}

/** The `~/.omp/profiles` root for the current PI_CONFIG_DIR layout. */
function profilesRoot(): string {
  // Config root with no profile applied, so the lookup itself is profile-free.
  return path.join(getConfigRoot({ ...envScope(), ompProfile: "", piProfile: "" }), "profiles");
}

/**
 * Profile names that exist on disk, sorted, excluding `default` (implicit).
 * Entries that fail normalization or are not directories are skipped — a stray
 * file named `Foo!` is not a profile and must never become a filesystem root.
 */
export function listProfileNames(): string[] {
  const root = profilesRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries) {
    try {
      const normalized = normalizeProfileName(entry);
      if (!normalized || normalized === DEFAULT_PROFILE) continue;
      if (!statSync(path.join(root, entry)).isDirectory()) continue;
      names.add(normalized);
    } catch {
      // Invalid name, or it vanished between readdir and stat.
    }
  }
  return [...names].sort();
}

/**
 * Validate an untrusted profile name against what actually exists. Returns
 * false (never throws) when it is not an acceptable target; `default` is
 * always acceptable.
 */
export function isKnownProfile(name: string | undefined | null): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed === DEFAULT_PROFILE) return true;
  let normalized: string | undefined;
  try {
    normalized = normalizeProfileName(trimmed);
  } catch {
    return false;
  }
  if (!normalized || normalized === DEFAULT_PROFILE) return false;
  return listProfileNames().includes(normalized);
}

/**
 * Resolve an untrusted profile name to a context, falling back to the
 * process/default profile when unknown. This is the only sanctioned entry
 * point for request-driven profile resolution.
 */
export function resolveProfileContext(name: string | undefined | null): ProfileContext {
  if (typeof name !== "string" || !name.trim() || name.trim() === DEFAULT_PROFILE) {
    return defaultProfileContext();
  }
  if (!isKnownProfile(name)) return defaultProfileContext();
  const normalized = normalizeProfileName(name.trim()) as string;
  return buildContext(normalized, {
    ...envScope(),
    ompProfile: normalized,
    // Pin the profile: an inherited PI_PROFILE must never compete once a
    // request selected an explicit profile.
    piProfile: "",
  });
}

/** Every discoverable context: the process profile first, then the other
 * profiles on disk. The process profile is never duplicated — when ompweb is
 * launched with OMP_PROFILE=agent, `agent` is the fallback context and must
 * appear once. */
export function allProfileContexts(): ProfileContext[] {
  const primary = defaultProfileContext();
  const others = listProfileNames()
    .filter((name) => name !== primary.key)
    .map(resolveProfileContext);
  return [primary, ...others];
}
