import {
  readComposerSource,
  readMainModule,
  readMainSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const pickerSource = await readFile(
  new URL("../src/components/settings/ModelSelectionPanes.tsx", import.meta.url),
  "utf8",
);
const advancedSource = await readFile(
  new URL("../src/components/settings/ModelAdvancedSettings.tsx", import.meta.url),
  "utf8",
);
const imageModelRowSource = await readFile(
  new URL("../src/components/settings/ImageGenerationModelRow.tsx", import.meta.url),
  "utf8",
);
const composerSource = await readComposerSource();
const capabilitiesSource = await readFile(
  new URL(
    "../../../packages/agent-runtime/src/model-capabilities.ts",
    import.meta.url,
  ),
  "utf8",
);
const catalogSource = await readFile(
  new URL("../../../packages/shared/src/model-catalog.ts", import.meta.url),
  "utf8",
);
const mainSource = await readMainSource();
const providerCatalogSource = await readMainModule("runtime/provider-catalog.ts");
const sidecarSource = await readFile(
  new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("advanced settings choose the default thinking level among omit and the enabled ones", () => {
  // Offering the published ladder instead of the enabled subset would store a
  // default the runtime clamps away on the next request. omit is a client
  // selector, so it sits on the default picker rather than the capability chips.
  assert.match(advancedSource, /settings\.defaultThinkingLevel/);
  assert.match(advancedSource, /const enabledLevels = sortThinkingLevels\(/);
  assert.match(advancedSource, /bindingDefaultThinkingMenuLevels\(enabledLevels\)\.map/);
  assert.match(advancedSource, /defaultThinkingLevel: id as SessionThinkingLevel/);
  assert.match(advancedSource, /bindingDefaultThinkingMenuLevels\(enabledLevels\)\.length > 1 \?/);
});

test("advanced settings expose the model thinking protocol", () => {
  assert.match(advancedSource, /settings\.thinkingProtocol/);
  assert.match(advancedSource, /settings\.thinkingProtocolLegacy/);
  assert.match(advancedSource, /settings\.thinkingProtocolAdaptive/);
  assert.match(
    advancedSource,
    /binding\.thinkingProtocol\s*\?\?\s*info\?\.thinkingProtocol\s*\?\?\s*"legacy"/,
  );
  assert.match(advancedSource, /thinkingProtocol: id as ThinkingProtocol/);
});

test("the capability checkboxes show and follow the published value", () => {
  assert.match(advancedSource, /settings\.imageInput/);
  assert.match(advancedSource, /settings\.documentInput/);
  assert.match(advancedSource, /supportsImages: next/);
  assert.match(advancedSource, /supportsDocuments: next/);
  assert.match(advancedSource, /onChange\(event\.target\.checked\)/);
  assert.match(advancedSource, /const effective = typeof value === "boolean" \? value : published/);
  assert.match(advancedSource, /modelMatchesFilter\(info, "vision"\) : false/);
  assert.match(advancedSource, /modelMatchesFilter\(info, "pdf"\) : false/);
});

test("the capability row carries no explanatory copy or extra controls", () => {
  // The panel is a dense list of per-model rows; a hint paragraph and a reset
  // link per capability crowded it without telling the user anything the
  // checkbox state does not already say.
  assert.doesNotMatch(advancedSource, /documentInputHint/);
  assert.doesNotMatch(advancedSource, /followPublished/);
  assert.doesNotMatch(advancedSource, /capabilityPublished|capabilityUnknown/);
  assert.doesNotMatch(styles, /provider-chosen-capability-(reset|state|hint)/);
});


test("image generation selection hides the summary when nothing can be chosen", () => {
  assert.match(advancedSource, /className="provider-chosen-capability-rows">[\s\S]*?<ImageModelToggle/);
  assert.match(advancedSource, /settings\.setImageModel/);
  assert.doesNotMatch(
    pickerSource,
    /className="provider-chosen-advanced-toggle"[^\n]*settings\.setImageModel/,
  );
  assert.match(pickerSource, /imageModelIds\?\.some\([\s\S]*?modelId\.toLowerCase\(\) === binding\.id\.toLowerCase\(\)/);
  assert.match(advancedSource, /onChange=\{\(next\) => onImageModelChange\(binding\.id, next\)\}/);
  // The row's own rule — the stored candidate list, the legacy single binding
  // only while no list was ever saved, plus a signed-in vendor account's image
  // model — now lives in the shared helper, pinned by image-generation-default.test.mjs.
  assert.ok(imageModelRowSource.includes("imageGenerationPickerCandidates("));
  assert.match(imageModelRowSource, /if \(!options\.some\(\(option\) => !option\.disabled\)\) return null;/);
  assert.match(imageModelRowSource, /if \(candidates\.length === 0\) return null;/);
  assert.match(imageModelRowSource, /imageModelUnavailable/);
});

test("the Composer model rows use the provider binding for vision badges", () => {
  assert.match(composerSource, /composerModelBadges\(model, provider\)/);
});

test("capability overrides reach the transport modality arrays", () => {
  assert.match(capabilitiesSource, /function modalityOverride\(/);
  assert.match(capabilitiesSource, /nextInput\.add\("image"\)/);
  assert.match(capabilitiesSource, /nextInput\.add\("pdf"\)/);
  // Text input can never be dropped by an attachment override.
  assert.match(capabilitiesSource, /nextInput\.add\("text"\)/);
  // The adapter subset carries only blocks pi-ai can encode.
  assert.match(capabilitiesSource, /modality === "text" \|\| modality === "image"/);
  assert.match(catalogSource, /export function bindingSupportsImages\(/);
  assert.match(catalogSource, /export function bindingSupportsDocuments\(/);
});

test("the capability controls and default selector are styled", () => {
  assert.match(styles, /\.provider-chosen-capability-rows \{/);
  assert.match(styles, /\.provider-chosen-capability \{/);
  assert.match(styles, /\.provider-chosen-thinking-select \.settings-menu-select-trigger \{/);
  assert.match(styles, /\.provider-chosen-thinking-select \.settings-menu-select-trigger:focus-visible \{/);
});

test("selected thinking chips keep high contrast in both themes", () => {
  const selectedRule = styles.match(
    /\.provider-thinking-chip\.selected \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(selectedRule);
  assert.match(selectedRule, /background: var\(--ds-accent\)/);
  assert.match(selectedRule, /color: var\(--ds-on-accent, var\(--ds-bg-primary\)\)/);
});

test("thinking levels use a compact accessible grouped control", () => {
  assert.match(
    advancedSource,
    /className="provider-advanced-heading">[\s\S]*?thinkingManualOverrideHint[\s\S]*?<\/span>\s*<div\s+className="provider-chosen-thinking-chips"\s+role="group"/,
  );
  assert.match(styles, /\.provider-advanced-heading \{/);
  assert.match(
    styles,
    /\.provider-chosen-thinking-chips \{[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;/,
  );
  assert.match(
    styles,
    /\.provider-chosen-thinking-chips \{[\s\S]*?grid-template-columns: repeat\(7, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    styles,
    /\.provider-thinking-chip \{[\s\S]*?border: 0;[\s\S]*?transition:/,
  );
  assert.match(
    styles,
    /\.provider-thinking-chip:focus-visible \{[\s\S]*?outline:/,
  );
});

test("a configured model keeps its published record when discovery omits it", () => {
  // The checkboxes read models.dev through this record. The live branch used to
  // return only what the endpoint listed, so a configured model the service no
  // longer advertises lost its capabilities and both boxes read as unpublished.
  assert.match(mainSource, /const withConfiguredBindings =/);
  const unions = mainSource.match(/withConfiguredBindings\(/g) ?? [];
  assert.ok(unions.length >= 3, `expected 3+ union sites, saw ${unions.length}`);
  // Discovery stays the authority on what the service offers: only the rows it
  // returned are cached as discovered.
  const liveReturn = mainSource.slice(
    mainSource.indexOf("await cacheForCurrentProvider(models, outcome.complete);"),
  );
  assert.match(liveReturn.slice(0, 260), /models: withConfiguredBindings\(models\)/);
});

test("the published record is not shaped by the stored override", () => {
  // ModelInfo.modalities is the baseline the panel compares against. Applying
  // the binding to it would make an override its own justification.
  assert.match(
    mainSource,
    /modalities: operationMetadata\?\.modalities \?\? catalogModelConfig\.modalities \?\? \{ input: \["text"\], output: \["text"\] \}/,
  );
  const decorate = mainSource.slice(
    mainSource.indexOf("const decorate ="),
    mainSource.indexOf("const withConfiguredBindings"),
  );
  assert.doesNotMatch(decorate, /reasoning: capabilities\.supportsReasoning/);
  assert.doesNotMatch(
    decorate,
    /supportedThinkingLevels: \[\.\.\.capabilities\.supportedThinkingLevels\]/,
  );
});

test("every image gate reads the override-shaped model config", () => {
  // Five independent reads used to answer "can this model see an image": the two
  // enrichment helpers, the sidecar launch params, the prompt transport gate and
  // history replay. A raw input.includes("image") on any of them would disagree
  // with the settings switch for exactly the models the override exists for.
  assert.doesNotMatch(mainSource, /modelConfig\?\.input\.includes\("image"\)/);
  assert.doesNotMatch(sidecarSource, /modelConfig\?\.input\.includes\("image"\)/);
  const gates = mainSource.match(/visionFromModelConfig\(/g) ?? [];
  assert.ok(gates.length >= 4, `expected 4+ vision gates, saw ${gates.length}`);
  assert.match(sidecarSource, /visionFromModelConfig\(params\.provider\.modelConfig\)/);
});

test("a model the catalog does not describe still reports its binding overrides", () => {
  // Both enrichment helpers use the same catalog-or-generic resolver and then
  // apply the binding, matching the launch path; returning undefined instead
  // would report no image support for a hand-typed id whose transport does
  // inline images.
  const providerBlock = providerCatalogSource.slice(
    providerCatalogSource.indexOf("const enrichProvider ="),
    providerCatalogSource.indexOf("const normalizeThinkingLevel ="),
  );
  const sessionBlock = providerCatalogSource.slice(
    providerCatalogSource.indexOf("const enrichSession ="),
    providerCatalogSource.indexOf(
      "\n  return {\n    bindingForModel",
      providerCatalogSource.indexOf("const enrichSession ="),
    ),
  );
  for (const block of [providerBlock, sessionBlock]) {
    assert.match(block, /effectiveConfigWithBinding\(/);
    assert.match(block, /catalogModelConfigFor\(modelsDevCatalog/);
    assert.match(block, /providerId: provider.id/);
  }
  assert.match(providerCatalogSource, /resolveBindingLimits\(catalogConfig, binding\)/);
  assert.match(providerCatalogSource, /const effectiveConfigWithBinding[\s\S]*?resolveBindingLimits\(config, binding\)[\s\S]*?modelConfigWithBinding\(limits.catalogConfig, limits.binding\)/);
});

test("the advanced body is a compact sheet without helper paragraphs", () => {
  // The generic Field + hint paragraph made the disclosure a stacked form dump
  // The alias hint stays beside its compact label.
  assert.match(advancedSource, /className="provider-chosen-field"/);
  assert.match(advancedSource, /<HelpIcon label=\{t\("settings\.modelAliasHint"\)\} \/>/);
  assert.doesNotMatch(advancedSource, /hint=\{t\("settings\.modelAliasHint"\)\}/);
  assert.match(pickerSource, /aria-controls=\{advancedId\}/);
  // Every row starts folded so chosen models stay scannable (D625).
  assert.match(pickerSource, /useState<string \| null>\(null\)/);
  assert.doesNotMatch(pickerSource, /models\[0\]\?\.id \?\? null/);
  assert.match(
    advancedSource,
    /className="provider-chosen-limits"[\s\S]*?className="provider-chosen-thinking-chips"[\s\S]*?className="provider-advanced-options"[\s\S]*?settings\.defaultThinkingLevel[\s\S]*?settings\.thinkingProtocol[\s\S]*?<ReasoningEffortSelect[\s\S]*?className="provider-chosen-capability-rows"/,
  );
  assert.doesNotMatch(advancedSource, /<input\s+type="checkbox"/);
  assert.match(styles, /\.provider-advanced-options \{\s*display: grid;/);
  assert.match(styles, /\.provider-chosen-capability-rows \{\s*display: grid;/);
  assert.match(styles, /\.provider-chosen-field \{/);
  assert.match(styles, /\.provider-chosen-row-body\[hidden\] \{/);
  assert.match(
    styles,
    /\.provider-chosen-advanced-toggle\[aria-expanded="true"\]/,
  );
  assert.match(
    styles,
    /input\[type="number"\]::-webkit-inner-spin-button/,
  );
});

test("the offered default and the saved default use one order", () => {
  // The panel lists enabled levels in canonical order; the save path must fall
  // back to the same first entry, or the user is shown one default and another
  // is persisted for a binding whose levels were toggled out of order.
  assert.match(
    pickerSource,
    /const thinkingLevels = sortThinkingLevels\(binding\.thinkingLevels\)/,
  );
  assert.match(pickerSource, /const enabled = thinkingLevels/);
  assert.match(
    pickerSource,
    /resolveBindingDefaultThinkingLevel\(\s*binding\.defaultThinkingLevel,\s*enabled,/,
  );
  assert.match(
    advancedSource,
    /resolveBindingDefaultThinkingLevel\(\s*binding\.defaultThinkingLevel,\s*sortThinkingLevels\(next\),/,
  );
});

test("model settings let the user allow Fast mode per model on Responses wires", () => {
  // ADR 0334: the opt-in lives on the binding; `/fast` is the per-session switch.
  assert.match(pickerSource, /const fastModeBilling = fastModeBillingOn\(apiStyle\);/);
  assert.match(advancedSource, /checked=\{binding\.fastModeAllowed === true\}/);
  assert.match(advancedSource, /disabled=\{!fastModeBilling\}/);
  assert.match(advancedSource, /fastModeAllowed: event\.target\.checked \|\| undefined/);
  // Plan limits and per-token billing are different costs, so the hint differs.
  assert.match(pickerSource, /"settings\.fastModeAllowedSubscriptionHint"/);
  assert.match(pickerSource, /"settings\.fastModeAllowedUsageHint"/);
  assert.match(pickerSource, /"settings\.fastModeAllowedUnsupported"/);
});

test("Google retains its thinking, audio, video and native search controls", () => {
  assert.match(advancedSource, /const googleGenerativeAi = apiStyle === "google_generative_ai"/);
  assert.match(advancedSource, /\{googleGenerativeAi \? \([\s\S]*?settings\.googleThinkingHint[\s\S]*?\) : \(\s*<SettingsMenuSelect/);
  assert.match(advancedSource, /const showVideoInput = !apiStyle \|\| apiStyle === "chat_completions" \|\| googleGenerativeAi/);
  assert.match(advancedSource, /\{showVideoInput \? \(\s*<CapabilityToggle[\s\S]*?supportsVideo: next/);
  assert.match(advancedSource, /\{googleGenerativeAi \? \(\s*<CapabilityToggle[\s\S]*?supportsAudio: next/);
  assert.match(advancedSource, /\{showVideoInput && binding\.supportsVideo === true \? \([\s\S]*?value=\{binding\.videoTransport \?\? "base64"\}\s*disabled=\{busy\}[\s\S]*?videoTransport: value as VideoTransport/);
  assert.match(advancedSource, /\.\.\.\(googleGenerativeAi \? \[\] : \[\s*\{ id: "provider-file"/);
  assert.match(pickerSource, /nativeWebSearchSupportedOn\(apiStyle, lookupContext\?\.baseUrl\)/);
  assert.match(advancedSource, /googleGenerativeAi\s*\? "settings\.nativeWebSearchGoogleHint"/);
  assert.match(advancedSource, /disabled=\{!nativeWebSearchWireCapable\}/);
});
