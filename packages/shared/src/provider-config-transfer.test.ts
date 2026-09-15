import { describe, expect, it } from "vitest";
import { bindingForCustomModel } from "./model-catalog.js";
import {
  buildProviderExportFile,
  parseProviderExportFile,
  planProviderImport,
  providerExportEntryFrom,
  providerImportPayload,
  PROVIDER_EXPORT_KIND,
} from "./provider-config-transfer.js";

const binding = bindingForCustomModel("acme-large");

describe("providerExportEntryFrom", () => {
  it("keeps the settings the provider dialog owns", () => {
    const entry = providerExportEntryFrom({
      name: "Acme",
      vendorKey: "Acme",
      type: "openai_compatible",
      protocol: "openai-compatible",
      apiStyle: "chat_completions",
      baseUrl: "https://api.acme.io/v1",
      authKind: "api_key",
      enabled: true,
      headers: { "x-vendor": "1" },
      models: [binding],
      defaultModelId: "acme-large",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      temperature: 0.2,
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "high"],
    }, "sk-acme");

    expect(entry).toEqual({
      name: "Acme",
      vendorKey: "acme",
      type: "openai_compatible",
      protocol: "openai-compatible",
      apiStyle: "chat_completions",
      baseUrl: "https://api.acme.io/v1",
      authKind: "api_key",
      headers: { "x-vendor": "1" },
      models: [binding],
      defaultModelId: "acme-large",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      temperature: 0.2,
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "high"],
      apiKey: "sk-acme",
    });
    // A disabled row is worth recording; an enabled one is the default.
    expect(entry.enabled).toBeUndefined();
  });

  it("omits blanks and never exports an OAuth grant", () => {
    const entry = providerExportEntryFrom({
      name: "Anthropic",
      type: "native",
      hasOauth: true,
      oauthAccountLabel: "user@example.com",
      headers: {},
      models: [],
    });
    expect(entry).toEqual({
      name: "Anthropic",
      type: "native",
      oauthAccountLabel: "user@example.com",
    });
    expect(entry.apiKey).toBeUndefined();
  });

  it("records a disabled provider", () => {
    const entry = providerExportEntryFrom({ name: "Off", enabled: false });
    expect(entry.enabled).toBe(false);
  });
});

describe("buildProviderExportFile", () => {
  it("writes a versioned envelope", () => {
    const file = buildProviderExportFile([{ name: "Acme" }], {
      app: "这是一个助手",
      now: new Date("2026-09-15T00:00:00.000Z"),
    });
    expect(file).toEqual({
      kind: PROVIDER_EXPORT_KIND,
      version: 1,
      exportedAt: "2026-09-15T00:00:00.000Z",
      app: "这是一个助手",
      providers: [{ name: "Acme" }],
    });
  });
});

describe("parseProviderExportFile", () => {
  const valid = {
    kind: PROVIDER_EXPORT_KIND,
    version: 1,
    exportedAt: "2026-09-15T00:00:00.000Z",
    providers: [{ name: "Acme" }],
  };

  it("accepts a well-formed document and parses raw JSON text", () => {
    expect(parseProviderExportFile(valid)).toMatchObject({ ok: true });
    expect(parseProviderExportFile(JSON.stringify(valid))).toMatchObject({
      ok: true,
      file: { providers: [{ name: "Acme" }] },
    });
  });

  it("rejects malformed envelopes with a usable reason", () => {
    expect(parseProviderExportFile("not json")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(parseProviderExportFile({ ...valid, kind: "other" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("not a provider export"),
    });
    expect(parseProviderExportFile({ kind: PROVIDER_EXPORT_KIND, providers: [] }))
      .toMatchObject({ ok: false, error: expect.stringContaining("missing version") });
    expect(parseProviderExportFile({ ...valid, version: 99 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("newer than this build"),
    });
    expect(parseProviderExportFile({ ...valid, providers: "nope" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("must be an array"),
    });
  });

  it("skips entries without a name and fails when nothing is usable", () => {
    const mixed = parseProviderExportFile({
      ...valid,
      providers: [{ name: "Acme" }, { vendorKey: "x" }, "junk"],
    });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.file.providers).toEqual([{ name: "Acme" }]);
      expect(mixed.warnings).toHaveLength(2);
    }
    expect(parseProviderExportFile({ ...valid, providers: [{ name: "" }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("no usable providers"),
    });
  });
});

describe("planProviderImport", () => {
  it("updates on a case-insensitive name match and creates otherwise", () => {
    const plan = planProviderImport(
      [{ id: "p1", name: "Acme" }, { id: "p2", name: "Other" }],
      [{ name: "acme" }, { name: "Fresh" }],
    );
    expect(plan.steps).toEqual([
      { action: "update", key: "acme", entry: { name: "acme" }, id: "p1" },
      { action: "create", key: "fresh", entry: { name: "Fresh" } },
    ]);
    expect(plan.duplicates).toEqual([]);
  });

  it("applies only the first of two same-named entries in one file", () => {
    const plan = planProviderImport([], [{ name: "Dup" }, { name: "dup" }]);
    expect(plan.steps).toEqual([{ action: "create", key: "dup", entry: { name: "Dup" } }]);
    expect(plan.duplicates).toEqual(["dup"]);
  });
});

describe("providerImportPayload", () => {
  it("maps only create/update fields and keeps the credential out", () => {
    const payload = providerImportPayload({
      name: "  Acme  ",
      vendorKey: "acme",
      type: "openai_compatible",
      baseUrl: "https://api.acme.io/v1",
      models: [binding],
      apiKey: "sk-acme",
    });
    expect(payload).toEqual({
      name: "Acme",
      vendorKey: "acme",
      type: "openai_compatible",
      baseUrl: "https://api.acme.io/v1",
      models: [binding],
    });
    expect("apiKey" in payload).toBe(false);
  });
});
