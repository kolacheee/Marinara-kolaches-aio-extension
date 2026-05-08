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

// The /characters list and get-by-id endpoints return the row verbatim, with
// the entire CharacterData V2 (name, description, personality, etc.) packed
// into a JSON-string `data` column. Normalize so the rest of the extension can
// just read `c.data.name`. Idempotent — if `data` is already an object, no-op.
function normalizeCharacter(c) {
  if (!c) return c;
  if (typeof c.data === "string") {
    return { ...c, data: tryParseJSON(c.data, {}) };
  }
  return c;
}

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

  // ── Visual preview + inline variable editing ──
  // variablePreviews[variableName] = { cbId, optionId, value, savedValue }
  //   `value` is the in-progress (possibly edited) text used for substitution.
  //   `savedValue` is the option's value as last loaded from the server, used
  //   to detect dirty state for the Save button.
  variablePreviews: {},
  expandedBlocks: new Set(),     // block IDs whose preview is shown in full
  variablesPanelCollapsed: false,

  // Validation: { blockId → [{ kind, message, snippet }, ...] }
  // Cleared on Reload, source-switch, and Save. Repopulated by clicking
  // the Validate button in the middle column header.
  validationErrors: {},
  validationRanLast: false,      // true once Validate has run at least once
};

// ── DOM refs (populated by buildConsole) ──────────────────────
let overlayEl = null;
let leftBodyEl = null;
let middleBodyEl = null;
let rightBodyEl = null;
let rightFooterEl = null;
let toastEl = null;
let activeTipEl = null;

