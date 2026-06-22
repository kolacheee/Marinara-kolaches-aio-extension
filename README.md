# kolache's AIO Prompt Viewer and Editor

A "see-what-the-LLM-sees" console for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine). Pick a preset, lorebook(s), character, and persona; watch them assemble into the actual prompt order the engine would build at request time; click any block to open and edit its fields in place — saves write back to the real source, not to ephemeral state.

Built for prompt engineers who are tired of opening four separate editors to figure out why an entry isn't firing where they expected.

## What it does

When you toggle the extension on, a 🥞 button appears in the top-right tab strip. On mobile (where toolbar space is limited), the 🥞 appears on the extension's card in Settings → Extensions instead. Click it for the full console:

| Column | Purpose |
|---|---|
| **Left — Sources** | Single-select dropdowns for Preset / Character / Persona, plus a multi-lorebook section. The preset dropdown has a ✏️ button that opens the **Preset Editor** in the Editor column. Each lorebook dropdown has its own ✏️ button that opens the **Lorebook Editor** — edit name, description, tags, category, scan depth, token budget, recursive, enabled, and global. Each lorebook expands into a checklist with **folders at the top** (📁 icon, nested-entry count badge, ✏️ edit button) separated by a divider from individual entries. Checking a folder selects all its nested entries; unchecking deselects them. `+ Folder` and `+ Entry` buttons below each lorebook let you create new items inline. |
| **Middle — Simulated Prompt** | Every selected piece rendered in the *exact order* the engine would assemble it — preset sections in `sectionOrder`, lorebook entries placed at `world_info_before` / `world_info_after` / depth markers per the entry's `position` and `order`, character & persona slotted into their respective marker sections, depth-injected entries shown nested inside the chat-history block at their depth (higher `depth` renders higher in the substack — opposite to Order). Sections and markers belonging to a **group** display a green badge with the group name at the far right of the block header, aligned with the order badge. Lorebook entries nested in a **folder** display an amber badge with the folder name. **Disabled** lorebook entries are included in the simulation but rendered grayed out with a dashed border and a `DISABLED` badge (always the rightmost indicator). Sections, markers, and chat-history blocks are **drag-and-drop reorderable** — drag to rearrange and the new order is saved to the preset's `sectionOrder`. Each lorebook entry shows its `order` as a badge at the top-right; if two displayed entries collide on `order` within the same anchor (and `depth`, for depth-injected ones) both blocks turn red and the badge reads **OVERLAPPING!**. Blocks longer than three lines or 600 characters get an **Expand / Compress** toggle in the bottom-right; shorter blocks collapse to their actual height with no toggle. Markers and chat-history blocks are grayed out with dashed borders to visually distinguish them from editable content. A **Validate** button in the column header scans every selected source — preset, lorebook(s) (every entry, not just the checked ones), character, and persona — for orphaned XML tags and malformed `{{macro}}` syntax, highlights the offending blocks in orange, and auto-checks any unselected lorebook entries that need to come into view. Backtick-wrapped tags (`` `<context>` ``) and triple-backtick fences are treated as referential and skipped by the XML check. |
| **Right — Editor** | Editable fields for whichever block or folder you clicked. Save / Revert / **Delete** buttons in the footer (scroll position is preserved across saves). Switching to another block while dirty fires a Save / Revert / Stay confirmation. **Preset Editor** (via ✏️ on the preset dropdown) opens three collapsible sections: *Overview* (name, description, wrap format, author), *Sections* (groups at the top with create/rename/delete and batch-add, then the section order list with drag-and-drop reorder and delete, and a `+ Section` button at the bottom to create sections or markers from a type menu), and *Preset Variables* (full variable editor with name, question, options list, multi-select, separator, random-pick). **Lorebook Editor** (via ✏️ on each lorebook dropdown) opens an *Overview* collapsible with name, description, tags, category (World / Character / NPC / Spellbook / Uncategorized), scan depth, token budget, recursive scanning, enabled, and global. Sections can also be assigned to a group via a dropdown when editing an individual section. The **Folder editor** shows Name, Enabled, Order, a list of nested entries (with Remove buttons), and a batch-add checklist for assigning unassigned entries — with a "Show already nested" toggle to see entries in other folders. **Lorebook entry fields** are organized into collapsible sections (Basic, Matching options, Context filters, Additional matching sources, Timing, Group & Tag, Advanced) — Basic starts expanded, the rest start collapsed. When the open block's content references one or more of the preset's variables, a collapsible **Preset variables** panel appears at the top — pick an option to substitute it live in the Simulated Prompt, and edit the option's value in place to PATCH it back to the preset. Field labels carry a `?` tooltip icon that explains what each field does on hover. |

