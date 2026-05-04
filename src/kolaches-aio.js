/* ─────────────────────────────────────────────
 *  kolache's AIO Prompt Viewer and Editor
 *  ---------------------------------------------
 *  Entry-point button in the top-right tab strip
 *  (left of the Browser tab) opens a 3-column
 *  console:
 *    Left   — pickers for preset / lorebook / character / persona
 *    Middle — the simulated assembled prompt
 *    Right  — inspector + editor + dirty-state guard
 * ─────────────────────────────────────────────*/

// `marinara` is supplied by the engine when the extension JS runs.
// Available helpers we use: marinara.observe, marinara.onCleanup.

// ── API helpers ────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch("/api" + path, opts);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(method + " " + path + " → " + r.status + (text ? ": " + text.slice(0, 120) : ""));
  }
  if (r.status === 204) return null;
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : null;
}

const tryParseJSON = (s, fallback) => {
  if (typeof s !== "string" || !s.length) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// ── Global state ───────────────────────────────────────────────
const state = {
  presets: [],            // [{id, name, ...}]
  lorebooks: [],
  characters: [],
  personas: [],

  selectedPresetId: null,
  // Multi-lorebook: ordered list of selected lorebook IDs, plus the
  // ID whose entry list is currently "active" (most-recently-tapped).
  selectedLorebookIds: [],
  activeLorebookId: null,
  selectedEntryIdsByLorebook: {}, // {lorebookId → Set<entryId>}
  selectedCharacterId: null,
  selectedPersonaId: null,

  presetFull: null,              // {preset, sections, groups, choiceBlocks}
  lorebookEntries: {},           // lorebookId → entries[]
  characterFull: null,           // full character (with .data)
  personaFull: null,

  inspecting: null,              // {kind, id} – current right-panel target
  draft: null,                   // local edits before save
  isDirty: false,
};

// ── DOM refs (populated by buildConsole) ──────────────────────
let overlayEl = null;
let leftBodyEl = null;
let middleBodyEl = null;
let rightBodyEl = null;
let rightFooterEl = null;
let toastEl = null;

// ── Top-bar 🥞 button injection ──────────────────────────────
function injectTopbarButton() {
  const nav = document.querySelector('nav[data-tour="panel-buttons"]');
  if (!nav) return false;
  if (nav.querySelector(".kaio-tab-btn")) return true;

  const btn = document.createElement("button");
  btn.className = "kaio-tab-btn";
  btn.title = "kolache's AIO";
  btn.innerHTML = '<span class="kaio-tab-emoji">🥞</span>';
  btn.addEventListener("click", () => openConsole());
  nav.insertBefore(btn, nav.firstChild);
  return true;
}

// ── Console build (one-time) ──────────────────────────────────
function buildConsole() {
  if (overlayEl) return;

  overlayEl = document.createElement("div");
  overlayEl.className = "kaio-overlay";
  overlayEl.innerHTML = `
    <div class="kaio-shell" role="dialog" aria-label="kolache's AIO">
      <div class="kaio-titlebar">
        <span class="kaio-title-emoji">🥞</span>
        <span class="kaio-title">kolache's AIO</span>
        <span class="kaio-subtitle">Prompt Viewer &amp; Editor</span>
        <span class="kaio-spacer"></span>
        <button class="kaio-iconbtn" data-action="refresh" title="Reload sources">↻ Reload</button>
        <button class="kaio-iconbtn" data-action="close" title="Close (Esc)">✕</button>
      </div>
      <div class="kaio-body">
        <section class="kaio-col kaio-col-left">
          <header class="kaio-col-header">
            <h3>Sources</h3>
            <p>Pick one of each. Lorebook entries are added manually below.</p>
          </header>
          <div class="kaio-col-body" data-region="left"></div>
        </section>
        <section class="kaio-col kaio-col-middle">
          <header class="kaio-col-header">
            <h3>Simulated Prompt</h3>
            <p>Click any block to inspect &amp; edit on the right.</p>
          </header>
          <div class="kaio-col-body" data-region="middle"></div>
        </section>
        <section class="kaio-col kaio-col-right">
          <header class="kaio-col-header">
            <h3>Inspector</h3>
            <p>Edits write back to the actual source.</p>
          </header>
          <div class="kaio-col-body" data-region="right"></div>
          <footer class="kaio-right-footer" data-region="right-footer"></footer>
        </section>
      </div>
      <div class="kaio-toast" data-region="toast"></div>
    </div>
  `;
  document.body.appendChild(overlayEl);

  leftBodyEl    = overlayEl.querySelector('[data-region="left"]');
  middleBodyEl  = overlayEl.querySelector('[data-region="middle"]');
  rightBodyEl   = overlayEl.querySelector('[data-region="right"]');
  rightFooterEl = overlayEl.querySelector('[data-region="right-footer"]');
  toastEl       = overlayEl.querySelector('[data-region="toast"]');

  overlayEl.querySelector('[data-action="close"]').addEventListener("click", attemptClose);
  overlayEl.querySelector('[data-action="refresh"]').addEventListener("click", async () => {
    await loadAllSources();
    if (state.selectedPresetId) await loadPresetFull(state.selectedPresetId);
    for (const lbId of state.selectedLorebookIds) {
      await loadLorebookEntries(lbId);
    }
    if (state.selectedCharacterId) await loadCharacter(state.selectedCharacterId);
    if (state.selectedPersonaId) await loadPersona(state.selectedPersonaId);
    renderAll();
    showToast("Reloaded", "success");
  });

  // Esc closes (with dirty-state guard)
  document.addEventListener("keydown", onKeydown);
}

function onKeydown(e) {
  if (e.key !== "Escape") return;
  if (!overlayEl || overlayEl.dataset.open !== "true") return;
  attemptClose();
}

// ── Open / close ──────────────────────────────────────────────
async function openConsole() {
  if (!overlayEl) buildConsole();
  overlayEl.dataset.open = "true";
  await loadAllSources();
  renderAll();
}

function attemptClose() {
  if (state.isDirty) {
    confirmDirtySwitch(null);
    return;
  }
  closeConsoleNow();
}
function closeConsoleNow() {
  if (overlayEl) overlayEl.dataset.open = "false";
}

// ── Loading data ──────────────────────────────────────────────
async function loadAllSources() {
  try {
    const [presets, lorebooks, characters, personas] = await Promise.all([
      api("GET", "/prompts/").catch(() => []),
      api("GET", "/lorebooks").catch(() => []),
      api("GET", "/characters").catch(() => []),
      api("GET", "/characters/personas/list").catch(() => []),
    ]);
    state.presets    = Array.isArray(presets)    ? presets    : [];
    state.lorebooks  = Array.isArray(lorebooks)  ? lorebooks  : [];
    state.characters = Array.isArray(characters) ? characters : [];
    state.personas   = Array.isArray(personas)   ? personas   : [];
  } catch (err) {
    console.error("[kolache-AIO] Failed to load sources", err);
    showToast("Failed to load sources — see console", "error");
  }
}
async function loadPresetFull(id) {
  state.presetFull = await api("GET", "/prompts/" + id + "/full").catch((e) => {
    console.error(e); showToast("Couldn't load preset", "error"); return null;
  });
}
async function loadLorebookEntries(id) {
  const list = await api("GET", "/lorebooks/" + id + "/entries").catch((e) => {
    console.error(e); showToast("Couldn't load entries", "error"); return [];
  });
  state.lorebookEntries[id] = Array.isArray(list) ? list : [];
}
async function loadCharacter(id) {
  state.characterFull = await api("GET", "/characters/" + id).catch((e) => {
    console.error(e); showToast("Couldn't load character", "error"); return null;
  });
}
async function loadPersona(id) {
  state.personaFull = await api("GET", "/characters/personas/" + id).catch((e) => {
    console.error(e); showToast("Couldn't load persona", "error"); return null;
  });
}

// ── Rendering ─────────────────────────────────────────────────
function renderAll() {
  renderLeft();
  renderMiddle();
  renderRight();
}

// LEFT — source pickers
function renderLeft() {
  if (!leftBodyEl) return;
  leftBodyEl.innerHTML = "";

  leftBodyEl.appendChild(renderSourcePicker({
    label: "Preset",
    icon: "📜",
    items: state.presets,
    valueId: state.selectedPresetId,
    placeholder: "— Select a preset —",
    onChange: async (id) => {
      if (await guardDirty() === false) return;
      state.selectedPresetId = id;
      state.presetFull = null;
      state.inspecting = null;
      state.draft = null;
      state.isDirty = false;
      if (id) await loadPresetFull(id);
      renderAll();
    },
  }));

  // Multi-lorebook: one row per selected lorebook + one trailing "add" row.
  // Only the active (most-recently-tapped) lorebook shows its entry checklist.
  const lbSection = document.createElement("div");
  lbSection.className = "kaio-source";

  const lbHeader = document.createElement("div");
  lbHeader.className = "kaio-source-label";
  lbHeader.innerHTML =
    `<span class="kaio-source-icon">📖</span><span>Lorebooks</span>`;
  lbSection.appendChild(lbHeader);

  const slots = state.selectedLorebookIds.length + 1; // trailing empty
  for (let i = 0; i < slots; i++) {
    const isLast = i === state.selectedLorebookIds.length;
    const currentId = isLast ? null : state.selectedLorebookIds[i];
    const isActive = !isLast && currentId === state.activeLorebookId;

    // Each row is a container that holds the dropdown (and, if active, the
    // entry checklist below it).
    const row = document.createElement("div");
    row.className = "kaio-lb-row";
    if (isActive) row.dataset.active = "true";

    // Pool of lorebooks available for THIS row: everything not already
    // selected in another row, plus whatever this row currently holds.
    const taken = new Set(state.selectedLorebookIds);
    if (currentId) taken.delete(currentId);
    const items = state.lorebooks.filter((lb) => !taken.has(lb.id));

    const rowHeader = document.createElement("div");
    rowHeader.className = "kaio-lb-rowhead";
    // Clicking the row's dropdown area should also "activate" that lorebook.
    rowHeader.addEventListener("mousedown", () => {
      if (currentId && currentId !== state.activeLorebookId) {
        state.activeLorebookId = currentId;
        // Re-render after the click event finishes so the select can open.
        setTimeout(renderLeft, 0);
      }
    });

    const sel = document.createElement("select");
    sel.className = "kaio-select";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = isLast
      ? (state.selectedLorebookIds.length ? "— Add another lorebook —" : "— Select a lorebook —")
      : "— Remove this lorebook —";
    sel.appendChild(blank);
    for (const lb of items) {
      const o = document.createElement("option");
      o.value = lb.id;
      o.textContent = lb.name || lb.id;
      if (lb.id === currentId) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", async (ev) => {
      const newId = sel.value || null;
      // Snapshot the original value so we can revert if guardDirty cancels.
      if (await guardDirty() === false) {
        sel.value = currentId || "";
        ev.preventDefault();
        return;
      }
      if (isLast) {
        // Adding a new lorebook
        if (!newId) return;
        state.selectedLorebookIds = [...state.selectedLorebookIds, newId];
        if (!state.selectedEntryIdsByLorebook[newId]) {
          state.selectedEntryIdsByLorebook[newId] = new Set();
        }
        state.activeLorebookId = newId;
        if (!state.lorebookEntries[newId]) await loadLorebookEntries(newId);
      } else if (!newId) {
        // Removing this lorebook from the selection
        state.selectedLorebookIds = state.selectedLorebookIds.filter((id) => id !== currentId);
        delete state.selectedEntryIdsByLorebook[currentId];
        if (state.activeLorebookId === currentId) {
          state.activeLorebookId = state.selectedLorebookIds[state.selectedLorebookIds.length - 1] || null;
        }
        // If the inspector was looking at an entry from this lorebook, clear it.
        if (state.inspecting && state.inspecting.kind === "lorebook-entry" &&
            state.inspecting.entry && state.inspecting.entry.lorebookId === currentId) {
          state.inspecting = null;
          state.draft = null;
          state.isDirty = false;
        }
      } else {
        // Swapping this slot to a different lorebook
        const next = [...state.selectedLorebookIds];
        next[i] = newId;
        state.selectedLorebookIds = next;
        if (!state.selectedEntryIdsByLorebook[newId]) {
          state.selectedEntryIdsByLorebook[newId] = new Set();
        }
        delete state.selectedEntryIdsByLorebook[currentId];
        state.activeLorebookId = newId;
        if (!state.lorebookEntries[newId]) await loadLorebookEntries(newId);
      }
      renderAll();
    });
    rowHeader.appendChild(sel);
    row.appendChild(rowHeader);

    // Entry checklist only under the active lorebook.
    if (isActive) {
      row.appendChild(renderEntryChecklist(currentId));
    }

    lbSection.appendChild(row);
  }
  leftBodyEl.appendChild(lbSection);

  leftBodyEl.appendChild(renderSourcePicker({
    label: "Character",
    icon: "🧍",
    items: state.characters.map((c) => ({
      id: c.id,
      name: (c.data && c.data.name) || c.name || "Untitled character",
    })),
    valueId: state.selectedCharacterId,
    placeholder: "— Select a character —",
    onChange: async (id) => {
      if (await guardDirty() === false) return;
      state.selectedCharacterId = id;
      state.characterFull = null;
      state.inspecting = null;
      state.draft = null;
      state.isDirty = false;
      if (id) await loadCharacter(id);
      renderAll();
    },
  }));

  leftBodyEl.appendChild(renderSourcePicker({
    label: "Persona",
    icon: "👤",
    items: state.personas,
    valueId: state.selectedPersonaId,
    placeholder: "— Select a persona —",
    onChange: async (id) => {
      if (await guardDirty() === false) return;
      state.selectedPersonaId = id;
      state.personaFull = null;
      state.inspecting = null;
      state.draft = null;
      state.isDirty = false;
      if (id) await loadPersona(id);
      renderAll();
    },
  }));
}

