---
name: office-desktop
description: Windows GUI steps for Microsoft Excel/Word/PowerPoint and WPS 表格/文字/演示 via computer-use. Use when the file is already open on the desktop or the user asked to operate Office/WPS in the GUI. Keys and Go To first; no blind Alt sequences; untested WPS shortcuts are not guarantees.
---

# Office desktop GUI

Uses `computer-use` on Windows. Follow that skill: **fresh AX**, **one action per call**, **no replay**, **keys first**, **physical Esc stops** (injected `press_key` Escape does not). `delivery=sent` is not goal completion; `partial`/`unknown` is not a retry.

Desktop Stop/physical Esc stops GUI automation. After a user interruption, do not start new mutations until their intent to continue is clear, and inspect the document before claiming a write was cancelled.

WPS shares some Windows chords with Microsoft Office; **do not treat untested WPS shortcuts as guaranteed**. Safe common set until observed on *this* machine: `Control_L+s`, `paste_text` (not a paste chord), `Control_L+z`, arrows, `F2`, `Return`, `Escape`, `Tab`. Everything else: `get_app_state`, then a named control or a verified chord.

No blind Alt / ribbon keytip sequences (`Alt, H, …`). Locales, versions and WPS vs Office disagree. Open a menu only by observing a named `MenuItem`/`Button`/`TabItem` and clicking that fresh `element_index`, or by a shortcut already proven in this session.

## Shared loop

1. `list_apps` / `launch_app` / known `window_id`. One `get_app_state`.
2. Focus the document surface once if needed. Then keys — no screenshot between known navigation keys. While a dialog/menu owns focus, keep that focus; do not activate the document behind it.
3. One action. Read `action_result`. Do not replay. A successful input transport is not proof that the command ran.
4. Verify with a **read-only** observation (`include_screenshot=false, refresh=true` for AX; screenshot/crop when the grid/canvas has no cell text). After Go To, Save, Open, or Slide Show, use `list_windows` to find a new window before concluding the command failed. A main-window screenshot may omit an owned popup. A save panel may appear only in the main window's AX tree: inspect it there and use its fresh named controls, not guessed pixel positions.
   If UIA times out, use the returned screenshot-only fallback or request `include_tree=false`; do not repeatedly lower depth and traverse the same stalled provider. Tree absence does not mean dialog absence.
5. Save: `press_key` `Control_L+s` (Windows). Do not `type_text` the word Save.

Pixel `x,y` last. Do not Tab across a grid just to read truncated labels.

On Office startup screens, `Control_L+n` may open a template page instead of creating a document. Observe and choose the named blank template before pasting. Add-in task panes can own keyboard focus in another process (observed with Excel OfficePLUS); `focus_mismatch` means no input was sent. Observe and reselect the document or close the visible add-in pane, then verify focus before continuing. Do not disable the PID guard or treat app foreground alone as document focus.

## Spreadsheet (Excel / WPS 表格)

**Go To, then verify, then edit.** Never click around for `D18`.

Name Box (left of the formula bar) or Go To:

1. Focus the workbook.
2. `press_key` `Control_L+g` (Excel Go To / F5). Observe and check `list_windows` for the Go To dialog, then target that window ID. Only if no dialog opened, use the observed Name Box `Edit` — do not assume WPS bound Ctrl+G.
3. `type_text` or `paste_text` a range (`B2:B20`, `Sheet1!A1:D10`). Confirm with `Return`.
4. **Verify** selection: Name Box text, or a crop of the highlighted range. If verification fails, stop; do not type into the wrong cell.
5. Then `F2` (edit), `paste_text`, or type a formula. `Return` confirms (Excel moves down); `Control_L+Return` stays. `Escape` cancels edit — then observe; an accepted Escape does not prove editing ended.

Other supported **Microsoft Excel** chords (not promised on WPS until seen): `Control_L+1` Format Cells, `Control_L+Shift+l` Filter, `F9` recalc, `Control_L+d` fill down. For Show Formulas, Table, sheet switching, freeze panes, print area and Name Manager, observe and use the named ribbon control or sheet tab. The native Office route deliberately rejects unknown chords with `unsupported_key_chord`; use an observed control rather than retrying through another transport.

`Delete` **clears a cell**. It does not delete a sheet row. Insert/delete rows or columns only from an observed control or a shortcut just verified; those change structure — see `office-workflows`.

Formulas: after landing on the cell, enter `=SUM(D2:D50)` and confirm, then inspect the formula bar and expected result. Change inputs to probe recalculation only on a disposable test copy, never on the user's source data just to verify a formula.

## Word (Word / WPS 文字)

Styles first, not local font clicks.

- Microsoft Word headings: `Control_L+Alt+1` / `2` / `3` are well-known Heading 1/2/3. **WPS 文字: not guaranteed** — open the observed Styles gallery and click the named style.
- Word Normal: `Control_L+Shift+n` (do not send on WPS unless observed).
- Page break (Word): `Control_L+Return`. Section break / TOC / page orientation: References or Layout **named controls** after a fresh tree. Never Alt ribbon walks.
- Update fields (Word): select the TOC, `F9`. Confirm the update dialog if it appears. Do not `Control_L+a` then F9 on a dirty mixed document unless the user asked for a full-field update.
- Save `Control_L+s`. Find `Control_L+f` is common; still verify the find box appeared.
- Select title text with `Control_L+Home`, then `Shift+End`; `Shift` + arrows/Home/End and `Control_L+Shift` + arrows/Home/End preserve selection modifiers. Paragraph styles can be applied with the caret in the paragraph; avoid repeated clicks just to select it.
- A small black square beside a Word heading can be a nonprinting paragraph pagination mark. Check paragraph formatting before treating it as a bullet or deleting content.