**Mobile & tablet:** On screens ≤ 768px the three columns collapse into a single full-screen panel with a **Sources / Prompt / Editor** tab bar. Tapping a block in the Prompt tab auto-switches to Editor. The desktop layout is completely unaffected.

### 🔍 Prompt Inspector

The **Inspect** button in the console titlebar (next to *Reload*) captures the prompt as it would be sent to your LLM and shows it as a list of messages — **colour-coded by role** via the left border (System = cyan, Assistant = magenta, User = yellow by default, all themeable). Text role labels are off by default.

- **With a chat open**, it asks whether to **include** that chat's history or **omit** it (set a default in ⚙️ Settings to skip the dialog):
  - *Include* pulls the engine's **exact** prompt via Marinara 2.0.0's dry-run preview (`POST /api/generate/dryRun`) — macros resolved, history trimmed to the model's context window, wrap formatting applied. The header shows the resolved model, context size, and wrap format.
  - *If the chat has no API connection* (so the engine can't produce the exact prompt), it falls back to fetching the raw chat history (`GET /api/chats/:id/messages`) and inserting it into the structural prompt — clearly labeled as an approximation (macros unresolved, untrimmed). Cap how many recent turns to insert in ⚙️ Settings.
  - *Omit* shows the structural preview from your current console selection, with a `{{chat_history}}` placeholder.
- **With no chat open**, it shows the structural preview directly.
- **Depth-injected** sections and lorebook entries are placed by depth around the chat history (between the real turns when history is present), matching how they assemble at runtime.
- Toggle **¶ Line breaks** to mark every newline; the choice is remembered. **Copy** grabs the prompt as readable text; **Copy JSON** grabs the `[{role, content}]` messages array — the structure chat-completion APIs actually receive. Multimodal turns are annotated with image/file counts.
- On failure, the modal shows the actual error (HTTP status + body) with a cause hint.

### ⚙️ Settings

A **⚙️** button in the console titlebar (between *Reload* and *Close*) opens settings, persisted in `localStorage`:

- **Inspect — chat history default** — *Always ask* / *Include* / *Omit* (skip the per-click dialog).
- **Connection-free Inspect — max history messages** — cap the raw turns inserted when a chat has no connection (`0` = all).
- **Prompt Inspector appearance** — toggle text role labels, set the three role colours, and the role border thickness (for accessibility).

For lorebook entries the editor exposes every field the engine actually supports, organized into collapsible sections: **Basic** (name, content, description, primary keys, secondary keys, position, depth, order, role, enabled, matching mode — Normal / Selective / Constant as a 3-state orb selector, selective logic when Selective), **Matching options** (probability, scan depth, match-whole-words, case-sensitive, treat-as-regex), **Context filters** (character/tag/trigger filter modes + values), **Additional matching sources** (the seven scan targets), **Timing** (sticky / cooldown / delay / ephemeral), **Group & Tag** (group + group weight, tag, folder dropdown), **Advanced** (prevent-recursion, locked).

For preset sections, the editor only shows **Depth** and **Order** when **Position** is set to `depth` — those fields don't do anything for `ordered` sections (which sequence by the preset's `sectionOrder`), so they're hidden to avoid implying otherwise.

## Install

