import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveOmpBin } from "@/lib/omp/omp-cli";
import { aggregateFromStatsDb } from "@/lib/stats-aggregate";
import { hostEnvFor, type ProfileContext } from "@/lib/omp/profile-context";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const STATS_CACHE_TTL_MS = 2_000;

interface CachedStatsData {
  expiresAt: number;
  data: Record<string, unknown>;
}

// Profile-keyed: one ompweb process answers for several profiles, and a single
// shared entry would serve profile A's aggregates to profile B's dashboard.
const cachedStatsByProfile = new Map<string, CachedStatsData>();
const inFlightByProfile = new Map<string, Promise<Record<string, unknown>>>();

/**
 * omp stats --json can return zeroed aggregates (observed with omp/18.1.2 on
 * Windows) even when ~/.omp/stats.db holds valid rows: the sync step reports
 * "Synced 0 new entries" and every aggregate is 0/empty. Treat that as a CLI
 * failure and fall back to a direct read-only aggregation of the sqlite db so
 * the usage dashboard always shows real numbers.
 */
function statsLookMeaningful(parsed: Record<string, unknown>): boolean {
  const overall = parsed.overall as Record<string, unknown> | null | undefined;
  if (!overall) return false;
  const reqs = typeof overall.totalRequests === "number" ? overall.totalRequests : 0;
  const inp = typeof overall.totalInputTokens === "number" ? overall.totalInputTokens : 0;
  const out = typeof overall.totalOutputTokens === "number" ? overall.totalOutputTokens : 0;
  const byModel = Array.isArray(parsed.byModel) ? parsed.byModel : [];
  return reqs > 0 || inp > 0 || out > 0 || byModel.length > 0;
}

async function fetchStatsData(ctx: ProfileContext): Promise<Record<string, unknown>> {
  const ompBin = resolveOmpBin();
  if (!ompBin) {
    throw new Error("omp binary not found on PATH or OMP_WEB_OMP_BIN");
  }

  // The CLI resolves its own profile from the environment, so pin it; without
  // this the subprocess reads the process profile regardless of the request.
  const execOpts = { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, env: hostEnvFor(ctx) };
  const [statsResult, usageResult] = await Promise.allSettled([
    execFileAsync(ompBin, ["stats", "--json"], execOpts),
    execFileAsync(ompBin, ["usage", "--json"], execOpts),
  ]);

  let parsedStats: Record<string, unknown> = {};
  if (statsResult.status === "fulfilled") {
    const raw = statsResult.value.stdout;
    // Strip possible non-json log lines before {
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      try {
        parsedStats = JSON.parse(raw.slice(jsonStart)) as Record<string, unknown>;
      } catch (e) {
        console.warn("Failed to parse omp stats --json output:", e);
      }
    }
  } else {
    console.warn("Failed to run omp stats --json:", statsResult.reason);
  }

  let parsedUsage: Record<string, unknown> = {};
  if (usageResult.status === "fulfilled") {
    const raw = usageResult.value.stdout;
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      try {
        parsedUsage = JSON.parse(raw.slice(jsonStart)) as Record<string, unknown>;
      } catch (e) {
        console.warn("Failed to parse omp usage --json output:", e);
      }
    }
  } else {
    console.warn("Failed to run omp usage --json:", usageResult.reason);
  }

  if (!statsLookMeaningful(parsedStats)) {
    try {
      const db = await aggregateFromStatsDb(ctx);
      if (db && db.overall && (db.overall.totalRequests > 0 || db.overall.totalInputTokens > 0)) {
        console.warn("omp stats --json returned empty aggregates; fell back to stats.db aggregation");
        parsedStats = db as unknown as Record<string, unknown>;
      }
    } catch (error) {
      console.warn("stats.db fallback aggregation failed:", error);
    }
  }

  return {
    overall: parsedStats.overall ?? null,
    byModel: parsedStats.byModel ?? [],
    byFolder: parsedStats.byFolder ?? [],
    byAgentType: parsedStats.byAgentType ?? [],
    timeSeries: parsedStats.timeSeries ?? [],
    modelSeries: parsedStats.modelSeries ?? [],
    modelPerformanceSeries: parsedStats.modelPerformanceSeries ?? [],
    costSeries: parsedStats.costSeries ?? [],
    reports: parsedUsage.reports ?? [],
    capacity: parsedUsage.capacity ?? {},
    timestamp: Date.now(),
  };
}

export async function GET(request: Request) {
  const ctx = requestProfileContext(request);
  const now = Date.now();
  const cached = cachedStatsByProfile.get(ctx.key);
  if (cached && cached.expiresAt > now) {
    return NextResponse.json(cached.data, { headers: { ...PROFILE_SCOPED_HEADERS } });
  }

  let inFlight = inFlightByProfile.get(ctx.key);
  if (!inFlight) {
    inFlight = fetchStatsData(ctx)
      .then((data) => {
        cachedStatsByProfile.set(ctx.key, {
          expiresAt: Date.now() + STATS_CACHE_TTL_MS,
          data,
        });
        return data;
      })
      .finally(() => {
        if (inFlightByProfile.get(ctx.key) === inFlight) inFlightByProfile.delete(ctx.key);
      });
    inFlightByProfile.set(ctx.key, inFlight);
  }

  try {
    const data = await inFlight;
    return NextResponse.json(data, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    console.error("Failed to retrieve usage stats:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { ...PROFILE_SCOPED_HEADERS } }
    );
  }
}
