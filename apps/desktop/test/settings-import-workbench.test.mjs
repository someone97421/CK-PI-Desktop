import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("inline import disclosure exposes state and forwards the user's toggle", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  try {
    const { ImportToggleButton } = await server.ssrLoadModule(
      "/src/features/settings/import-workbench.tsx",
    );
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { translation: catalogs.en } },
    });
    let toggles = 0;
    const props = {
      open: false,
      controls: "agent-skills-import-panel",
      label: "Scan other tools",
      onClick: () => { toggles += 1; },
    };
    const render = (open) => renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ImportToggleButton, { ...props, open }),
      ),
    );

    assert.match(render(false), /aria-expanded="false"/);
    assert.match(render(false), /aria-controls="agent-skills-import-panel"/);
    assert.match(render(true), /aria-expanded="true"/);
    assert.match(render(true), />Scan other tools<\/button>/);

    const button = ImportToggleButton(props);
    button.props.onClick();
    assert.equal(toggles, 1, "activating the disclosure reaches the owning page");
  } finally {
    await server.close();
  }
});
