import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createProfile,
  deleteProfile,
  getProfileDetails,
  updateProfileConfig,
  validateProfileName,
} = await jiti.import("./profile-manager.ts");

test("validateProfileName validates names correctly", () => {
  assert.equal(validateProfileName("").valid, false);
  assert.equal(validateProfileName("   ").valid, false);
  assert.equal(validateProfileName("default").valid, false);
  assert.equal(validateProfileName("invalid name with spaces").valid, false);
  assert.equal(validateProfileName("bad@symbol").valid, false);
  assert.equal(validateProfileName("a".repeat(33)).valid, false);

  assert.equal(validateProfileName("valid-profile-name").valid, true);
  assert.equal(validateProfileName("dev_worktree_1").valid, true);
});

test("create, inspect, update, and delete profile cycle", async () => {
  const testName = `test-unit-${Date.now().toString(36)}`;

  // 1. Create
  const ctx = createProfile(testName);
  assert.equal(ctx.profile, testName);
  assert.equal(ctx.isDefault, false);

  // 2. Inspect details
  const details = getProfileDetails(testName);
  assert.equal(details.profile, testName);
  assert.equal(details.isDefault, false);
  assert.ok(details.configYaml.includes("model_roles:"));
  assert.equal(details.mcpServersCount, 0);

  // 3. Update config
  const newMcp = JSON.stringify({ mcpServers: { dummy: { command: "test" } } }, null, 2);
  const updated = updateProfileConfig(testName, {
    mcpJson: newMcp,
    agentsMd: "# Unit Test Persona\n",
  });
  assert.equal(updated.mcpServersCount, 1);
  assert.equal(updated.agentsMd, "# Unit Test Persona\n");

  // 4. Cannot delete active
  await assert.rejects(async () => {
    await deleteProfile(testName, testName);
  }, /currently active profile/);

  // 5. Cannot delete default
  await assert.rejects(async () => {
    await deleteProfile("default", "other");
  }, /Cannot delete the default profile/);

  // 6. Delete clean
  await deleteProfile(testName, "other");
  assert.throws(() => {
    getProfileDetails(testName);
  }, /not found/);
});

test("createProfile with selective stripping", async () => {
  const testName = `test-strip-${Date.now().toString(36)}`;

  // Create with agentsMd stripped (false)
  const ctx = createProfile(testName, {
    copyFrom: "default",
    include: {
      configYaml: true,
      modelsYaml: true,
      mcpJson: true,
      agentsMd: false, // stripped!
      rulesMd: true,
    },
  });

  const details = getProfileDetails(testName);
  assert.ok(details.agentsMd.includes("You are an expert fullstack software engineer"));

  await deleteProfile(testName, "other");
});
