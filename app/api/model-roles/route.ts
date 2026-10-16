import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { readModelRoles, writeModelRoles } from "@/lib/omp/model-roles";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const ctx = requestProfileContext(request);
  try {
    return NextResponse.json(readModelRoles(ctx), { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}

export async function PUT(request: Request) {
  const ctx = requestProfileContext(request);
  try {
    const body = await request.json() as { roles?: unknown };
    if (!body.roles || typeof body.roles !== "object" || Array.isArray(body.roles)) {
      return NextResponse.json({ error: "roles must be an object" }, { status: 400 });
    }
    const roles = Object.fromEntries(Object.entries(body.roles).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[0].trim().length > 0 && entry[1].trim().length > 0,
    ));
    writeModelRoles(roles, ctx);
    invalidateModelsCache();
    return NextResponse.json({ success: true, roles }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}
