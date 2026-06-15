import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import aihubmixPlugin from "./index.js";

type FetchInput = Parameters<typeof fetch>[0];

type CatalogRunFn = (ctx: unknown) => Promise<unknown>;

type AuthMethodRegistration = {
  id: string;
  label: string;
  hint?: string;
  kind: string;
  run: (ctx: unknown) => Promise<unknown>;
  runNonInteractive?: (ctx: unknown) => Promise<unknown>;
};

type RegisteredProvider = {
  id: string;
  label: string;
  envVars: readonly string[];
  catalog?: { run: CatalogRunFn };
  staticCatalog?: { run: CatalogRunFn };
  resolveDynamicModel?: (ctx: { modelId: string }) => unknown;
  auth: AuthMethodRegistration[];
};

type RegisteredModelCatalog = {
  provider: string;
  kinds: readonly string[];
  liveCatalog?: (ctx: unknown) => Promise<unknown>;
  staticCatalog?: (ctx: unknown) => Promise<unknown>;
};

type Capture = {
  providers: RegisteredProvider[];
  catalogs: RegisteredModelCatalog[];
};

const PROVIDER_IDS = [
  "aihubmix-openai",
  "aihubmix-anthropic",
  "aihubmix-google",
  "aihubmix-other",
] as const;

function extractRequestUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

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

function findProvider(providers: RegisteredProvider[], id: string): RegisteredProvider {
  const found = providers.find((p) => p.id === id);
  if (!found) {
    throw new Error(
      `Expected provider ${id} to be registered (got: ${providers.map((p) => p.id).join(", ")})`,
    );
  }
  return found;
}

function findCatalog(
  catalogs: RegisteredModelCatalog[],
  id: string,
): RegisteredModelCatalog {
  const found = catalogs.find((c) => c.provider === id);
  if (!found) {
    throw new Error(
      `Expected catalog ${id} to be registered (got: ${catalogs.map((c) => c.provider).join(", ")})`,
    );
  }
  return found;
}

