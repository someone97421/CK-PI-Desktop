---
name: visualize
description: "Create interactive visualizations directly in the conversation. Use to show how something works; explore 'what happens when', 'what changes', or 'help me understand'; compare or inspect; create simulations, charts, graphs, diagrams, and UI previews. Use standard tools for static scientific figures."
---

<!-- Adapted from the ZCode visualize skill (Apache-2.0); see resources/gen-ui/NOTICE.md. -->

# Visualize

- A request for a new standalone file, website, app page, component, or other
  project change is not an in-conversation visualization, even when it
  contains charts or interactive content. Build that in the project instead.
- Create a visual only when the user needs to see or explore it in the
  conversation and it materially improves the explanation.
- Use a normal Markdown table when the user asks for a table. Use a fenced
  Mermaid block when labeled nodes and edges fully explain a static structure.
  Use a visualization for dynamics, motion, adjustable inputs, spatial layout,
  and data worth hovering or filtering.
- Follow the session's existing progress communication rules. In the final
  reply, explain what the visualization helps the user understand or decide.

Read this skill in full before creating or updating a visualization.
After compaction, reload it when visualization work continues.

## Output contract

### File

- Write `<title>.html` with a concise lowercase-hyphenated ASCII title into
  the **visualization directory named in the system prompt**, using its
  absolute path. Files must sit directly in that directory. If no
  visualization directory is listed, or you cannot write files there,
  inline visualizations are unavailable: answer without one.
- Never write inline fragments into the project or a temp directory.

### Fragment

- Write only an HTML fragment: no `<!doctype>`, `<html>`, `<head>`, or
  `<body>`. The host supplies the document, the stylesheet below, and the
  runtime.
- Write literal markup with real newlines, never an escaped string
  (`<div class=\"card\">`, `\n`). Read the file back if unsure.
- Give the fragment root a unique ID and select it with
  `document.getElementById(...)`; never derive it from `document.currentScript`.
- Keep it under 1 MB: aggregate, bin, downsample, or drop unused fields from
  large inline datasets.
- Check that the script has no undefined identifiers, every queried element
  exists, and the primary interaction updates the visual. Review with the
  Read tool; do not run shell commands to check the file.

### Reference in the reply

Put any short explanation in the reply, then the reference as the last line of
the reply, as plain text. The line looks like this (with real values):

::visualize{"path":"<absolute-path>/<title>.html","title":"<short title>"}

- Emit the literal ASCII prefix `::visualize` followed by a JSON object; do
  not put it in a code block, backticks, or a link. Write the path with
  forward slashes (`C:/Users/...` on Windows).
- Whenever you create or update a visualization, reference it again in that
  turn's final reply, even when editing an existing file.
- Do not repeat the visual's data as a table; add at most one short
  conclusion.

### Sandbox

- There is no network: `fetch`, XHR, WebSocket, remote scripts, fonts, images,
  and map data are all blocked and fail silently. Draw with inline SVG or
  `<canvas>`; embed small assets as `data:` URIs.
- Bundled libraries are available offline through these exact URLs. Keep them
  unchanged; any other URL or version is blocked:
  - D3 7.9.0: `<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>`.
    D3 is not preloaded: a fragment that calls `d3` must include this tag
    before its own script.
  - Floating UI is already loaded by the runtime for tooltips; do not load it
    again.
- No popups, alerts, navigation, external links, form submission, cookies,
  or `localStorage`. Keep state in script variables; it resets when the card
  reloads.
- The card starts at 240px and follows content height up to 2000px. The same
  fragment also opens in a larger expanded view.

## Color and type

- Make every fill, stroke, text, border, and canvas color theme-aware. The
  host follows the app's light or dark theme; never hard-code white panels,
  black text, or Tailwind color literals.
- Theme variables: `--background`, `--foreground`, `--card`,
  `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`,
  `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`,
  `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`,
  `--border`, `--input`, `--ring`, and hues `--blue`, `--orange`, `--green`,
  `--red`, `--purple`, `--yellow`. Use `currentColor` inside SVG.
- In each pair the base token is a surface and `-foreground` is the content
  on it. `--muted` is a fill; use `--muted-foreground` for secondary text.
- Use `--viz-series-1` for a single measure or active state, and
  `--viz-series-2` … `--viz-series-6` only for persistent category or series
  identity. Keep mappings stable and pair color with labels or shapes. Keep
  values and labels in `--foreground` / `--muted-foreground`.
- Keep grids and inactive structure thin (1–2px) and neutral. Never outline
  bars, progress tracks, or stacked segments.
- For canvas or chart APIs that cannot read CSS variables, resolve them with
  `getComputedStyle(document.documentElement).getPropertyValue(...)` and redraw
  when the root's `style` attribute changes (`MutationObserver`).
- Type scales from `--font-size-base` (14px); `.text-small` is 12px. Never go
  below 11px, never set custom font sizes or line heights, and use only
  `var(--font-weight-normal)` and `var(--font-weight-medium)`. Use `.tabular-nums` on changing numbers.
- Use at most one concise visible heading (`h1`–`h3`) for a self-contained
  chart; do not restate the prompt.

## Composition

Choose the smallest composition that fits.

