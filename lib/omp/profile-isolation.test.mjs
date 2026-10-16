import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Permanent regression net for multi-profile live (Opsi C). These assert the
// invariants the whole design rests on: an untrusted profile name can never
// become an arbitrary directory, per-profile state cannot leak into another
// profile, and the deliberately-global paths stay global.
//
// PI_CONFIG_DIR is a NAME resolved relative to $HOME (paths.ts getConfigRoot),
// not an absolute path, so isolation means a sibling dotdir that is removed in
// after(). Treating it as absolute silently collapses every profile onto the
// process profile — the exact bug this file exists to keep from coming back.
const CONFIG_DIR_NAME = ".omp-test-profile-isolation";
const ROOT = join(homedir(), CONFIG_DIR_NAME);

process.env.PI_CONFIG_DIR = CONFIG_DIR_NAME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_PROFILE;
process.env.OMP_PROFILE = "";

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "agent"), { recursive: true });
for (const name of ["alpha", "beta"]) {
  mkdirSync(join(ROOT, "profiles", name, "agent"), { recursive: true });
}
// A stray file and an invalid directory name must not become profiles.
writeFileSync(join(ROOT, "profiles", "gamma.txt"), "not a profile");
mkdirSync(join(ROOT, "profiles", "Bad!"), { recursive: true });

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const paths = await jiti.import("./paths.ts");
const pc = await jiti.import("./profile-context.ts");
const scripts = await jiti.import("../project-scripts.ts");
const proxy = await jiti.import("../proxy-config.ts");

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const alpha = pc.resolveProfileContext("alpha");
const beta = pc.resolveProfileContext("beta");
const dflt = pc.resolveProfileContext(undefined);

test("discovery lists only real, validly-named profile directories", () => {
  assert.deepEqual(pc.listProfileNames(), ["alpha", "beta"]);
  assert.equal(pc.isKnownProfile("alpha"), true);
  assert.equal(pc.isKnownProfile("default"), true);
  assert.equal(pc.isKnownProfile("gamma.txt"), false);
  assert.equal(pc.isKnownProfile("Bad!"), false);
  assert.equal(pc.isKnownProfile("nope"), false);
});

test("an untrusted name can never escape the profiles root", () => {
  for (const attack of ["../../Windows", "..", ".", "alpha/../../..", "%2e%2e%2f", "CON", "nul.txt", "alpha."]) {
    const ctx = pc.resolveProfileContext(attack);
    assert.ok(
      ctx.agentDir.startsWith(ROOT) || ctx.agentDir === join(ROOT, "agent"),
      `${attack} resolved outside the config root: ${ctx.agentDir}`,
    );
    assert.ok(!ctx.agentDir.includes(".."), `${attack} produced a traversing path: ${ctx.agentDir}`);
  }
  // Traversal input collapses to the process profile rather than throwing.
  assert.equal(pc.resolveProfileContext("../../Windows").key, dflt.key);
});

test("every derived path is distinct per profile and rooted in that profile", () => {
  const groups = [
    [alpha.agentDir, beta.agentDir, dflt.agentDir],
    [alpha.sessionsDir, beta.sessionsDir, dflt.sessionsDir],
    [alpha.blobsDir, beta.blobsDir, dflt.blobsDir],
    [alpha.runtimeDbPath, beta.runtimeDbPath, dflt.runtimeDbPath],
    [alpha.settingsPath, beta.settingsPath, dflt.settingsPath],
    [alpha.modelsConfigPath, beta.modelsConfigPath, dflt.modelsConfigPath],
  ];
  for (const group of groups) {
    assert.equal(new Set(group).size, 3, `collision in ${JSON.stringify(group)}`);
  }
  assert.equal(alpha.agentDir, join(ROOT, "profiles", "alpha", "agent"));
  assert.equal(dflt.agentDir, join(ROOT, "agent"));
  assert.equal(alpha.runtimeDbPath, join(alpha.agentDir, "ompweb", "runtime.db"));
});

test("hostEnvFor pins the profile and never inherits a stale PI_PROFILE", () => {
  const envAlpha = pc.hostEnvFor(alpha);
  assert.equal(envAlpha.OMP_PROFILE, "alpha");
  assert.equal(envAlpha.PI_PROFILE, "");
  assert.equal(envAlpha.PI_CODING_AGENT_DIR, alpha.agentDir);
  assert.equal(envAlpha.OMPWEB_RUNTIME_DB, alpha.runtimeDbPath);

  // Empty string means "the default profile", not "inherit from the parent".
  const envDefault = pc.hostEnvFor(dflt);
  assert.equal(envDefault.OMP_PROFILE, "");
  assert.equal(envDefault.PI_CODING_AGENT_DIR, dflt.agentDir);
  assert.notEqual(envDefault.PI_CODING_AGENT_DIR, envAlpha.PI_CODING_AGENT_DIR);
});