1. Grab `kolaches-aio.json` from the [Releases page](../../releases) (or this repo's root).
2. In Marinara, click the gear icon in the top-right → **Extensions** tab → **Import Extension File (.zip, .json, .css, or .js)**.
3. Select `kolaches-aio.json`. The extension installs enabled by default.
4. Refresh the page once. A 🥞 button appears at the left end of the top-right tab strip.

To uninstall, find it in Settings → Extensions and click the trash icon. The 🥞 button disappears immediately.

## What's in the box

| Path | What it is |
|---|---|
| `kolaches-aio.json` | The single-file extension manifest. This is what you import into Marinara. CSS and JS are embedded inside it. |
| `src/kolaches-aio.js`  | Editable JavaScript source. The bundled `.json` is built from this. |
| `src/kolaches-aio.css` | Editable stylesheet source. |
| `tools/build.mjs` | Tiny Node script that bundles `src/*` into `kolaches-aio.json`. Run with `node tools/build.mjs` after editing source. |
| `LICENSE` | MIT. |
| `README.md` | This file. |
| `CHANGELOG.md` | Per-release notes. |

## Editing the source

The shipped `.json` is the only file Marinara cares about. The split source files are there so you can read/edit/PR the code without untangling JSON-encoded strings. After you change anything in `src/`, run:

```bash
node tools/build.mjs
```

…to regenerate `kolaches-aio.json`.

Marinara's extension loader executes the JS inside a function that receives a `marinara` argument with a small helper API (auto-cleaned `observe`, `on`, `setInterval`, `setTimeout`, plus `addStyle`, `addElement`, `apiFetch`, `onCleanup`). This extension uses only `observe` and `onCleanup`, and reaches Marinara's data through plain same-origin `fetch('/api/...')` calls. Marinara installs a global fetch shim that adds the CSRF header to mutating (`POST`/`PATCH`/`PUT`/`DELETE`) requests automatically, so no extra wiring is needed. (We use a direct `fetch` rather than `marinara.apiFetch` because the latter always parses the response as JSON, which throws on the `204 No Content` replies our delete/reorder calls rely on.)

## Compatibility

Built against **Marinara Engine 2.0.0**. Data access is plain REST against the same-origin `/api` server; the same endpoints are served by the legacy Node.js/Fastify build (v1.5.9+), so the extension also runs there. Endpoints used:

- `GET  /api/prompts/`              (list presets)
- `GET  /api/prompts/:id/full`      (preset + sections + groups + choiceBlocks)
- `PATCH /api/prompts/:id`          (update preset overview fields)
- `POST /api/prompts/:id/sections`  (create section or marker)
- `PATCH /api/prompts/:id/sections/:sectionId`
- `DELETE /api/prompts/:id/sections/:sectionId`
- `PUT  /api/prompts/:id/sections/reorder`
- `POST /api/prompts/:id/groups`    (create group)
- `PATCH /api/prompts/:id/groups/:groupId`
- `DELETE /api/prompts/:id/groups/:groupId`
- `POST /api/prompts/:presetId/variables` (create variable)
- `PATCH /api/prompts/:presetId/variables/:variableId`
- `DELETE /api/prompts/:presetId/variables/:variableId`
- `GET  /api/lorebooks`
- `PATCH /api/lorebooks/:id`             (update lorebook overview fields)
- `GET  /api/lorebooks/:id/entries`
- `POST /api/lorebooks/:id/entries`
- `PATCH /api/lorebooks/:id/entries/:entryId`
- `DELETE /api/lorebooks/:id/entries/:entryId`
- `GET  /api/lorebooks/:id/folders`
- `POST /api/lorebooks/:id/folders`
- `PATCH /api/lorebooks/:id/folders/:folderId`
- `DELETE /api/lorebooks/:id/folders/:folderId`
- `GET  /api/characters` / `GET /api/characters/:id` / `PATCH /api/characters/:id`
- `GET  /api/characters/personas/list` / `GET /api/characters/personas/:id` / `PATCH /api/characters/personas/:id`
- `POST /api/generate/dryRun` (Prompt Inspector — `{ chatId, returnPrompt: true }` returns the assembled prompt without generating)

Marinara 2.0.0 stores some boolean fields (e.g. a prompt section's `enabled`) as the strings `"true"`/`"false"`; the extension normalizes those on load so disabled sections render correctly.

If a future Marinara release renames or reshapes any of these, the extension will surface the failure as a "Couldn't load ..." / "Save failed — see console" toast. File an issue and I'll patch.

## What this does NOT do (yet)

- **Agents are skipped in the Simulated Prompt.** It only shows preset sections, lorebook entries, character, persona, and chat-history placeholders. Agent prompts (which run as separate generation passes) are not displayed. (The live **Inspect** capture *does* reflect whatever the engine actually assembles, agents included.)
- **Markers like `chat_history`, `chat_summary`, `dialogue_examples`, `agent_data` are read-only placeholders** in the simulation — their content is dynamic at runtime so there's nothing meaningful to preview at design time.
- **The lorebook-entry editor preserves but does not edit** the rarely-used fields `relationships`, `dynamicState`, `activationConditions`, and `schedule`. Use Marinara's full lorebook editor for those.
- **Character `data` is shallow-merged on save** — only the fields the editor shows are overwritten; everything else under `data` is preserved.

## License

MIT. See [`LICENSE`](LICENSE).

Marinara Engine itself is AGPL-3.0; this extension is an *overlay* (it doesn't modify or redistribute Marinara's source), so MIT is appropriate for the overlay's own code.

## Credits

🥞 emoji is the kolache symbol because, well — that's me. Built with help from Claude.

If you ship a bug fix or a feature, PRs welcome.