// Resolve a CSS variable to an opaque rgb() string by temporarily applying it
// to a hidden element, reading the computed value, and stripping any alpha.
// Works with any color format the browser supports (hex, rgb, hsl, oklch, …).
function resolveOpaque(varName, fallback) {
  const tmp = document.createElement("div");
  tmp.style.display = "none";
  tmp.style.backgroundColor = `var(${varName}, ${fallback})`;
  overlayEl.appendChild(tmp);
  const resolved = getComputedStyle(tmp).backgroundColor;
  tmp.remove();
  // getComputedStyle always returns rgb(r,g,b) or rgba(r,g,b,a)
  const m = resolved.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`;
  return fallback;
}
function resolveVar(varName, fallback) {
  const tmp = document.createElement("div");
  tmp.style.display = "none";
  tmp.style.color = `var(${varName}, ${fallback})`;
  overlayEl.appendChild(tmp);
  const resolved = getComputedStyle(tmp).color;
  tmp.remove();
  return resolved || fallback;
}

function showTip(tipSpan) {
  hideTip();
  const text = tipSpan.dataset.tip;
  if (!text) return;
  const popup = document.createElement("div");
  popup.className = "kaio-tooltip-popup";
  popup.textContent = text;
  // Resolve theme colors from the overlay scope, force card background opaque
  // so the tooltip is solid regardless of theme alpha. Append to document.body
  // to stay outside the overlay's backdrop-filter stacking context.
  if (overlayEl) {
    popup.style.backgroundColor = resolveOpaque("--card", "#0f0f15");
    popup.style.color = resolveVar("--foreground", "#e4e4e7");
    popup.style.borderColor = resolveVar("--border", "#27272a");
  }
  popup.style.left = "-9999px";
  popup.style.top = "0";
  document.body.appendChild(popup);
  const tipW = 210;
  const tipH = popup.offsetHeight;
  const iconRect = tipSpan.getBoundingClientRect();
  // Center above the icon, then clamp to viewport with 8px inset
  let left = iconRect.left + iconRect.width / 2 - tipW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
  let top = iconRect.top - tipH - 6;
  // Flip below if there's not enough space above
  if (top < 8) top = iconRect.bottom + 6;
  popup.style.left = left + "px";
  popup.style.top = top + "px";
  activeTipEl = popup;
}
function hideTip() {
  if (activeTipEl) { activeTipEl.remove(); activeTipEl = null; }
}

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
            <div class="kaio-col-header-row">
              <div class="kaio-col-header-text">
                <h3>Simulated Prompt</h3>
                <p>Click any block to inspect &amp; edit on the right.</p>
              </div>
              <div class="kaio-col-header-actions">
                <button class="kaio-col-header-btn" data-action="validate"
                        title="Scan all sources for unbalanced XML tags and broken macros">
                  ✓ Validate
                </button>
              </div>
            </div>
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

  // Tooltip delegation — works across all dynamic content in the overlay
  overlayEl.addEventListener("mouseover", (e) => {
    const tip = e.target.closest(".kaio-tip");
    if (tip) showTip(tip);
  });
  overlayEl.addEventListener("mouseout", (e) => {
    if (e.target.closest(".kaio-tip")) hideTip();
  });

  overlayEl.querySelector('[data-action="close"]').addEventListener("click", attemptClose);
  overlayEl.querySelector('[data-action="refresh"]').addEventListener("click", async () => {
    await loadAllSources();
    if (state.selectedPresetId) await loadPresetFull(state.selectedPresetId);
    for (const lbId of state.selectedLorebookIds) {
      await loadLorebookEntries(lbId);
    }
    if (state.selectedCharacterId) await loadCharacter(state.selectedCharacterId);
    if (state.selectedPersonaId) await loadPersona(state.selectedPersonaId);
    state.validationErrors = {};
    state.validationRanLast = false;
    resetValidateBtn();
    renderAll();
    showToast("Reloaded", "success");
  });
  overlayEl.querySelector('[data-action="validate"]').addEventListener(
    "click",
    runValidation,
  );

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
  hideTip();
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
    state.characters = Array.isArray(characters) ? characters.map(normalizeCharacter) : [];
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
  const c = await api("GET", "/characters/" + id).catch((e) => {
    console.error(e); showToast("Couldn't load character", "error"); return null;
  });
  state.characterFull = normalizeCharacter(c);
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
      state.variablePreviews = {};
      state.expandedBlocks.clear();
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
  // Depth is INVERTED relative to Order: higher depth shows higher up in the
  // chat history (= further from the most recent message), so we sort
  // descending here and again where the substack is rendered.
  const depthEntries  = picked.filter((e) => e.position === 2)
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || (a.order ?? 0) - (b.order ?? 0));

  const character = state.characterFull || null;
  const persona   = state.personaFull   || null;

  // Sections with depth-injection are separated out — they would
  // inject inside the chat-history marker, not in the linear flow.
  const depthSections = (state.presetFull.sections || []).filter(
    (s) => s.enabled !== false && s.injectionPosition === "depth"
  ).sort((a, b) => (b.injectionDepth ?? 0) - (a.injectionDepth ?? 0));

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

// ── Validation ────────────────────────────────────────────────
//
// `Validate` walks every selected source — preset sections, ALL entries in
// every selected lorebook (whether the user has them checked or not),
// character fields, persona fields — concatenated in the order Marinara would
// assemble them. We run a stack-based XML scan and a macro-shape check across
// the combined stream so an opener in one entry can find its closer in
// another. Any block that ends up "owning" an error gets:
//   • added to state.validationErrors[blockId]
//   • auto-checked into the Simulated Prompt if it's a lorebook entry the
//     user hadn't selected (so the highlight is actually visible).
//
// Returns the error list so the caller can build a toast summary.
function buildValidationItems() {
  const items = [];
  if (!state.presetFull) return items;

  const sectionOrder = tryParseJSON(state.presetFull.preset.sectionOrder, []);
  const sectionsById = Object.fromEntries(
    (state.presetFull.sections || []).map((s) => [s.id, s])
  );
  const orderedIds = sectionOrder.length
    ? sectionOrder
    : (state.presetFull.sections || []).map((s) => s.id);

  // Collect ALL entries from ALL selected lorebooks (regardless of the per-
  // entry checkbox state) so we can spot orphans living in entries the user
  // hasn't yet pulled into the simulation.
  const allEntries = [];
  for (const lbId of state.selectedLorebookIds) {
    const entries = state.lorebookEntries[lbId] || [];
    for (const e of entries) {
      if (e.enabled === false) continue;
      allEntries.push({ ...e, lorebookId: lbId });
    }
  }
  const beforeEntries = allEntries.filter((e) => e.position === 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const afterEntries  = allEntries.filter((e) => e.position === 1)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const depthEntries  = allEntries.filter((e) => e.position === 2)
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || (a.order ?? 0) - (b.order ?? 0));

  const character = state.characterFull || null;
  const persona   = state.personaFull   || null;

  const depthSections = (state.presetFull.sections || []).filter(
    (s) => s.enabled !== false && s.injectionPosition === "depth"
  ).sort((a, b) => (b.injectionDepth ?? 0) - (a.injectionDepth ?? 0));

  const pushSection = (s) => {
    items.push({
      blockId: "section-" + s.id,
      label: s.name || s.identifier || "Section",
      content: s.content || "",
    });
  };
  const pushEntry = (e) => {
    items.push({
      blockId: "entry-" + e.id,
      label: e.name || "(unnamed entry)",
      content: e.content || "",
      lorebookId: e.lorebookId,
      entryId: e.id,
    });
  };
  const pushCharacter = (sectionId) => {
    if (!character) return;
    const d = character.data || {};
    const fields = [
      "description", "personality", "scenario",
      "system_prompt", "post_history_instructions",
    ];
    const text = fields.map((f) => d[f] || "").filter(Boolean).join("\n\n");
    items.push({
      blockId: "character-" + character.id + "-" + sectionId,
      label: d.name || character.name || "Character",
      content: text,
    });
  };
  const pushPersona = (sectionId) => {
    if (!persona) return;
    const text = [persona.description, persona.personality, persona.scenario]
      .filter(Boolean).join("\n\n");
    items.push({
      blockId: "persona-" + persona.id + "-" + sectionId,
      label: persona.name || "Persona",
      content: text,
    });
  };

  for (const id of orderedIds) {
    const section = sectionsById[id];
    if (!section || section.enabled === false) continue;
    if (section.injectionPosition === "depth") continue;

    if (section.isMarker && section.markerConfig) {
      const cfg = tryParseJSON(section.markerConfig, {});
      switch (cfg.type) {
        case "world_info_before":
          for (const e of beforeEntries) pushEntry(e);
          break;
        case "world_info_after":
          for (const e of afterEntries) pushEntry(e);
          break;
        case "lorebook":
          for (const e of [...beforeEntries, ...afterEntries]) pushEntry(e);
          break;
        case "character":
          pushCharacter(section.id);
          break;
        case "persona":
          pushPersona(section.id);
          break;
        case "chat_history": {
          const allDepth = [
            ...depthSections.map((s) => ({ kind: "section", section: s, depth: s.injectionDepth })),
            ...depthEntries.map((e)  => ({ kind: "entry",   entry: e,    depth: e.depth ?? 0 })),
          ].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
          for (const item of allDepth) {
            if (item.kind === "section") pushSection(item.section);
            else                         pushEntry(item.entry);
          }
          break;
        }
        // Other marker kinds (e.g. dialogue_examples, jailbreak) have no
        // user-supplied content to scan, so we skip them.
      }
    } else {
      pushSection(section);
    }
  }
  return items;
}

// Macro shape check: a valid macro is exactly `{{name}}` — two `{`s, a name
// of word-chars (and a few connectors like `:` for `{{getvar::x}}`), two `}`s.
// We scan for any `\{+ ... \}+` substring whose brace counts aren't both 2 and
// flag those as malformed. Nested-brace typos like `{u{ser}}` are caught by
// this same scan: the inner `{ser}}` matches with 1 open / 2 close, which is
// flagged. Single `{ x }` shapes inside code only get flagged when the inner
// looks like a plain identifier — so `{ return y; }` (with punctuation) is
// safely ignored.
function scanMacroErrors(text) {
  const out = [];
  if (!text) return out;
  const re = /(\{+)([^{}]*)(\}+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open  = m[1].length;
    const close = m[3].length;
    if (open === 2 && close === 2) continue; // valid {{name}}
    const inner = m[2].trim();
    if (!inner) continue; // bare `{}` or `{{}}` — not macro-shaped
    if (!/^[A-Za-z0-9_:.\-\s]+$/.test(inner)) continue; // unlikely to be a macro
    out.push({
      kind: "macro",
      message: `Malformed macro (${open} '{', ${close} '}') — expected {{name}}`,
      snippet: m[0],
    });
  }
  return out;
}

// Stack-walk every <tag> across the concatenated source stream. Comments
// (<!-- ... -->), processing instructions (<?...?>), and self-closing tags
// (<br/>) are ignored. Mismatched closers and unclosed openers each carry
// the blockId of the source they came from so renderBlock can highlight it.
function scanXmlErrors(items) {
  const errors = [];
  const stack = [];
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)\s*([^<>]*?)(\/?)>/g;
  // Skip comments, processing instructions, and backtick-wrapped spans —
  // backtick spans are nearly always referential mentions of a tag (e.g.
  // "refer to `<context>`") rather than real openers/closers, so flagging
  // them produces false positives. Triple-backtick fences first so they
  // win over single-backtick matching inside the same code block.
  const stripRe =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|```[\s\S]*?```|`[^`\n]*`/g;

  for (const it of items) {
    // Replace stripped content with spaces (not "") so snippet positions and
    // any future column reporting stay aligned with the source.
    const text = (it.content || "").replace(stripRe, (m) => " ".repeat(m.length));
    tagRe.lastIndex = 0;
    let m;
    while ((m = tagRe.exec(text)) !== null) {
      const isClose = m[1] === "/";
      const isSelf  = !isClose && m[4] === "/";
      if (isSelf) continue;
      const name = m[2];
      const snippet = m[0];
      if (!isClose) {
        stack.push({ name, snippet, blockId: it.blockId, label: it.label });
      } else {
        const top = stack[stack.length - 1];
        if (top && top.name === name) {
          stack.pop();
          continue;
        }
        // Search for the nearest matching opener; everything above it is
        // unclosed and gets reported in its source block.
        let foundIdx = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === name) { foundIdx = i; break; }
        }
        if (foundIdx >= 0) {
          for (let i = stack.length - 1; i > foundIdx; i--) {
            const orphan = stack[i];
            errors.push({
              blockId: orphan.blockId,
              label: orphan.label,
              kind: "xml-unclosed",
              message: `<${orphan.name}> is never closed`,
              snippet: orphan.snippet,
            });
          }
          stack.length = foundIdx;
        } else {
          errors.push({
            blockId: it.blockId,
            label: it.label,
            kind: "xml-unmatched-close",
            message: `</${name}> has no opener`,
            snippet,
          });
        }
      }
    }
  }
  for (const orphan of stack) {
    errors.push({
      blockId: orphan.blockId,
      label: orphan.label,
      kind: "xml-unclosed",
      message: `<${orphan.name}> is never closed`,
      snippet: orphan.snippet,
    });
  }
  return errors;
}

