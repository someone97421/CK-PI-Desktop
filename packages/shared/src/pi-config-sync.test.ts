import { describe, expect, it } from "vitest";
import { bindingForCustomModel } from "./model-catalog.js";
import {
  buildPiExportPlan,
  isUnresolvedPiValue,
  mergePiAuthRoot,
  mergePiModelsRoot,
  mergePiSettingsRoot,
  parsePiAuthApiKeys,
  piApiForApiStyle,
  piModelEntry,
  piProviderKeyFor,
} from "./pi-config-sync.js";

describe("piProviderKeyFor", () => {
  it("uses the vendor id for a native provider", () => {
    expect(piProviderKeyFor({ type: "native", vendorKey: "Anthropic" })).toBe("anthropic");
  });

  it("uses the endpoint host for a custom provider", () => {
    expect(
      piProviderKeyFor({ type: "openai_compatible", vendorKey: "custom", baseUrl: "https://Api.Acme.IO/v1" }),
    ).toBe("api-acme-io");
  });

  it("falls back to the display name, then to custom", () => {
    expect(piProviderKeyFor({ type: "custom", name: "My Gateway" })).toBe("my-gateway");
    expect(piProviderKeyFor({})).toBe("custom");
  });

  it("keeps a stable vendor slug when the vendor key is not custom", () => {
    expect(piProviderKeyFor({ vendorKey: "deepseek" })).toBe("deepseek");
  });
});

describe("piApiForApiStyle", () => {
  it("maps Desktop api styles to pi api values", () => {
    expect(piApiForApiStyle("chat_completions")).toBe("openai-completions");
    expect(piApiForApiStyle("responses")).toBe("openai-responses");
    expect(piApiForApiStyle("anthropic_messages")).toBe("anthropic-messages");
    expect(piApiForApiStyle("google_generative_ai")).toBe("google-generative-ai");
    expect(piApiForApiStyle("unknown")).toBeUndefined();
  });
});

describe("isUnresolvedPiValue", () => {
  it("detects shell commands and environment interpolation", () => {
    expect(isUnresolvedPiValue("!op read 'op://vault/item'")).toBe(true);
    expect(isUnresolvedPiValue("$MY_API_KEY")).toBe(true);
    expect(isUnresolvedPiValue("${KEY_PREFIX}_x")).toBe(true);
    expect(isUnresolvedPiValue("sk-literal")).toBe(false);
    expect(isUnresolvedPiValue("$$literal")).toBe(false);
    expect(isUnresolvedPiValue("$!literal-bang")).toBe(false);
  });
});

describe("piModelEntry", () => {
  it("projects limits, image input, and reasoning", () => {
    const entry = piModelEntry({
      ...bindingForCustomModel("gpt-test"),
      contextWindow: 128000,
      maxTokens: 4096,
      supportsImages: true,
      thinkingLevels: ["off", "high"],
    });
    expect(entry).toEqual({
      id: "gpt-test",
      contextWindow: 128000,
      maxTokens: 4096,
      input: ["text", "image"],
      reasoning: true,
    });
  });

  it("omits reasoning when only off is available", () => {
    const entry = piModelEntry({
      ...bindingForCustomModel("plain"),
      thinkingLevels: ["off"],
    });
    expect(entry.reasoning).toBeUndefined();
    expect(entry.input).toBeUndefined();
  });
});

describe("buildPiExportPlan", () => {
  it("builds provider, credential, and default upserts", () => {
    const plan = buildPiExportPlan({
      providers: [
        {
          key: "api-acme-io",
          name: "Acme",
          type: "openai_compatible",
          baseUrl: "https://api.acme.io/v1",
          apiStyle: "chat_completions",
          headers: { "x-vendor": "1" },
          models: [bindingForCustomModel("acme-large")],
          apiKey: "sk-acme",
        },
      ],
      defaults: {
        defaultProviderId: "p1",
        defaultModelId: "acme-large",
        defaultThinkingLevel: "medium",
      },
      piKeyForProviderId: () => "api-acme-io",
    });

    expect(plan.providers["api-acme-io"]).toMatchObject({
      baseUrl: "https://api.acme.io/v1",
      api: "openai-completions",
      headers: { "x-vendor": "1" },
    });
    expect(plan.credentials["api-acme-io"]).toEqual({ type: "api_key", key: "sk-acme" });
    expect(plan.defaults).toEqual({
      defaultProvider: "api-acme-io",
      defaultModel: "acme-large",
      defaultThinkingLevel: "medium",
    });
    expect(plan.managedKeys).toEqual(["api-acme-io"]);
  });

  it("never exports OAuth grants and reports unresolved values", () => {
    const plan = buildPiExportPlan({
      providers: [
        {
          key: "anthropic",
          name: "Anthropic",
          type: "native",
          vendorKey: "anthropic",
          apiKey: "!security find-generic-password",
          hasOauth: true,
          models: [],
        },
      ],
    });
    expect(plan.credentials).toEqual({});
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "credential", key: "anthropic", reason: "unresolved-value" }),
        expect.objectContaining({ kind: "credential", key: "anthropic", reason: "oauth-not-synced" }),
      ]),
    );
  });

  it("skips a duplicate provider key", () => {
    const plan = buildPiExportPlan({
      providers: [
        { key: "dup", name: "A", models: [] },
        { key: "dup", name: "B", models: [] },
      ],
    });
    expect(plan.skipped).toEqual([
      expect.objectContaining({ key: "dup", reason: "duplicate-key" }),
    ]);
  });
});

