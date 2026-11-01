import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { invalidateModelsCache } from "@/lib/models-cache";
import { pruneConfigProviderRefs } from "@/lib/omp/model-roles";
import { disposeUtilityRpc } from "@/lib/omp/rpc-utility";
import {
  ModelsConfigParseError,
  maskModelsConfigApiKeys,
  readModelsConfigFile,
  restoreModelsConfigApiKeys,
  validateModelsConfig,
  writeModelsConfig,
  type ModelsFileConfig,
} from "@/lib/omp/models-config";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ctx = requestProfileContext(request);
  const file = readModelsConfigFile(ctx);
  if (file.parseError) {
    // The editor must show the failure instead of an empty form — an empty
    // form invites a Save that would wipe the user's real providers.
    return NextResponse.json({
      providers: {},
      parseError: file.parseError,
      path: file.path,
      code: "models_config_unparseable",
    }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  }
  // Never emit a real key: the file API denies models.yml outright, so this
  // route is the only reader and must redact what it returns.
  return NextResponse.json(maskModelsConfigApiKeys(file.config), { headers: { ...PROFILE_SCOPED_HEADERS } });
}

// PUT /api/models-config[?overwrite=true]
// Refuses to write while models.yml is unparseable unless ?overwrite=true.
export async function PUT(req: Request) {
  const ctx = requestProfileContext(req);
  try {
    const overwriteUnparseable = new URL(req.url).searchParams.get("overwrite") === "true";
    const body = await req.json() as ModelsFileConfig;
    // The editor echoes masked keys back on every save; restore the stored key
    // for those, so an unrelated edit never wipes (or leaks, then re-saves) a
    // credential, and a placeholder is never written to disk.
    const stored = readModelsConfigFile(ctx);
    if (!body || !body.providers || typeof body.providers !== "object" || Array.isArray(body.providers)) {
      return NextResponse.json({ error: "Providers must be a mapping" }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    if (!stored.parseError && Object.keys(stored.config.providers ?? {}).length > 0 && Object.keys(body.providers).length === 0) {
      return NextResponse.json({ error: "Refusing to replace existing providers with an empty configuration", code: "models_config_empty" }, { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    const restored = restoreModelsConfigApiKeys(body, stored.parseError ? { providers: {} } : stored.config);
    try {
      validateModelsConfig(restored);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: { ...PROFILE_SCOPED_HEADERS } });
    }
    try {
      writeModelsConfig(restored, { overwriteUnparseable }, ctx);
    } catch (error) {
      if (error instanceof ModelsConfigParseError) {
        return NextResponse.json(
          { error: `${error.message} — fix it by hand; omp-web will not overwrite it`, code: "models_config_unparseable" },
          { status: 409, headers: { ...PROFILE_SCOPED_HEADERS } },
        );
      }
      throw error;
    }
    // A provider removal must also drop config.yml entries that referenced it
    // (model roles, fallback chains, webSearchOrder) — otherwise omp keeps
    // resolving the deleted provider to a random/unusable model, which reads
    // as "the CLI did not sync the deletion".
    pruneConfigProviderRefs(Object.keys(body.providers), ctx, Object.keys(stored.config.providers ?? {}));
    invalidateModelsCache();
    // The utility process loads models.yml once at startup. A cache flush alone
    // would still query that stale registry after a provider was added.
    disposeUtilityRpc(ctx);
    return NextResponse.json({ success: true }, { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
