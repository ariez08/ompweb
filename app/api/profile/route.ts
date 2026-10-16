import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import {
  DEFAULT_PROFILE,
  isKnownProfile,
  resolveProfileContext,
} from "@/lib/omp/profile-context";
import {
  OMP_WEB_PROFILE_COOKIE,
  OMP_WEB_PROFILE_MAX_AGE_SECONDS,
  PROFILE_SCOPED_HEADERS,
} from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 4 * 1024;

/**
 * Select the profile for this browser. The value is validated against
 * profiles that exist on disk; an unknown name is a 400 rather than a silent
 * fallback, so the UI cannot mistake a typo'd profile for the default one and
 * start writing sessions into the wrong agent dir.
 */
export async function PUT(request: Request) {
  let body: { profile?: unknown };
  try {
    body = await parseJsonWithinLimit(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    return NextResponse.json({ error: "Invalid profile request" }, { status });
  }

  const wanted = typeof body.profile === "string" ? body.profile.trim() : "";
  if (!wanted) {
    return NextResponse.json({ error: "Profile is required" }, { status: 400 });
  }
  if (wanted !== DEFAULT_PROFILE && !isKnownProfile(wanted)) {
    return NextResponse.json({ error: `Unknown profile "${wanted}"` }, { status: 400 });
  }

  const ctx = resolveProfileContext(wanted);
  const response = NextResponse.json(
    { ok: true, profile: ctx.profile, isDefault: ctx.isDefault, agentDir: ctx.agentDir },
    { headers: { ...PROFILE_SCOPED_HEADERS } },
  );
  const secure =
    new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  response.cookies.set({
    name: OMP_WEB_PROFILE_COOKIE,
    value: ctx.profile,
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: OMP_WEB_PROFILE_MAX_AGE_SECONDS,
    path: "/",
  });
  return response;
}
