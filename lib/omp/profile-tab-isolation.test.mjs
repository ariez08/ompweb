import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readRequestedProfile, requestProfileContext } = await jiti.import("./profile-cookie.ts");

test("readRequestedProfile prioritizes query param, then header, then cookie", () => {
  // 1. Query parameter takes highest priority
  const req1 = new Request("http://localhost:30177/api/sessions?profile=alpha", {
    headers: {
      "x-omp-profile": "beta",
      cookie: "omp_web_profile=gamma",
    },
  });
  assert.equal(readRequestedProfile(req1), "alpha");

  // 2. Header takes priority over cookie when query param is absent
  const req2 = new Request("http://localhost:30177/api/sessions", {
    headers: {
      "x-omp-profile": "beta",
      cookie: "omp_web_profile=gamma",
    },
  });
  assert.equal(readRequestedProfile(req2), "beta");

  // 3. Cookie is used when neither query nor header is present
  const req3 = new Request("http://localhost:30177/api/sessions", {
    headers: {
      cookie: "omp_web_profile=gamma",
    },
  });
  assert.equal(readRequestedProfile(req3), "gamma");

  // 4. Undefined when all are absent
  const req4 = new Request("http://localhost:30177/api/sessions");
  assert.equal(readRequestedProfile(req4), undefined);
});

test("requestProfileContext resolves profile context correctly from header", () => {
  const req = new Request("http://localhost:30177/api/sessions", {
    headers: {
      "x-omp-profile": "agent",
      cookie: "omp_web_profile=default",
    },
  });
  const ctx = requestProfileContext(req);
  assert.equal(ctx.key, "agent");
  assert.equal(ctx.profile, "agent");
});
