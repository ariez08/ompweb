import { NextResponse } from "next/server";
import { listAllSessionInfos } from "@/lib/omp/session-files";
import { readModelsConfigFile } from "@/lib/omp/models-config";
import { allProfileContexts, defaultProfileContext, type ProfileContext } from "@/lib/omp/profile-context";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

/** Counting scans each profile's sessions through its host, which boots one
 * ompweb-host per profile (plan D-5). The sidebar needs names on first paint
 * and counts only when asked, so counting is capped and opt-in. */
const MAX_COUNTED_PROFILES = 4;

interface ProfileSummary {
  profile: string;
  isDefault: boolean;
  /** True when this profile is the one the ompweb process was launched with. */
  isProcessProfile: boolean;
  agentDir: string;
  sessionsDir: string;
  sessionCount?: number;
  modelCount?: number;
  /** Present only when counting failed; the profile itself is still valid. */
  countError?: string;
}

function countDeclaredModels(ctx: ProfileContext): number {
  const { config } = readModelsConfigFile(ctx);
  const providers = config.providers ?? {};
  return Object.values(providers).reduce((total, provider) => total + (provider.models?.length ?? 0), 0);
}

async function summarize(ctx: ProfileContext, withCounts: boolean, processKey: string): Promise<ProfileSummary> {
  const base: ProfileSummary = {
    profile: ctx.profile,
    isDefault: ctx.isDefault,
    isProcessProfile: ctx.key === processKey,
    agentDir: ctx.agentDir,
    sessionsDir: ctx.sessionsDir,
  };
  if (!withCounts) return base;
  try {
    const sessions = await listAllSessionInfos(ctx);
    return {
      ...base,
      sessionCount: sessions.length,
      // Declared models.yml entries, not the runtime-resolved catalog: resolving
      // would spawn a utility RPC per profile for a sidebar badge.
      modelCount: countDeclaredModels(ctx),
    };
  } catch (error) {
    return { ...base, countError: error instanceof Error ? error.message : String(error) };
  }
}

export async function GET(request: Request) {
  const withCounts = new URL(request.url).searchParams.get("counts") === "1";
  const current = requestProfileContext(request);
  const processKey = defaultProfileContext().key;
  const profiles = allProfileContexts();

  // The requesting profile is always counted, even past the cap.
  const toCount = withCounts
    ? [current, ...profiles.filter((ctx) => ctx.key !== current.key).slice(0, MAX_COUNTED_PROFILES - 1)]
    : [];
  const toList = profiles.filter((ctx) => !toCount.includes(ctx));

  const summaries = await Promise.all([
    ...toCount.map((ctx) => summarize(ctx, true, processKey)),
    ...toList.map((ctx) => summarize(ctx, false, processKey)),
  ]);

  return NextResponse.json(
    { profiles: summaries, current: current.key, counted: withCounts },
    { headers: { ...PROFILE_SCOPED_HEADERS } },
  );
}
