# 🥞 kolache's AIO Prompt Viewer and Editor

A single console for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine) that puts your **preset, lorebooks, character, and persona** in one place — pick them, watch them assemble into the exact prompt the engine would build, and edit any piece in place. Saves write straight back to the real source.

It exists to kill the back-and-forth: instead of bouncing between five separate editors to figure out why an entry isn't firing where you expected, you see the whole prompt assemble in front of you and click what you want to change.

> 🖼️ **Screenshot** · `docs/screenshots/console-overview.png`
> _The full three-column console with a preset, a couple of lorebooks, a character, and a persona selected — Sources (left), Simulated Prompt (middle), Editor (right)._

---

## Install

1. Grab **`kolaches-aio.json`** from the [Releases page](../../releases) (or this repo's root).
2. In Marinara, open the gear menu (top-right) → **Extensions** → **Import Extension File (.zip, .json, .css, or .js)**.
3. Select `kolaches-aio.json`. It installs **enabled** by default.
4. Refresh the page once. A 🥞 button appears at the left end of the top-right tab strip.

On phones/tablets (where toolbar space is tight) the toolbar 🥞 is hidden — open the console from the extension's card in **Settings → Extensions** instead.

To uninstall: Settings → Extensions → trash icon. The 🥞 disappears immediately.

---

## The console at a glance

Click the 🥞 to open a three-column overlay:

| Column | What it's for |
|---|---|
| **Sources** (left) | Pick your preset, lorebook(s), character, and persona. Expand a lorebook to check the entries (and folders) you want. |
| **Simulated Prompt** (middle) | Everything you picked, rendered in the **exact order** the engine assembles it. Click any block to edit it. |
| **Editor** (right) | The fields for whatever block you clicked. Save / Revert / Delete — changes write back to the real source. |

Two utilities live in the titlebar: **🔍 Inspect** (capture the real prompt) and **⚙️ Settings**.

---

## Sources

Type-to-filter comboboxes for **Preset**, **Character**, and **Persona**, plus a **multi-lorebook** section. Start typing to narrow a long list — handy once you have dozens or hundreds of characters or lorebooks — then click or press Enter.

- The **Preset** picker has a ✏️ that opens the **Preset Editor**.
- Each **lorebook** row has a ✏️ (its **Lorebook Editor**); the **active** lorebook also gets a 🔍 to **filter its entries** by name or content.
- Add as many lorebooks as you like — each gets its own row, and only the active one expands its checklist (keeps the column compact).
- Your selection is **remembered** between sessions and restored when you reopen the console.

> 🖼️ **Screenshot** · `docs/screenshots/sources-combobox.png`
> _A Sources dropdown open with text typed, showing the autocomplete-filtered list._

### Entry & folder checklist

Expanding a lorebook shows its **folders at the top** (📁 icon, entry-count badge, ✏️ edit button) and its **entries** below. Check a folder to pull all its entries into the prompt; check individual entries to add just those. `+ Folder` / `+ Entry` buttons create new items inline and drop you straight into the editor.

**Folders nest.** Child folders are indented beneath their parents, so the hierarchy is visible at a glance.

> 🖼️ **Screenshot** · `docs/screenshots/sources-nested-folders.png`
> _A lorebook expanded with nested (indented) child folders and the 🔍 entry filter open._

---

## Simulated Prompt

Every selected piece, rendered in the order the engine would build it: preset sections in `sectionOrder`, lorebook entries placed at `world_info_before` / `world_info_after` / depth markers per each entry's `position` and `order`, character and persona slotted into their marker sections, and **depth-injected** entries nested inside the chat-history block at their depth (higher `depth` renders higher — the opposite of Order).

- **Token gauge.** Each block carries a rough `~N` token estimate, and the header shows the total plus a bar that fills toward your **active connection's Max Context Window** — green, amber at 80%, red at 100%. (Requires an active API connection; toggle the whole thing off in Settings.)
- **Filter bar.** Search the assembled blocks by name or content.
- **Validate.** Scans every selected source — including *every* entry in every selected lorebook — for orphaned XML tags and malformed `{{macro}}` syntax, highlights the offenders, and pulls any unchecked offending entry into view. Backtick-wrapped tags and code fences are treated as referential and skipped.
- **Badges & cues.** Group sections show a green group badge; foldered entries show an amber folder badge; **disabled** entries render grayed out with a `DISABLED` badge; colliding `order` values turn both blocks red with an **OVERLAPPING!** badge.
- **Drag-and-drop** sections / markers / chat-history to reorder — the new order saves to the preset's `sectionOrder`.
- **Expand / Compress** appears on blocks longer than three lines or 600 characters.

> 🖼️ **Screenshot** · `docs/screenshots/simulated-prompt.png`
> _The middle column: the token gauge + filter bar in the header, with a few assembled blocks (one grouped, one foldered, one disabled)._

---

## Editor

Click any block (or a folder) to edit its fields on the right. **Save / Revert / Delete** sit in the footer, scroll position is preserved across saves, and switching away while dirty prompts a Save / Revert / Stay confirmation. Failed saves surface the engine's actual error message.

- **Preset Editor** (✏️ on the preset) — three collapsibles: *Overview* (name, description, wrap format, author), *Sections* (group management + the section-order list with drag reorder and a `+ Section` type menu), and *Preset Variables* (name, question, options, multi-select, separator, random-pick).
- **Lorebook Editor** (✏️ on a lorebook) — name, description, tags, category, scan depth, token budget, recursive, enabled, global.
- **Folder Editor** — Name, Enabled, Order, a **Parent folder** dropdown and a **Child folders** multiselect for nesting, the list of entries in the folder (with Remove), and a batch-add checklist for unassigned entries.
- **Entry Editor** — every field the engine supports, in collapsibles: *Basic* (name, content, description, primary/secondary keys, position/depth/order, role, enabled, a 3-state Normal/Selective/Constant matching selector, plus prevent-recursion and locked), *Matching options*, *Context filters*, *Additional matching sources*, *Timing*, and *Group & Tag*. Field labels carry `?` tooltips. (Depth/Order only show for `depth`-positioned sections, since they do nothing for `ordered` ones.)
- **Preset variables panel** — when a block references the preset's variables, a panel appears at the top: pick an option to substitute it live in the Simulated Prompt, and edit the value in place to write it back.

> 🖼️ **Screenshot** · `docs/screenshots/folder-editor-nesting.png`
> _The Folder Editor showing the Parent-folder dropdown and the Child-folders multiselect._

---

## 🔍 Prompt Inspector

The **Inspect** button (titlebar, next to *Reload*) captures the prompt as it would be sent to your LLM, shown as a list of messages **colour-coded by role** via the left border (System = cyan, Assistant = magenta, User = yellow — all themeable; text labels off by default).

- **Chat open → Include / Omit.** *Include* pulls the engine's **exact** prompt via Marinara's dry-run (`POST /api/generate/dryRun`) — macros resolved, history trimmed to the context window, wrap applied; the header shows model, context size, and wrap format. *Omit* shows the structural preview from your console selection with a `{{chat_history}}` placeholder. (Set a default in Settings to skip the prompt.)
- **No API connection on the chat?** Falls back to the raw chat history (`GET /api/chats/:id/messages`) interleaved into the structural prompt — clearly labeled as an approximation. Cap how many recent turns in Settings.
- **No chat open →** the structural preview directly.
- **JSON / plaintext toggle** — switch between readable `### Role` text and a colour-coded `[{role, content}]` array.
- **¶ Line breaks** marks every newline (remembered). **Copy** grabs readable text; **Copy JSON** grabs the messages array chat-completion APIs actually receive. Multimodal turns are annotated with image/file counts.
- On failure, the modal shows the actual HTTP status + body with a cause hint.

> 🖼️ **Screenshot** · `docs/screenshots/prompt-inspector.png`
> _The Prompt Inspector modal with role colour-coding and the JSON / plaintext + Copy buttons._

---

## ⚙️ Settings

The **⚙️** button (titlebar, between *Reload* and *Close*) opens settings, persisted in `localStorage`:

- **Inspect — chat history default** — *Always ask* / *Include* / *Omit*.
- **Connection-free Inspect — max history messages** — cap raw turns when a chat has no connection (`0` = all).
- **Simulated Prompt column** — toggle the filter bar, token estimates, group badges, and folder badges (all on by default).
- **Prompt Inspector appearance** — text role labels on/off, the three role colours, and the role border thickness.

> 🖼️ **Screenshot** · `docs/screenshots/settings.png`
> _The Settings dialog._

---

## Mobile & tablet

On screens ≤ 768px the three columns collapse into a single full-screen panel with a **Sources / Prompt / Editor** tab bar; tapping a block in Prompt jumps to Editor. The Prompt Inspector and Settings open as full-screen windows. The desktop layout is untouched.

> 🖼️ **Screenshot** · `docs/screenshots/mobile.png`
> _The mobile single-column layout with the tab bar._

---

## Compatibility

Built against **Marinara Engine 2.0.0**. Data access is plain REST against the same-origin `/api` server, so it also runs on the legacy Node.js/Fastify build (v1.5.9+). Endpoints used:

- **Presets:** `GET /api/prompts/`, `GET /api/prompts/:id/full`, `PATCH /api/prompts/:id`, sections `POST`/`PATCH`/`DELETE` + `PUT …/sections/reorder`, groups `POST`/`PATCH`/`DELETE`, variables `POST`/`PATCH`/`DELETE`.
- **Lorebooks:** `GET /api/lorebooks`, `PATCH /api/lorebooks/:id`, entries `GET`/`POST`/`PATCH`/`DELETE`, folders `GET`/`POST`/`PATCH`/`DELETE` (folder `PATCH` carries `parentFolderId` for nesting).
- **Characters & personas:** `GET`/`PATCH` for `/api/characters[/:id]` and `/api/characters/personas/{list,:id}`.
- **Prompt Inspector & token gauge:** `POST /api/generate/dryRun` (`{ chatId, returnPrompt: true }`), `GET /api/chats/:id` + `GET /api/chats/:id/messages`, and `GET /api/connections` (to read the active connection's Max Context Window).

Marinara 2.0.0 returns some booleans (e.g. a prompt section's `enabled`) as the strings `"true"`/`"false"`; the extension normalizes those on load. If a future release reshapes an endpoint, the extension surfaces it as a "Couldn't load …" / "Save failed …" toast — file an issue and I'll patch.

---

## Editing the source

The shipped `.json` is the only file Marinara loads; `src/` is split out so you can read and edit the code without untangling JSON-encoded strings.

| Path | What it is |
|---|---|
| `kolaches-aio.json` | The single-file extension you import into Marinara (CSS + JS embedded). |
| `src/kolaches-aio.js` | Editable JavaScript source. |
| `src/kolaches-aio.css` | Editable stylesheet source. |
| `tools/build.mjs` | Bundles `src/*` into `kolaches-aio.json`. |

After editing anything under `src/`, rebuild:

```bash
node tools/build.mjs
```

Marinara runs the JS inside a function that receives a `marinara` helper API (`observe`, `onCleanup`, `addStyle`, `addElement`, `apiFetch`, …). This extension uses only `observe`/`onCleanup` and reaches data through plain same-origin `fetch('/api/...')` — Marinara's global fetch shim adds the CSRF header to mutating requests automatically. (We avoid `marinara.apiFetch` because it always parses JSON, which throws on the `204 No Content` replies our delete/reorder calls rely on.)

---

## What this does **not** do (yet)

- **Agents are skipped in the Simulated Prompt** — it shows preset sections, lorebook entries, character, persona, and chat-history placeholders. (The live **Inspect** capture *does* include whatever the engine actually assembles, agents and all.)
- **Runtime markers** (`chat_history`, `chat_summary`, `dialogue_examples`, `agent_data`) are read-only placeholders — their content is dynamic.
- **The Simulated Prompt doesn't yet model the disabled-*ancestor* folder rule** — at generation time the engine excludes every entry in a disabled folder's whole subtree; the structural preview reflects a folder's own disabled state but not (yet) inherited disabling from a parent.
- **The entry editor preserves but doesn't edit** the rarely-used `relationships`, `dynamicState`, `activationConditions`, `schedule` fields.
- **Character `data` is shallow-merged on save** — only the fields the editor shows are overwritten.

> **Heads-up on import:** Marinara's importer currently flattens folder nesting on re-import (`parentFolderId` is dropped), so nested folders survive *export* but land at root if a lorebook is re-imported. That's an engine limitation, not this extension's.

---

## License

MIT — see [`LICENSE`](LICENSE). Marinara Engine itself is AGPL-3.0; this extension is an *overlay* (it doesn't modify or redistribute Marinara's source), so MIT fits the overlay's own code.

## Credits

The 🥞 is the kolache symbol — that's me. Built with help from Claude. PRs for bug fixes and features welcome.
