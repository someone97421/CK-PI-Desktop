import { describe, expect, it } from "vitest";
import { genericModelConfig } from "./model-capabilities.js";
import { buildProviderModel, type RuntimeProviderConfig } from "./provider-binding.js";

const baseUrl = "https://native.test/v1";
const provider: RuntimeProviderConfig = {
  id: "account", name: "Account", modelId: "exact-model", baseUrl, apiStyle: "openai_completions",
  apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"],
  modelConfig: {
    ...genericModelConfig("exact-model", baseUrl), source: "pi",
    transcriptBinding: { modelId: "exact-model", api: "openai-completions", baseUrl },
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: false },
  },
};

describe("transcript compatibility binding", () => {
  it("keeps Pi transport capabilities when models.dev owns published metadata", () => {
    expect(buildProviderModel({ ...provider, modelConfig: { ...provider.modelConfig!, source: "models.dev" } }).compat)
      .toMatchObject({ supportsMidConvoSystemMessages: true });
  });
  it("keeps instruction and tool capabilities independent on the exact binding", () => {
    expect(buildProviderModel(provider).compat).toMatchObject({ supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: false });
    expect(buildProviderModel({ ...provider, baseUrl: `${baseUrl}/` }).compat).toMatchObject({ supportsMidConvoSystemMessages: true });
  });
  it.each([
    { baseUrl: "https://relay.test/v1" }, { baseUrl: "https://native.test/other" },
    { baseUrl: "https://native.test:8443/v1" }, { modelId: "alias" }, { apiStyle: "responses" },
    { modelConfig: { ...provider.modelConfig!, transcriptBinding: undefined } },
  ])("falls back for an unverified route or model: %j", (overrides) => {
    expect(buildProviderModel({ ...provider, ...overrides }).compat).toMatchObject({
      supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false,
      supportsMidConvoToolChanges: false, supportsAdditionalTools: false,
    });
  });
});
