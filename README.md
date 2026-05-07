# kolache's AIO Prompt Viewer and Editor

A "see-what-the-LLM-sees" console for [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine). Pick a preset, lorebook(s), character, and persona; watch them assemble into the actual prompt order the engine would build at request time; click any block to inspect its fields and edit them in place — saves write back to the real source, not to ephemeral state.

Built for prompt engineers who are tired of opening four separate editors to figure out why an entry isn't firing where they expected.

## What it does

When you toggle the extension on, a 🥞 button appears in the top-right tab strip (left of Browser). Click it for the full console:

| Column | Purpose |
|---|---|
| **Left — Sources** | Single-select dropdowns for Preset / Character / Persona, plus a multi-lorebook section with a per-lorebook entry checklist. |
| **Middle — Simulated Prompt** | Every selected piece rendered in the *exact order* the engine would assemble it — preset sections in `sectionOrder`, lorebook entries placed at `world_info_before` / `world_info_after` / depth markers per the entry's `position` and `order`, character & persona slotted into their respective marker sections, depth-injected entries shown nested inside the chat-history block at their depth. Each lorebook entry shows its `order` as a badge at the top-right; if two displayed entries collide on `order` within the same anchor (and `depth`, for depth-injected ones) both blocks turn red and the badge reads **OVERLAPPING!**. Every block has an **Expand / Compress** toggle in the bottom-right that flips between the 600-char preview and the full content. |
| **Right — Inspector** | Editable fields for whichever block you clicked. Save / Revert buttons in the footer. Switching to another block while dirty fires a Save / Revert / Stay confirmation. When the inspected block's content references one or more of the preset's variables, a collapsible **Preset variables** panel appears at the top — pick an option to substitute it live in the Simulated Prompt, and edit the option's value in place to PATCH it back to the preset. |

For lorebook entries the inspector exposes every field the engine actually supports: name, content, description, primary keys, secondary keys, position, depth, order, role, enabled, constant, selective + selective logic, probability, scan depth, match-whole-words, case-sensitive, treat-as-regex, character/tag/trigger filter modes + values, the seven additional matching sources, sticky / cooldown / delay / ephemeral, group + group weight, tag, folder ID, prevent-recursion, locked.

For preset sections, the editor only shows **Depth** and **Order** when **Position** is set to `depth` — those fields don't do anything for `ordered` sections (which sequence by the preset's `sectionOrder`), so they're hidden to avoid implying otherwise.

## Install

> **Heads-up about Marinara's CSP.** Marinara Engine ships with a strict Content Security Policy of `script-src 'self'`. The engine's own extension loader runs your JS through `new Function(...)`, which `'unsafe-eval'` would normally allow — but the engine doesn't grant it. Until that is patched upstream, no JS-based Marinara extension will run, including this one. To enable it locally, edit `packages/server/src/middleware/security-headers.ts` (and the compiled `packages/server/dist/middleware/security-headers.js` if you're running a built install) so the `script-src` line reads `"script-src 'self' 'unsafe-eval',"`, restart the server, and you're good. The same fix unblocks every other JS extension you'd want to install.

1. Grab `kolaches-aio.json` from the [Releases page](../../releases) (or this repo's root).
2. In Marinara, click the gear icon in the top-right → **Extensions** tab → **Import Extension (.json, .css, or .js)**.
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

Marinara's extension loader executes the JS via `new Function("marinara", ext.js)`. The `marinara` argument supplies a small helper API (auto-cleaned `observe`, `on`, `setInterval`, `setTimeout`, plus `addStyle`, `addElement`, `apiFetch`, `onCleanup`). This extension uses `observe`, `onCleanup`, and direct `fetch('/api/...')` calls — no other dependencies.

## Compatibility

Built against Marinara Engine v1.5.7. Endpoints used:

- `GET  /api/prompts/`              (list presets)
- `GET  /api/prompts/:id/full`      (preset + sections + groups)
- `PATCH /api/prompts/:id/sections/:sectionId`
- `GET  /api/lorebooks`
- `GET  /api/lorebooks/:id/entries`
- `PATCH /api/lorebooks/:id/entries/:entryId`
- `GET  /api/characters` / `GET /api/characters/:id` / `PATCH /api/characters/:id`
- `GET  /api/characters/personas/list` / `GET /api/characters/personas/:id` / `PATCH /api/characters/personas/:id`
- `PATCH /api/prompts/:presetId/variables/:variableId` (used by the inline variable-value editor)

If a future Marinara release renames or reshapes any of those, the extension will surface the failure as a "Couldn't load …" / "Save failed — see console" toast. File an issue and I'll patch.

## What this does NOT do (yet)

- **Agents are skipped in v1.** The simulated prompt only shows preset sections, lorebook entries, character, persona, and chat-history placeholders. Agent prompts (which run as separate generation passes) are not displayed.
- **Markers like `chat_history`, `chat_summary`, `dialogue_examples`, `agent_data` are read-only placeholders** in the simulation — their content is dynamic at runtime so there's nothing meaningful to preview at design time.
- **The lorebook-entry editor preserves but does not edit** the rarely-used fields `relationships`, `dynamicState`, `activationConditions`, and `schedule`. Use Marinara's full lorebook editor for those.
- **Folder ID** is a free-text input, not a folder picker. If you don't already know the folder ID, you'll need to look it up in Marinara's lorebook editor.
- **Character `data` is shallow-merged on save** — only the fields the inspector shows are overwritten; everything else under `data` is preserved.

## License

MIT. See [`LICENSE`](LICENSE).

Marinara Engine itself is AGPL-3.0; this extension is an *overlay* (it doesn't modify or redistribute Marinara's source), so MIT is appropriate for the overlay's own code.

## Credits

🥞 emoji is the kolache symbol because, well — that's me. Built with help from Claude.

If you ship a bug fix or a feature, PRs welcome.