function resetValidateBtn() {
  const btn = overlayEl && overlayEl.querySelector('[data-action="validate"]');
  if (!btn) return;
  delete btn.dataset.state;
  btn.textContent = "✓ Validate";
}

function runValidation() {
  if (!state.presetFull) {
    showToast("Select a preset first", "error");
    return;
  }
  const items = buildValidationItems();
  const errors = [
    ...scanXmlErrors(items),
    ...items.flatMap((it) =>
      scanMacroErrors(it.content).map((e) => ({
        blockId: it.blockId,
        label: it.label,
        kind: e.kind,
        message: e.message,
        snippet: e.snippet,
      }))
    ),
  ];

  // Auto-check any unselected lorebook entries whose blocks now carry errors,
  // so the highlight is actually visible in the simulated prompt.
  const itemByBlockId = new Map(items.map((it) => [it.blockId, it]));
  let autoChecked = 0;
  for (const err of errors) {
    const it = itemByBlockId.get(err.blockId);
    if (!it || !it.lorebookId || !it.entryId) continue;
    if (!state.selectedEntryIdsByLorebook[it.lorebookId]) {
      state.selectedEntryIdsByLorebook[it.lorebookId] = new Set();
    }
    const checked = state.selectedEntryIdsByLorebook[it.lorebookId];
    if (!checked.has(it.entryId)) {
      checked.add(it.entryId);
      autoChecked++;
    }
  }

  // Group errors by blockId for the per-block UI.
  state.validationErrors = {};
  for (const err of errors) {
    if (!state.validationErrors[err.blockId]) state.validationErrors[err.blockId] = [];
    state.validationErrors[err.blockId].push(err);
  }
  state.validationRanLast = true;
  renderAll();

  const btn = overlayEl && overlayEl.querySelector('[data-action="validate"]');
  if (btn) {
    btn.dataset.state = errors.length ? "errors" : "ok";
    btn.textContent = errors.length
      ? `⚠ ${errors.length} issue${errors.length === 1 ? "" : "s"}`
      : "✓ All clean";
  }

  if (!errors.length) {
    showToast("No XML or macro problems found", "success");
  } else {
    const extra = autoChecked
      ? ` — added ${autoChecked} entr${autoChecked === 1 ? "y" : "ies"} to view`
      : "";
    showToast(`Found ${errors.length} issue${errors.length === 1 ? "" : "s"}${extra}`, "error");
  }
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

  const overlaps = computeEntryOverlaps(blocks);
  for (const b of blocks) {
    middleBodyEl.appendChild(renderBlock(b, overlaps));
  }
}

