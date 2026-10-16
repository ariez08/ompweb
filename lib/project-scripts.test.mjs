import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// project-scripts.ts resolves its path through lib/omp/paths (extensionless
// specifiers), which Node's strip-types loader cannot resolve.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { validateQuickScripts, getProjectScripts, saveProjectScripts, listQuickScripts } =
  await jiti.import("./project-scripts.ts");

test("validates quick script arrays strictly", () => {
  assert.deepEqual(validateQuickScripts([{ name: "build", command: "npm run build" }]), [{ name: "build", command: "npm run build" }]);
  assert.deepEqual(validateQuickScripts([{ name: "start", command: "npm run dev", description: "dev" }]), [{ name: "start", command: "npm run dev", description: "dev" }]);
  assert.equal(validateQuickScripts("nope"), null);
  assert.equal(validateQuickScripts([{ name: "", command: "x" }]), null);
  assert.equal(validateQuickScripts([{ name: "x", command: "  " }]), null);
});

test("round-trips project scripts with atomic write", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-scripts-"));
  try {
    saveProjectScripts(root, [{ name: "build", command: "npm run build" }]);
    assert.deepEqual(getProjectScripts(root), [{ name: "build", command: "npm run build" }]);
    // Later saves replace the project's own list (name collisions resolve to
    // the project copy; global scripts are merged separately by listQuickScripts).
    saveProjectScripts(root, [{ name: "build", command: "npm run build -- --prod" }, { name: "publish", command: "npm publish" }]);
    const scripts = listQuickScripts(root);
    assert.equal(scripts.find((s) => s.name === "build")?.command, "npm run build -- --prod");
    assert.equal(scripts.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});