/**
 * Remove variables owned by the omp-web host before starting any child process.
 * Two groups are stripped:
 *
 *  - Host runtime variables (PORT, NODE_ENV, NEXT_*, OMPWEB_PEER_SECRET): these
 *    describe the Next.js server, not the selected project, and can make project
 *    commands behave as if they were running inside the web app.
 *  - omp-web's own secrets. Every `omp` session inherits this environment, so an
 *    agent that runs `env` would otherwise print the web password into its
 *    transcript and off to the model provider. Only the *secret* names are
 *    removed, not every `OMP_WEB_*`: the launcher's non-secret settings
 *    (OMP_WEB_PACKAGE_DIR, OMP_WEB_HOSTNAME, OMP_WEB_PROXY_URL, ...) must keep
 *    reaching children that start the server again.
 */

const HOST_RUNTIME_NAMES: Record<string, true> = { PORT: true, NODE_ENV: true, OMPWEB_PEER_SECRET: true };
const HOST_RUNTIME_PREFIXES = ["NEXT_"];

/** Values that grant access to this server. */
export const OMP_WEB_SECRET_ENV_VARS: readonly string[] = ["OMP_WEB_PASSWORD"];
const OMP_WEB_SECRET_NAMES: Record<string, true> = { OMP_WEB_PASSWORD: true };

/** Windows environment names are case-insensitive; POSIX ones are not. */
export function isHostRuntimeVariable(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const comparable = platform === "win32" ? name.toUpperCase() : name;
  return HOST_RUNTIME_NAMES[comparable] === true
    || HOST_RUNTIME_PREFIXES.some((prefix) => comparable.startsWith(prefix));
}

export function isOmpWebSecretVariable(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return OMP_WEB_SECRET_NAMES[platform === "win32" ? name.toUpperCase() : name] === true;
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform) || isOmpWebSecretVariable(name, platform)) {
      delete environment[name];
    }
  }
  return environment;
}

/**
 * Build the environment for a child process that may run repository or plugin
 * code. Always returns a fresh object, so callers can add their own variables
 * without mutating `process.env`.
 */
export function createChildProcessEnvironment(
  additions: Readonly<Record<string, string | undefined>> = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return sanitizeProjectCommandEnvironment({ ...baseEnvironment, ...additions }, platform);
}
