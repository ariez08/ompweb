import { statSync } from "fs";
import { invalidateModelsCache, loadModelsWithCache, withModelRuntimeError, withSafeModelLoadFailure, type ModelsData } from "@/lib/models-cache";
import { disposeUtilityRpc, runUtilityCommand, type OmpModel } from "@/lib/omp/rpc-utility";
import { readDisabledProviders } from "@/lib/omp/model-roles";
import { PROFILE_SCOPED_HEADERS, requestProfileContext } from "@/lib/omp/profile-cookie";
import type { ProfileContext } from "@/lib/omp/profile-context";

export const dynamic = "force-dynamic";
// The omp model registry (auth + models.yml) is global, not per-cwd, so one
// cache entry per profile serves every request. The ?cwd= query parameter is
// still accepted for client compatibility but no longer affects the result.
// The entry is profile-keyed: two profiles sharing one process must never
// read each other's cached registry.
const MODELS_CACHE_SUFFIX = "global";

declare global {
  var __ompModelsConfigFingerprints: Map<string, string> | undefined;
}

function refreshModelsIfConfigChanged(ctx: ProfileContext): void {
  const path = ctx.modelsConfigPath;
  let fingerprint = `${path}:missing`;
  try {
    const stat = statSync(path);
    fingerprint = `${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    // A missing models file is a valid state; the fingerprint still detects
    // its later creation.
  }

  // Per-profile fingerprints: a single shared slot would report a false
  // "config changed" every time two profiles alternate requests.
  if (!globalThis.__ompModelsConfigFingerprints) globalThis.__ompModelsConfigFingerprints = new Map();
  const fingerprints = globalThis.__ompModelsConfigFingerprints;
  const previous = fingerprints.get(ctx.key);
  fingerprints.set(ctx.key, fingerprint);
  if (previous !== undefined && previous !== fingerprint) {
    // The utility process reads models.yml once at startup. External edits
    // therefore need the same invalidation as the web editor's PUT route.
    invalidateModelsCache();
    disposeUtilityRpc(ctx);
  }
}

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string }
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

// Upstream gateways like OmniRoute expose separate model aliases for thinking
// effort tiers (e.g. -low, -medium, -high) for legacy clients lacking reasoning
// parameters. In ompweb, thinking level is chosen natively in the UI, so we
// collapse these suffixed variants into their canonical base model whenever that
// base model already exists in the provider catalog.
const EFFORT_SUFFIX_RE = /-(?:thinking-)?(none|min|minimal|low|medium|high|xhigh|max)(?:-\d+k)?$/i;
const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function resolveCanonicalBaseId(id: string, allIds: Set<string>): { baseId: string; effort: string } | null {
  const match = EFFORT_SUFFIX_RE.exec(id);
  if (!match) return null;
  const effort = match[1].toLowerCase();
  const rawBase = id.slice(0, match.index);
  if (allIds.has(rawBase)) return { baseId: rawBase, effort };
  if (allIds.has(`${rawBase}-thinking`)) return { baseId: `${rawBase}-thinking`, effort };
  return null;
}

function sortThinkingLevels(levels: string[]): string[] {
  return [...new Set(levels)].sort((a, b) => {
    const idxA = THINKING_LEVEL_ORDER.indexOf(a);
    const idxB = THINKING_LEVEL_ORDER.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });
}

// "off" is always a valid selector; the concrete efforts come from the model's
// baked thinking metadata (omp: getSupportedEfforts = reasoning ? efforts : []).
function thinkingLevelsFor(model: OmpModel): string[] {
  if (!model.reasoning) return ["off"];
  return ["off", ...(model.thinking?.efforts ?? [])];
}

// OMP's /fast maps to a priority service tier. These are the provider families
// OMP currently resolves for that control (ModelControls.setFastMode).
function supportsFastMode(model: OmpModel): boolean {
  return model.provider === "anthropic" || model.provider === "openai" || model.provider === "google";
}

async function loadModels(ctx: ProfileContext): Promise<ModelsData> {
  const availableResponse = await runUtilityCommand<{ models?: unknown }>(
    { type: "get_available_models" },
    120_000,
    ctx,
  );
  const available = Array.isArray(availableResponse.models)
    ? availableResponse.models
        .filter((model): model is OmpModel => (
          typeof model === "object" && model !== null
          && typeof (model as OmpModel).id === "string"
          && typeof (model as OmpModel).provider === "string"
        ))
        .map((model) => ({
          ...model,
          name: typeof model.name === "string" && model.name.trim().length > 0 ? model.name : model.id,
        }))
    : [];

  const allIdsByProvider = new Map<string, Set<string>>();
  for (const m of available) {
    let set = allIdsByProvider.get(m.provider);
    if (!set) {
      set = new Set();
      allIdsByProvider.set(m.provider, set);
    }
    set.add(m.id);
  }

  const nameMap = new Map<string, string>();
  const thinkingLevels: Record<string, string[]> = {};
  for (const m of available) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = thinkingLevelsFor(m);
  }

  const collapsedModels: typeof available = [];
  for (const m of available) {
    const set = allIdsByProvider.get(m.provider);
    const resolved = set ? resolveCanonicalBaseId(m.id, set) : null;
    if (resolved) {
      const baseKey = `${m.provider}:${resolved.baseId}`;
      const levels = thinkingLevels[baseKey] ?? ["off"];
      const eff = resolved.effort === "none" ? "off" : resolved.effort;
      if (!levels.includes(eff)) {
        levels.push(eff);
      }
      thinkingLevels[baseKey] = sortThinkingLevels(levels);
      continue;
    }
    collapsedModels.push(m);
  }

  const modelList = collapsedModels
    .map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      thinkingLevels: thinkingLevels[`${m.provider}:${m.id}`] ?? thinkingLevelsFor(m),
      supportsFastMode: supportsFastMode(m),
      contextWindow: m.contextWindow ?? undefined,
      maxTokens: m.maxTokens ?? undefined,
    }))
    .sort(compareModelEntries);
  const loginResponse = await runUtilityCommand<{ providers?: unknown }>(
    { type: "get_login_providers" },
    30_000,
    ctx,
  );
  const loginProviders = Array.isArray(loginResponse.providers)
    ? loginResponse.providers.filter((provider): provider is { id: string; name: string; authenticated: boolean } => (
      typeof provider === "object" && provider !== null
      && typeof (provider as { id?: unknown }).id === "string"
      && typeof (provider as { name?: unknown }).name === "string"
      && typeof (provider as { authenticated?: unknown }).authenticated === "boolean"
    ))
    : [];
  const disabledProviders = readDisabledProviders(ctx);
  const connectedProviders = loginProviders
    .filter((provider) => provider.authenticated)
    .map((provider) => ({ id: provider.id, name: provider.name, disabled: disabledProviders.has(provider.id) }));
  for (const m of available) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = thinkingLevelsFor(m);
  }

  // omp resolves the default model at session start; a --no-session utility
  // process reports it via get_state.
  let defaultModel: { provider: string; modelId: string } | null = null;
  try {
    const state = await runUtilityCommand<{ model?: { provider?: string; id?: string } }>(
      { type: "get_state" },
      30_000,
      ctx,
    );
    const provider = state.model?.provider;
    let modelId = state.model?.id;
    if (provider && modelId) {
      const set = allIdsByProvider.get(provider);
      const canonical = set ? resolveCanonicalBaseId(modelId, set) : null;
      if (canonical) modelId = canonical.baseId;
      if (collapsedModels.some((m) => m.provider === provider && m.id === modelId)) {
        defaultModel = { provider, modelId };
      }
    }
  } catch {
    // Default model is cosmetic — the models list is still useful without it.
  }

  return withModelRuntimeError(
    { models: Object.fromEntries(nameMap), modelList, defaultModel, thinkingLevels, connectedProviders },
    undefined,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
};

export async function GET(request: Request) {
  const ctx = requestProfileContext(request);
  refreshModelsIfConfigChanged(ctx);
  try {
    return Response.json(await loadModelsWithCache(`${ctx.key}:${MODELS_CACHE_SUFFIX}`, () => loadModels(ctx)), { headers: { ...PROFILE_SCOPED_HEADERS } });
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS), { headers: { ...PROFILE_SCOPED_HEADERS } });
  }
}
