import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const host = path.resolve("crates", "target", "debug", process.platform === "win32" ? "ompweb-host.exe" : "ompweb-host");
const rustc = spawnSync("rustc", ["--version"], { timeout: 10000, stdio: "ignore" });

const fakeAgent = String.raw`
use std::io::{self, BufRead, Write};
fn field(line: &str, name: &str) -> String {
    let needle = format!("\"{}\":\"", name);
    line.split(&needle).nth(1).and_then(|v| v.split('"').next()).unwrap_or("").to_string()
}
fn main() {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{{\"type\":\"ready\",\"supportedProtocolVersions\":[1]}}").unwrap();
    out.flush().unwrap();
    let payload = "x".repeat(32768);
    let update = format!("{{\"type\":\"message_update\",\"payload\":\"{}\"}}\n", payload);
    for line in io::stdin().lock().lines() {
        let line = match line { Ok(v) => v, Err(_) => break };
        let kind = field(&line, "type");
        let id = field(&line, "id");
        if kind == "flood" {
            writeln!(out, "{{\"type\":\"tool_execution_start\",\"toolCallId\":\"flood\"}}").unwrap();
            for _ in 0..1000 { if out.write_all(update.as_bytes()).is_err() { return; } }
            writeln!(out, "{{\"type\":\"agent_end\",\"isTerminal\":true}}").unwrap();
        }
        writeln!(out, "{{\"type\":\"response\",\"id\":\"{}\",\"command\":\"{}\",\"success\":true,\"data\":{{\"alive\":true}}}}", id, kind).unwrap();
        out.flush().unwrap();
    }
}
`;

test("real Rust host reconnects after a slow subscriber overflows", {
  timeout: 60000,
  skip: !existsSync(host) ? "build the Rust host first" : rustc.status !== 0 ? "rustc unavailable" : false,
}, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ompweb-overflow-"));
  const profileName = `.omp-overflow-test-${process.pid}-${Date.now()}`;
  const profileRoot = path.join(os.homedir(), profileName);
  const envKeys = ["OMPWEB_HOST_BIN", "OMP_WEB_OMP_BIN", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  let proc;
  let disposeHostFor;
  let createdProfile = false;
  try {
    mkdirSync(profileRoot);
    createdProfile = true;
    const source = path.join(tmp, "fake-agent.rs");
    const executable = path.join(tmp, process.platform === "win32" ? "fake-agent.exe" : "fake-agent");
    writeFileSync(source, fakeAgent);
    execFileSync("rustc", [source, "-o", executable], { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    Object.assign(process.env, {
      OMPWEB_HOST_BIN: host,
      OMP_WEB_OMP_BIN: executable,
      PI_CONFIG_DIR: profileName,
      PI_CODING_AGENT_DIR: path.join(profileRoot, "agent"),
      OMP_PROFILE: "",
      PI_PROFILE: "",
    });
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const subject = await jiti.import("./rust-rpc-process.ts");
    disposeHostFor = subject.disposeHostFor;
    proc = new subject.RustRpcProcess({ cwd: tmp, sessionId: `overflow-${process.pid}` });
    let readyTimer;
    try {
      await Promise.race([
        proc.waitReady(10000),
        new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error("isolated host was not ready")), 10000); }),
      ]);
    } finally {
      clearTimeout(readyTimer);
    }
    const seen = [];
    let blocked = false;
    let resolveRestored;
    const restored = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`transport did not recover; blocked=${blocked}, frames=${seen.length}, tail=${seen.slice(-5).join(",")}`)), 15000);
      resolveRestored = () => { clearTimeout(timer); resolve(); };
    });
    proc.onFrame((frame) => {
      seen.push(frame.type);
      if (frame.type === "tool_execution_start" && !blocked) {
        blocked = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
      }
      if (frame.type === "rpc_stream_restored") resolveRestored();
    });
    const flood = proc.sendCommand({ type: "flood" }, 12000).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await restored;
    const outcome = await flood;
    assert.equal(blocked, true);
    assert.ok(seen.includes("rpc_stream_gap"), "overflow must be reported");
    assert.equal(outcome.error?.code, "rpc_stream_gap", "lost acknowledgement must be reported uncertain");
    assert.deepEqual(await proc.sendCommand({ type: "get_state" }, 3000), { alive: true });
    assert.equal(proc.isAlive, true);
  } finally {
    if (proc) await proc.dispose(0).catch(() => {});
    if (disposeHostFor) await disposeHostFor("default").catch(() => {});
    for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value;
    rmSync(tmp, { recursive: true, force: true });
    if (createdProfile) rmSync(profileRoot, { recursive: true, force: true });
  }
});
