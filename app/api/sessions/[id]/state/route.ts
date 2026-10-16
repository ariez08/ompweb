import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { isExternallyActive } from "@/lib/session-watcher";
import { findCliSessionLock } from "@/lib/session-cli-lock";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = requestProfileContext(req);
  const { id } = await params;
  try {
    // A live process proves the session exists: omp does not create the session
    // file until the history holds an assistant message, so the path check
    // below would 404 a brand-new running session.
    const rpc = getRpcSession(id, ctx);
    if (rpc?.isAlive()) {
      try {
        const state = await rpc.send({ type: "get_state" }) as { isPromptRunning?: boolean; isStreaming?: boolean; isBashRunning?: boolean } | undefined;
        const cliLock = await findCliSessionLock(id);
        const externallyActive = (Boolean(cliLock) || (await isExternallyActive(id, 5000, ctx)))
          && !state?.isPromptRunning && !state?.isStreaming && !state?.isBashRunning;
        if (externallyActive) {
          // The web-owned omp is idle but the session file keeps changing or
          // is held by an active terminal CLI — report as externally running.
          return NextResponse.json({
            running: true,
            external: true,
            cliLocked: Boolean(cliLock),
            cliLockPid: cliLock?.pid,
            state: null,
          }, { headers: { ...PROFILE_SCOPED_HEADERS } });
        }
        return NextResponse.json({
          running: true,
          cliLocked: Boolean(cliLock),
          cliLockPid: cliLock?.pid,
          state,
        }, { headers: { ...PROFILE_SCOPED_HEADERS } });
      } catch {
        // RPC unavailable (e.g. the external CLI took over the session) —
        // fall through to file-based mode below.
      }
    }

    const resolved = await resolveSessionPathOr404(id, ctx);
    if ("response" in resolved) return resolved.response;
    const cliLock = await findCliSessionLock(id);
    const externallyActive = Boolean(cliLock) || (await isExternallyActive(id, 5000, ctx));
    return NextResponse.json({
      running: externallyActive,
      external: externallyActive,
      cliLocked: Boolean(cliLock),
      cliLockPid: cliLock?.pid,
      state: null,
    }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
