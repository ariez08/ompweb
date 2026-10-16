import { getRunningRpcSessionIdsFor, subscribeRunningSessions } from "@/lib/rpc-manager";
import { subscribeSessionFileChanges, getExternallyActiveIds } from "@/lib/session-watcher";
import { listCliLockedSessions } from "@/lib/session-cli-lock";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Also carries refresh hints when a live session's file metadata
// changes, so the sidebar can show a newly-started session immediately.
export async function GET(req: Request) {
  const ctx = requestProfileContext(req);
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the subscriber.
  let streamCleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeRunningSessions(({ ids, refreshSessionList }) => {
        try {
          encode({
            type: "running",
            runningSessionIds: ids,
            ...(refreshSessionList ? { refreshSessionList: true } : {}),
          });
        } catch {
          // controller already closed
        }
      }, ctx.key);

      // Sessions omp writes outside the web UI produce no RPC events, so the
      // only signal that they advanced is the file itself.
      const holder: { fn: (() => void) | null } = { fn: null };
      holder.fn = subscribeSessionFileChanges((sessionIds) => {
        try {
          // Sessions the web UI spawned itself produce their own RPC events;
          // everything else that changed on disk is being written by an
          // external omp/harness and should render as externally running.
          const rpcIds = new Set(getRunningRpcSessionIdsFor(ctx));
          const externallyRunning = sessionIds.filter((id) => !rpcIds.has(id));
          encode({
            type: "sessions-changed",
            sessionIds,
            refreshSessionList: true,
            ...(externallyRunning.length > 0 ? { externallyRunning } : {}),
          });
        } catch {
          try { holder.fn?.(); } catch { /* already cleaned up */ }
        }
      }, ctx);
      const unsubscribeFiles = holder.fn;

      // Periodically re-broadcast the externally-running set so badges expire
      // client-side once a CLI session stops writing or exits.
      const externalHeartbeat = setInterval(async () => {
        try {
          const rpcIds = new Set(getRunningRpcSessionIdsFor(ctx));
          const fileActive = getExternallyActiveIds(5000, ctx);
          const cliLocks = await listCliLockedSessions();
          const active = [...new Set([...fileActive, ...cliLocks.keys()])].filter((id) => !rpcIds.has(id));
          if (active.length > 0) {
            encode({ type: "externally-running", externallyRunning: active });
          }
        } catch {
          // controller already closed
        }
      }, 5_000);

      // Initial snapshot so the client renders the correct state immediately.
      const initialRpc = getRunningRpcSessionIdsFor(ctx);
      encode({ type: "running", runningSessionIds: initialRpc });
      void listCliLockedSessions().then((cliLocks) => {
        const fileActive = getExternallyActiveIds(5000, ctx);
        const rpcIds = new Set(initialRpc);
        const active = [...new Set([...fileActive, ...cliLocks.keys()])].filter((id) => !rpcIds.has(id));
        if (active.length > 0) {
          encode({ type: "externally-running", externallyRunning: active });
        }
      }).catch(() => {});
      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeFiles();
        clearInterval(externalHeartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      streamCleanup = cleanup;

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      ...PROFILE_SCOPED_HEADERS,
      Connection: "keep-alive",
    },
  });
}