test("scope precedence matches omp: profile beats override, empty OMP_PROFILE does not inherit", () => {
  const override = join(ROOT, "somewhere-else");
  // A scope is WHOLE, not merged with the environment: callers pass envScope()
  // (or a context's scope) rather than patching one field. Asserting it here
  // keeps that contract from drifting into a surprising partial override.
  const scope = (over = {}) => ({ ...pc.defaultProfileContext().scope, ...over });
  // A named profile outranks PI_CODING_AGENT_DIR (omp rewrites the override itself).
  assert.equal(paths.getAgentDir(scope({ agentDirOverride: override, ompProfile: "alpha" })),
    join(ROOT, "profiles", "alpha", "agent"));
  // Without a profile, the override wins.
  assert.equal(paths.getAgentDir(scope({ agentDirOverride: override, ompProfile: "" })), override);
  // An explicitly empty OMP_PROFILE selects default rather than falling through
  // to PI_PROFILE — the rule hostEnvFor relies on to stop inheritance.
  assert.equal(paths.activeProfile({ ompProfile: "", piProfile: "beta" }), undefined);
  assert.equal(paths.activeProfile({ piProfile: "beta" }), "beta");
  assert.equal(paths.activeProfile({ ompProfile: "default" }), undefined);
  // PI_CONFIG_DIR rename is honoured by every derived path.
  assert.equal(paths.getConfigRoot({ configDirName: ".other", ompProfile: "alpha" }),
    join(homedir(), ".other", "profiles", "alpha"));
});

test("the process profile is not duplicated in the discovery list", () => {
  // ompweb launched with OMP_PROFILE=agent must show `agent` once, as primary.
  process.env.OMP_PROFILE = "alpha";
  try {
    const all = pc.allProfileContexts();
    assert.deepEqual(all.map((ctx) => ctx.key), ["alpha", "beta"]);
    assert.equal(pc.defaultProfileContext().key, "alpha");
  } finally {
    process.env.OMP_PROFILE = "";
  }
});

test("per-profile state reads its own scripts.json, never the default profile's", () => {
  const script = (name) => JSON.stringify({ scripts: [{ name, command: `run ${name}` }] });
  writeFileSync(join(alpha.agentDir, "scripts.json"), script("alpha-script"));
  writeFileSync(join(beta.agentDir, "scripts.json"), script("beta-script"));
  writeFileSync(join(dflt.agentDir, "scripts.json"), script("default-script"));

  assert.deepEqual(scripts.getGlobalScripts(alpha).map((s) => s.name), ["alpha-script"]);
  assert.deepEqual(scripts.getGlobalScripts(beta).map((s) => s.name), ["beta-script"]);
  assert.deepEqual(scripts.getGlobalScripts(dflt).map((s) => s.name), ["default-script"]);
  // Omitting ctx keeps the historical process-profile behaviour.
  assert.deepEqual(scripts.getGlobalScripts().map((s) => s.name), ["default-script"]);
});

// The Node scanner is the only read path that works without a live Rust host,
// and it is a supported rollback mode (OMPWEB_BACKEND=node), so this exercises
// production code rather than a mock.
test("session list caches are per-profile and survive invalidation", async () => {
  const reader = await jiti.import("../session-reader.ts");
  const backend = process.env.OMPWEB_BACKEND;
  process.env.OMPWEB_BACKEND = "node";
  const cwd = join(ROOT, "no-such-project");
  const writeSession = (ctx, id) => {
    const dir = join(ctx.sessionsDir, "-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-01-01_${id}.jsonl`), [
      JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({
        type: "message", id: `${id}-u`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: `hello from ${id}` },
      }),
    ].join("\n") + "\n");
  };
  // Sort defensively: the real order is mtime-based, this asserts membership.
  const idsOf = async (ctx) => (await reader.listAllSessions(ctx)).map((s) => s.id).sort();
  try {
    writeSession(alpha, "alpha-1");
    writeSession(beta, "beta-1");
    reader.invalidateSessionListCache();

    assert.deepEqual(await idsOf(alpha), ["alpha-1"]);
    assert.deepEqual(await idsOf(beta), ["beta-1"]);

    // Warm cache: a new file on disk stays invisible until an invalidation —
    // which is what makes the profile-keyed cache observable at all.
    writeSession(alpha, "alpha-2");
    assert.deepEqual(await idsOf(alpha), ["alpha-1"]);

    reader.invalidateSessionListCache();
    // Both profiles rescan, and neither picks up the other's transcript.
    assert.deepEqual(await idsOf(alpha), ["alpha-1", "alpha-2"]);
    assert.deepEqual(await idsOf(beta), ["beta-1"]);
  } finally {
    if (backend === undefined) delete process.env.OMPWEB_BACKEND;
    else process.env.OMPWEB_BACKEND = backend;
    for (const ctx of [alpha, beta, dflt]) {
      rmSync(join(ctx.agentDir, "sessions"), { recursive: true, force: true });
    }
    reader.invalidateSessionListCache();
  }
});

test("proxy config stays global by design (access infrastructure, not profile state)", () => {
  // CONFIG_PATH is resolved from the process scope at import time. A profile
  // request must not relocate it, or a paired device's proxy settings would
  // silently change when it switches profiles.
  proxy.saveProxyConfig({ mode: "manual", url: "http://127.0.0.1:7890" });
  assert.ok(existsSync(join(ROOT, "agent", "proxy.json")));
  assert.ok(!existsSync(join(alpha.agentDir, "proxy.json")));
  assert.ok(!existsSync(join(beta.agentDir, "proxy.json")));
});
