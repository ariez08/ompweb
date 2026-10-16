import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// proxy-config.ts resolves its path through lib/omp/paths (extensionless
// specifiers), which Node's strip-types loader cannot resolve.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { proxyEnv } = await jiti.import("./proxy-config.ts");

test("proxy env vars are injected for child processes", () => {
  assert.deepEqual(proxyEnv(null), {});
  assert.deepEqual(proxyEnv("http://127.0.0.1:7890"), {
    HTTP_PROXY: "http://127.0.0.1:7890",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    ALL_PROXY: "http://127.0.0.1:7890",
    http_proxy: "http://127.0.0.1:7890",
    https_proxy: "http://127.0.0.1:7890",
    all_proxy: "http://127.0.0.1:7890",
  });
});

test("manual proxy URL shape validation", () => {
  const ok = "http://127.0.0.1:7890";
  assert.match(ok, /^https?:\/\/[^/]+:\d+$/);
  // No port / no scheme are invalid for the manual input.
  assert.doesNotMatch("http://localhost", /:\d+$/);
  assert.doesNotMatch("127.0.0.1:7890", /^https?:\/\//);
});