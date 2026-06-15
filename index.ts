import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-types";

type OpenClawConfig = {
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
};

const PLUGIN_ID = "aihubmix-auth";

const PROVIDER_IDS = {
  openai: "aihubmix-openai",
  anthropic: "aihubmix-anthropic",
  google: "aihubmix-google",
  other: "aihubmix-other",
} as const;

const PROVIDER_LABELS = {
  openai: "AIHubmix (OpenAI)",
  anthropic: "AIHubmix (Anthropic)",
  google: "AIHubmix (Google)",
  other: "AIHubmix (Other)",
} as const;

const API_KEY_ENV = "AIHUBMIX_API_KEY";
const FLAG_NAME = "--aihubmix-api-key" as const;

const OPENAI_BASE_URL = "https://aihubmix.com/v1";
const ANTHROPIC_BASE_URL = "https://aihubmix.com";
const GOOGLE_BASE_URL = "https://aihubmix.com/gemini/v1beta";
const AIHUBMIX_MODELS_URL = "https://aihubmix.com/api/v1/models";

const SORT_BY = "order";
const SORT_ORDER = "desc";
const FALLBACK_CONTEXT_TOKENS = 200_000;
const FALLBACK_MAX_TOKENS = 8192;
const MODEL_LIMITS = {
  openai: 10,
  anthropic: 10,
  google: 10,
  other: 20,
} as const;

type TextProvider = keyof typeof MODEL_LIMITS;
type ProviderId = (typeof PROVIDER_IDS)[TextProvider];

interface AihubmixModelRecord {
  model_id?: unknown;
  model_name?: unknown;
  endpoints?: unknown;
  features?: unknown;
  input_modalities?: unknown;
  max_output?: unknown;
  context_length?: unknown;
  order?: unknown;
}

interface AihubmixModelListResponse {
  data?: unknown;
}

interface AihubmixModelDefinition {
  id: string;
  name: string;
  api: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image" | "audio" | "video">;
  cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsDeveloperRole?: boolean };
}

type ModelMap = Record<TextProvider, AihubmixModelDefinition[]>;

interface CatalogAuthAttempt {
  label: string;
  headers: Record<string, string>;
}

const trimText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const splitList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const toPositiveInt = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
};

const extractOrder = (record: AihubmixModelRecord): number => {
  const numeric = Number(record.order);
  return Number.isFinite(numeric) ? numeric : -Infinity;
};

const dedupeInputs = (values: string[]): Array<"text" | "image" | "audio" | "video"> => {
  const normalized = values
    .map((value) => value.toLowerCase())
    .filter((value): value is "text" | "image" | "audio" | "video" =>
      value === "text" || value === "image" || value === "audio" || value === "video",
    );
  if (!normalized.includes("text")) normalized.unshift("text");
  return normalized;
};

const detectProvider = (
  modelId: string,
  record: AihubmixModelRecord,
): TextProvider => {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("gemini-")) return "google";

  const endpointHints = new Set(
    splitList(record.endpoints).map((item) => item.toLowerCase()),
  );
  if (endpointHints.has("claude_api") && !endpointHints.has("gemini_api")) {
    return "anthropic";
  }
  if (endpointHints.has("gemini_api") && !endpointHints.has("claude_api")) {
    return "google";
  }

  if (
    lower.startsWith("gpt") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return "openai";
  }

  return "other";
};

const buildModelDefinition = (params: {
  modelId: string;
  modelName: string;
  record: AihubmixModelRecord;
  provider: TextProvider;
}): AihubmixModelDefinition => {
  const features = new Set(
    splitList(params.record.features).map((feature) => feature.toLowerCase()),
  );
  const contextWindow = toPositiveInt(
    params.record.context_length,
    FALLBACK_CONTEXT_TOKENS,
  );
  const maxOutput = toPositiveInt(
    params.record.max_output,
    Math.min(contextWindow, FALLBACK_MAX_TOKENS),
  );

  const api: ModelApi =
    params.provider === "google"
      ? "google-generative-ai"
      : params.provider === "anthropic"
        ? "anthropic-messages"
        : "openai-completions";

  return {
    id: params.modelId,
    name: params.modelName,
    api,
    reasoning: features.has("thinking"),
    input: dedupeInputs(splitList(params.record.input_modalities)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(contextWindow, maxOutput),
    compat: { supportsDeveloperRole: false },
  };
};

const buildModelsUrl = (): string => {
  const url = new URL(AIHUBMIX_MODELS_URL);
  url.searchParams.set("sort_by", SORT_BY);
  url.searchParams.set("sort_order", SORT_ORDER);
  return url.toString();
};

const buildCatalogAuthAttempts = (apiKey: string): CatalogAuthAttempt[] => {
  if (!apiKey) {
    return [
      { label: "unauthenticated", headers: { Accept: "application/json" } },
    ];
  }
  return [
    {
      label: "authorization-bearer",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    },
    {
      label: "anthropic-x-api-key",
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
      },
    },
    {
      label: "gemini-x-goog-api-key",
      headers: {
        Accept: "application/json",
        "x-goog-api-key": apiKey,
      },
    },
  ];
};

