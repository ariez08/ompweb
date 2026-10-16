import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { enableProvider } from "@/lib/omp/model-roles";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export async function POST(request: Request) {
  const ctx = requestProfileContext(request);
  try {
    const body = await request.json() as { provider?: unknown };
    if (typeof body.provider !== "string" || !body.provider.trim()) {
      return NextResponse.json({ error: "provider is required" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    // enableProvider rewrites config.yml inside the agent dir: unpinned it
    // would toggle the profile the server was launched with, not the one the
    // UI is showing.
    enableProvider(body.provider, ctx);
    invalidateModelsCache();
    disposeUtilityRpc(ctx);
    return NextResponse.json({ success: true }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}