describe("mergePiModelsRoot", () => {
  it("upserts a provider and preserves unknown providers and fields", () => {
    const { root, actions } = mergePiModelsRoot(
      {
        theme: "dark",
        providers: {
          "pi-only": { baseUrl: "http://localhost:11434/v1" },
          "api-acme-io": { baseUrl: "https://old.example.com", note: "keep-me" },
        },
      },
      { "api-acme-io": { baseUrl: "https://api.acme.io/v1", api: "openai-completions" } },
      ["api-acme-io"],
    );

    expect(root.theme).toBe("dark");
    expect((root.providers as Record<string, unknown>)["pi-only"]).toBeDefined();
    expect((root.providers as Record<string, unknown>)["api-acme-io"]).toMatchObject({
      baseUrl: "https://api.acme.io/v1",
      api: "openai-completions",
      note: "keep-me",
    });
    expect(actions).toEqual([
      expect.objectContaining({ kind: "provider", key: "api-acme-io", action: "update" }),
    ]);
  });

  it("merges models by id instead of dropping unknown model fields", () => {
    const { root } = mergePiModelsRoot(
      { providers: { p: { models: [{ id: "a", name: "keep", cost: { input: 1 } }] } } },
      { p: { models: [{ id: "a", contextWindow: 200000 }, { id: "b" }] } },
      ["p"],
    );
    const providers = root.providers as Record<
      string,
      { models: Array<Record<string, unknown>> }
    >;
    expect(providers.p.models).toEqual([
      { id: "a", name: "keep", cost: { input: 1 }, contextWindow: 200000 },
      { id: "b" },
    ]);
  });

  it("reports a managed key that is no longer exported without deleting it", () => {
    const { root, actions } = mergePiModelsRoot(
      { providers: { gone: { baseUrl: "https://gone.example.com" } } },
      {},
      ["gone"],
    );
    expect((root.providers as Record<string, unknown>).gone).toBeDefined();
    expect(actions).toEqual([
      expect.objectContaining({ key: "gone", action: "removed", reason: "no-longer-managed" }),
    ]);
  });
});

describe("mergePiAuthRoot", () => {
  it("preserves unrelated credentials and reports removals", () => {
    const { root, actions } = mergePiAuthRoot(
      { anthropic: { type: "oauth", access: "token" }, acme: { type: "api_key", key: "old" } },
      { acme: { type: "api_key", key: "new" } },
      ["acme", "gone"],
    );
    expect(root.anthropic).toEqual({ type: "oauth", access: "token" });
    expect(root.acme).toEqual({ type: "api_key", key: "new" });
    expect(actions).toEqual([
      expect.objectContaining({ key: "acme", action: "update", hasSecret: true }),
    ]);
  });
});

describe("mergePiSettingsRoot", () => {
  it("writes only the three model defaults", () => {
    const { root, actions } = mergePiSettingsRoot(
      { theme: "light", compaction: { enabled: false } },
      { defaultProvider: "anthropic", defaultModel: "claude" },
    );
    expect(root.theme).toBe("light");
    expect(root.compaction).toEqual({ enabled: false });
    expect(root.defaultProvider).toBe("anthropic");
    expect(actions).toEqual([
      expect.objectContaining({ kind: "model-default", key: "defaultProvider", action: "update" }),
      expect.objectContaining({ kind: "model-default", key: "defaultModel", action: "update" }),
    ]);
  });
});

describe("parsePiAuthApiKeys", () => {
  it("separates api keys, OAuth entries, and unresolved values", () => {
    const parsed = parsePiAuthApiKeys({
      anthropic: { type: "api_key", key: "sk-ant" },
      openai: { type: "oauth", access: "token" },
      acme: { type: "api_key", key: "!op read secret" },
      bare: { key: "sk-bare" },
    });
    expect(parsed.keys).toEqual({ anthropic: "sk-ant", bare: "sk-bare" });
    expect(parsed.oauthKeys).toEqual(["openai"]);
    expect(parsed.unresolvedKeys).toEqual(["acme"]);
  });
});