// Returns a Set of entry IDs whose `order` collides with another displayed
// entry within the same anchor bucket (and same depth, for depth entries).
function computeEntryOverlaps(blocks) {
  const overlap = new Set();
  // Top-level entries (before-char / after-char anchors)
  const topByPosition = new Map(); // position → Map<order, entryId[]>
  for (const b of blocks) {
    if (b.kind !== "lorebook-entry") continue;
    const pos = b.entry.position ?? 0;
    const ord = b.entry.order ?? 0;
    if (!topByPosition.has(pos)) topByPosition.set(pos, new Map());
    const byOrder = topByPosition.get(pos);
    if (!byOrder.has(ord)) byOrder.set(ord, []);
    byOrder.get(ord).push(b.entry.id);
  }
  for (const byOrder of topByPosition.values()) {
    for (const ids of byOrder.values()) {
      if (ids.length > 1) for (const id of ids) overlap.add(id);
    }
  }
  // Depth-injected entries (inside chat-history blocks)
  for (const b of blocks) {
    if (b.kind !== "chat-history") continue;
    const byKey = new Map(); // "depth|order" → entryId[]
    for (const e of b.depthEntries || []) {
      const key = (e.depth ?? 0) + "|" + (e.order ?? 0);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(e.id);
    }
    for (const ids of byKey.values()) {
      if (ids.length > 1) for (const id of ids) overlap.add(id);
    }
  }
  return overlap;
}

function renderBlock(block, overlaps) {
  const el = document.createElement("div");
  el.className = "kaio-block";
  const isReadonly = block.kind === "marker"; // markers w/o resolved content
  el.dataset.readonly = isReadonly ? "true" : "false";
  el.dataset.selected =
    state.inspecting && state.inspecting.id === block.id ? "true" : "false";

  const isOverlapping =
    block.kind === "lorebook-entry" && overlaps && overlaps.has(block.entry.id);
  if (isOverlapping) el.dataset.overlap = "true";

  const validateErrs = state.validationErrors[block.id];
  if (validateErrs && validateErrs.length) el.dataset.validateError = "true";

  const expanded = state.expandedBlocks.has(block.id);
  const previewHTML = blockPreviewHTML(block, expanded);
  const raw = blockPreviewRaw(block);
  // For chat-history we always want the depth substack rendered, but the
  // parent block has no inline body — the runtime hint folds into the head.
  const isChatHistory = block.kind === "chat-history";
  // Compact = render hint inline in the head, no body element. Used for
  // markers (no resolved content), chat-history shell, and any block whose
  // own preview is empty.
  const isCompact = isReadonly || isChatHistory || !previewHTML;
  const headHint = isCompact ? blockEmptyHint(block) : "";

  if (isCompact) el.dataset.compact = "true";

  el.appendChild(renderBlockHead(block, {
    isOverlapping,
    isSubblock: false,
    headHint,
  }));

  if (!isCompact) {
    const body = document.createElement("div");
    body.className = "kaio-block-content";
    if (expanded) body.dataset.expanded = "true";
    body.innerHTML = previewHTML;
    if (needsExpandToggle(raw)) body.dataset.hasToggle = "true";
    el.appendChild(body);
  }

  // Chat history shows nested depth-injected items as sub-blocks
  if (isChatHistory) {
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
    ].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));

    if (all.length) {
      const stack = document.createElement("div");
      stack.className = "kaio-block-substack";
      for (const sub of all) {
        stack.appendChild(renderSubblock(sub, overlaps));
      }
      el.appendChild(stack);
    }
  }

  // Expand/compress toggle: only when there's a body that's actually too big
  // to render at once (or that's been expanded so the user can collapse).
  if (!isCompact && needsExpandToggle(raw)) {
    el.appendChild(makeExpandToggle(block.id, expanded));
  }

  if (validateErrs && validateErrs.length) {
    el.appendChild(renderValidationErrors(validateErrs));
  }

  if (!isReadonly) el.addEventListener("click", () => inspectBlock(block));
  return el;
}

function renderSubblock(sub, overlaps) {
  const subEl = document.createElement("div");
  subEl.className = "kaio-subblock";
  const subOverlap =
    sub.kind === "lorebook-entry" && overlaps && overlaps.has(sub.entry.id);
  if (subOverlap) subEl.dataset.overlap = "true";
  const subErrs = state.validationErrors[sub.id];
  if (subErrs && subErrs.length) subEl.dataset.validateError = "true";
  subEl.dataset.selected =
    state.inspecting && state.inspecting.id === sub.id ? "true" : "false";

  const subExpanded = state.expandedBlocks.has(sub.id);
  const subHTML = blockPreviewHTML(sub, subExpanded);
  const subRaw = blockPreviewRaw(sub);
  const isCompactSub = !subHTML;
  const subHint = isCompactSub ? blockEmptyHint(sub) : "";
  if (isCompactSub) subEl.dataset.compact = "true";

  subEl.appendChild(renderBlockHead(sub, {
    isOverlapping: subOverlap,
    isSubblock: true,
    headHint: subHint,
  }));

  if (!isCompactSub) {
    const subBody = document.createElement("div");
    subBody.className = "kaio-block-content";
    if (subExpanded) subBody.dataset.expanded = "true";
    subBody.innerHTML = subHTML;
    if (needsExpandToggle(subRaw)) subBody.dataset.hasToggle = "true";
    subEl.appendChild(subBody);
    if (needsExpandToggle(subRaw)) {
      subEl.appendChild(makeExpandToggle(sub.id, subExpanded));
    }
  }

  if (subErrs && subErrs.length) {
    subEl.appendChild(renderValidationErrors(subErrs));
  }

  subEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    inspectBlock(sub);
  });
  return subEl;
}