const trimErrorDetail = (value: string): string => {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
};

async function fetchAihubmixModels(apiKey: string): Promise<ModelMap> {
  const empty: ModelMap = { openai: [], anthropic: [], google: [], other: [] };
  let payload: AihubmixModelListResponse | null = null;
  const failures: string[] = [];

  for (const attempt of buildCatalogAuthAttempts(apiKey)) {
    const response = await fetch(buildModelsUrl(), { headers: attempt.headers });
    if (!response.ok) {
      const detail = trimErrorDetail(await response.text());
      failures.push(
        detail
          ? `${attempt.label}=${response.status}(${detail})`
          : `${attempt.label}=${response.status}`,
      );
      continue;
    }

    try {
      payload = (await response.json()) as AihubmixModelListResponse;
    } catch (error) {
      throw new Error(
        `AIHubmix model API returned invalid JSON: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    break;
  }

  if (!payload) {
    const detail = failures.length > 0 ? ` Tried: ${failures.join(", ")}` : "";
    throw new Error(`Failed to fetch model catalog.${detail}`);
  }

  const rawModels = Array.isArray(payload.data) ? payload.data : [];
  if (rawModels.length === 0) return empty;

  const buckets: Record<
    TextProvider,
    Array<{ value: AihubmixModelDefinition; order: number }>
  > = {
    openai: [],
    anthropic: [],
    google: [],
    other: [],
  };
  const seen: Record<TextProvider, Set<string>> = {
    openai: new Set(),
    anthropic: new Set(),
    google: new Set(),
    other: new Set(),
  };

  for (const raw of rawModels) {
    const record = raw as AihubmixModelRecord;
    const modelId = trimText(record.model_id);
    if (!modelId) continue;

    const provider = detectProvider(modelId, record);
    if (
      seen.openai.has(modelId) ||
      seen.anthropic.has(modelId) ||
      seen.google.has(modelId) ||
      seen.other.has(modelId) ||
      seen[provider].has(modelId)
    ) {
      continue;
    }
    seen[provider].add(modelId);

    const modelName = trimText(record.model_name) || modelId;
    const model = buildModelDefinition({ modelId, modelName, record, provider });
    buckets[provider].push({ value: model, order: extractOrder(record) });
  }

  const sortAndTrim = (provider: TextProvider): AihubmixModelDefinition[] =>
    buckets[provider]
      .sort((left, right) => right.order - left.order)
      .slice(0, MODEL_LIMITS[provider])
      .map((item) => item.value);

  return {
    openai: sortAndTrim("openai"),
    anthropic: sortAndTrim("anthropic"),
    google: sortAndTrim("google"),
    other: sortAndTrim("other"),
  };
}

function toModelDefinition(
  model: AihubmixModelDefinition,
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  };
}

function buildProviderConfig(
  provider: TextProvider,
  models: ModelMap,
): ModelProviderConfig {
  const baseUrl =
    provider === "anthropic"
      ? ANTHROPIC_BASE_URL
      : provider === "google"
        ? GOOGLE_BASE_URL
        : OPENAI_BASE_URL;
  const api: ModelApi =
    provider === "anthropic"
      ? "anthropic-messages"
      : provider === "google"
        ? "google-generative-ai"
        : "openai-completions";
  return {
    baseUrl,
    api,
    models: models[provider].map(toModelDefinition),
  };
}

function registerAihubmixProvider(params: {
  api: OpenClawPluginApi;
  provider: TextProvider;
  models: ModelMap;
  apiKey: string;
}): void {
  const { api, provider, models, apiKey } = params;
  const id: ProviderId = PROVIDER_IDS[provider];
  const label = PROVIDER_LABELS[provider];
  const config = buildProviderConfig(provider, models);

  api.registerProvider({
    id,
    label,
    docsPath: "/providers/models",
    envVars: [API_KEY_ENV],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: id,
        methodId: "api-key",
        label: `${label} API key`,
        hint: "Paste one AIHubmix key shared across all four transports",
        optionKey: `aihubmixApiKey${provider.charAt(0).toUpperCase() + provider.slice(1)}`,
        flagName: FLAG_NAME,
        envVar: API_KEY_ENV,
        promptMessage: `AIHubmix API key (${label})`,
        defaultModel: `${id}/${models.openai[0]?.id ?? models.anthropic[0]?.id ?? models.google[0]?.id ?? models.other[0]?.id ?? "gpt-4o-mini"}`,
        applyConfig: (cfg) => {
          if (!apiKey) return cfg;
          const existing = cfg.models?.providers?.[id];
          if (existing) {
            return {
              ...cfg,
              models: {
                ...(cfg.models ?? {}),
                providers: {
                  ...(cfg.models?.providers ?? {}),
                  [id]: { ...existing, apiKey },
                },
              },
            };
          }
          return {
            ...cfg,
            models: {
              ...(cfg.models ?? {}),
              providers: {
                ...(cfg.models?.providers ?? {}),
                [id]: { ...config, apiKey },
              },
            },
          };
        },
      }),
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const resolved = ctx.resolveProviderApiKey(id)?.apiKey ?? apiKey;
        if (!resolved) return null;
        try {
          const fetched = await fetchAihubmixModels(resolved);
          return { provider: buildProviderConfig(provider, fetched) };
        } catch {
          return null;
        }
      },
    },
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: config }),
    },
  });

  api.registerModelCatalogProvider({
    provider: id,
    kinds: ["text"],
    liveCatalog: async (ctx) => {
      const resolved = ctx.resolveProviderApiKey(id)?.apiKey ?? apiKey;
      if (!resolved) return null;
      try {
        const fetched = await fetchAihubmixModels(resolved);
        return fetched[provider].map((model) => ({
          kind: "text" as const,
          provider: id,
          model: model.id,
          label: model.name,
          source: "live" as const,
        }));
      } catch {
        return null;
      }
    },
    staticCatalog: async () =>
      models[provider].map((model) => ({
        kind: "text" as const,
        provider: id,
        model: model.id,
        label: model.name,
        source: "static" as const,
      })),
  });
}

type PluginEntry = ReturnType<typeof definePluginEntry>;

const entry: PluginEntry = definePluginEntry({
  id: PLUGIN_ID,
  name: "AIHubmix",
  description: "Route OpenAI/Anthropic/Gemini model calls through AIHubmix",
  register(api: OpenClawPluginApi) {
    const apiKey = (process.env[API_KEY_ENV] ?? "").trim();
    const models: ModelMap = { openai: [], anthropic: [], google: [], other: [] };

    for (const provider of Object.keys(MODEL_LIMITS) as TextProvider[]) {
      registerAihubmixProvider({ api, provider, models, apiKey });
    }

    if (apiKey) {
      void fetchAihubmixModels(apiKey)
        .then((fetched) => {
          for (const provider of Object.keys(MODEL_LIMITS) as TextProvider[]) {
            const id = PROVIDER_IDS[provider];
            api.registerModelCatalogProvider({
              provider: id,
              kinds: ["text"],
              liveCatalog: async (ctx) => {
                const resolved = ctx.resolveProviderApiKey(id)?.apiKey ?? apiKey;
                if (!resolved) return null;
                try {
                  const fresh = await fetchAihubmixModels(resolved);
                  return fresh[provider].map((model) => ({
                    kind: "text" as const,
                    provider: id,
                    model: model.id,
                    label: model.name,
                    source: "live" as const,
                  }));
                } catch {
                  return null;
                }
              },
              staticCatalog: async () =>
                fetched[provider].map((model) => ({
                  kind: "text" as const,
                  provider: id,
                  model: model.id,
                  label: model.name,
                  source: "static" as const,
                })),
            });
          }
        })
        .catch(() => {
          // Catalog warm-up is best-effort; live catalog still falls back to the catalog hook.
        });
    }
  },
});

export default entry;
