import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";

const PLUGIN_ID = "aihubmix-auth";
const PROVIDER_ID = "aihubmix";
const PROVIDER_LABEL = "AIHubmix";
const OPENAI_BASE_URL = "https://aihubmix.com/v1";
const ANTHROPIC_BASE_URL = "https://aihubmix.com";
const GOOGLE_BASE_URL = "https://aihubmix.com/gemini/v1beta";
const AIHUBMIX_MODELS_URL = "https://aihubmix.com/api/v1/models";
const AIHUBMIX_RECENT_SORT_BY = "order";
const AIHUBMIX_RECENT_SORT_ORDER = "desc";
const FALLBACK_CONTEXT_TOKENS = 200_000;
const FALLBACK_MAX_TOKENS = 8192;
const AIHUBMIX_MODEL_LIMITS = {
  openai: 10,
  anthropic: 10,
  google: 10,
  other: 20,
} as const;

type TextModelProvider = "openai" | "anthropic" | "google" | "other";

type AihubmixModelRecord = {
  model_id?: unknown;
  model_name?: unknown;
  endpoints?: unknown;
  features?: unknown;
  input_modalities?: unknown;
  max_output?: unknown;
  context_length?: unknown;
};

type AihubmixModelListResponse = {
  data?: unknown;
};

type AihubmixModelDefinition = ReturnType<typeof buildModelDefinition>;
type ModelMap = Record<TextModelProvider, AihubmixModelDefinition[]>;

type ProviderModelAllowlist = Record<string, Record<string, never>>;

type ModelBucket = {
  provider: TextModelProvider;
  limit: number;
  items: Array<{ value: AihubmixModelDefinition; order: number }>;
};

type CatalogAuthAttempt = {
  label: string;
  headers: Record<string, string>;
};

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function splitList(value: unknown): string[] {
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
}

function extractModelOrder(record: AihubmixModelRecord): number {
  const numeric = Number((record as Record<string, unknown>).order);
  if (!Number.isFinite(numeric)) {
    return -Infinity;
  }
  return numeric;
}

function limitForProvider(provider: TextModelProvider): number {
  if (provider === "other") {
    return AIHUBMIX_MODEL_LIMITS.other;
  }
  return AIHUBMIX_MODEL_LIMITS[provider];
}

function toPositiveInt(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function normalizeApiKey(value: string | undefined): string {
  return value?.trim() ?? "";
}

function resolveApiKeyFromInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("AIHubmix API key is required.");
  }
  return trimmed;
}

function dedupeModelInputs(values: string[]): Array<"text" | "image"> {
  const normalized = values
    .map((value) => value.toLowerCase())
    .filter((value) => value === "text" || value === "image");
  const withImage = normalized.includes("image");
  return ["text", ...(withImage ? ["image"] : [])];
}

function detectProvider(modelId: string, record: AihubmixModelRecord): TextModelProvider {
  const lowerModelId = modelId.toLowerCase();
  if (lowerModelId.startsWith("claude-")) {
    return "anthropic";
  }
  if (lowerModelId.startsWith("gemini-")) {
    return "google";
  }

  const endpointHints = new Set(splitList(record.endpoints).map((item) => item.toLowerCase()));
  if (endpointHints.has("claude_api") && !endpointHints.has("gemini_api")) {
    return "anthropic";
  }
  if (endpointHints.has("gemini_api") && !endpointHints.has("claude_api")) {
    return "google";
  }

  if (
    lowerModelId.startsWith("gpt") ||
    lowerModelId.startsWith("o1") ||
    lowerModelId.startsWith("o3") ||
    lowerModelId.startsWith("o4")
  ) {
    return "openai";
  }

  return "other";
}