// Whether a block's preview is long enough to warrant the Expand/Compress
// toggle. Mirrors the truncation thresholds used in blockPreviewHTML and the
// 3-line clamp from .kaio-block-content.
function needsExpandToggle(raw) {
  if (!raw) return false;
  if (raw.length > 600) return true;
  // Count newlines — if there are 3+ lines the clamp is doing real work.
  let lines = 1;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10) lines++;
    if (lines > 3) return true;
  }
  return false;
}

function renderValidationErrors(errs) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-block-validate";
  for (const e of errs) {
    const line = document.createElement("div");
    line.className = "kaio-block-validate-line";
    const snippet = e.snippet
      ? ` <code>${escapeHTML(e.snippet)}</code>`
      : "";
    line.innerHTML = `⚠ ${escapeHTML(e.message)}${snippet}`;
    wrap.appendChild(line);
  }
  return wrap;
}

function renderBlockHead(block, { isOverlapping, isSubblock, headHint }) {
  const head = document.createElement("div");
  head.className = "kaio-block-head";
  const tagText = blockTagText(block);
  const role = block.section?.role || (block.entry && block.entry.role) || "";

  let orderHTML = "";
  if (block.kind === "lorebook-entry") {
    const ord = block.entry.order ?? 0;
    orderHTML = `<span class="kaio-block-order"${isOverlapping ? ' data-overlap="true"' : ''}>order ${ord}${isOverlapping ? ' — OVERLAPPING!' : ''}</span>`;
  }

  // For depth-injected sub-blocks, the existing depth label still appears at
  // the right; the order indicator (if any) sits to its left.
  const depthLabel = isSubblock && block.depth !== undefined
    ? `<span class="kaio-block-role">depth ${block.depth}</span>`
    : "";

  // Inline hint replaces the now-removed empty body for compact blocks.
  const hintHTML = headHint
    ? `<span class="kaio-block-head-hint">${escapeHTML(headHint)}</span>`
    : "";

  head.innerHTML = `
    <span class="kaio-block-tag" data-kind="${block.kind}">${tagText}</span>
    <span class="kaio-block-name">${escapeHTML(blockTitle(block))}</span>
    ${hintHTML}
    ${orderHTML}
    ${role && !isSubblock ? `<span class="kaio-block-role">${escapeHTML(role)}</span>` : ""}
    ${depthLabel}
  `;
  return head;
}