describe("aihubmix-auth plugin", () => {
  let originalFetch: typeof globalThis.fetch;
  let capture: Capture;

  beforeEach(() => {
    capture = { providers: [], catalogs: [] };
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    aihubmixPlugin.register({
      registerProvider(provider: unknown) {
        capture.providers.push(provider as RegisteredProvider);
      },
      registerModelCatalogProvider(catalog: unknown) {
        capture.catalogs.push(catalog as RegisteredModelCatalog);
      },
    } as unknown as OpenClawPluginApi);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("registers four providers (openai/anthropic/google/other)", () => {
    const ids = capture.providers.map((p) => p.id).sort();
    expect(ids).toEqual([...PROVIDER_IDS].sort());
  });

  it("configures every provider with an api-key auth method and AIHUBMIX_API_KEY env", () => {
    for (const id of PROVIDER_IDS) {
      const provider = findProvider(capture.providers, id);
      const method = provider.auth[0];
      expect(method).toBeDefined();
      expect(method?.kind).toBe("api_key");
      expect(typeof method?.run).toBe("function");
      expect(provider.envVars).toContain("AIHUBMIX_API_KEY");
    }
  });

  it("requests model catalog with descending order", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonResponse({ data: [] }),
    );

    const provider = findProvider(capture.providers, "aihubmix-openai");
    if (!provider.catalog) {
      throw new Error("Provider catalog was not registered.");
    }
    await provider.catalog.run({
      resolveProviderApiKey: () => ({ apiKey: "sk-aihubmix-test-key" }),
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [requestInput] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    if (!requestInput) throw new Error("Expected fetch request input.");
    const requestUrl = new URL(extractRequestUrl(requestInput));
    expect(requestUrl.searchParams.get("sort_by")).toBe("order");
    expect(requestUrl.searchParams.get("sort_order")).toBe("desc");
  });

  it("orders bucket models by descending API order across the four transports", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
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
      ),
    );

    const fetchFor = (providerId: string) => ({
      resolveProviderApiKey: (id?: string) =>
        id === providerId
          ? { apiKey: "sk-aihubmix-test-key" }
          : { apiKey: undefined },
    });

    const openai = findProvider(capture.providers, "aihubmix-openai");
    const anthropic = findProvider(capture.providers, "aihubmix-anthropic");
    const other = findProvider(capture.providers, "aihubmix-other");
    if (!openai.catalog || !anthropic.catalog || !other.catalog) {
      throw new Error("Provider catalogs were not registered.");
    }

    const openaiResult = (await openai.catalog.run(fetchFor("aihubmix-openai"))) as {
      provider: { models: Array<{ id: string }> };
    };
    const anthropicResult = (await anthropic.catalog.run(
      fetchFor("aihubmix-anthropic"),
    )) as { provider: { models: Array<{ id: string }> } };
    const otherResult = (await other.catalog.run(fetchFor("aihubmix-other"))) as {
      provider: { models: Array<{ id: string }> };
    };

    expect(openaiResult.provider.models.map((m) => m.id)).toEqual([
      "gpt-high",
      "gpt-low",
    ]);
    expect(anthropicResult.provider.models.map((m) => m.id)).toEqual([
      "claude-high",
      "claude-low",
    ]);
    expect(otherResult.provider.models.map((m) => m.id)).toEqual([
      "custom-high",
      "custom-low",
    ]);
  });

  it("returns null catalog when no api key is available", async () => {
    const provider = findProvider(capture.providers, "aihubmix-openai");
    if (!provider.catalog) {
      throw new Error("Provider catalog was not registered.");
    }
    const result = await provider.catalog.run({
      resolveProviderApiKey: () => ({ apiKey: undefined }),
    });
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("registers a unified model catalog provider for every transport", () => {
    for (const id of PROVIDER_IDS) {
      const catalog = findCatalog(capture.catalogs, id);
      expect(catalog.kinds).toEqual(["text"]);
      expect(typeof catalog.liveCatalog).toBe("function");
      expect(typeof catalog.staticCatalog).toBe("function");
    }
  });

  it("live catalog returns provider-scoped rows for the requested transport", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            makeModelRecord({ modelId: "gpt-x", order: 5 }),
            makeModelRecord({
              modelId: "claude-x",
              order: 4,
              endpoints: ["claude_api"],
            }),
          ],
        }),
      ),
    );
    const openai = findCatalog(capture.catalogs, "aihubmix-openai");
    if (!openai.liveCatalog) throw new Error("liveCatalog was not registered.");
    const rows = (await openai.liveCatalog({
      resolveProviderApiKey: () => ({ apiKey: "sk-aihubmix-test-key" }),
    })) as Array<{ provider: string; model: string }>;
    expect(rows.find((r) => r.model === "gpt-x")).toBeDefined();
    expect(rows.find((r) => r.model === "claude-x")).toBeUndefined();
  });

  it("registers exactly one unified model catalog provider per provider id", () => {
    const counts = new Map<string, number>();
    for (const catalog of capture.catalogs) {
      counts.set(catalog.provider, (counts.get(catalog.provider) ?? 0) + 1);
    }
    for (const id of PROVIDER_IDS) {
      expect(counts.get(id) ?? 0).toBe(1);
    }
  });

  it("registers a resolveDynamicModel hook on every provider that routes by id prefix", () => {
    const claude = findProvider(capture.providers, "aihubmix-anthropic");
    const gemini = findProvider(capture.providers, "aihubmix-google");
    const openai = findProvider(capture.providers, "aihubmix-openai");
    if (!claude.resolveDynamicModel || !gemini.resolveDynamicModel || !openai.resolveDynamicModel) {
      throw new Error("resolveDynamicModel was not registered on every provider.");
    }
    const claudeResolved = claude.resolveDynamicModel({ modelId: "claude-sonnet-4-6" }) as {
      provider: string;
      api: string;
      baseUrl: string;
    };
    const geminiResolved = gemini.resolveDynamicModel({ modelId: "gemini-2-5-pro" }) as {
      provider: string;
      api: string;
      baseUrl: string;
    };
    const openaiResolved = openai.resolveDynamicModel({ modelId: "gpt-5-4" }) as {
      provider: string;
      api: string;
      baseUrl: string;
    };
    expect(claudeResolved.api).toBe("anthropic-messages");
    expect(claudeResolved.baseUrl).toBe("https://aihubmix.com");
    expect(geminiResolved.api).toBe("google-generative-ai");
    expect(geminiResolved.baseUrl).toBe("https://aihubmix.com/gemini/v1beta");
    expect(openaiResolved.api).toBe("openai-completions");
    expect(openaiResolved.baseUrl).toBe("https://aihubmix.com/v1");
  });

  it("staticCatalog always carries baseUrl/api route config (no key gate)", async () => {
    // applyConfig in the source code unconditionally writes the baseUrl/api
    // route block; staticCatalog is the offline projection that must always
    // surface the same route, even before a key is configured.
    for (const id of PROVIDER_IDS) {
      const provider = findProvider(capture.providers, id);
      if (!provider.staticCatalog) {
        throw new Error(`staticCatalog missing for ${id}.`);
      }
      const projection = (await provider.staticCatalog.run({})) as {
        provider: { baseUrl: string; api: string };
      };
      const expectedBase =
        id === "aihubmix-anthropic"
          ? "https://aihubmix.com"
          : id === "aihubmix-google"
            ? "https://aihubmix.com/gemini/v1beta"
            : "https://aihubmix.com/v1";
      const expectedApi =
        id === "aihubmix-anthropic"
          ? "anthropic-messages"
          : id === "aihubmix-google"
            ? "google-generative-ai"
            : "openai-completions";
      expect(projection.provider.baseUrl).toBe(expectedBase);
      expect(projection.provider.api).toBe(expectedApi);
    }
  });
});
