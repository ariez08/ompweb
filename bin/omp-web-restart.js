#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port);
const packageDir = args["package-dir"];
const launcher = packageDir ? path.join(packageDir, "bin", "omp-web.js") : "";

if (!Number.isInteger(port) || port < 1024 || port > 65535 || !packageDir || !existsSync(launcher)) process.exit(1);

waitForPortToClose(port)
  .then(() => {
    const child = spawn(process.execPath, [launcher, "--port", String(port), "--hostname", args.hostname || "127.0.0.1", "--no-open"], {
      cwd: packageDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, OMP_WEB_NO_OPEN: "1" },
    });
    child.unref();
  })
  .catch(() => process.exit(1));

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}

async function waitForPortToClose(targetPort) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isPortClosed(targetPort)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("OMP Web did not stop within the restart window");
}

function isPortClosed(targetPort) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: targetPort });
    const finish = (closed) => { socket.destroy(); resolve(closed); };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(500, () => finish(true));
  });
}
