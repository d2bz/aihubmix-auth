import type { OpenClawPluginApi, ProviderAuthContext } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aihubmixPlugin from "./index.js";

type ModelOutput = { id: string };

type AuthRunResult = {
  profiles: Array<{
    profileId: string;
    credential: { provider: string; key?: string };
  }>;
  configPatch: {
    models: {
      providers: {
        openai: { models: ModelOutput[] };
        anthropic: { models: ModelOutput[] };
        google: { models: ModelOutput[] };
        other: { models: ModelOutput[] };
      };
    };
  };
  defaultModel?: string;
};

type RegisteredProvider = {
  auth: Array<{
    run: (ctx: ProviderAuthContext) => Promise<AuthRunResult>;
  }>;
};

type FetchInput = Parameters<typeof fetch>[0];

function makeModelRecord(params: {
  modelId: string;
  order: number;
  endpoints?: string[];
}): Record<string, unknown> {
  return {
    model_id: params.modelId,
    model_name: params.modelId,
    order: params.order,
    endpoints: params.endpoints ?? [],
    features: [],
    input_modalities: ["text"],
    context_length: 128_000,
    max_output: 8_192,
  };
}

function extractRequestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

async function runAuthFlow(provider: RegisteredProvider): Promise<AuthRunResult> {
  const auth = provider.auth[0];
  if (!auth) {
    throw new Error("Auth flow was not registered.");
  }
  return auth.run({
    prompter: {
      text: async () => "sk-aihubmix-test-key",
    },
  } as unknown as ProviderAuthContext);
}

describe("aihubmix-auth plugin", () => {
  let originalFetch: typeof globalThis.fetch;
  let registeredProvider: RegisteredProvider | undefined;

  beforeEach(() => {
    registeredProvider = undefined;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    aihubmixPlugin.register({
      registerProvider(provider: unknown) {
        registeredProvider = provider as RegisteredProvider;
      },
    } as unknown as OpenClawPluginApi);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests model catalog with descending order", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    if (!registeredProvider) {
      throw new Error("Provider registration was not captured.");
    }

    await runAuthFlow(registeredProvider);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [requestInput] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    if (!requestInput) {
      throw new Error("Expected fetch request input.");
    }
    const requestUrl = new URL(extractRequestUrl(requestInput));
    expect(requestUrl.searchParams.get("sort_by")).toBe("order");
    expect(requestUrl.searchParams.get("sort_order")).toBe("desc");
  });

  it("keeps provider model lists in descending order by API order", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            makeModelRecord({ modelId: "gpt-low", order: 1 }),
            makeModelRecord({ modelId: "gpt-high", order: 9 }),
            makeModelRecord({ modelId: "custom-low", order: 2 }),
            makeModelRecord({ modelId: "custom-high", order: 8 }),
            makeModelRecord({
              modelId: "claude-low",
              order: 3,
              endpoints: ["claude_api"],
            }),
            makeModelRecord({
              modelId: "claude-high",
              order: 7,
              endpoints: ["claude_api"],
            }),
          ],
        }),
        { status: 200 },
      ),
    );

    if (!registeredProvider) {
      throw new Error("Provider registration was not captured.");
    }

    const result = await runAuthFlow(registeredProvider);

    expect(result.configPatch.models.providers.openai.models.map((model) => model.id)).toEqual([
      "gpt-high",
      "gpt-low",
    ]);
    expect(result.configPatch.models.providers.anthropic.models.map((model) => model.id)).toEqual([
      "claude-high",
      "claude-low",
    ]);
    expect(result.configPatch.models.providers.other.models.map((model) => model.id)).toEqual([
      "custom-high",
      "custom-low",
    ]);
    expect(result.defaultModel).toBe("openai/gpt-high");
    expect(result.profiles.map((profile) => profile.profileId)).toContain("other:aihubmix");
  });
});
