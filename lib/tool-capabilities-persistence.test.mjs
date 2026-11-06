import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getPreferredCapabilities, setPreferredCapabilities } = await jiti.import("./tool-preset-preference.ts");

function createStorage(values = {}) {
  const map = new Map(Object.entries(values));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

test("custom tool and MCP selection survives a reload", () => {
  const storage = createStorage();
  const selection = {
    preset: "custom",
    customPresetName: "Review Only",
    tools: ["read", "grep", "task"],
    disabledMcp: ["manage_omp", "gitlab_repo_simrskartini"],
  };

  setPreferredCapabilities(selection, storage);

  // Simulate a fresh page load: only storage survives.
  const restored = getPreferredCapabilities(storage);
  assert.equal(restored.preset, "custom");
  assert.equal(restored.customPresetName, "Review Only");
  assert.deepEqual(restored.tools, ["read", "grep", "task"]);
  assert.deepEqual(restored.disabledMcp, ["manage_omp", "gitlab_repo_simrskartini"]);
});

test("a restrictive selection is not widened back to the full toolset", () => {
  const storage = createStorage();
  setPreferredCapabilities({ preset: "chat_only", tools: [], skills: [], disabledMcp: [] }, storage);

  const restored = getPreferredCapabilities(storage);
  assert.deepEqual(restored.tools, []);
  assert.deepEqual(restored.skills, []);
});

test("full_agent keeps tools and skills undefined so nothing is restricted", () => {
  const storage = createStorage();
  setPreferredCapabilities({ preset: "full_agent" }, storage);

  const restored = getPreferredCapabilities(storage);
  assert.equal(restored.preset, "full_agent");
  assert.equal(restored.tools, undefined);
  assert.equal(restored.skills, undefined);
});

test("corrupt stored capabilities fall back to the legacy preset key", () => {
  const storage = createStorage({
    "omp-web:capabilities": "{not json",
    "omp-web:tool-preset": "default",
  });

  const restored = getPreferredCapabilities(storage);
  assert.equal(restored.preset, "code_editor");
  assert.deepEqual(restored.tools, ["read", "edit", "write", "bash", "glob", "grep"]);
});

test("stored capabilities without a valid preset are ignored", () => {
  const storage = createStorage({
    "omp-web:capabilities": JSON.stringify({ tools: ["read"] }),
    "omp-web:tool-preset": "none",
  });

  const restored = getPreferredCapabilities(storage);
  assert.equal(restored.preset, "chat_only");
});
