# Changelog

All notable changes to **kolache's AIO Prompt Viewer and Editor** are recorded here.

## [1.4.0] — 2026-05-15

Lorebook folder support — folders are now first-class objects in the extension, with full CRUD, batch entry assignment, and integrated selection logic.

### Added

- **Folder rows in Sources.** Each lorebook's entry checklist now shows folders at the top, separated by a divider. Each folder row has a checkbox, 📁 icon, name, nested-entry count badge, and a ✏️ pencil button to open the folder in the Inspector.
- **Folder selection cascades to entries.** Checking a folder automatically selects all entries nested inside it (and populates them into the Simulated Prompt). Unchecking deselects them. If an entry is added to or removed from a selected folder, its selection state updates automatically.
- **Create Folder / Create Entry buttons.** A `+ Folder` and `+ Entry` button appear beneath each selected lorebook's checklist. Creating either opens the new item in the Inspector immediately, ready for editing.
- **Folder Inspector.** Clicking a folder's ✏️ button opens it in the Inspector with editable Name, Enabled, and Order fields, a list of currently nested entries (each with a Remove button to unassign), and a batch-add section.
- **Batch add entries to folders.** The folder Inspector includes a checklist of unassigned entries. An "Add selected (N)" button PATCHes all checked entries into the folder in one action. A "Show already nested" toggle reveals entries assigned to other folders — displayed grayed-out and unselectable, with the owning folder's name shown on the right (folder name takes visual precedence over entry name when space is tight).
- **Delete button in Inspector.** A Delete button now appears in the Inspector footer (to the left of Revert) for lorebook entries and folders. Deleting shows a confirmation dialog; for folders, the dialog notes that nested entries will be moved to root level.
- **Folder dropdown for entries.** The entry Inspector's Folder field is now a dropdown populated from the lorebook's folders, replacing the old free-text input.

### Changed

- **Mobile: folder deletion returns to Sources.** After deleting a folder on mobile, the view automatically switches back to the Sources tab instead of leaving the user on an empty Inspector.

## [1.3.0] — 2026-05-13

Mobile and tablet support — the extension is now usable on small screens without sacrificing anything on desktop.

### Added

- **Responsive mobile layout.** On screens ≤ 768px wide, the three-column layout collapses to a single panel with a **Sources / Prompt / Inspector** tab bar at the top. Tap a tab to switch panels. The tab bar is completely hidden on desktop — the existing side-by-side layout is unchanged.
- **Auto-switch to Inspector on block tap.** When you tap a block in the Simulated Prompt panel on mobile, the view automatically switches to the Inspector tab so you can start editing immediately.

### Changed

- **Shell goes fullscreen on mobile.** The dialog drops its border-radius and expands to 100vw × 100vh, giving the most usable space on small screens. The subtitle ("Prompt Viewer & Editor") is hidden in the titlebar to save horizontal room.
- **Block heads wrap gracefully on narrow screens.** The tag pill, block name, and order badge are allowed to wrap instead of squishing together. Block names truncate with ellipsis when space is tight. The role label (e.g. "system") is hidden on mobile since the same info is visible in the Inspector.

## [1.2.1] — 2026-05-08

Inspector UX pass — less scrolling, better discoverability, and a matching-mode selector that mirrors the familiar SillyTavern/Marinara lorebook convention.

### Changed

