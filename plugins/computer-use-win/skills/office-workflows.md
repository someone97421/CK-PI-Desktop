---
name: office-workflows
description: Knowledge for Excel formulas, data types and structure changes; Word styles, sections and TOC; PowerPoint outline, layout and charts; plus acceptance. Use when planning or reviewing Office/WPS documents. No GUI automation, document runtime or model training required.
---

# Office workflows (knowledge)

What a correct workbook / document / deck **contains**. Does not click the desktop and does not call a file engine.

- Desktop GUI: skill `office-desktop`
- Document engine coverage gaps (unsupported functions, round-trip features) are engine limits, not Excel/Word/PowerPoint limits.

No model training or Office installation is required to use this knowledge skill.

## Excel / WPS 表格 — formulas, types, structure

**Live formulas.** Totals, rates, lookups and tax columns are formulas, not pasted results.

- `=SUM(D2:D50)`, `=E2/$E$1`, table refs `=SUM(Sales[Amount])`. Growing ranges → Table + structured refs, not `A2:A9999` by habit.
- Absolute vs relative: `$B$1` a single rate copied down; `$A2` a row key copied across; `F4` in Excel cycles this while editing.
- `IFERROR` only for real missing keys. Do not hide broken lookups.
- `VLOOKUP` needs the key in the leftmost column. Prefer `XLOOKUP` where the user's Excel version supports it, or `INDEX/MATCH` for older versions. Engine support and Excel-version support are separate checks; VBA, Power Query and pivot features may require desktop Excel.

**Data types** (wrong type is a logic bug, not formatting):

- Numbers as numbers; not `"1,234"` or a leading `'`.
- Dates as date serials with a date format, not `2024/1/1` text.
- Percents as `0.13` + `%` format, not the string `13%`.
- One unit per column; currency in the number format or header, not `¥12` inside the cell.
- Booleans `TRUE/FALSE` when the column is logical; labels (`是/否`) are text.
- No merged cells in data ranges. Filters, sorts and tables break on them.

**Structure changes** (insert/delete/move):

- Before inserting or deleting rows/columns, know what tables, named ranges, charts and formulas reference.
- Unique headers, **one** header row, no blank header cells.
- Split facts: do not store `Beijing / 2024 / Q1` in one cell if you will filter city or year.
- Raw data sheet vs report sheet; do not type narrative into the fact table.

**Example — sales table**

Headers `Date | SKU | Qty | Amount | Taxed` (`Date`=date, `Qty`/`Amount`=number), table `Sales`. Tax rate lives outside the table in `H2` = `0.13` (percent). Column `Taxed` = `=[@Amount]*(1+$H$2)` (blank-safe if needed). Acceptance: inspect formulas and expected results; only on a disposable test copy change `H2` and confirm recalculation.

## Word / WPS 文字 — styles, sections, TOC

- Structure is **styles** (Title, Heading 1/2/3, Normal), not local bold/size on Normal. Restyle the style when a whole level should change.
- **Section breaks** (not extra page breaks) when header/footer, page numbers, columns or orientation must differ — e.g. one landscape table in a portrait doc.
- **TOC is a field** built from heading styles. Typed page numbers are not a TOC. After heading edits, update the field.
- Numbered/bulleted lists use list styles so they renumber. Captions if the user asked for numbered figures.

**Example.** Heading 1 = chapter, Heading 2 = section. TOC after the title page. Landscape appendix = section break, orientation only in that section.

## PowerPoint / WPS 演示 — outline, style, charts, layout

1. Outline: one claim per slide, 3–6 bullets **or** one visual.
2. Layout from the master, not ad-hoc boxes on every slide.
3. Chart from a small category+series grid. A screenshot of a chart is not a chart.
4. Master/theme owns fonts, title position, logo. Same type scale (e.g. title 28–32, body 16–20). No 3D, no 10-series pie, no rainbow palette unless the user specified a brand.

**Example — 3 slides.** (1) Title + subtitle. (2) Three findings. (3) Column chart `Q1–Q4` × `Actual/Plan`, legend on.

## Acceptance

Keep **structure** and **look** as two checks. Opening the file is not success.

| Surface | Structure | Visual |
|---|---|---|
| Excel | Computed cells are formulas; expected values match; recalculation probe only on a test copy; types sort/filter; table/name still valid after insert/delete | Print area, freeze, chart not overlapping data |
| Word | Heading tree exists; TOC is a field; section count/orientation match the plan | Header text, orphan headings, overflow |
| PPT | Slide titles match the outline; chart has a data range; master applied | Alignment, contrast, clipped text |

`partial` / unapplied ops / “looks roughly right” ≠ done.
