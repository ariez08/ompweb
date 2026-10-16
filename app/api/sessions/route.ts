import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIdsFor } from "@/lib/rpc-manager";
import { allProfileContexts } from "@/lib/omp/profile-context";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";
import type { SessionInfo } from "@/lib/types";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = PROFILE_SCOPED_HEADERS;

/** One profile's slice of the `?all=1` aggregate view. */
interface ProfileSessionBucket {
  profile: string;
  isDefault: boolean;
  sessions: SessionInfo[];
  runningIds: string[];
}

export async function GET(req: Request) {
  const ctx = requestProfileContext(req);
  try {
    const all = new URL(req.url).searchParams.get("all");

    const sessions = await listAllSessions(ctx);
    const runningSessionIds = getRunningRpcSessionIdsFor(ctx);

    let body: object;
    if (all === null || all === "" || all === "0") {
      // Requesting profile only: shape identical to the pre-multi-profile one.
      body = { sessions, runningSessionIds };
    } else {
      // Aggregate: every known profile, each scanned with its OWN context so a
      // profile's list can never be served from another profile's caches.
      const byProfile = await Promise.all(
        allProfileContexts().map(
          async (p): Promise<ProfileSessionBucket> => ({
            profile: p.profile,
            isDefault: p.isDefault,
            sessions: await listAllSessions(p),
            runningIds: getRunningRpcSessionIdsFor(p),
          }),
        ),
      );
      body = { sessions, runningSessionIds, byProfile };
    }

    const bodyJson = JSON.stringify(body);
    // The ETag input carries the profile key: two profiles whose bodies happen
    // to serialise identically must not share an entity tag, or a conditional
    // GET from profile B would be answered with profile A's cached body.
    const etag = `"${createHash("sha1").update(`${ctx.key}\n${bodyJson}`).digest("hex").slice(0, 16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new NextResponse(bodyJson, { headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "session_list_failed";
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code },
      { status: 500, headers: { ...SESSION_LIST_HEADERS } },
    );
  }
}
