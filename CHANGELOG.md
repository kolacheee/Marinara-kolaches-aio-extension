# Changelog

All notable changes to **kolache's AIO Prompt Viewer and Editor** are recorded here.

## [1.10.0] — 2026-07-07

Group chat support: build a multi-character group and see how its character section assembles.

### Added

- **Full character editor.** The character editor is now the complete V2 card in collapsible sections — *Metadata*, *Card* (now with **Backstory** and **Appearance**), *Dialogue & greetings* (incl. an add/remove alternate-greetings list), *Lorebook* (link/unlink standalone lorebooks to the character + a read-only embedded-book summary), *Colors* (swatch **color pickers** with a Hex/CSS field that also accepts `rgba()`/gradients/names), *Stats (RPG)* (editable attributes + pools), and *Advanced* (system prompt, post-history instructions, depth prompt) — with Name + Title always on top. Fields under the card's `extensions` (backstory, appearance, talkativeness, colors, stats, depth prompt) are mapped automatically, and everything the editor doesn't show (embedded lorebook, avatar crop, tracker colors, …) is preserved on save. Heavy text fields auto-grow to ~5 lines then offer an Expand toggle. (Sprites and Gallery are image files managed in Marinara, so they're not part of this editor.)
- **Create new sources from scratch.** A **+** button on each Sources header — **Preset**, **Lorebooks**, **Character**, **Persona** — creates a brand-new empty one (via the engine's create endpoints), selects it, and drops you straight into its editor to fill in.
- **Multi-character group picker.** When no chat is open, the **Character** source becomes a group picker — add a row per character (mirroring the multi-lorebook rows), with the first row marked **Primary** (index 0 = first responder) and ▲ to reorder. A group chat in Marinara is simply a chat with 2+ characters, so this is the console's way to compose one and preview it.
- **Group Chat settings panel.** A **⚙️** on the *Characters (Group)* source (and clicking the group banner in the Simulated Prompt) opens a settings panel mirroring Marinara's *Chat Settings → Group Chat*: **Mode** (Merged/Narrator vs Individual), **Response order** (Sequential / Smart / Manual), **Add Turn To Prompt**, **Name Prefix History**, **Color Dialogues** (merged), **Scenario Override**, and **Inactive members** (bench a participant). Settings are console-local and remembered between sessions.
- **Group-aware Simulated Prompt.** The `character` marker now stacks one card block per active member behind a **Group** banner. **Merged** stacks all cards; **Individual** stacks all with an optional **Preview turn** focus to view a single responder (others hidden). A **Scenario Override** drops each card's own scenario and renders one shared **Scenario** block after the cards — matching how the engine assembles it. Benched (inactive) members are excluded. The banner explains the runtime-only bits (per-turn card, `Respond ONLY as…`, history relabeling, Smart/Manual choice) as notes rather than fabricating them.
- **Structural-only, off-chat.** Like the chat-history preview, the group surface is design-time: when a Marinara chat is **open**, the console defers to the live **🔍 Inspect** capture (which reflects the chat's real composition and settings) and shows a single primary-character picker with a note.

### Changed

- **Selection persistence** now stores the full character group (`characterIds`), the group settings, and the focused responder. Older saved selections with a single `characterId` still restore (as a one-member group).

## [1.9.0] — 2026-06-30

A workflow-quality-of-life release: find things faster, see how full the prompt is, keep your selection between sessions, and nest lorebook folders.

### Added

- **Searchable Sources pickers.** The Preset / Character / Persona / Lorebook dropdowns are now type-to-filter comboboxes — start typing to narrow a long list, then click or press Enter. Works on desktop and mobile (tap the field, the on-screen keyboard filters the list). Arrow keys + Enter to pick, Esc to close.
- **Lorebook entry search.** A 🔍 button next to the active lorebook's ✏️ opens an inline filter that narrows the entry checklist by name or content as you type.
- **Simulated Prompt filter bar.** A search box in the Simulated Prompt header filters the assembled blocks by name or content; chat-history blocks also match on their depth-injected items.
- **Token estimates + context gauge.** Each block shows a rough `~N` token estimate (≈4 characters per token), and the Simulated Prompt header shows the total plus a usage bar that fills toward your **active connection's Max Context Window** (green → amber at 80% → red at 100%). The Prompt Inspector badge shows the captured prompt's estimated total. Token estimates require an active API connection (the gauge needs a real context window to fill toward), and can be turned off in Settings.
- **Remember last selection.** Your Sources selection — preset, lorebooks (and the active one), character, persona, and each lorebook's checked entries/folders — is saved and restored when you reopen the console. IDs that no longer exist are quietly dropped.
- **Nested lorebook folders.** Folders can now nest inside other folders. The folder editor has a **Parent folder** dropdown (excludes the folder itself and its own descendants so you can't create a loop) and a **Child folders** multiselect (check to nest a folder here, uncheck to detach). In Sources, child folders are indented beneath their parents. (Disabling a parent folder disables every entry in its subtree at generation time — matching the engine.)
- **JSON / plaintext view toggle** in the Prompt Inspector — switch between readable `### Role` text and a colour-coded `[{role, content}]` JSON array, keeping the role colour-coding either way.
- **Simulated Prompt column toggles** in ⚙️ Settings — hide the filter bar, token estimates, group badges, and folder badges individually to reduce clutter (all on by default).
- **Token gauge note** clarifies that estimates need an active connection.

### Changed

- **Settings is full-screen on mobile**, matching the Prompt Inspector, so the header and close button are always reachable and the body scrolls.
- **Clearer save/move errors.** Failed saves and folder moves now surface the engine's actual error message (e.g. an invalid folder nesting) instead of a generic "see console" toast.

### Fixed

- **Dropdowns no longer show a duplicate "— Select a … —" row.** The combobox shows the placeholder in the field itself, so the redundant blank list row was removed (the lorebook "— Remove this lorebook —" row is kept).
- **Settings header/scroll on small screens** — the header is pinned and the body scrolls, so the dialog is always closable on mobile.

## [1.8.1] — 2026-06-22

### Fixed

- **Prompt Inspector header on mobile.** The *Line breaks* / *Copy* / *Copy JSON* buttons no longer split across rows — they wrap together onto a single row, with the title on the first row and the ✕ pinned to the far-right corner.
- **Column header alignment.** Condensed the Sources column subtext to one line so the **Sources / Simulated Prompt / Editor** headers are the same height and their bodies line up.

## [1.8.0] — 2026-06-22

Adds a **Prompt Inspector** — capture the entire prompt as it would be sent to your LLM.

### Added

- **🔍 Prompt Inspector.** A new button in the console titlebar (next to *Reload*) opens a modal showing the full assembled prompt as a list of messages, **colour-coded by role** via the left border (System = cyan, Assistant = magenta, User = yellow by default). Text role labels are off by default and can be turned on in Settings.
  - **With a chat open**, it asks whether to **include** the active chat history (fit to the preset's context limit) or **omit** it. *Include* captures the engine's exact prompt via Marinara 2.0.0's dry-run preview (`POST /api/generate/dryRun`), including the model, context size, and wrap format. *Omit* shows the structural preview from your current console selection with a `{{chat_history}}` placeholder.
  - **With no chat open**, it skips the prompt and shows the structural preview directly.
  - **Depth-injected** sections and lorebook entries are stacked by depth around the chat-history placeholder (higher depth first), mirroring how they assemble at runtime.
  - **No API connection?** The dry-run needs a connection to resolve the model + context window, so for connection-less chats the inspector falls back to fetching the raw chat history (`GET /api/chats/:id/messages`) and inserting it into the structural prompt, with depth prompts placed between the real turns. Labeled as untrimmed.
  - **Visible line-breaks toggle** (`¶`) renders a marker at each newline; the choice is remembered across opens. **Copy** grabs the prompt as readable text; **Copy JSON** grabs the `[{role, content}]` messages array — the structure chat-completion APIs actually receive.
  - Multimodal turns are annotated with image/file counts in the live capture.
  - On failure, the inspector shows the actual error (HTTP status + body) with a cause hint, instead of a generic "see console" message.
- **⚙️ Settings menu.** A new settings button in the console titlebar (between *Reload* and *Close*). Options: a default for the Inspect history prompt (*Always ask* / *Include* / *Omit*, so you can skip the per-click dialog); a cap on how many recent chat turns the connection-free Inspect inserts (0 = all); a toggle for the Prompt Inspector's text role labels; and **customisable role colours + border thickness** for accessibility. Preferences persist in `localStorage`.

### Changed

- **Renamed the right-hand "Inspector" column to "Editor"** (and dropped "inspect" from its hint text) to avoid confusion with the new 🔍 Inspect utility.

### Fixed

- **Short Prompt Inspector blocks no longer squish.** A flex-column trap shrank one-line messages (e.g. a tiny `Role` section or a one-word turn) to an unreadable sliver; blocks now keep their height and the modal scrolls.

## [1.7.0] — 2026-06-22

Compatibility pass for **Marinara Engine 2.0.0**, plus Simulated Prompt visual enhancements and a disabled-section fix.

### Added

- **Disabled entries visible in Simulated Prompt.** Disabled lorebook entries now appear in the Simulated Prompt when selected, rendered with reduced opacity and a dashed border to visually distinguish them from active entries. A `DISABLED` badge appears as the rightmost indicator on the block header (left of the role).
- **Folder badge on lorebook entries.** Lorebook entries nested in a folder now display an amber folder-name badge in the Simulated Prompt block header, similar to how grouped preset sections display their group name.

### Changed

- **Lorebook entry "Advanced" fields merged into Basic.** *Prevent recursion* and *Locked* now sit in the Basic section of the entry inspector instead of a separate Advanced collapsible.
- **Defensive field normalization.** `normalizeEntry` coerces `order` / `sortOrder` / `position` / `depth` to numbers, and `tryParseJSON` now passes through values that are already arrays/objects instead of discarding them — Marinara 2.0.0 returns fields like `sectionOrder` and `markerConfig` as real arrays/objects, not JSON strings.

### Fixed

- **Disabled prompt sections no longer render as enabled.** Marinara 2.0.0 persists prompt-section booleans as the strings `"true"` / `"false"`, so the strict `enabled !== false` check treated a disabled section (`"false"`) as enabled and still showed it in the simulation. A new `normalizeSection` pass coerces `enabled` / `isMarker` back to real booleans on load.

## [1.6.0] — 2026-05-17

Lorebook overview editing from the Inspector, plus layout refinements to the Simulated Prompt and preset Sections panel.

### Added

- **Lorebook Editor in the Inspector.** A ✏️ button next to each selected lorebook dropdown opens an Overview panel with editable fields for name, description, tags (comma-separated), category (World / Character / NPC / Spellbook / Uncategorized as a button group), scan depth, token budget, recursive scanning, enabled, and global. Uses the standard Save / Revert draft flow; saves write back via `PATCH /api/lorebooks/:id`.

### Changed

- **Group badge pushed to the far right in the Simulated Prompt.** The green group-name pill now sits at the far-right edge of the block header, vertically aligned with the `ORDER N` badge on lorebook entries, instead of appearing between the block name and the role label.
- **Preset Sections panel reordered.** Inside the Sections collapsible, Groups now appear at the top, followed by the Section Order list, with the `+ Section` button moved to the bottom below the section list.

## [1.5.0] — 2026-05-16

Preset editing from the Inspector — sections, groups, variables, and drag-and-drop reordering without leaving the AIO console.

### Added

- **Preset Editor in the Inspector.** A ✏️ button on the preset dropdown opens a full preset editor with three collapsible sections:
  - **Overview** — edit name, description, wrap format (XML / Markdown / None toggle), and author. Uses the standard Save / Revert draft flow.
  - **Sections** — create new sections or markers from a type dropdown (Prompt Block, Character Info, Lorebook All/Before/After, Persona, Chat History, Chat Summary, Dialogue Examples), delete sections, and drag-and-drop to reorder. Includes group management with create / rename / delete and batch-add sections to groups (same pattern as lorebook folder batch-add).
  - **Preset Variables** — create, delete, and edit variables inline: variable name, question, options list with add / remove, multi-select toggle, separator, and random-pick toggle.
- **Group dropdown on section Inspector.** When editing a section, a Group dropdown lets you assign it to a group manually.
- **Group badge in Simulated Prompt.** Sections and markers belonging to a group display a green pill badge with the group name.
- **Drag-and-drop reordering in Simulated Prompt.** Sections, markers, and chat-history blocks can be dragged to reorder. The new order is saved to the preset's `sectionOrder` via `PUT /sections/reorder`.
- **Collapsible lorebook entry sections.** The lorebook entry Inspector fields are now organized into seven collapsible sections (Basic, Matching options, Context filters, Additional matching sources, Timing, Group & Tag, Advanced). Basic starts expanded; the rest start collapsed to reduce scrolling.
- **Extension-card launch button.** A 🥞 button is injected into the extension's own card in Settings → Extensions, providing an alternate way to open the console — especially useful on mobile where the toolbar icon is hidden.

### Changed

- **Collapsible styling unified.** The preset editor and lorebook entry collapsibles use the same visual style as the existing Preset Variables panel: bottom-border separator, caret + title + count badge header, no card border.
- **Chat History blocks grayed out.** Chat History blocks in the Simulated Prompt now have the same dashed-border, reduced-opacity appearance as markers, since their content is resolved at runtime.
- **Toolbar 🥞 hidden on mobile.** On screens ≤ 768px the toolbar button is hidden to avoid overlapping the navigation. Mobile users access the console via the extension-card button in Settings → Extensions.

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
