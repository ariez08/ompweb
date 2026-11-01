import { NextResponse } from "next/server";
import { deleteProfile, getProfileDetails, updateProfileConfig, type ProfileConfigPayload } from "@/lib/omp/profile-manager";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ profile: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { profile } = await params;
    const details = getProfileDetails(decodeURIComponent(profile));
    return NextResponse.json(details, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { profile } = await params;
    const body = (await request.json()) as ProfileConfigPayload;
    const updated = updateProfileConfig(decodeURIComponent(profile), body);
    return NextResponse.json({ ok: true, details: updated }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { profile } = await params;
    const currentCtx = requestProfileContext(request);
    await deleteProfile(decodeURIComponent(profile), currentCtx.key);
    return NextResponse.json({ ok: true }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } },
    );
  }
}