- Prefer interaction detail over permanent panels, toolbars, repeated
  legends, or long stacks. Add only requested controls; never invent search,
  filter, or reset controls, or qualitative score and status cards.
- Put live values in control labels or on the visual.
- **Explainer or simulation:** compact controls, one dominant visual, at most
  one single-line selected-state detail. For step-throughs, add only step
  controls and update one current visual.
- **Graphs and plots:** use D3 for data-rich Cartesian or statistical plots
  and handwritten SVG for simple, directly labeled values.
- **Dense categorical grid:** one compact selected-item summary, a grid with
  one readable identifier per cell, one small legend.
- **Part-to-whole over time:** one stacked chart of category allocation per
  period.
- **Maps:** the sandbox cannot download geometry. Draw a map only from
  coordinates or small geometry you embed yourself; otherwise choose another
  form.
- **UI mockups:** match the product's own chrome, colors, and type. Do not use
  the visualization utility classes or variables inside the mocked product;
  define root-scoped product styles with `light-dark(<light>, <dark>)`. Give
  product surfaces opaque backgrounds and keep the surrounding area
  transparent. Show realistic states, not filler dashboards.

## Layout

- Keep the top-level surface transparent and unframed, and fill the available
  width. Design for about 700px and support widths down to 320px; stack
  side-by-side content when it no longer fits.
- Text, controls, and dynamic content must fit at every width without overlap
  or clipping. The host sizes the frame to content, so never use fixed outer
  widths, horizontal overflow, internal scrolling, `position: fixed`, or
  viewport-height layouts. Use `.table-responsive` only when table columns
  cannot fit.
- Size every SVG from its actual container: set its `viewBox` from the
  container's measured width and redraw with `ResizeObserver`. Never scale
  down a fixed-width `viewBox`; at narrow widths reduce ticks and annotations
  instead.

## Utility classes

Let the utilities own geometry, appearance, and interaction. Never restyle
them: no custom sizes, spacing, borders, radii, shadows, or colors.

- **Surfaces:** `.card` is the only card-like surface — use it for a necessary
  numeric summary, a selected-item summary, or a bounded interactive field.
  Never nest cards or frame charts, maps, tables, or the whole visual.
  `.viz-stat` + `.viz-stat-value` inside a card for one metric.
- **Layout:** `.viz-grid` (equal columns that stack when narrow; 2–3 columns at
  700px), `.viz-row` (wrapping inline group), `.viz-controls` (wrapping row of
  controls for one visual), `<hr>` separator.
- **Controls:** `.btn`, `.btn-primary` (one main action per group),
  `.btn-ghost`, `.btn-block`; `.form-label`, `.form-control`, `.form-select`,
  `.form-range` (show the current value and units right before it),
  `.form-check` / `.form-switch` around a native checkbox,
  `.form-control-color`. Use native `button`, `input`, `select`, `textarea`;
  never recreate controls or add `tabindex`.
- **Tabs:** `.nav.nav-pills[role="tablist"]` with `aria-label`, holding
  `button.nav-link[role="tab"]` with a unique `id`, `type="button"`,
  `aria-controls`, and `aria-selected`; mark the initial tab `.active`. Each
  `[role="tabpanel"]` has the matching `id`, `aria-labelledby`, and `hidden`
  when inactive. The runtime wires the behavior.
- **Data:** `.table` (add `.table-sm` for more rows; `.text-end`,
  `.text-center`, `.text-nowrap` in cells), `.progress` + `.progress-bar` with
  `role="progressbar"` and `aria-value*`, `.viz-badge` for a display-only
  status pill, `.viz-tile` on a selectable dense-grid `.btn`.
- **Text:** `.text-small`, `.text-muted` (never for essential values),
  `.text-destructive` (errors only), `<code>`, `.sr-only`.
- **Tooltips:** `data-tooltip="…"` on any focusable trigger or SVG mark,
  optionally `data-tooltip-placement="top|right|bottom|left"`. The runtime
  handles hover, focus, and touch. Never use `title` or custom tooltip markup
  for these.
- Use `.cursor-interaction` on custom interactive elements instead of
  `cursor: pointer`.

## Charts

- Give every axis a title with quantity and units, reserve at least 64px for
  the y axis, and label important values directly. Add a legend only when
  series cannot be labeled directly.
- Derive padded domains from all observations (`d3.extent`); never hard-code
  them. Keep marks inside the plot frame.
- After drawing, keep tick, axis, and value labels from overlapping: leave
  about 4px between labels, anchor edge labels inward, and drop optional
  annotations first. At 360px show at most four x ticks.
- Use one tooltip per chart, attached to real marks with `data-tooltip`
  (label, value, units). Give isolated marks hit targets at least 32px across.
- Animate transitions between chart states, not the initial appearance; never
  loop motion, and honor `prefers-reduced-motion`.
- Scope SVG styles to the chart's class.

## Accessibility

- Use semantic HTML, keyboard-accessible controls, and concise labels.
- Give every chart, SVG, and canvas a screen-reader summary (`<title>` /
  `<desc>`, `aria-label`, or an `.sr-only` description).
- Use `aria-live="polite"` for dynamic results and `role="alert"` for
  validation errors; do not announce every hover or frame.
- Keep essential content and actions available without hover, and keep
  browser focus styles.
- Keep visible text in the user's language.
