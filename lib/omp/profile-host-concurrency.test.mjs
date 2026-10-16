import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Multi-profile live (Opsi C), permanent gate for the premise the whole design
// rests on: one ompweb process drives SEVERAL Rust hosts, one per profile, and
// they stay independent. Verified as a test rather than a one-off spike because
// a future refactor of the host lifecycle can silently collapse two profiles
// onto one journal, which reads as "sessions vanish" to a user.
//
// Skips when the host binary is not built, matching rust-rpc-process.test.mjs.
const root = join(import.meta.dirname, "..", "..");
const hostBin = [
  join(root, "crates", "target", "debug", "ompweb-host.exe"),
  join(root, "crates", "target", "debug", "ompweb-host"),
  join(root, "vendor", "ompweb-host", `${process.platform}-${process.arch}`, "ompweb-host.exe"),
].find(existsSync);
const skip = hostBin ? false : "ompweb-host binary not built (run cargo build)";

// PI_CONFIG_DIR is a NAME relative to $HOME (paths.ts getConfigRoot), so
// isolation means a sibling dotdir. PI_CODING_AGENT_DIR must be cleared: for
// the default profile it outranks the derived agent dir and would collapse the
// whole experiment onto whichever profile the runner happens to use.
const CONFIG_DIR_NAME = ".omp-test-profile-hosts";
const ROOT = join(homedir(), CONFIG_DIR_NAME);
process.env.PI_CONFIG_DIR = CONFIG_DIR_NAME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_PROFILE;
process.env.OMP_PROFILE = "";
if (hostBin) process.env.OMPWEB_HOST_BIN = hostBin;
for (const name of ["alpha", "beta"]) {
  mkdirSync(join(ROOT, "profiles", name, "agent"), { recursive: true });
}

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

test("two profiles boot independent hosts with their own journals", { skip }, async () => {
  const pc = await jiti.import("./profile-context.ts");
  const rr = await jiti.import("./rust-rpc-process.ts");
  const alpha = pc.resolveProfileContext("alpha");
  const beta = pc.resolveProfileContext("beta");
  try {
    const hostAlpha = rr.hostFor(alpha);
    const hostBeta = rr.hostFor(beta);
    assert.notEqual(hostAlpha, hostBeta, "profiles must not share a host manager");
    assert.equal(hostAlpha.profileKey, "alpha");
    assert.equal(hostBeta.profileKey, "beta");

    await hostAlpha.controlRequest("ping", {});
    await hostBeta.controlRequest("ping", {});
    const pidAlpha = hostAlpha.hostPid;
    const pidBeta = hostBeta.hostPid;
    assert.ok(pidAlpha > 0 && pidBeta > 0, "both hosts should be booted");
    assert.notEqual(pidAlpha, pidBeta, "each profile needs its own host process");

    // The journal is the event authority; sharing one file across profiles is
    // the failure this test exists to catch.
    assert.notEqual(alpha.runtimeDbPath, beta.runtimeDbPath);
    assert.ok(existsSync(alpha.runtimeDbPath), `missing ${alpha.runtimeDbPath}`);
    assert.ok(existsSync(beta.runtimeDbPath), `missing ${beta.runtimeDbPath}`);

    // Each host answers for its own profile's sessions root only.
    const scanAlpha = await hostAlpha.controlRequest("session.scan", { root: alpha.sessionsDir });
    assert.ok(Array.isArray(scanAlpha), "session.scan must answer with an array");
  } finally {
    await rr.shutdownRustHost();
  }
});

test("stopping one profile's host leaves the other serving", { skip }, async () => {
  const pc = await jiti.import("./profile-context.ts");
  const rr = await jiti.import("./rust-rpc-process.ts");
  const alpha = pc.resolveProfileContext("alpha");
  const beta = pc.resolveProfileContext("beta");
  try {
    const hostAlpha = rr.hostFor(alpha);
    const hostBeta = rr.hostFor(beta);
    await hostAlpha.controlRequest("ping", {});
    await hostBeta.controlRequest("ping", {});

    await hostAlpha.shutdown();
    assert.deepEqual(await hostBeta.controlRequest("ping", {}), { pong: true },
      "beta must survive alpha's teardown");
  } finally {
    await rr.shutdownRustHost();
  }
});

test("shutdownRustHost settles every profile host", { skip }, async () => {
  const pc = await jiti.import("./profile-context.ts");
  const rr = await jiti.import("./rust-rpc-process.ts");
  const hosts = [pc.resolveProfileContext("alpha"), pc.resolveProfileContext("beta"), pc.defaultProfileContext()]
    .map((ctx) => rr.hostFor(ctx));
  for (const host of hosts) await host.controlRequest("ping", {});
  const pids = hosts.map((host) => host.hostPid);
  assert.equal(new Set(pids).size, hosts.length, "expected one host process per profile");

  await rr.shutdownRustHost();
  // A settled manager reports no pid; the OS may still be reaping the process,
  // so assert on the manager's own view rather than polling the PID.
  for (const host of hosts) assert.equal(host.hostPid, undefined, "host should be released");
});
