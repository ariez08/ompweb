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
      const cliLock = await findCliSessionLock(id);
      try {
        const state = await rpc.send(
          { type: "get_state" },
          { stateTimeoutMs: 1000, propagateStateTimeout: true },
        ) as { isPromptRunning?: boolean; isStreaming?: boolean; isBashRunning?: boolean; isCompacting?: boolean } | undefined;
        const rpcRunning = Boolean(state?.isPromptRunning || state?.isStreaming || state?.isBashRunning || state?.isCompacting);
        return NextResponse.json({
          running: rpcRunning,
          webActive: true,
          cliLocked: Boolean(cliLock),
          cliLockPid: cliLock?.pid,
          state,
        }, { headers: { ...PROFILE_SCOPED_HEADERS } });
      } catch {
        // A cached snapshot cannot prove the child has become idle.
        const rpcRunning = rpc.isRunning();
        return NextResponse.json({
          running: rpcRunning,
          webActive: true,
          stale: true,
          cliLocked: Boolean(cliLock),
          cliLockPid: cliLock?.pid,
          state: rpc.getCachedWebState(),
        }, { headers: { ...PROFILE_SCOPED_HEADERS } });
      }
    }

    const resolved = await resolveSessionPathOr404(id, ctx);
    if ("response" in resolved) return resolved.response;
    const cliLock = await findCliSessionLock(id);
    const fileActive = await isExternallyActive(id, 5000, ctx);
    return NextResponse.json({
      running: fileActive,
      external: fileActive,
      webActive: false,
      cliLocked: Boolean(cliLock),
      cliLockPid: cliLock?.pid,
      state: null,
    }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
