import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { getRpcSession, WebRpcError } from "@/lib/rpc-manager";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

const MAX_JOB_REQUEST_BYTES = 4096;

export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function errorResponse(error: unknown, status = 400) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "invalid_job_request";
  return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid job request", code }, { status, headers: { ...PROFILE_SCOPED_HEADERS } });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requestProfileContext(req);
  const { id } = await params;
  if (!SAFE_ID.test(id)) return errorResponse(new WebRpcError("Invalid session id.", "invalid_session_id"));
  const session = getRpcSession(id, ctx);
  if (!session || session.ctx.key !== ctx.key || session.sessionId !== id || !session.isAlive()) {
    return NextResponse.json({ jobs: [] }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  }
  return NextResponse.json({ jobs: session.listJobProvenance().map(({ id, toolCallId, state }) => ({ id, toolCallId, state })) }, { headers: { ...PROFILE_SCOPED_HEADERS } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requestProfileContext(req);
  const { id } = await params;
  if (!SAFE_ID.test(id)) return errorResponse(new WebRpcError("Invalid session id.", "invalid_session_id"));
  try {
    const body = await parseJsonWithinLimit<{ jobId?: unknown; toolCallId?: unknown; action?: unknown }>(req, MAX_JOB_REQUEST_BYTES);
    if (typeof body.jobId !== "string" || !SAFE_ID.test(body.jobId) || typeof body.toolCallId !== "string" || !SAFE_ID.test(body.toolCallId)) {
      return errorResponse(new WebRpcError("Valid jobId and toolCallId are required.", "invalid_job_id"));
    }
    if (body.action !== "inspect" && body.action !== "stop") return errorResponse(new WebRpcError("Invalid job action.", "invalid_job_action"));
    const session = getRpcSession(id, ctx);
    if (!session || session.ctx.key !== ctx.key || session.sessionId !== id || !session.isAlive()) return errorResponse(new WebRpcError("Job is not available in the live process.", "job_unavailable"), 409);
    await session.requestJobAction(body.jobId, body.toolCallId, body.action);
    return NextResponse.json({ accepted: true, action: body.action }, { status: 202, headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return errorResponse(new WebRpcError("Job request is too large.", "request_too_large"), 413);
    if (error instanceof SyntaxError) return errorResponse(new WebRpcError("Invalid JSON request body.", "invalid_json"));
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return errorResponse(error, typeof code === "string" && (code.startsWith("job_") || code === "session_restarting") ? 409 : 400);
  }
}
