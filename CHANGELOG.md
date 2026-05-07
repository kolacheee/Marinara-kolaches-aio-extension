# Changelog

All notable changes to **kolache's AIO Prompt Viewer and Editor** are recorded here.

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
