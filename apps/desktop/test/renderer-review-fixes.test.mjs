import { readAppSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(here, path), "utf8");
const app = readAppSourceSync();
const rendererApi = read("../src/capture/renderer-api.ts");
const captureRig = read("../src/capture/capture-rig.ts");
const main = read("../src/main.tsx");
const windowControls = read("../src/components/WindowControls.tsx");
const pulls = read("../src/pages/PullRequestsPage.tsx");
const messages = read("../src/styles/messages.css");

test("screenshot fixtures stay out of the production App bundle", () => {
  // App only mounts the tiny automation surface; the fixtures are a separate
  // module reached through a dynamic import.
  assert.match(app, /useEffect\(\(\) => installRendererApi\(\), \[\]\);/);
  assert.doesNotMatch(app, /__PI_CAPTURE__|seedTranscript|ensureVisualFixtures|\(api as any\)/);
  assert.match(rendererApi, /import\("\.\/capture-rig"\)/);
  assert.match(rendererApi, /^import type \{[^}]*\} from "\.\/capture-rig";/m);
  assert.doesNotMatch(rendererApi, /^import \{[^}]*\} from "\.\/capture-rig";/m);
  // The e2e runner and capture suite reach these without any flag set.
  for (const name of [
    "setPage",
    "selectSession",
    "setSettingsTab",
    "showToast",
    "clearProject",
    "setThemeAttr",
    "refreshProviders",
  ]) {
    assert.match(rendererApi, new RegExp(`^    ${name}: `, "m"), name);
  }
  // Fixture stubs refuse to load the rig unless the capture flag is set, and
  // every fixture in the rig re-checks it before touching state.
  assert.match(rendererApi, /if \(!window\.__PI_CAPTURE__\) return undefined;/);
  const guards = captureRig.match(/if \(!window\.__PI_CAPTURE__\) return/g) ?? [];
  const fixtures = captureRig.match(/^    (?:seed\w+|ensureVisualFixtures|openWorkPanel\w*|collapseWorkPanel): /gm) ?? [];
  assert.ok(fixtures.length >= 13, `expected the fixture methods, saw ${fixtures.length}`);
  assert.ok(guards.length >= fixtures.length, "every fixture checks __PI_CAPTURE__");
  // Restoring the monkey-patched api.* calls is part of tearing the rig down.
  assert.match(captureRig, /dispose: \(\) => \{[\s\S]*api\.listPluginServices = originalListPluginServices;/);
});

test("the crash fallback never interprets the error as markup", () => {
  assert.doesNotMatch(main, /innerHTML/);
  assert.match(main, /detail\.textContent = String\(error\);/);
  assert.match(main, /heading\.textContent = crashCatalog\.app\.uiCrashed;/);
});

test("window controls draw through the icon wrappers", () => {
  assert.doesNotMatch(windowControls, /from "lucide-react"/);
  assert.match(windowControls, /import \{ IconClose, IconCopy, IconMinus, IconSquare \} from "\.\/icons";/);
});

test("pull request links open through the shared external-open path", () => {
  assert.doesNotMatch(pulls, /window\.open\(/);
  assert.match(pulls, /api\.browserOpenExternal\(pr\.url\)/);
});

test("message image chips carry no tile or stroke of their own (D297)", () => {
  const start = messages.indexOf(".message-attachment-image-chip {");
  assert.notEqual(start, -1, "message image chip rule is missing");
  const block = messages.slice(start, messages.indexOf("}", start));
  // The shared composer chip and the preview card own the surface; the wrapper
  // stays a bare inline layout box.
  assert.doesNotMatch(block, /background:|border|box-shadow/);
  assert.match(block, /display: inline-flex;/);
});

test("a chip inside a message reads at that message's own type scale", () => {
  const start = messages.indexOf(".message-row .composer-chip {");
  assert.notEqual(start, -1, "message chip type rule is missing");
  const block = messages.slice(start, messages.indexOf("}", start));
  // The composer's fixed 11.5px/20px chip is a draft-only box. In a message the
  // tile is sized by the inherited leading and sits on the line, so the label
  // reads on the message's own baseline instead of poking out of a 20px tile.
  assert.match(block, /font: inherit;/);
  assert.match(block, /height: auto;/);
  assert.match(block, /line-height: inherit;/);
  assert.match(block, /vertical-align: top;/);
  assert.doesNotMatch(block, /--text-xs-plus/);
  assert.doesNotMatch(block, /height: 20px/);
});

test("a conversation chip breaks with the line instead of emptying it", () => {
  const selector = '.message-row .composer-chip[data-action="open-session-reference"]';
  const start = messages.indexOf(`${selector} {`);
  assert.notEqual(start, -1, "the conversation chip has no inline-run rule");
  const block = messages.slice(start, messages.indexOf("}", start));
  // Chromium never fragments a `<button>`: as one, a chip that does not fit is
  // pushed whole onto the next line and the line it left keeps its blank. An
  // inline run breaks with the text, so its first line still reaches the edge.
  assert.match(block, /display: inline;/);
  assert.match(block, /white-space: normal;/);
  assert.match(block, /box-decoration-break: clone;/);
  const nameStart = messages.indexOf(`${selector} .composer-chip-name {`);
  assert.notEqual(nameStart, -1, "the label is never told it may break");
  const nameBlock = messages.slice(nameStart, messages.indexOf("}", nameStart));
  assert.match(nameBlock, /overflow-wrap: anywhere;/);
  assert.match(nameBlock, /white-space: normal;/);
  assert.doesNotMatch(nameBlock, /text-overflow: ellipsis;/);
  const iconStart = messages.indexOf(`${selector} .composer-chip-icon {`);
  assert.notEqual(iconStart, -1, "an inline run has no flex gap, so the icon needs its own");
  assert.match(messages.slice(iconStart, messages.indexOf("}", iconStart)), /margin-right:/);
});

test("dead components are gone", () => {
  assert.ok(!existsSync(join(here, "../src/components/Topbar.tsx")));
  assert.ok(!existsSync(join(here, "../src/components/HomeQuickActions.tsx")));
});
