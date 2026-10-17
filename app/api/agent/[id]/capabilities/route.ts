import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = requestProfileContext(req);
  const { id } = await params;

  try {
    const resolved = await resolveSessionPathOr404(id, ctx);
    if ("response" in resolved) return resolved.response;

    const body = (await req.json().catch(() => ({}))) as {
      toolNames?: string[];
      skillPatterns?: string[];
    };

    const session = getRpcSession(id, ctx);
    if (session && session.isAlive()) {
      await session.updateCapabilities({
        toolNames: body.toolNames,
        skillPatterns: body.skillPatterns,
      });
    }

    return NextResponse.json(
      {
        success: true,
        sessionId: id,
        live: Boolean(session?.isAlive()),
        toolNames: body.toolNames,
        skillPatterns: body.skillPatterns,
      },
      { headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, code: "capabilities_update_failed" },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}