function makeExpandToggle(blockId, expanded) {
  const btn = document.createElement("button");
  btn.className = "kaio-expand-toggle";
  btn.type = "button";
  btn.title = expanded ? "Show compressed preview" : "Show full content";
  btn.textContent = expanded ? "Compress" : "Expand";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (state.expandedBlocks.has(blockId)) state.expandedBlocks.delete(blockId);
    else state.expandedBlocks.add(blockId);
    renderMiddle();
  });
  return btn;
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
function blockPreviewRaw(block) {
  if (block.kind === "section")        return block.section.content || "";
  if (block.kind === "lorebook-entry") return block.entry.content || "";
  if (block.kind === "character") {
    const d = block.character.data || {};
    const fields = block.fields || ["description", "personality", "scenario", "system_prompt"];
    return fields.map((f) => d[f] ? `[${f}]\n${d[f]}` : "").filter(Boolean).join("\n\n");
  }
  if (block.kind === "persona") {
    const p = block.persona || {};
    return [p.description, p.personality, p.scenario].filter(Boolean).join("\n\n");
  }
  return "";
}
// Build the HTML body for a block's preview, applying variable substitution
// and respecting per-block expansion state. Returns "" for empty content.
//
// Truncation happens in raw-text space *before* escaping so a `<` in the
// source never gets escaped twice (which would render as the literal "&lt;").
function blockPreviewHTML(block, expanded) {
  const raw = blockPreviewRaw(block);
  if (!raw) return "";
  const text = expanded ? raw : raw.slice(0, 600);
  const subs = activeVariableSubs();
  if (!subs.length) return escapeHTML(text);

  const pattern = subs
    .map((s) => `\\{\\{(?:getvar::)?${escapeRegex(s.name)}\\}\\}`)
    .join("|");
  const re = new RegExp(pattern, "gi");
  let out = "";
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out += escapeHTML(text.slice(lastIdx, m.index));
    const inner = m[0].slice(2, -2); // strip "{{" / "}}"
    const name = inner.replace(/^getvar::/i, "");
    const sub = subs.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const value = sub ? sub.value : "";
    out += `<mark class="kaio-var-preview" title="Preview of {{${escapeHTML(name)}}}">${escapeHTML(value)}</mark>`;
    lastIdx = m.index + m[0].length;
  }
  out += escapeHTML(text.slice(lastIdx));
  return out;
}
function activeVariableSubs() {
  const cbs = (state.presetFull && state.presetFull.choiceBlocks) || [];
  const out = [];
  for (const cb of cbs) {
    const entry = state.variablePreviews[cb.variableName];
    if (!entry || entry.value === undefined || entry.value === null) continue;
    out.push({ name: cb.variableName, value: String(entry.value) });
  }
  return out;
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const savedScroll = rightBodyEl.scrollTop;
  rightBodyEl.innerHTML = "";
  rightFooterEl.innerHTML = "";

  // Variables panel only shows when the currently-inspected block's content
  // references one or more of the preset's choice-block variables. Pure visual
  // preview — never edits anything.
  if (state.inspecting) {
    const referencedVars = collectReferencedVariables(state.inspecting);
    if (referencedVars.length) {
      rightBodyEl.appendChild(renderVariablesPanel(referencedVars));
    }
  }

  if (!state.inspecting || !state.draft) {
    const empty = document.createElement("div");
    empty.className = "kaio-right-empty";
    empty.innerHTML = "Click a block in the simulated prompt to inspect &amp; edit it here.";
    rightBodyEl.appendChild(empty);
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
      // Depth & Order only matter for depth-injected sections — ordered sections
      // are sequenced by the preset's sectionOrder array, so showing the fields
      // would imply they do something they don't.
      if (f.injectionPosition === "depth") {
        rightBodyEl.appendChild(rowOf(
          numberField("Depth", f.injectionDepth, "injectionDepth"),
          numberField("Order", f.injectionOrder, "injectionOrder"),
        ));
      }
      rightBodyEl.appendChild(checkboxField("Enabled", f.enabled, "enabled"));
      break;

    case "lorebook-entry": {
      const matchMode = f.constant ? "constant" : (f.selective ? "selective" : "normal");

      // ── Basic ─────────────────────────────────────
      rightBodyEl.appendChild(sectionHeader("Basic"));
      rightBodyEl.appendChild(field("Name", f.name, "name", "input"));
      rightBodyEl.appendChild(field("Content", f.content, "content", "textarea", null, 6));
      rightBodyEl.appendChild(field("Description", f.description, "description", "textarea",
        "Brief summary used by the Knowledge Router to decide whether to inject this entry. Not sent to the AI as content.", 3));
      rightBodyEl.appendChild(field("Primary keys", f.keys, "keys", "input",
        "Comma-separated keywords that trigger this entry when found in recent chat messages."));
      rightBodyEl.appendChild(field("Secondary keys", f.secondaryKeys, "secondaryKeys", "input",
        "Comma-separated secondary keywords. Used with Selective matching to further filter when this entry fires."));
      rightBodyEl.appendChild(rowOf(
        selectField("Position", String(f.position), "position",
          [["0","before char"],["1","after char"],["2","depth"]]),
        selectField("Role", f.role, "role", ["system", "user", "assistant"]),
      ));
      rightBodyEl.appendChild(rowOf(
        numberField("Depth", f.depth, "depth",
          "How many messages deep to insert this entry when Position is set to depth."),
        numberField("Order", f.order, "order",
          "Insertion order relative to other lorebook entries at the same position. Lower numbers insert first."),
      ));
      rightBodyEl.appendChild(checkboxField("Enabled", f.enabled, "enabled"));
      rightBodyEl.appendChild(matchingModeField(matchMode));
      if (matchMode === "selective") {
        rightBodyEl.appendChild(
          selectField("Selective logic", f.selectiveLogic, "selectiveLogic", ["and", "or", "not"],
            "How primary and secondary keys are combined. AND = both must match, OR = either, NOT = primary matches but secondary does not."),
        );
      }

      // ── Matching options ──────────────────────────
      rightBodyEl.appendChild(sectionHeader("Matching options"));
      rightBodyEl.appendChild(rowOf(
        nullableNumberField("Probability", f.probability, "probability",
          { step: "0.05", min: 0, max: 1 },
          "Chance this entry is injected each time it triggers (0–100%). Leave empty to always inject when matched."),
        nullableNumberField("Scan depth", f.scanDepth, "scanDepth",
          { step: "1", min: 0 },
          "How many messages back to scan for keywords. Leave empty to use the global lorebook default."),
      ));
      rightBodyEl.appendChild(rowOf(
        checkboxField("Match whole words", f.matchWholeWords, "matchWholeWords",
          "Only trigger on whole-word matches. Prevents partial matches like 'cat' matching 'scatter'."),
        checkboxField("Case sensitive", f.caseSensitive, "caseSensitive"),
      ));
      rightBodyEl.appendChild(checkboxField("Treat keys as regex", f.useRegex, "useRegex",
        "Interpret primary and secondary keys as regular expressions instead of plain text."));

      // ── Context filters ───────────────────────────
      rightBodyEl.appendChild(sectionHeader("Context filters"));
      rightBodyEl.appendChild(rowOf(
        selectField("Character mode", f.characterFilterMode, "characterFilterMode",
          ["any", "include", "exclude"]),
        field("Character IDs", f.characterFilterIds, "characterFilterIds", "input",
          "Comma-separated character IDs. Used when Character mode is include or exclude."),
      ));
      rightBodyEl.appendChild(rowOf(
        selectField("Tag mode", f.characterTagFilterMode, "characterTagFilterMode",
          ["any", "include", "exclude"]),
        field("Character tags", f.characterTagFilters, "characterTagFilters", "input",
          "Comma-separated character tags. Used when Tag mode is include or exclude."),
      ));
      rightBodyEl.appendChild(rowOf(
        selectField("Trigger mode", f.generationTriggerFilterMode, "generationTriggerFilterMode",
          ["any", "include", "exclude"]),
        field("Generation triggers", f.generationTriggerFilters, "generationTriggerFilters", "input",
          "Comma-separated generation contexts to filter on, e.g. chat, game."),
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
        nullableNumberField("Sticky", f.sticky, "sticky", { step: "1", min: 0 },
          "Keep this entry injected for N turns after it triggers, even if keywords stop matching."),
        nullableNumberField("Cooldown", f.cooldown, "cooldown", { step: "1", min: 0 },
          "Block this entry from triggering again for N turns after it was last injected."),
      ));
      rightBodyEl.appendChild(rowOf(
        nullableNumberField("Delay", f.delay, "delay", { step: "1", min: 0 },
          "Wait N turns after a keyword match before injecting this entry."),
        nullableNumberField("Ephemeral", f.ephemeral, "ephemeral", { step: "1", min: 0 },
          "Automatically remove this entry from context after N turns."),
      ));

      // ── Group & Tag ──────────────────────────────
      rightBodyEl.appendChild(sectionHeader("Group & Tag"));
      rightBodyEl.appendChild(rowOf(
        field("Group", f.group, "group", "input",
          "Group name for mutual-exclusion logic. Only one entry per group fires per turn."),
        nullableNumberField("Group weight", f.groupWeight, "groupWeight", { step: "0.1" },
          "Weighted probability for selection within a group. Higher = more likely to be chosen."),
      ));
      rightBodyEl.appendChild(rowOf(
        field("Tag", f.tag, "tag", "input"),
        field("Folder ID", f.folderId, "folderId", "input"),
      ));

      // ── Advanced ─────────────────────────────────
      rightBodyEl.appendChild(sectionHeader("Advanced"));
      rightBodyEl.appendChild(rowOf(
        checkboxField("Prevent recursion", f.preventRecursion, "preventRecursion",
          "Stop this entry's content from being scanned for additional lorebook keyword matches."),
        checkboxField("Locked", f.locked, "locked",
          "Lock this entry to prevent it from being edited in the regular lorebook UI."),
      ));
      break;
    }

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
  requestAnimationFrame(() => { rightBodyEl.scrollTop = savedScroll; });
}

// ── Field constructors ──────────────────────────────────
function tipIcon(text) {
  const s = document.createElement("span");
  s.className = "kaio-tip";
  s.dataset.tip = text;
  s.textContent = "?";
  return s;
}
function applyLabel(lab, label, tooltip) {
  const txt = document.createElement("span");
  txt.textContent = label;
  lab.appendChild(txt);
  if (tooltip) lab.appendChild(tipIcon(tooltip));
}
function field(label, value, key, type, tooltip, rows) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  applyLabel(lab, label, tooltip);
  wrap.appendChild(lab);
  let input;
  if (type === "textarea") {
    input = document.createElement("textarea");
    input.className = "kaio-textarea";
    input.rows = rows ?? 8;
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
function numberField(label, value, key, tooltip) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  applyLabel(lab, label, tooltip);
  wrap.appendChild(lab);
  const input = document.createElement("input");
  input.className = "kaio-input";
  input.type = "number";
  input.value = String(value ?? 0);
  input.addEventListener("input", () => onFieldChange(key, Number(input.value) || 0));
  wrap.appendChild(input);
  return wrap;
}
function nullableNumberField(label, value, key, attrs, tooltip) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  applyLabel(lab, label, tooltip);
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
function selectField(label, value, key, options, tooltip) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  applyLabel(lab, label, tooltip);
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
function checkboxField(label, value, key, tooltip) {
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
  if (tooltip) wrap.appendChild(tipIcon(tooltip));
  return wrap;
}
function matchingModeField(currentMode) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("div");
  lab.className = "kaio-field-label";
  applyLabel(lab, "Matching mode", "Controls when this entry is injected. Normal: keyword-triggered. Selective: requires secondary key match. Constant: always injected regardless of keywords.");
  wrap.appendChild(lab);
  const row = document.createElement("div");
  row.className = "kaio-match-mode";
  for (const [mode, label] of [["normal","Normal"],["selective","Selective"],["constant","Constant"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kaio-match-btn";
    btn.dataset.mode = mode;
    btn.dataset.active = String(currentMode === mode);
    const orb = document.createElement("span");
    orb.className = "kaio-match-orb";
    orb.dataset.mode = mode;
    btn.appendChild(orb);
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener("click", () => onFieldChange("matchingMode", mode));
    row.appendChild(btn);
  }
  wrap.appendChild(row);
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
// Returns the parsed option array for a choice block (the API returns it as a
// JSON-encoded text column, but tolerate it already being an array).
function choiceBlockOptions(cb) {
  if (Array.isArray(cb.options)) return cb.options;
  return tryParseJSON(cb.options, []);
}

// Returns the choice blocks whose `{{varName}}` (or `{{getvar::varName}}`) is
// referenced in the inspected block's source text. Used to scope the
// variables panel to only what's actually relevant to the selection.
function collectReferencedVariables(block) {
  const cbs = (state.presetFull && state.presetFull.choiceBlocks) || [];
  if (!cbs.length || !block) return [];
  const text = blockPreviewRaw(block);
  if (!text) return [];
  const out = [];
  for (const cb of cbs) {
    const re = new RegExp(
      "\\{\\{(?:getvar::)?" + escapeRegex(cb.variableName) + "\\}\\}",
      "i",
    );
    if (re.test(text)) out.push(cb);
  }
  return out;
}

// Variables panel — pick an option for live substitution in the Simulated
// Prompt, then optionally edit that option's value and save back to the preset.
function renderVariablesPanel(cbs) {
  if (!cbs || !cbs.length) return null;

  const wrap = document.createElement("div");
  wrap.className = "kaio-vars-panel";
  if (state.variablesPanelCollapsed) wrap.dataset.collapsed = "true";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "kaio-vars-header";
  header.innerHTML = `
    <span class="kaio-vars-caret">▾</span>
    <span class="kaio-vars-title">Preset variables</span>
    <span class="kaio-vars-count">${cbs.length}</span>
  `;
  header.addEventListener("click", () => {
    state.variablesPanelCollapsed = !state.variablesPanelCollapsed;
    renderRight();
  });
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "kaio-vars-body";

  const help = document.createElement("div");
  help.className = "kaio-field-help";
  help.textContent = "Pick an option to substitute it in the Simulated Prompt. While an option is selected, its value can be edited and saved.";
  body.appendChild(help);

  for (const cb of cbs) {
    body.appendChild(renderVariableRow(cb));
  }
  wrap.appendChild(body);
  return wrap;
}

function renderVariableRow(cb) {
  const row = document.createElement("div");
  row.className = "kaio-field kaio-vars-row";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  lab.textContent = `{{${cb.variableName}}}`;
  if (cb.question) lab.title = cb.question;
  row.appendChild(lab);

  const opts = choiceBlockOptions(cb);
  const sel = document.createElement("select");
  sel.className = "kaio-select";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— No preview —";
  sel.appendChild(blank);
  const current = state.variablePreviews[cb.variableName];
  for (const opt of opts) {
    const o = document.createElement("option");
    o.value = opt.id || opt.value || "";
    o.textContent = opt.label || opt.value || opt.id || "(unnamed option)";
    if (current && current.optionId === o.value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => {
    const optId = sel.value;
    if (!optId) {
      delete state.variablePreviews[cb.variableName];
    } else {
      const picked = opts.find((o) => (o.id || o.value) === optId);
      const value = picked ? picked.value : "";
      state.variablePreviews[cb.variableName] = {
        cbId: cb.id,
        optionId: optId,
        value,
        savedValue: value,
      };
    }
    renderRight();   // re-render so the editor textarea appears/disappears
    renderMiddle();
  });
  row.appendChild(sel);

  // If an option is currently selected, expose an editable textarea for its
  // value. Edits are live-substituted in the middle column; Save persists the
  // change back through the preset's choice-block API.
  if (current && current.optionId) {
    const ta = document.createElement("textarea");
    ta.className = "kaio-textarea kaio-vars-edit";
    ta.rows = 4;
    ta.value = current.value ?? "";
    ta.addEventListener("input", () => {
      current.value = ta.value;
      // Update Save / Revert button states without a full re-render so the
      // textarea keeps its caret position.
      const dirty = current.value !== current.savedValue;
      const saveBtn = row.querySelector('[data-act="vsave"]');
      const revertBtn = row.querySelector('[data-act="vrevert"]');
      if (saveBtn) saveBtn.disabled = !dirty;
      if (revertBtn) revertBtn.disabled = !dirty;
      renderMiddle();
    });
    row.appendChild(ta);

    const actions = document.createElement("div");
    actions.className = "kaio-vars-actions";
    const dirty = current.value !== current.savedValue;

    const revertBtn = document.createElement("button");
    revertBtn.type = "button";
    revertBtn.className = "kaio-btn";
    revertBtn.dataset.act = "vrevert";
    revertBtn.textContent = "Revert";
    revertBtn.disabled = !dirty;
    revertBtn.addEventListener("click", () => {
      current.value = current.savedValue;
      ta.value = current.savedValue;
      renderRight();
      renderMiddle();
    });
    actions.appendChild(revertBtn);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "kaio-btn kaio-btn-primary";
    saveBtn.dataset.act = "vsave";
    saveBtn.textContent = "Save";
    saveBtn.disabled = !dirty;
    saveBtn.addEventListener("click", () => saveVariableOption(cb));
    actions.appendChild(saveBtn);
    row.appendChild(actions);
  }
  return row;
}

async function saveVariableOption(cb) {
  const presetId = state.presetFull && state.presetFull.preset && state.presetFull.preset.id;
  const entry = state.variablePreviews[cb.variableName];
  if (!presetId || !entry) return;
  // Build the new options array, replacing the edited option's value.
  const opts = choiceBlockOptions(cb).map((o) => {
    if ((o.id || o.value) === entry.optionId) return { ...o, value: entry.value };
    return o;
  });
  try {
    await api("PATCH", "/prompts/" + presetId + "/variables/" + cb.id, {
      options: opts,
    });
    await loadPresetFull(presetId);
    // Re-anchor the preview entry to the freshly-loaded option (savedValue
    // catches up). cbId / optionId may be the same; refresh defensively.
    const fresh = (state.presetFull.choiceBlocks || []).find((c) => c.id === cb.id);
    if (fresh) {
      const freshOpts = choiceBlockOptions(fresh);
      const picked = freshOpts.find((o) => (o.id || o.value) === entry.optionId);
      if (picked) {
        state.variablePreviews[cb.variableName] = {
          cbId: fresh.id,
          optionId: entry.optionId,
          value: picked.value,
          savedValue: picked.value,
        };
      }
    }
    renderAll();
    showToast("Saved ✓", "success");
  } catch (err) {
    console.error("[kolache-AIO] Variable save failed", err);
    showToast("Save failed — see console", "error");
  }
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
  if (key === "matchingMode") {
    state.draft.fields.constant = value === "constant";
    state.draft.fields.selective = value === "selective";
  } else {
    state.draft.fields[key] = value;
  }
  state.isDirty = isDraftDirty();
  // Section's injectionPosition toggles whether the Depth/Order row is
  // rendered, so re-render the whole inspector when it changes. Other fields
  // can patch the footer in place to preserve focus / caret.
  if ((state.draft.kind === "section" && key === "injectionPosition") ||
      key === "matchingMode") {
    renderRight();
    return;
  }
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
        const fresh = normalizeCharacter(await api("GET", "/characters/" + d.sourceId));
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