Verify: Navigation pane / heading list if visible in AX or screenshot; TOC looks like a field (updates), not typed numbers.

## Slides (PowerPoint / WPS 演示)

- Microsoft PowerPoint: select the **slide thumbnail** before `Control_L+m` (new slide) or `Control_L+d` (duplicate). In text/shape focus these commands may affect a different context. Verify the selected thumbnail and slide count. For a context menu, prefer the fresh named “Duplicate Slide / 复制幻灯片” control with `delivery_mode=background` so UIA can invoke it without activating the owner. Do not derive keyboard offsets from AX order or invent mnemonic letters. **WPS 演示: observe first.**
- `F5` starts from the beginning; `Shift+F5` starts from the current slide. Discover and target the new slide-show HWND. After Escape, verify that HWND disappeared and the editing window returned. A post-click foreground change may be the intended new slide-show window, not evidence that the click failed.
- Title/body: click the observed placeholder once, then `paste_text`. Do not pixel-hunt empty canvas if placeholders are in the tree.
- **Master / theme / layout**: View → Slide Master (or equivalent) as an **observed** `MenuItem`/`Button`. Select the master thumbnail, then the control to change. Never a memorized Alt sequence. Exit master by an observed Close Master / `Escape`, then verify you are back on the deck.
- Charts: Insert → Chart as observed; edit the tiny data grid with Go To / keys, not by drawing shapes that look like bars.
- `Escape` exits slide show or a pane only after observation says so.

## Save and reopen

1. Send `Control_L+s` once. Check new windows and the current window's AX tree for “Save this file / 保存此文件”. `F12` or `Control_L+Shift+s` may request Save As, but observe the current panel before sending another command.
2. Prefer the fresh named “More options / 更多选项…” control with `delivery_mode=background` to choose a local folder, then inspect the standard Save As dialog. If using the inline panel, target its explicit “File name / 文件名” Edit with `set_value`; do not blindly send Ctrl+A and a path while the document may still own focus. Named UIA actions avoid foreground pixel clicks on a main window that does not include the owned panel.
3. Use the latest observation with `snapshot_actionable=true`, including a fresh post-action or query observation. Only its displayed indices are usable. Otherwise refresh first; swapping between set_value/type_text/secondary_action cannot revive an old index. An incomplete tree can expose exact snapshot-bound controls but cannot prove that another dialog or editor is absent. Do not bypass a refusal with unobserved coordinates.
4. Verify file name, full destination and file type before the named Save action. Handle overwrite prompts only for a path the user authorized. Confirm the saved document title and actual file, then reopen and inspect content before marking save/reopen passed.
5. For exact filename read-back, use the observed `automation_id` and `role=Edit` if available (the tested standard dialog exposed `1001`; discover it, do not assume it). Otherwise use the exact Name including punctuation: the standard dialog's `文件名:` differs from the inline panel's `文件名`. `no_match` means the independent UIA search found no matching control, not that the write failed; never substitute the label or cached tree value as a successful native read.
6. Close only the authorized document after saving: `Control_L+w` closes the current Office document and `Alt+F4` closes its window; inspect any save prompt rather than assuming it was dismissed. If a post-click foreground check fails, inspect `target_window_closed` evidence or list windows once before doing anything else. A vanished HWND does not prove that changes were saved. If reopening via Explorer is blocked by another foreground window, use Office's observed recent-file entry instead of repeating Enter or launching a system Run dialog.

## File handoff

Before another application writes the same path, **save and close** the document or write a **copy**. Do not overwrite a workbook the GUI still has open.

For authorized test-file cleanup in Explorer, a file ListItem's `Invoke` opens the document; it is not selection. If the file is already visibly selected, use the fresh named Delete toolbar command. Otherwise select via a verified single-click on an observed non-invoking row area or keyboard navigation, then verify selection. Do not use `click(element_index)`/`Invoke` on a file expecting it only to select. If “File in use” appears, cancel that delete operation, close only the authorized test document, refresh the folder, and start a new verified delete; do not leave a pending retry.

`perform_secondary_action(action="Select")` is unsupported by the current driver and returns `unsupported_secondary_action` with `delivery=not_sent`; an advertised UIA pattern does not imply the driver exposes an action for it. Do not retry it as Invoke or element click. Use verified keyboard navigation or a screenshot-grounded single click to select, then confirm selection before Delete.

Explorer's “1 item selected” status proves selection, not keyboard focus: the address bar or search box can still own focus. Prefer the fresh named Delete toolbar button for authorized cleanup. Use the Delete key only after verifying focus is in the file list. `press_key` must preserve the current focus for Delete/Backspace; it must not search for an Edit control. If the address-bar suggestions appear and the file remains, inspect the state and use the observed Delete command rather than replaying the key.

After Cancel or Close dismisses a dialog, use a fresh `list_windows` result to check whether its HWND still exists, then observe the surviving owner window. Do not keep `wait_for text_absent` attached to a dismissed dialog. A timeout with `capture_failed` or “No window ... exists” is not a successful text-absence check; confirm closure with an independent successful window listing. Refresh the target document before using any earlier control index after switching between Explorer and Office.

## Acceptance (GUI)

Same split as `office-workflows`: structure (formula bar shows `=…`, style name, slide title) vs look (one crop). Physical Esc on the banner stops the runtime — do not continue GUI actions until the user starts Computer Use again.
