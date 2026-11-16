import { getRpcSession } from "@/lib/rpc-manager";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestProfileContext(req);
  const { id } = await params;

  // SSE is observer-only: listing or opening a saved session must not create
  // another omp process for a terminal-owned session. Explicit commands use
  // POST /api/agent/[id], which starts the wrapper before this route attaches.
  const existing = getRpcSession(id, ctx);
  const session = existing?.isAlive() ? existing : undefined;
  if (!session) return new Response("Session is not managed by omp-web", { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } });

  const encoder = new TextEncoder();
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the RpcProcess listener.
  let streamCleanup: (() => void) | null = null;
  let streamPull: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      // Backpressure slot: while the consumer is behind (desiredSize < 0),
      // replaceable `message_update` frames collapse to the latest one (omp
      // sends the FULL accumulated message each time, so latest-wins is safe).
      // Control/terminal frames are small and never dropped; they flush the
      // pending update first so ordering is preserved.
      let pendingUpdate: unknown | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      // force=false (timer tick): hold the update while the queue is still
      // full instead of enqueuing one large update every 25ms — a non-reading
      // client would otherwise accumulate them without bound. The held update
      // is delivered by the next pull() or control frame.
      // pull / control frame: flush before the following terminal frame.
      const flushPendingUpdate = (force: boolean): boolean => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const data = pendingUpdate;
        pendingUpdate = null;
        if (data === null) return true;
        if (!force && controller.desiredSize !== null && controller.desiredSize <= 0) {
          pendingUpdate = data;
          return false;
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };
      streamPull = () => flushPendingUpdate(true);

      const encode = (data: unknown) => {
        if (closed) return;
        const type = (data as { type?: string } | null)?.type;
        // Coalesce while backpressured; never buffer unboundedly.
        if (type === "message_update" && controller.desiredSize !== null && controller.desiredSize <= 0) {
          pendingUpdate = data;
          if (!flushTimer) {
            flushTimer = setTimeout(() => flushPendingUpdate(false), 25);
          }
          return;
        }
        if (!flushPendingUpdate(true)) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        if (closed) return;
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        if (!flushPendingUpdate(true)) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      encode({ type: "connected", sessionId: id });
      if (closed) return;
      unsubscribe = session.onEvent((event) => {
        if (event.type === "session_destroyed") {
          cleanup();
          return;
        }
        encode(event);
      });
    },
    pull() {
      streamPull?.();
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      ...PROFILE_SCOPED_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