function renderSourcePicker({ label, icon, items, valueId, placeholder, onChange, inline }) {
  const wrap = inline ? document.createElement("div") : document.createElement("div");
  if (!inline) wrap.className = "kaio-source";

  const lab = document.createElement("div");
  lab.className = "kaio-source-label";
  lab.innerHTML = `<span class="kaio-source-icon">${icon}</span><span>${label}</span>`;
  wrap.appendChild(lab);

  const sel = document.createElement("select");
  sel.className = "kaio-select";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = placeholder;
  sel.appendChild(blank);
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id;
    o.textContent = it.name || it.id;
    if (it.id === valueId) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value || null));
  wrap.appendChild(sel);
  return wrap;
}

function renderEntryChecklist(lorebookId) {
  const list = document.createElement("div");
  list.className = "kaio-entrylist";
  const entries = state.lorebookEntries[lorebookId] || [];
  if (!entries.length) {
    list.innerHTML = '<div class="kaio-entrylist-empty">No entries in this lorebook.</div>';
    return list;
  }
  if (!state.selectedEntryIdsByLorebook[lorebookId]) {
    state.selectedEntryIdsByLorebook[lorebookId] = new Set();
  }
  const checkedSet = state.selectedEntryIdsByLorebook[lorebookId];

  // Sort by order asc for display
  const sorted = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const e of sorted) {
    const item = document.createElement("label");
    item.className = "kaio-entry-item";
    const checked = checkedSet.has(e.id);
    const positionLabel = positionToLabel(e.position);
    item.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""}>
      <div style="flex:1;min-width:0;">
        <div class="kaio-entry-name">${escapeHTML(e.name || "(unnamed)")}</div>
        <div class="kaio-entry-meta">
          <span class="kaio-entry-position">${positionLabel}</span>
          <span>order ${e.order ?? 0}</span>
          ${e.position === 2 ? `<span>depth ${e.depth ?? 0}</span>` : ""}
          ${e.role && e.role !== "system" ? `<span>${escapeHTML(e.role)}</span>` : ""}
        </div>
      </div>
    `;
    item.querySelector("input").addEventListener("change", async (ev) => {
      if (await guardDirty() === false) {
        ev.target.checked = !ev.target.checked; // undo
        return;
      }
      if (ev.target.checked) checkedSet.add(e.id);
      else checkedSet.delete(e.id);
      // Re-render middle so the entry shows/hides in the simulation
      renderMiddle();
    });
    list.appendChild(item);
  }
  return list;
}

function positionToLabel(position) {
  switch (position) {
    case 0: return "before char";
    case 1: return "after char";
    case 2: return "depth";
    default: return "?";
  }
}

// ── Build the simulated prompt blocks ─────────────────────────
function buildSimulatedPrompt() {
  const blocks = [];
  if (!state.presetFull) return blocks;

  const sectionOrder = tryParseJSON(state.presetFull.preset.sectionOrder, []);
  const sectionsById = Object.fromEntries(
    (state.presetFull.sections || []).map((s) => [s.id, s])
  );
  const orderedIds = sectionOrder.length
    ? sectionOrder
    : (state.presetFull.sections || []).map((s) => s.id);

  // Collect all entries the user picked across every selected lorebook,
  // then separate by position so each anchor in the preset gets its bucket.
  const picked = [];
  for (const lbId of state.selectedLorebookIds) {
    const checked = state.selectedEntryIdsByLorebook[lbId];
    if (!checked || !checked.size) continue;
    const entries = state.lorebookEntries[lbId] || [];
    for (const e of entries) {
      if (checked.has(e.id) && e.enabled !== false) picked.push(e);
    }
  }
  const beforeEntries = picked.filter((e) => e.position === 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const afterEntries  = picked.filter((e) => e.position === 1)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const depthEntries  = picked.filter((e) => e.position === 2)
    .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || (a.order ?? 0) - (b.order ?? 0));

  const character = state.characterFull || null;
  const persona   = state.personaFull   || null;

  // Sections with depth-injection are separated out — they would
  // inject inside the chat-history marker, not in the linear flow.
  const depthSections = (state.presetFull.sections || []).filter(
    (s) => s.enabled !== false && s.injectionPosition === "depth"
  ).sort((a, b) => (a.injectionDepth ?? 0) - (b.injectionDepth ?? 0));

  for (const id of orderedIds) {
    const section = sectionsById[id];
    if (!section || section.enabled === false) continue;
    if (section.injectionPosition === "depth") continue; // shown inside chat_history block

    if (section.isMarker && section.markerConfig) {
      const cfg = tryParseJSON(section.markerConfig, {});
      switch (cfg.type) {
        case "world_info_before":
          for (const e of beforeEntries) blocks.push(makeEntryBlock(section, e));
          if (!beforeEntries.length) blocks.push(makeMarkerBlock(section, "world_info_before"));
          break;
        case "world_info_after":
          for (const e of afterEntries) blocks.push(makeEntryBlock(section, e));
          if (!afterEntries.length) blocks.push(makeMarkerBlock(section, "world_info_after"));
          break;
        case "lorebook":
          {
            const all = [...beforeEntries, ...afterEntries];
            for (const e of all) blocks.push(makeEntryBlock(section, e));
            if (!all.length) blocks.push(makeMarkerBlock(section, "lorebook"));
          }
          break;
        case "character":
          if (character) blocks.push(makeCharacterBlock(section, character, cfg));
          else blocks.push(makeMarkerBlock(section, "character"));
          break;
        case "persona":
          if (persona) blocks.push(makePersonaBlock(section, persona));
          else blocks.push(makeMarkerBlock(section, "persona"));
          break;
        case "chat_history":
          blocks.push({
            kind: "chat-history",
            id: "marker-" + section.id,
            section,
            depthEntries,
            depthSections,
          });
          break;
        default:
          blocks.push(makeMarkerBlock(section, cfg.type));
      }
    } else {
      blocks.push({
        kind: "section",
        id: "section-" + section.id,
        section,
      });
    }
  }
  return blocks;
}

function makeEntryBlock(section, entry) {
  return {
    kind: "lorebook-entry",
    id: "entry-" + entry.id,
    section,
    entry,
  };
}
function makeCharacterBlock(section, character, cfg) {
  return {
    kind: "character",
    id: "character-" + character.id + "-" + section.id,
    section,
    character,
    fields: (cfg && cfg.characterFields) || null,
  };
}
function makePersonaBlock(section, persona) {
  return {
    kind: "persona",
    id: "persona-" + persona.id + "-" + section.id,
    section,
    persona,
  };
}
function makeMarkerBlock(section, markerType) {
  return {
    kind: "marker",
    id: "marker-" + section.id,
    section,
    markerType,
  };
}

// MIDDLE — render simulated prompt
function renderMiddle() {
  if (!middleBodyEl) return;
  middleBodyEl.innerHTML = "";

  if (!state.selectedPresetId) {
    middleBodyEl.innerHTML = `
      <div class="kaio-middle-empty">
        <span class="emoji">🥞</span>
        <div>Select a preset on the left to start.<br>
        Lorebook entries, character, and persona will slot into the preset's anchors as the engine would assemble them.</div>
      </div>`;
    return;
  }
  if (!state.presetFull) {
    middleBodyEl.innerHTML = `<div class="kaio-middle-empty"><div>Loading preset…</div></div>`;
    return;
  }

  const blocks = buildSimulatedPrompt();
  if (!blocks.length) {
    middleBodyEl.innerHTML = `<div class="kaio-middle-empty"><div>This preset has no enabled sections.</div></div>`;
    return;
  }

  for (const b of blocks) {
    middleBodyEl.appendChild(renderBlock(b));
  }
}

function renderBlock(block) {
  const el = document.createElement("div");
  el.className = "kaio-block";
  const isReadonly = block.kind === "marker"; // markers w/o resolved content
  el.dataset.readonly = isReadonly ? "true" : "false";
  el.dataset.selected =
    state.inspecting && state.inspecting.id === block.id ? "true" : "false";

  const head = document.createElement("div");
  head.className = "kaio-block-head";
  const tagText = blockTagText(block);
  const role = block.section?.role || (block.entry && block.entry.role) || "";
  head.innerHTML = `
    <span class="kaio-block-tag" data-kind="${block.kind}">${tagText}</span>
    <span class="kaio-block-name">${escapeHTML(blockTitle(block))}</span>
    ${role ? `<span class="kaio-block-role">${escapeHTML(role)}</span>` : ""}
  `;
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "kaio-block-content";
  const preview = blockPreview(block);
  if (!preview) {
    body.dataset.empty = "true";
    body.textContent = blockEmptyHint(block);
  } else {
    body.textContent = preview;
  }
  el.appendChild(body);

  // Chat history shows nested depth-injected items as sub-blocks
  if (block.kind === "chat-history") {
    const all = [
      ...block.depthSections.map((s) => ({
        kind: "section",
        id: "section-" + s.id,
        section: s,
        depth: s.injectionDepth,
      })),
      ...block.depthEntries.map((e) => ({
        kind: "lorebook-entry",
        id: "entry-" + e.id,
        section: block.section,
        entry: e,
        depth: e.depth ?? 0,
      })),
    ].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));

    if (all.length) {
      const stack = document.createElement("div");
      stack.className = "kaio-block-substack";
      for (const sub of all) {
        const subEl = document.createElement("div");
        subEl.className = "kaio-subblock";
        subEl.dataset.selected =
          state.inspecting && state.inspecting.id === sub.id ? "true" : "false";
        subEl.innerHTML = `
          <div class="kaio-block-head">
            <span class="kaio-block-tag" data-kind="${sub.kind}">${blockTagText(sub)}</span>
            <span class="kaio-block-name">${escapeHTML(blockTitle(sub))}</span>
            <span class="kaio-block-role">depth ${sub.depth}</span>
          </div>
          <div class="kaio-block-content">${escapeHTML(blockPreview(sub) || blockEmptyHint(sub))}</div>
        `;
        subEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          inspectBlock(sub);
        });
        stack.appendChild(subEl);
      }
      el.appendChild(stack);
    }
  }

  if (!isReadonly) el.addEventListener("click", () => inspectBlock(block));
  return el;
}

function blockTagText(block) {
  switch (block.kind) {
    case "section":        return "Section";
    case "lorebook-entry": return "Lorebook";
    case "character":      return "Character";
    case "persona":        return "Persona";
    case "chat-history":   return "Chat history";
    case "marker":         return "Marker";
    default: return block.kind;
  }
}
function blockTitle(block) {
  if (block.kind === "section")        return block.section.name || block.section.identifier || "Section";
  if (block.kind === "lorebook-entry") return block.entry.name || "(unnamed entry)";
  if (block.kind === "character")      return (block.character.data?.name) || block.character.name || "Character";
  if (block.kind === "persona")        return block.persona.name || "Persona";
  if (block.kind === "chat-history")   return block.section.name || "Chat history";
  if (block.kind === "marker")         return block.section.name || `[${block.markerType}]`;
  return "Block";
}
function blockPreview(block) {
  if (block.kind === "section")        return (block.section.content || "").slice(0, 600);
  if (block.kind === "lorebook-entry") return (block.entry.content || "").slice(0, 600);
  if (block.kind === "character") {
    const d = block.character.data || {};
    const fields = block.fields || ["description", "personality", "scenario", "system_prompt"];
    return fields.map((f) => d[f] ? `[${f}]\n${d[f]}` : "").filter(Boolean).join("\n\n").slice(0, 600);
  }
  if (block.kind === "persona") {
    const p = block.persona || {};
    return [p.description, p.personality, p.scenario].filter(Boolean).join("\n\n").slice(0, 600);
  }
  return "";
}
function blockEmptyHint(block) {
  switch (block.kind) {
    case "marker":         return `(Resolved at runtime: ${block.markerType})`;
    case "chat-history":   return "(Chat history is injected at runtime)";
    case "lorebook-entry": return "(Empty entry)";
    case "character":      return "(Empty character fields)";
    case "persona":        return "(Empty persona)";
    default:               return "(Empty)";
  }
}

// ── Inspector / editor ────────────────────────────────────────
function inspectBlock(block) {
  if (state.isDirty) {
    confirmDirtySwitch(block);
    return;
  }
  state.inspecting = block;
  state.draft = makeDraft(block);
  state.isDirty = false;
  renderMiddle();   // re-paint selection state
  renderRight();
}

function makeDraft(block) {
  if (!block) return null;
  switch (block.kind) {
    case "section":
      return {
        kind: "section",
        sourceId: block.section.id,
        fields: {
          name: block.section.name || "",
          content: block.section.content || "",
          role: block.section.role || "system",
          enabled: block.section.enabled !== false,
          injectionPosition: block.section.injectionPosition || "ordered",
          injectionDepth: block.section.injectionDepth ?? 4,
          injectionOrder: block.section.injectionOrder ?? 100,
        },
      };
    case "lorebook-entry":
      {
        const e = block.entry;
        const arrCSV = (a) => Array.isArray(a) ? a.join(", ") : "";
        const arrSrc = Array.isArray(e.additionalMatchingSources)
          ? new Set(e.additionalMatchingSources)
          : new Set();
        return {
          kind: "lorebook-entry",
          sourceId: e.id,
          lorebookId: e.lorebookId,
          fields: {
            // ── Basic ─────────────────────────────────
            name: e.name || "",
            content: e.content || "",
            description: e.description || "",
            keys: arrCSV(e.keys),
            secondaryKeys: arrCSV(e.secondaryKeys),
            enabled: e.enabled !== false,
            constant: !!e.constant,
            position: e.position ?? 0,
            depth: e.depth ?? 4,
            order: e.order ?? 100,
            role: e.role || "system",
            // ── Matching options ─────────────────────
            selective: !!e.selective,
            selectiveLogic: e.selectiveLogic || "and",
            probability: e.probability ?? null,
            scanDepth: e.scanDepth ?? null,
            matchWholeWords: !!e.matchWholeWords,
            caseSensitive: !!e.caseSensitive,
            useRegex: !!e.useRegex,
            // ── Context filters ──────────────────────
            characterFilterMode: e.characterFilterMode || "any",
            characterFilterIds: arrCSV(e.characterFilterIds),
            characterTagFilterMode: e.characterTagFilterMode || "any",
            characterTagFilters: arrCSV(e.characterTagFilters),
            generationTriggerFilterMode: e.generationTriggerFilterMode || "any",
            generationTriggerFilters: arrCSV(e.generationTriggerFilters),
            // additionalMatchingSources is a Set of enum values
            additionalMatchingSources: arrSrc,
            // ── Timing ───────────────────────────────
            sticky: e.sticky ?? null,
            cooldown: e.cooldown ?? null,
            delay: e.delay ?? null,
            ephemeral: e.ephemeral ?? null,
            // ── Group & Tag ──────────────────────────
            group: e.group || "",
            groupWeight: e.groupWeight ?? null,
            tag: e.tag || "",
            folderId: e.folderId || "",
            // ── Misc ────────────────────────────────
            preventRecursion: !!e.preventRecursion,
            locked: !!e.locked,
          },
        };
      }
    case "character":
      {
        const d = block.character.data || {};
        return {
          kind: "character",
          sourceId: block.character.id,
          fields: {
            name: d.name || "",
            description: d.description || "",
            personality: d.personality || "",
            scenario: d.scenario || "",
            system_prompt: d.system_prompt || "",
            post_history_instructions: d.post_history_instructions || "",
          },
        };
      }
    case "persona":
      {
        const p = block.persona || {};
        return {
          kind: "persona",
          sourceId: p.id,
          fields: {
            name: p.name || "",
            description: p.description || "",
            personality: p.personality || "",
            scenario: p.scenario || "",
          },
        };
      }
    default:
      return null;
  }
}

function renderRight() {
  if (!rightBodyEl || !rightFooterEl) return;
  rightBodyEl.innerHTML = "";
  rightFooterEl.innerHTML = "";

  if (!state.inspecting || !state.draft) {
    rightBodyEl.innerHTML = `<div class="kaio-right-empty">
      Click a block in the simulated prompt to inspect &amp; edit it here.
    </div>`;
    return;
  }

  const d = state.draft;
  const editable = d.kind !== "marker";
  const f = d.fields;

  switch (d.kind) {
    case "section":
      rightBodyEl.appendChild(field("Name", f.name, "name", "input"));
      rightBodyEl.appendChild(field("Content", f.content, "content", "textarea"));
      rightBodyEl.appendChild(rowOf(
        selectField("Role", f.role, "role", ["system", "user", "assistant"]),
        selectField("Position", f.injectionPosition, "injectionPosition", ["ordered", "depth"]),
      ));
      rightBodyEl.appendChild(rowOf(
        numberField("Depth", f.injectionDepth, "injectionDepth"),
        numberField("Order", f.injectionOrder, "injectionOrder"),
      ));
      rightBodyEl.appendChild(checkboxField("Enabled", f.enabled, "enabled"));
      break;

    case "lorebook-entry":
      // ── Basic ─────────────────────────────────────
      rightBodyEl.appendChild(sectionHeader("Basic"));
      rightBodyEl.appendChild(field("Name", f.name, "name", "input"));
      rightBodyEl.appendChild(field("Content", f.content, "content", "textarea"));
      rightBodyEl.appendChild(field("Description", f.description, "description", "textarea"));
      rightBodyEl.appendChild(field("Keys (primary, comma-separated)", f.keys, "keys", "input"));
      rightBodyEl.appendChild(field("Secondary keys (comma-separated)", f.secondaryKeys, "secondaryKeys", "input"));
      rightBodyEl.appendChild(rowOf(
        selectField("Position", String(f.position), "position",
          [["0","before char"],["1","after char"],["2","depth"]]),
        selectField("Role", f.role, "role", ["system", "user", "assistant"]),
      ));
      rightBodyEl.appendChild(rowOf(
        numberField("Depth", f.depth, "depth"),
        numberField("Order", f.order, "order"),
      ));
      rightBodyEl.appendChild(checkboxField("Enabled", f.enabled, "enabled"));
      rightBodyEl.appendChild(checkboxField("Constant (always inject)", f.constant, "constant"));

      // ── Matching options ──────────────────────────
      rightBodyEl.appendChild(sectionHeader("Matching options"));
      rightBodyEl.appendChild(rowOf(
        checkboxField("Selective", f.selective, "selective"),
        selectField("Selective logic", f.selectiveLogic, "selectiveLogic", ["and", "or", "not"]),
      ));
      rightBodyEl.appendChild(rowOf(
        nullableNumberField("Probability (0–1)", f.probability, "probability",
          { step: "0.05", min: 0, max: 1 }),
        nullableNumberField("Scan depth (override)", f.scanDepth, "scanDepth",
          { step: "1", min: 0 }),
      ));
      rightBodyEl.appendChild(rowOf(
        checkboxField("Match whole words", f.matchWholeWords, "matchWholeWords"),
        checkboxField("Case sensitive", f.caseSensitive, "caseSensitive"),
      ));
      rightBodyEl.appendChild(checkboxField("Treat keys as regex", f.useRegex, "useRegex"));

      // ── Context filters ───────────────────────────
      rightBodyEl.appendChild(sectionHeader("Context filters"));
      rightBodyEl.appendChild(rowOf(
        selectField("Character mode", f.characterFilterMode, "characterFilterMode",
          ["any", "include", "exclude"]),
        field("Character IDs (comma-separated)", f.characterFilterIds, "characterFilterIds", "input"),
      ));
      rightBodyEl.appendChild(rowOf(
        selectField("Tag mode", f.characterTagFilterMode, "characterTagFilterMode",
          ["any", "include", "exclude"]),
        field("Character tags (comma-separated)", f.characterTagFilters, "characterTagFilters", "input"),
      ));
      rightBodyEl.appendChild(rowOf(
        selectField("Trigger mode", f.generationTriggerFilterMode, "generationTriggerFilterMode",
          ["any", "include", "exclude"]),
        field("Generation triggers (e.g. chat, game)", f.generationTriggerFilters, "generationTriggerFilters", "input"),
      ));

      // ── Matching sources ─────────────────────────
      rightBodyEl.appendChild(sectionHeader("Additional matching sources"));
      rightBodyEl.appendChild(multiSelectField(
        "Scan these in addition to the chat",
        f.additionalMatchingSources,
        "additionalMatchingSources",
        [
          ["character_name",        "Character name"],
          ["character_description", "Character description"],
          ["character_personality", "Character personality"],
          ["character_scenario",    "Character scenario"],
          ["character_tags",        "Character tags"],
          ["persona_description",   "Persona description"],
          ["persona_tags",          "Persona tags"],
        ],
      ));

      // ── Timing ───────────────────────────────────
      rightBodyEl.appendChild(sectionHeader("Timing"));
      rightBodyEl.appendChild(rowOf(
        nullableNumberField("Sticky (turns)", f.sticky, "sticky", { step: "1", min: 0 }),
        nullableNumberField("Cooldown (turns)", f.cooldown, "cooldown", { step: "1", min: 0 }),
      ));
      rightBodyEl.appendChild(rowOf(
        nullableNumberField("Delay (turns)", f.delay, "delay", { step: "1", min: 0 }),
        nullableNumberField("Ephemeral (turns)", f.ephemeral, "ephemeral", { step: "1", min: 0 }),
      ));

      // ── Group & Tag ──────────────────────────────
      rightBodyEl.appendChild(sectionHeader("Group & Tag"));
      rightBodyEl.appendChild(rowOf(
        field("Group", f.group, "group", "input"),
        nullableNumberField("Group weight", f.groupWeight, "groupWeight", { step: "0.1" }),
      ));
      rightBodyEl.appendChild(rowOf(
        field("Tag", f.tag, "tag", "input"),
        field("Folder ID", f.folderId, "folderId", "input"),
      ));

      // ── Advanced ─────────────────────────────────
      rightBodyEl.appendChild(sectionHeader("Advanced"));
      rightBodyEl.appendChild(rowOf(
        checkboxField("Prevent recursion", f.preventRecursion, "preventRecursion"),
        checkboxField("Locked", f.locked, "locked"),
      ));
      break;

    case "character":
      rightBodyEl.appendChild(field("Name", f.name, "name", "input"));
      rightBodyEl.appendChild(field("Description", f.description, "description", "textarea"));
      rightBodyEl.appendChild(field("Personality", f.personality, "personality", "textarea"));
      rightBodyEl.appendChild(field("Scenario", f.scenario, "scenario", "textarea"));
      rightBodyEl.appendChild(field("System prompt", f.system_prompt, "system_prompt", "textarea"));
      rightBodyEl.appendChild(field("Post-history instructions",
        f.post_history_instructions, "post_history_instructions", "textarea"));
      break;

    case "persona":
      rightBodyEl.appendChild(field("Name", f.name, "name", "input"));
      rightBodyEl.appendChild(field("Description", f.description, "description", "textarea"));
      rightBodyEl.appendChild(field("Personality", f.personality, "personality", "textarea"));
      rightBodyEl.appendChild(field("Scenario", f.scenario, "scenario", "textarea"));
      break;
  }

  // Footer with Save/Revert
  const dot = document.createElement("span");
  dot.className = "kaio-dirty-dot";
  dot.dataset.dirty = state.isDirty ? "true" : "false";
  dot.title = "Unsaved changes";
  rightFooterEl.appendChild(dot);

  const dirtyTxt = document.createElement("span");
  dirtyTxt.style.fontSize = "0.6875rem";
  dirtyTxt.style.color = "var(--muted-foreground)";
  dirtyTxt.textContent = state.isDirty ? "Unsaved changes" : "No changes";
  rightFooterEl.appendChild(dirtyTxt);

  const spacer = document.createElement("span");
  spacer.className = "kaio-spacer";
  rightFooterEl.appendChild(spacer);

  const revertBtn = document.createElement("button");
  revertBtn.className = "kaio-btn";
  revertBtn.textContent = "Revert";
  revertBtn.disabled = !state.isDirty;
  revertBtn.addEventListener("click", () => {
    state.draft = makeDraft(state.inspecting);
    state.isDirty = false;
    renderRight();
    showToast("Reverted", "info");
  });
  rightFooterEl.appendChild(revertBtn);

  const saveBtn = document.createElement("button");
  saveBtn.className = "kaio-btn kaio-btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.disabled = !editable || !state.isDirty;
  saveBtn.addEventListener("click", () => saveDraft());
  rightFooterEl.appendChild(saveBtn);
}

// ── Field constructors ──────────────────────────────────
function field(label, value, key, type) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  let input;
  if (type === "textarea") {
    input = document.createElement("textarea");
    input.className = "kaio-textarea";
    input.rows = 8;
  } else {
    input = document.createElement("input");
    input.className = "kaio-input";
    input.type = "text";
  }
  input.value = value ?? "";
  input.addEventListener("input", () => onFieldChange(key, input.value));
  wrap.appendChild(input);
  return wrap;
}
function numberField(label, value, key) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const input = document.createElement("input");
  input.className = "kaio-input";
  input.type = "number";
  input.value = String(value ?? 0);
  input.addEventListener("input", () => onFieldChange(key, Number(input.value) || 0));
  wrap.appendChild(input);
  return wrap;
}
function nullableNumberField(label, value, key, attrs) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const input = document.createElement("input");
  input.className = "kaio-input";
  input.type = "number";
  input.placeholder = "(default)";
  if (attrs) for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, String(v));
  input.value = value === null || value === undefined ? "" : String(value);
  input.addEventListener("input", () => {
    const raw = input.value.trim();
    if (raw === "") return onFieldChange(key, null);
    const n = Number(raw);
    onFieldChange(key, Number.isFinite(n) ? n : null);
  });
  wrap.appendChild(input);
  return wrap;
}
function selectField(label, value, key, options) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const sel = document.createElement("select");
  sel.className = "kaio-select";
  for (const opt of options) {
    const o = document.createElement("option");
    if (Array.isArray(opt)) { o.value = opt[0]; o.textContent = opt[1]; }
    else { o.value = opt; o.textContent = opt; }
    if (o.value === String(value)) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => {
    let v = sel.value;
    if (key === "position") v = Number(v);
    onFieldChange(key, v);
  });
  wrap.appendChild(sel);
  return wrap;
}
function checkboxField(label, value, key) {
  const wrap = document.createElement("label");
  wrap.className = "kaio-checkbox";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!value;
  cb.addEventListener("change", () => onFieldChange(key, cb.checked));
  wrap.appendChild(cb);
  const txt = document.createElement("span");
  txt.textContent = label;
  wrap.appendChild(txt);
  return wrap;
}
function multiSelectField(label, value, key, options) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  lab.textContent = label;
  wrap.appendChild(lab);
  const set = value instanceof Set ? value : new Set(value || []);
  const list = document.createElement("div");
  list.className = "kaio-multilist";
  for (const opt of options) {
    const [val, text] = Array.isArray(opt) ? opt : [opt, opt];
    const row = document.createElement("label");
    row.className = "kaio-checkbox kaio-multi-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = set.has(val);
    cb.addEventListener("change", () => {
      const current = state.draft.fields[key] instanceof Set
        ? state.draft.fields[key]
        : new Set();
      if (cb.checked) current.add(val);
      else current.delete(val);
      onFieldChange(key, current);
    });
    row.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = text;
    row.appendChild(span);
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}
function sectionHeader(text) {
  const h = document.createElement("div");
  h.className = "kaio-section-header";
  h.textContent = text;
  return h;
}
function rowOf(...children) {
  const row = document.createElement("div");
  row.className = "kaio-field kaio-field-row";
  for (const c of children) row.appendChild(c);
  return row;
}
function onFieldChange(key, value) {
  if (!state.draft) return;
  state.draft.fields[key] = value;
  state.isDirty = isDraftDirty();
  const dot = rightFooterEl.querySelector(".kaio-dirty-dot");
  if (dot) dot.dataset.dirty = state.isDirty ? "true" : "false";
  const txt = rightFooterEl.querySelector("span:nth-child(2)");
  if (txt) txt.textContent = state.isDirty ? "Unsaved changes" : "No changes";
  const buttons = rightFooterEl.querySelectorAll("button");
  if (buttons[0]) buttons[0].disabled = !state.isDirty;
  if (buttons[1]) buttons[1].disabled = !state.isDirty;
}
function isDraftDirty() {
  if (!state.draft || !state.inspecting) return false;
  const fresh = makeDraft(state.inspecting);
  return !deepEqual(fresh.fields, state.draft.fields);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}
async function saveDraft() {
  if (!state.draft) return;
  const d = state.draft;
  try {
    switch (d.kind) {
      case "section": {
        const presetId = state.presetFull.preset.id;
        const body = {
          name: d.fields.name, content: d.fields.content, role: d.fields.role,
          enabled: d.fields.enabled, injectionPosition: d.fields.injectionPosition,
          injectionDepth: d.fields.injectionDepth, injectionOrder: d.fields.injectionOrder,
        };
        await api("PATCH", "/prompts/" + presetId + "/sections/" + d.sourceId, body);
        await loadPresetFull(presetId);
        break;
      }
      case "lorebook-entry": {
        const f = d.fields;
        const csv = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
        const body = {
          name: f.name, content: f.content, description: f.description,
          keys: csv(f.keys), secondaryKeys: csv(f.secondaryKeys),
          enabled: f.enabled, constant: f.constant,
          position: Number(f.position), depth: Number(f.depth), order: Number(f.order),
          role: f.role, selective: f.selective, selectiveLogic: f.selectiveLogic,
          probability: f.probability, scanDepth: f.scanDepth,
          matchWholeWords: f.matchWholeWords, caseSensitive: f.caseSensitive, useRegex: f.useRegex,
          characterFilterMode: f.characterFilterMode,
          characterFilterIds: csv(f.characterFilterIds),
          characterTagFilterMode: f.characterTagFilterMode,
          characterTagFilters: csv(f.characterTagFilters),
          generationTriggerFilterMode: f.generationTriggerFilterMode,
          generationTriggerFilters: csv(f.generationTriggerFilters),
          additionalMatchingSources: f.additionalMatchingSources instanceof Set
            ? [...f.additionalMatchingSources]
            : Array.isArray(f.additionalMatchingSources) ? f.additionalMatchingSources : [],
          sticky: f.sticky, cooldown: f.cooldown, delay: f.delay, ephemeral: f.ephemeral,
          group: f.group, groupWeight: f.groupWeight, tag: f.tag,
          folderId: f.folderId ? f.folderId : null,
          preventRecursion: f.preventRecursion, locked: f.locked,
        };
        await api("PATCH", "/lorebooks/" + d.lorebookId + "/entries/" + d.sourceId, body);
        await loadLorebookEntries(d.lorebookId);
        break;
      }
      case "character": {
        const fresh = await api("GET", "/characters/" + d.sourceId);
        const newData = { ...(fresh.data || {}), ...d.fields };
        await api("PATCH", "/characters/" + d.sourceId, { data: newData });
        await loadCharacter(d.sourceId);
        break;
      }
      case "persona": {
        await api("PATCH", "/characters/personas/" + d.sourceId, d.fields);
        await loadPersona(d.sourceId);
        break;
      }
    }
    const previousId = state.inspecting?.id;
    const blocks = buildSimulatedPrompt();
    const same = blocks.find((b) => b.id === previousId);
    state.inspecting = same || null;
    state.draft = same ? makeDraft(same) : null;
    state.isDirty = false;
    renderAll();
    showToast("Saved ✓", "success");
  } catch (err) {
    console.error("[kolache-AIO] Save failed", err);
    showToast("Save failed — see console", "error");
  }
}
function confirmDirtySwitch(pending) {
  const bg = document.createElement("div");
  bg.className = "kaio-confirm-bg";
  bg.innerHTML = '<div class="kaio-confirm"><div class="kaio-confirm-title">Unsaved changes</div><div class="kaio-confirm-msg">You have unsaved edits. Save them, revert, or stay here?</div><div class="kaio-confirm-actions"><button class="kaio-btn kaio-btn-ghost" data-act="cancel">Stay</button><button class="kaio-btn" data-act="revert">Revert</button><button class="kaio-btn kaio-btn-primary" data-act="save">Save</button></div></div>';
  overlayEl.querySelector(".kaio-shell").appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-act="cancel"]').addEventListener("click", close);
  bg.querySelector('[data-act="revert"]').addEventListener("click", () => {
    state.draft = makeDraft(state.inspecting);
    state.isDirty = false;
    close();
    if (pending === null) closeConsoleNow();
    else if (pending) inspectBlock(pending);
    else renderAll();
  });
  bg.querySelector('[data-act="save"]').addEventListener("click", async () => {
    await saveDraft();
    close();
    if (state.isDirty) return;
    if (pending === null) closeConsoleNow();
    else if (pending) inspectBlock(pending);
    else renderAll();
  });
}
function guardDirty() {
  return new Promise((resolve) => {
    if (!state.isDirty) return resolve(true);
    const bg = document.createElement("div");
    bg.className = "kaio-confirm-bg";
    bg.innerHTML = '<div class="kaio-confirm"><div class="kaio-confirm-title">Unsaved changes</div><div class="kaio-confirm-msg">Save or revert your edits before changing sources.</div><div class="kaio-confirm-actions"><button class="kaio-btn kaio-btn-ghost" data-act="cancel">Stay</button><button class="kaio-btn" data-act="revert">Revert</button><button class="kaio-btn kaio-btn-primary" data-act="save">Save</button></div></div>';
    overlayEl.querySelector(".kaio-shell").appendChild(bg);
    const close = () => bg.remove();
    bg.querySelector('[data-act="cancel"]').addEventListener("click", () => { close(); resolve(false); });
    bg.querySelector('[data-act="revert"]').addEventListener("click", () => {
      state.draft = makeDraft(state.inspecting);
      state.isDirty = false;
      close(); resolve(true);
    });
    bg.querySelector('[data-act="save"]').addEventListener("click", async () => {
      await saveDraft();
      close();
      resolve(!state.isDirty);
    });
  });
}
let toastTimer = null;
function showToast(msg, kind) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind || "info";
  toastEl.dataset.visible = "true";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.dataset.visible = "false"; }, 1800);
}
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
injectTopbarButton();
marinara.observe(document.body, () => { injectTopbarButton(); });
marinara.onCleanup(() => {
  if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
  document.removeEventListener("keydown", onKeydown);
  document.querySelectorAll(".kaio-tab-btn").forEach((b) => b.remove());
});