function buildModelDefinition(params: {
  modelId: string;
  modelName: string;
  record: AihubmixModelRecord;
  provider: TextModelProvider;
}) {
  const featureSet = new Set(
    splitList(params.record.features).map((feature) => feature.toLowerCase()),
  );
  const contextWindow = toPositiveInt(params.record.context_length, FALLBACK_CONTEXT_TOKENS);
  const maxOutput = toPositiveInt(
    params.record.max_output,
    Math.min(contextWindow, FALLBACK_MAX_TOKENS),
  );

  return {
    id: params.modelId,
    name: params.modelName,
    api:
      params.provider === "google"
        ? ("google-generative-ai" as const)
        : params.provider === "anthropic"
          ? ("anthropic-messages" as const)
          : ("openai-completions" as const),
    reasoning: featureSet.has("thinking"),
    input: dedupeModelInputs(splitList(params.record.input_modalities)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(contextWindow, maxOutput),
    compat: { supportsDeveloperRole: false },
  };
}

function buildAgentModelAllowlist(modelsByProvider: ModelMap): ProviderModelAllowlist {
  const entries: ProviderModelAllowlist = {};

  for (const [provider, models] of Object.entries(modelsByProvider) as Array<
    [TextModelProvider, AihubmixModelDefinition[]]
  >) {
    for (const model of models) {
      const modelId = model.id.trim();
      if (!modelId) {
        continue;
      }
      entries[`${provider}/${modelId}`] = {};
    }
  }

  return entries;
}

function buildAihubmixModelsUrl(): string {
  const url = new URL(AIHUBMIX_MODELS_URL);
  url.searchParams.set("sort_by", AIHUBMIX_RECENT_SORT_BY);
  url.searchParams.set("sort_order", AIHUBMIX_RECENT_SORT_ORDER);
  return url.toString();
}

function buildCatalogAuthAttempts(apiKey: string): CatalogAuthAttempt[] {
  if (!apiKey) {
    return [{ label: "unauthenticated", headers: { Accept: "application/json" } }];
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
}

function trimErrorDetail(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
}

async function fetchAihubmixModels(apiKey: string): Promise<ModelMap> {
  let payload: AihubmixModelListResponse | null = null;
  const failures: string[] = [];

  for (const attempt of buildCatalogAuthAttempts(apiKey)) {
    const response = await fetch(buildAihubmixModelsUrl(), {
      headers: attempt.headers,
    });

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
        `AIHubmix model API returned invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    break;
  }

  if (!payload) {
    const detail = failures.length > 0 ? ` Tried: ${failures.join(", ")}` : "";
    throw new Error(`Failed to fetch model catalog.${detail}`);
  }

  const limitBuckets: Record<TextModelProvider, ModelBucket> = {
    openai: { provider: "openai", limit: limitForProvider("openai"), items: [] },
    anthropic: {
      provider: "anthropic",
      limit: limitForProvider("anthropic"),
      items: [],
    },
    google: { provider: "google", limit: limitForProvider("google"), items: [] },
    other: { provider: "other", limit: limitForProvider("other"), items: [] },
  };

  const rawModels = Array.isArray(payload.data) ? payload.data : [];
  if (rawModels.length === 0) {
    return {
      openai: [],
      anthropic: [],
      google: [],
      other: [],
    };
  }

  const modelsByProvider: Record<TextModelProvider, AihubmixModelDefinition[]> = {
    openai: [],
    anthropic: [],
    google: [],
    other: [],
  };
  const seenIds: Record<TextModelProvider, Set<string>> = {
    openai: new Set(),
    anthropic: new Set(),
    google: new Set(),
    other: new Set(),
  };

  for (const raw of rawModels) {
    const record = raw as AihubmixModelRecord;
    const modelId = trimText(record.model_id);
    if (!modelId) {
      continue;
    }

    const provider = detectProvider(modelId, record);
    if (
      seenIds[provider].has(modelId) ||
      seenIds.openai.has(modelId) ||
      seenIds.anthropic.has(modelId) ||
      seenIds.google.has(modelId) ||
      seenIds.other.has(modelId)
    ) {
      continue;
    }
    seenIds[provider].add(modelId);

    const modelName = trimText(record.model_name) || modelId;
    const modelDefinition = buildModelDefinition({
      modelId,
      modelName,
      record,
      provider,
    });

    modelsByProvider[provider].push(modelDefinition);
    limitBuckets[provider].items.push({
      value: modelDefinition,
      order: extractModelOrder(record),
    });
  }

  const selectedModels = (provider: TextModelProvider): AihubmixModelDefinition[] => {
    return limitBuckets[provider].items
      .sort((left, right) => right.order - left.order)
      .slice(0, limitForProvider(provider))
      .map((item) => item.value);
  };

  const openaiTop = selectedModels("openai");
  const anthropicTop = selectedModels("anthropic");
  const googleTop = selectedModels("google");
  const otherTop = selectedModels("other");

  modelsByProvider.openai = openaiTop;
  modelsByProvider.anthropic = anthropicTop;
  modelsByProvider.google = googleTop;
  modelsByProvider.other = otherTop;

  return modelsByProvider;
}

function makeDefaultModel(modelsByProvider: ModelMap): string | undefined {
  if (modelsByProvider.openai[0]) {
    return `openai/${modelsByProvider.openai[0].id}`;
  }
  if (modelsByProvider.anthropic[0]) {
    return `anthropic/${modelsByProvider.anthropic[0].id}`;
  }
  if (modelsByProvider.google[0]) {
    return `google/${modelsByProvider.google[0].id}`;
  }
  if (modelsByProvider.other[0]) {
    return `other/${modelsByProvider.other[0].id}`;
  }
  return undefined;
}

const aihubmixPlugin = {
  id: PLUGIN_ID,
  name: "AIHubmix API",
  description: "Route OpenAI/Anthropic/Gemini model calls through AIHubmix",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["aihubmix-api"],
      auth: [
        {
          id: "api-key",
          label: "AIHubmix API key",
          hint: "Paste one AIHubmix key shared by OpenAI, Anthropic, and Gemini",
          kind: "api_key",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const rawKey = String(
              await ctx.prompter.text({
                message: "AIHubmix API key",
              }),
            );
            const apiKey = resolveApiKeyFromInput(rawKey);
            const normalizedApiKey = normalizeApiKey(apiKey);

            const notes: string[] = [
              "AIHubmix API key is saved to auth-profiles for openai/anthropic/google/other providers.",
              "OpenAI-style models use baseUrl: https://aihubmix.com/v1 and openai-completions.",
              "Anthropic models are configured with anthropic-messages and baseUrl https://aihubmix.com (calls /v1/messages).",
              "Gemini models are configured with google-generative-ai and baseUrl https://aihubmix.com/gemini/v1beta (calls /models/{model}:...).",
              "Auth headers stay provider-native: OpenAI=Authorization Bearer, Anthropic=x-api-key, Gemini=x-goog-api-key.",
            ];

            let modelsByProvider: ModelMap = {
              openai: [],
              anthropic: [],
              google: [],
              other: [],
            };

            try {
              modelsByProvider = await fetchAihubmixModels(normalizedApiKey);
              notes.push("Fetched the latest model catalog from AIHubmix API.");
            } catch (error) {
              notes.push(
                error instanceof Error
                  ? `Model catalog fetch failed: ${error.message}. Using empty model lists.`
                  : "Model catalog fetch failed. Using empty model lists.",
              );
            }

            const defaultModel = makeDefaultModel(modelsByProvider);
            const modelAllowlist = buildAgentModelAllowlist(modelsByProvider);

            return {
              profiles: [
                {
                  profileId: "openai:aihubmix",
                  credential: {
                    type: "api_key",
                    provider: "openai",
                    key: normalizedApiKey,
                  },
                },
                {
                  profileId: "anthropic:aihubmix",
                  credential: {
                    type: "api_key",
                    provider: "anthropic",
                    key: normalizedApiKey,
                  },
                },
                {
                  profileId: "google:aihubmix",
                  credential: {
                    type: "api_key",
                    provider: "google",
                    key: normalizedApiKey,
                  },
                },
                {
                  profileId: "other:aihubmix",
                  credential: {
                    type: "api_key",
                    provider: "other",
                    key: normalizedApiKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    openai: {
                      baseUrl: OPENAI_BASE_URL,
                      api: "openai-completions",
                      models: modelsByProvider.openai,
                    },
                    anthropic: {
                      baseUrl: ANTHROPIC_BASE_URL,
                      api: "anthropic-messages",
                      models: modelsByProvider.anthropic,
                    },
                    google: {
                      baseUrl: GOOGLE_BASE_URL,
                      api: "google-generative-ai",
                      models: modelsByProvider.google,
                    },
                    other: {
                      baseUrl: OPENAI_BASE_URL,
                      api: "openai-completions",
                      models: modelsByProvider.other,
                    },
                  },
                },
                ...(Object.keys(modelAllowlist).length > 0
                  ? {
                      agents: {
                        defaults: {
                          models: modelAllowlist,
                        },
                      },
                    }
                  : {}),
              },
              ...(defaultModel ? { defaultModel } : {}),
              notes,
            };
          },
        },
      ],
    });
  },
};

export default aihubmixPlugin;