- **Matching mode is now a 3-state orb selector** instead of two separate checkboxes for Constant and Selective. A row of three pill buttons — ● Normal, ● Selective, ● Constant — color-coded gray / purple / gold to match the convention most users already know from SillyTavern and Marinara's own lorebook panel. The Selective Logic dropdown only appears when Selective mode is active.
- **Reduced inspector verticality.** Tightened field margins, section header spacing, and checkbox gaps across the board. Content and Description textareas default to shorter row counts (6 and 3 respectively) since they're resizable. The net effect is significantly less scrolling to reach the bottom of a lorebook entry.
- **Parenthetical hints removed from all labels.** Labels like "Probability (0–1)" and "Sticky (turns)" are now just "Probability" and "Sticky".
- **Tooltip help icons on field labels.** A small `?` badge next to each label reveals a styled tooltip on hover explaining what the field does, replacing the old parenthetical hints with richer context available on demand. Tooltip positioning is viewport-aware (clamped horizontally, flips below when there isn't room above).

### Fixed

- **Matching mode buttons didn't visually update until Save.** Clicking a mode button updated the draft but didn't re-render the inspector, so all three buttons appeared highlighted until the next full re-render.
- **Save / Revert jumped the inspector to the top.** The right column's scroll position is now preserved across re-renders — clicking Save or Revert keeps you where you were.
- **Tooltip background was semi-transparent on themes with alpha in `--card`.** The tooltip now resolves theme colors at runtime and forces the card background opaque, then appends outside the overlay's `backdrop-filter` stacking context. Works correctly across all themes.

## [1.2.0] — 2026-05-07

A v1.2.0 focused on making the Simulated Prompt column easier to scan at a glance and on catching the kinds of mistakes that silently break a prompt at runtime — orphaned XML tags and malformed `{{macro}}` syntax.

### Added

- **Validate button in the Simulated Prompt header.** Scans every selected source — every preset section, *every* entry in every selected lorebook (regardless of which checkboxes are ticked), the loaded character, and the loaded persona — concatenated in the order Marinara would assemble them.
  - **XML check.** Stack-walks `<tag>` openers and closers across the combined stream so an opener in one entry can match a closer in another. Reports unclosed openers and orphaned closers, attributing each to the source block it lives in. Self-closing tags (`<br/>`), comments (`<!-- … -->`), and processing instructions (`<?…?>`) are skipped. **Backtick-wrapped tags are skipped too** — single-backtick spans (`` `<context>` ``) and triple-backtick fences are treated as referential mentions, not as openers/closers.
  - **Macro check.** Flags any `{…}` shape that isn't exactly `{{name}}` — `{user}}` (1/2 braces), `{{user}` (2/1 braces), `{u{ser}}` (nested `{` inside the macro). Single `{ x }` shapes inside code that contain punctuation (e.g. `{ return y; }`) are deliberately ignored.
  - **Auto-pulls offending entries into view.** If an error lands on a lorebook entry the user hadn't checked, the entry is auto-checked so the highlight is actually visible in the simulation. Errors render as an orange border on the block plus a per-error chip listing the message and the offending snippet. The button itself flips to `⚠ N issues` (or `✓ All clean`) so the count is visible at a glance.

### Changed

- **Compact markers / chat-history / empty blocks.** Markers with no resolved content (`(Resolved at runtime: persona)`, etc.) now fold their hint text into the same row as the tag, name, and role badge instead of reserving a second line for it. The Chat History block does the same for its "(injected at runtime)" hint, and the depth substack still renders below as before. A marker that gets resolved (a Persona is selected, a Character is loaded) reverts to the multi-line layout with its content on the next line, exactly as before.
- **Auto-shrink for short content.** Blocks whose preview is ≤ 3 lines and ≤ 600 characters (e.g. lorebook entries containing only a single XML opener like `<group_chat>`) no longer reserve the bottom padding for the **Expand / Compress** toggle, and no toggle is rendered for them — the body collapses to its actual height. Longer content still gets the toggle and the existing 3-line clamp.
- **Depth ordering inverted in the chat-history substack.** Higher `depth` now renders **higher** in the prompt (further from the most recent message), matching the convention that Depth is opposite to Order. This change applies to both depth-positioned lorebook entries and `injectionPosition: "depth"` preset sections.

### Notes

- Depth-positioned items (`position === 2` for entries, `injectionPosition: "depth"` for sections) continue to live exclusively inside the Chat History block, regardless of where the entry's lorebook or section's preset sits. No behavior change here — just confirming this remains the contract in v1.2.0.

## [1.1.1] — 2026-05-07

### Fixed

- **Character dropdown showed every entry as "Untitled character".** The `/api/characters` and `/api/characters/:id` endpoints return the full CharacterData V2 packed into a JSON-string `data` column, but the extension was reading `c.data.name` as if `data` were already parsed. A new `normalizeCharacter` helper JSON-parses the `data` field on load (and after PATCH), so the dropdown, block titles, character-block previews, and the character editor all see real fields. This also fixes character saves silently writing a malformed `data` payload because the previous get-fresh-then-merge path was merging into a string.
- **Toast had no styles, so it stuck around indefinitely in the bottom-left.** The `.kaio-toast` element existed but no CSS was ever defined for it, which meant `data-visible="false"` did nothing and "Saved ✓" / "Reloaded" / "Reverted" sat on screen forever. The toast is now positioned in the bottom-right of the shell (above the Save/Revert footer), color-coded — green for success, red for errors, blue for info — and fades in/out with a short transform.

## [1.1.0] — 2026-05-07

QoL upgrades focused on making the Simulated Prompt column a more honest preview of what the engine will actually send, and surfacing preset variables where they're useful instead of in a separate editor.

### Added

- **Preset variables panel.** When the inspected block's content references one or more of the loaded preset's variables (`{{varName}}` or `{{getvar::varName}}`), a collapsible **Preset variables** panel appears at the top of the Inspector, listing only the matching variables. Picking an option from a variable's dropdown live-substitutes its value in the Simulated Prompt — substituted text is highlighted with a yellow underline so it's obvious where the substitution landed.
- **Inline variable-value editing.** While an option is selected for preview, its value is exposed in an editable textarea below the dropdown. Edits are reflected in the Simulated Prompt as you type. Save / Revert buttons commit (or roll back) the change via `PATCH /api/prompts/:presetId/variables/:variableId`.
- **Expand / Compress toggle on every block.** A pill button in the bottom-right of each Simulated Prompt block (and each depth-injected sub-block) flips between the default 600-char preview and the full block content. State is per-block.
- **Order badge on lorebook entries.** Every lorebook entry rendered in the Simulated Prompt now shows its `order` as a small blue badge at the top-right, so you can see at a glance which entry is winning the sort.
- **Overlapping-order detection.** If two displayed lorebook entries collide on `order` within the same anchor bucket (and the same `depth`, for depth-injected entries), both blocks render with a red border / red-tinted background and the order badge reads **OVERLAPPING!** in red.

### Changed

- **Section editor now hides Depth / Order for ordered sections.** Those fields only matter for depth-injected sections; for `ordered` sections, sequencing comes from the preset's `sectionOrder` array. Showing the inputs implied they did something they don't, so they're now only rendered when **Position** is set to `depth`. Flipping Position re-renders the inspector immediately.

### Fixed

- **Double-escaping when a variable preview was active.** Long blocks that didn't reference the previewed variable were getting escaped twice, so a literal `<pancakecat>` in the source rendered as the visible text `&lt;pancakecat&gt;`. The preview pipeline now truncates in raw-text space *before* escaping, so escape runs exactly once and entities never get double-encoded.
- **🥞 tab button forced its own cursor.** The button was setting `cursor: pointer`, which overrode Marinara Engine's custom cursor and looked inconsistent next to the rest of the top-right tab strip. Switched to `cursor: inherit` so it picks up the engine's cursor like every other tab.

## [1.0.0] — 2026-05-04

Initial public release.

### Added

- **🥞 console** wired to the top-right tab strip, opening a 3-column overlay (Sources / Simulated Prompt / Inspector).
- **Multi-source pickers.** Single-select dropdowns for Preset, Character, and Persona; multi-lorebook section with one row per active lorebook plus a per-lorebook entry checklist (only the active lorebook expands its checklist, to keep the column compact).
- **Simulated Prompt assembly.** Renders the selected pieces in the exact order the engine would build the prompt: preset sections in `sectionOrder`, lorebook entries placed at `world_info_before` / `world_info_after` / depth markers per the entry's `position` and `order`, character & persona slotted into their respective marker sections, depth-injected entries shown nested inside the chat-history block.
- **Per-block inspector & editor.** Click any block to inspect / edit its source on the right; saves PATCH back through Marinara's API. The lorebook-entry editor exposes every field the engine actually supports (name, content, description, primary/secondary keys, position, depth, order, role, enabled, constant, selective + selective logic, probability, scan depth, match-whole-words, case-sensitive, treat-as-regex, character/tag/trigger filter modes + values, the seven additional matching sources, sticky / cooldown / delay / ephemeral, group + group weight, tag, folder ID, prevent-recursion, locked).
- **Dirty-state guard.** Switching blocks, switching sources, or closing the console while edits are pending fires a Save / Revert / Stay confirmation dialog so unsaved work is never silently lost.
