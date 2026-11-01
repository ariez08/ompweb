import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  BUILTIN_TOOLS,
  getWorkspaceCapabilitiesCatalog,
  saveProfileCustomPreset,
  listProfileCustomPresets,
  deleteProfileCustomPreset,
} = await jiti.import("./capabilities-service.ts");
const { defaultProfileContext } = await jiti.import("./omp/profile-context.ts");

test("BUILTIN_TOOLS lists core omp tools", () => {
  const ids = BUILTIN_TOOLS.map((t) => t.id);
  assert.ok(ids.includes("read"));
  assert.ok(ids.includes("edit"));
  assert.ok(ids.includes("write"));
  assert.ok(ids.includes("bash"));
  assert.ok(ids.includes("glob"));
  assert.ok(ids.includes("grep"));
  assert.ok(ids.includes("task"));
  assert.ok(ids.includes("eval"));
});

test("getWorkspaceCapabilitiesCatalog returns catalog structure", async () => {
  const catalog = await getWorkspaceCapabilitiesCatalog(process.cwd());
  assert.ok(Array.isArray(catalog.builtinTools));
  assert.ok(catalog.builtinTools.length >= 8);
  assert.ok(Array.isArray(catalog.mcpServers));
  assert.ok(Array.isArray(catalog.skills));
  assert.equal(catalog.defaultCapabilities.preset, "full_agent");
});

test("saveProfileCustomPreset, listProfileCustomPresets, and deleteProfileCustomPreset lifecycle", () => {
  const ctx = defaultProfileContext();
  const testPreset = {
    name: "Test Unit Preset",
    description: "Preset for unit testing",
    tools: ["read", "edit"],
    skills: ["git-*"],
    disabledMcp: ["test_mcp"],
  };

  const saved = saveProfileCustomPreset(testPreset, ctx);
  assert.ok(saved.id);
  assert.equal(saved.name, "Test Unit Preset");
  assert.deepEqual(saved.tools, ["read", "edit"]);

  const list = listProfileCustomPresets(ctx);
  const found = list.find((p) => p.id === saved.id);
  assert.ok(found);
  assert.equal(found.name, "Test Unit Preset");

  const deleted = deleteProfileCustomPreset(saved.id, ctx);
  assert.equal(deleted, true);
  const listAfter = listProfileCustomPresets(ctx);
  assert.ok(!listAfter.some((p) => p.id === saved.id));
});
