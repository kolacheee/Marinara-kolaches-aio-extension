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

// ── API layer ──────────────────────────────────────────────────
// Marinara Engine 2.0.0 serves a same-origin REST API under /api and installs
// a global fetch CSRF shim, so a plain fetch("/api/...") is all we need — the
// shim adds the CSRF header to our POST/PATCH/PUT/DELETE calls automatically.
// (We avoid marinara.apiFetch: it always calls res.json(), which throws on the
// 204 No Content responses our DELETE / reorder calls rely on.)
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
  if (s !== null && s !== undefined && typeof s !== "string") return s;
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

// Coerce lorebook entry fields that the extension compares with === to
// numbers. Also applies Marinara's order/sortOrder fallback and defaults
// missing position/depth/order so entries always have usable values.
function normalizeEntry(e) {
  if (!e || typeof e !== "object") return e;
  // Marinara 2.0.0 uses `order`; fall back to `sortOrder` for older builds.
  const rawOrder = e.order ?? e.sortOrder ?? 0;
  e.order = Number(rawOrder) || 0;
  e.position = Number(e.position ?? 0) || 0;
  // NaN-safe: depth 0 is valid, so use explicit isNaN check
  e.depth = isNaN(Number(e.depth)) ? 0 : Number(e.depth);
  return e;
}

// Marinara 2.0.0 persists prompt-section booleans as the STRINGS "true"/"false"
// (the server stringifies on write and never re-parses on read). Strict checks
// like `section.enabled !== false` would treat the string "false" as enabled,
// so a disabled section would wrongly render in the Simulated Prompt. Coerce the
// booleans the extension compares back into real booleans. Idempotent — leaves
// values that are already booleans untouched.
function normalizeSection(s) {
  if (!s || typeof s !== "object") return s;
  if (typeof s.enabled === "string") s.enabled = s.enabled !== "false";
  if (typeof s.isMarker === "string") s.isMarker = s.isMarker === "true";
  return s;
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
  lorebookFolders: {},           // lorebookId → folders[]
  selectedFolderIdsByLorebook: {}, // {lorebookId → Set<folderId>}
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
  middleFilter: "",              // Simulated Prompt search/filter query (transient)

  // Validation: { blockId → [{ kind, message, snippet }, ...] }
  // Cleared on Reload, source-switch, and Save. Repopulated by clicking
  // the Validate button in the middle column header.
  validationErrors: {},
  validationRanLast: false,      // true once Validate has run at least once

  // Folder batch-add UI state (reset on inspect switch)
  folderBatchAdd: { showNested: false, selected: new Set() },

  // Collapsible states for inspector sections
  presetEditorCollapsed: { overview: false, sections: false, variables: false },
  lbEditorCollapsed: { overview: false },
  lbInspectorCollapsed: { basic: false, matching: true, contextFilters: true, matchingSources: true, timing: true, groupTag: true, advanced: true },
  presetGroupBatchAdd: { groupId: null, selected: new Set() },
  // Which variable is expanded in the preset variables panel (null = none)
  presetExpandedVariableId: null,
};

// ── DOM refs (populated by buildConsole) ──────────────────────
let overlayEl = null;
let leftBodyEl = null;
let middleBodyEl = null;
let tokenGaugeEl = null;
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
  matchTopbarButtonShape(btn, nav);
  return true;
}

// Copy a neighbouring nav button's rendered box (size + corner radius + padding)
// onto ours so the hover / active highlight matches the engine's buttons
// exactly. The engine's Tailwind classes for these buttons vary between builds
// (e.g. p-1.5/rounded-xl vs p-2/rounded-lg), so we measure rather than hard-code.
// Falls back to the stylesheet rule if no sibling is laid out yet.
function matchTopbarButtonShape(btn, nav) {
  try {
    const sib = nav.querySelector("button:not(.kaio-tab-btn)");
    if (!sib) return;
    const rect = sib.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cs = getComputedStyle(sib);
    btn.style.boxSizing = "border-box";
    btn.style.width = rect.width + "px";
    btn.style.height = rect.height + "px";
    btn.style.padding = cs.padding;
    btn.style.borderRadius = cs.borderRadius;
  } catch {
    /* non-fatal — fall back to the .kaio-tab-btn stylesheet rule */
  }
}

// ── Extension-card 🥞 button (injected into Settings → Extensions) ──
function tryInjectExtensionLauncher() {
  if (document.querySelector(".kaio-ext-launcher")) return;
  const nameSpans = document.querySelectorAll(".truncate.font-medium");
  for (const span of nameSpans) {
    if (!span.textContent || !span.textContent.includes("kolache")) continue;
    if (span.closest(".kaio-overlay")) continue;
    const card = span.closest(".rounded-lg");
    if (!card) continue;
    const btn = document.createElement("button");
    btn.className = "kaio-ext-launcher";
    btn.title = "Open kolache's AIO Console";
    btn.innerHTML = "🥞";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openConsole();
    });
    const trashBtn = card.querySelector('[title="Remove extension"]');
    if (trashBtn) card.insertBefore(btn, trashBtn);
    else card.appendChild(btn);
    return;
  }
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
        <button class="kaio-iconbtn" data-action="inspect" title="Inspect the full prompt as it would be sent to the API">🔍 Inspect</button>
        <button class="kaio-iconbtn" data-action="refresh" title="Reload sources">↻ Reload</button>
        <button class="kaio-iconbtn" data-action="settings" title="AIO settings">⚙️</button>
        <button class="kaio-iconbtn" data-action="close" title="Close (Esc)">✕</button>
      </div>
      <nav class="kaio-mobile-tabs" aria-label="Panel tabs">
        <button class="kaio-mobile-tab" data-tab="left"   data-active="true">Sources</button>
        <button class="kaio-mobile-tab" data-tab="middle">Prompt</button>
        <button class="kaio-mobile-tab" data-tab="right">Editor</button>
      </nav>
      <div class="kaio-body" data-active-tab="left">
        <section class="kaio-col kaio-col-left" data-col="left">
          <header class="kaio-col-header">
            <h3>Sources</h3>
            <p>Pick one of each. Add lorebooks below.</p>
          </header>
          <div class="kaio-col-body" data-region="left"></div>
        </section>
        <section class="kaio-col kaio-col-middle" data-col="middle">
          <header class="kaio-col-header">
            <div class="kaio-col-header-row">
              <div class="kaio-col-header-text">
                <h3>Simulated Prompt</h3>
                <p>Click any block to edit it on the right.</p>
              </div>
              <div class="kaio-col-header-actions">
                <button class="kaio-col-header-btn" data-action="validate"
                        title="Scan all sources for unbalanced XML tags and broken macros">
                  ✓ Validate
                </button>
              </div>
            </div>
            <div class="kaio-middle-search">
              <span class="kaio-middle-search-icon">🔍</span>
              <input type="search" class="kaio-middle-search-input" data-action="filter"
                     placeholder="Filter blocks by name or content…" aria-label="Filter simulated prompt blocks" />
              <button class="kaio-middle-search-clear" data-action="filter-clear" title="Clear filter" hidden>✕</button>
            </div>
            <div class="kaio-token-gauge" data-region="token-gauge" data-empty="true"></div>
          </header>
          <div class="kaio-col-body" data-region="middle"></div>
        </section>
        <section class="kaio-col kaio-col-right" data-col="right">
          <header class="kaio-col-header">
            <h3>Editor</h3>
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
  tokenGaugeEl  = overlayEl.querySelector('[data-region="token-gauge"]');
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
      await loadLorebookFolders(lbId);
    }
    if (state.selectedCharacterId) await loadCharacter(state.selectedCharacterId);
    if (state.selectedPersonaId) await loadPersona(state.selectedPersonaId);
    state.validationErrors = {};
    state.validationRanLast = false;
    resetValidateBtn();
    renderAll();
    showToast("Reloaded", "success");
  });
  overlayEl.querySelector('[data-action="inspect"]').addEventListener("click", () => openPromptInspector());
  overlayEl.querySelector('[data-action="settings"]').addEventListener("click", () => showSettings());
  overlayEl.querySelector('[data-action="validate"]').addEventListener(
    "click",
    runValidation,
  );

  // Simulated Prompt filter — re-renders only the middle body, so the input
  // (which lives in the static header) keeps focus while typing.
  const filterInput = overlayEl.querySelector('[data-action="filter"]');
  const filterClear = overlayEl.querySelector('[data-action="filter-clear"]');
  filterInput.addEventListener("input", () => {
    state.middleFilter = filterInput.value;
    filterClear.hidden = !filterInput.value;
    renderMiddle();
  });
  filterInput.addEventListener("keydown", (e) => {
    // Esc clears the filter first; only closes the console when already empty.
    if (e.key === "Escape" && filterInput.value) {
      e.stopPropagation();
      filterInput.value = "";
      state.middleFilter = "";
      filterClear.hidden = true;
      renderMiddle();
    }
  });
  filterClear.addEventListener("click", () => {
    filterInput.value = "";
    state.middleFilter = "";
    filterClear.hidden = true;
    renderMiddle();
    filterInput.focus();
  });

  // Mobile tab switching
  overlayEl.querySelector(".kaio-mobile-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".kaio-mobile-tab");
    if (!tab) return;
    const key = tab.dataset.tab;
    const body = overlayEl.querySelector(".kaio-body");
    body.dataset.activeTab = key;
    for (const t of overlayEl.querySelectorAll(".kaio-mobile-tab")) {
      t.dataset.active = t.dataset.tab === key ? "true" : "";
    }
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
  await restoreSelection();
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
  if (overlayEl) {
    // Tear down any open Prompt Inspector modal / Include-Omit dialog so their
    // document-level keydown listeners don't leak past the console closing.
    overlayEl.querySelectorAll(".kaio-pi-bg, .kaio-confirm-bg").forEach((el) => {
      if (typeof el._kaioClose === "function") el._kaioClose();
      else el.remove();
    });
    overlayEl.dataset.open = "false";
  }
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
  const full = await api("GET", "/prompts/" + id + "/full").catch((e) => {
    console.error(e); showToast("Couldn't load preset", "error"); return null;
  });
  if (full && Array.isArray(full.sections)) full.sections = full.sections.map(normalizeSection);
  state.presetFull = full;
}
async function loadLorebookEntries(id) {
  const list = await api("GET", "/lorebooks/" + id + "/entries").catch((e) => {
    console.error(e); showToast("Couldn't load entries", "error"); return [];
  });
  state.lorebookEntries[id] = Array.isArray(list) ? list.map(normalizeEntry) : [];
}
async function loadLorebookFolders(id) {
  const list = await api("GET", "/lorebooks/" + id + "/folders").catch((e) => {
    console.error(e); return [];
  });
  state.lorebookFolders[id] = Array.isArray(list) ? list : [];
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

// ── Remember last selection (persisted across opens) ───────────
const KAIO_SELECTION_KEY = "kaio-selection";
function persistSelection() {
  try {
    const entries = {};
    for (const [lbId, set] of Object.entries(state.selectedEntryIdsByLorebook)) {
      if (set && set.size) entries[lbId] = [...set];
    }
    const folders = {};
    for (const [lbId, set] of Object.entries(state.selectedFolderIdsByLorebook)) {
      if (set && set.size) folders[lbId] = [...set];
    }
    localStorage.setItem(KAIO_SELECTION_KEY, JSON.stringify({
      presetId: state.selectedPresetId,
      lorebookIds: state.selectedLorebookIds,
      activeLorebookId: state.activeLorebookId,
      characterId: state.selectedCharacterId,
      personaId: state.selectedPersonaId,
      entries,
      folders,
    }));
  } catch { /* ignore */ }
}
// Restore the saved selection, but only IDs that still exist in the freshly
// loaded sources (so deleted presets/lorebooks/etc. are quietly dropped).
async function restoreSelection() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KAIO_SELECTION_KEY) || "null"); } catch { saved = null; }
  if (!saved || typeof saved !== "object") return;

  if (saved.presetId && state.presets.some((p) => p.id === saved.presetId)) {
    state.selectedPresetId = saved.presetId;
    await loadPresetFull(saved.presetId);
  }

  const validLbIds = Array.isArray(saved.lorebookIds)
    ? saved.lorebookIds.filter((id) => state.lorebooks.some((lb) => lb.id === id))
    : [];
  state.selectedLorebookIds = validLbIds;
  state.activeLorebookId =
    saved.activeLorebookId && validLbIds.includes(saved.activeLorebookId)
      ? saved.activeLorebookId
      : (validLbIds[validLbIds.length - 1] || null);
  for (const lbId of validLbIds) {
    await loadLorebookEntries(lbId);
    await loadLorebookFolders(lbId);
    const entries = state.lorebookEntries[lbId] || [];
    const savedEntries = (saved.entries && saved.entries[lbId]) || [];
    state.selectedEntryIdsByLorebook[lbId] = new Set(savedEntries.filter((eid) => entries.some((e) => e.id === eid)));
    const folders = state.lorebookFolders[lbId] || [];
    const savedFolders = (saved.folders && saved.folders[lbId]) || [];
    state.selectedFolderIdsByLorebook[lbId] = new Set(savedFolders.filter((fid) => folders.some((f) => f.id === fid)));
  }

  if (saved.characterId && state.characters.some((c) => c.id === saved.characterId)) {
    state.selectedCharacterId = saved.characterId;
    await loadCharacter(saved.characterId);
  }
  if (saved.personaId && state.personas.some((p) => p.id === saved.personaId)) {
    state.selectedPersonaId = saved.personaId;
    await loadPersona(saved.personaId);
  }
}

// ── Rendering ─────────────────────────────────────────────────
function renderAll() {
  renderLeft();
  renderMiddle();
  renderRight();
  persistSelection();
}

// LEFT — source pickers
function renderLeft() {
  if (!leftBodyEl) return;
  leftBodyEl.innerHTML = "";

  const presetPicker = renderSourcePicker({
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
  });
  if (state.selectedPresetId && state.presetFull) {
    const sel = presetPicker.querySelector(".kaio-select");
    if (sel) {
      const row = document.createElement("div");
      row.className = "kaio-source-select-row";
      sel.parentNode.insertBefore(row, sel);
      row.appendChild(sel);
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "kaio-folder-edit-btn";
      editBtn.innerHTML = "✏️";
      editBtn.title = "Edit preset properties";
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        inspectBlock({ kind: "preset-editor", id: "preset-editor" });
      });
      row.appendChild(editBtn);
    }
  }
  leftBodyEl.appendChild(presetPicker);

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
        if (!state.lorebookFolders[newId]) await loadLorebookFolders(newId);
      } else if (!newId) {
        // Removing this lorebook from the selection
        state.selectedLorebookIds = state.selectedLorebookIds.filter((id) => id !== currentId);
        delete state.selectedEntryIdsByLorebook[currentId];
        delete state.lorebookFolders[currentId];
        delete state.selectedFolderIdsByLorebook[currentId];
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
        delete state.lorebookFolders[currentId];
        delete state.selectedFolderIdsByLorebook[currentId];
        state.activeLorebookId = newId;
        if (!state.lorebookEntries[newId]) await loadLorebookEntries(newId);
        if (!state.lorebookFolders[newId]) await loadLorebookFolders(newId);
      }
      renderAll();
    });
    rowHeader.appendChild(sel);
    if (currentId) {
      const lbEditBtn = document.createElement("button");
      lbEditBtn.type = "button";
      lbEditBtn.className = "kaio-folder-edit-btn";
      lbEditBtn.innerHTML = "✏️";
      lbEditBtn.title = "Edit lorebook properties";
      lbEditBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const lb = state.lorebooks.find((l) => l.id === currentId);
        if (lb) inspectBlock({ kind: "lorebook-editor", id: "lorebook-editor-" + currentId, lorebook: lb });
      });
      rowHeader.appendChild(lbEditBtn);
    }
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
  const wrap = document.createElement("div");
  wrap.className = "kaio-lb-content";

  const list = document.createElement("div");
  list.className = "kaio-entrylist";
  const entries = state.lorebookEntries[lorebookId] || [];
  const folders = state.lorebookFolders[lorebookId] || [];

  if (!entries.length && !folders.length) {
    list.innerHTML = '<div class="kaio-entrylist-empty">No entries in this lorebook.</div>';
    wrap.appendChild(list);
    wrap.appendChild(renderCreateActions(lorebookId));
    return wrap;
  }

  if (!state.selectedEntryIdsByLorebook[lorebookId]) {
    state.selectedEntryIdsByLorebook[lorebookId] = new Set();
  }
  if (!state.selectedFolderIdsByLorebook[lorebookId]) {
    state.selectedFolderIdsByLorebook[lorebookId] = new Set();
  }
  const checkedSet = state.selectedEntryIdsByLorebook[lorebookId];
  const folderSet = state.selectedFolderIdsByLorebook[lorebookId];

  // ── Folders at the top ────────────────────────
  const sortedFolders = [...folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const folder of sortedFolders) {
    const folderEntries = entries.filter((e) => e.folderId === folder.id);
    const isChecked = folderSet.has(folder.id);

    const item = document.createElement("div");
    item.className = "kaio-folder-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isChecked;
    cb.addEventListener("change", async (ev) => {
      if (await guardDirty() === false) {
        ev.target.checked = !ev.target.checked;
        return;
      }
      if (cb.checked) {
        folderSet.add(folder.id);
        for (const e of folderEntries) checkedSet.add(e.id);
      } else {
        folderSet.delete(folder.id);
        for (const e of folderEntries) checkedSet.delete(e.id);
      }
      renderLeft();
      renderMiddle();
    });
    item.appendChild(cb);

    const icon = document.createElement("span");
    icon.className = "kaio-folder-icon";
    icon.textContent = "📁";
    item.appendChild(icon);

    const nameEl = document.createElement("span");
    nameEl.className = "kaio-folder-name";
    nameEl.textContent = folder.name || "(unnamed folder)";
    item.appendChild(nameEl);

    const count = document.createElement("span");
    count.className = "kaio-folder-count";
    count.textContent = String(folderEntries.length);
    item.appendChild(count);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "kaio-folder-edit-btn";
    editBtn.innerHTML = "✏️";
    editBtn.title = "Edit folder";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      inspectBlock({
        kind: "folder",
        id: "folder-" + folder.id,
        folder: folder,
        lorebookId: lorebookId,
      });
    });
    item.appendChild(editBtn);

    list.appendChild(item);
  }

  // Divider between folders and entries
  if (sortedFolders.length && entries.length) {
    const divider = document.createElement("div");
    divider.className = "kaio-entrylist-divider";
    list.appendChild(divider);
  }

  // ── Entries ───────────────────────────────────
  const sorted = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const e of sorted) {
    const item = document.createElement("label");
    item.className = "kaio-entry-item";
    const checked = checkedSet.has(e.id);
    const positionLabel = positionToLabel(e.position);
    const folder = e.folderId ? folders.find((f) => f.id === e.folderId) : null;
    const folderTag = folder
      ? `<span class="kaio-entry-folder-tag" title="In folder: ${escapeHTML(folder.name || "")}">📁</span>`
      : "";
    item.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""}>
      <div style="flex:1;min-width:0;">
        <div class="kaio-entry-name">${escapeHTML(e.name || "(unnamed)")}</div>
        <div class="kaio-entry-meta">
          ${folderTag}
          <span class="kaio-entry-position">${positionLabel}</span>
          <span>order ${e.order ?? 0}</span>
          ${e.position === 2 ? `<span>depth ${e.depth ?? 0}</span>` : ""}
          ${e.role && e.role !== "system" ? `<span>${escapeHTML(e.role)}</span>` : ""}
        </div>
      </div>
    `;
    item.querySelector("input").addEventListener("change", async (ev) => {
      if (await guardDirty() === false) {
        ev.target.checked = !ev.target.checked;
        return;
      }
      if (ev.target.checked) checkedSet.add(e.id);
      else {
        checkedSet.delete(e.id);
        if (e.folderId && folderSet.has(e.folderId)) {
          folderSet.delete(e.folderId);
          renderLeft();
        }
      }
      renderMiddle();
    });
    list.appendChild(item);
  }

  wrap.appendChild(list);
  wrap.appendChild(renderCreateActions(lorebookId));
  return wrap;
}

function renderCreateActions(lorebookId) {
  const actions = document.createElement("div");
  actions.className = "kaio-create-actions";

  const folderBtn = document.createElement("button");
  folderBtn.type = "button";
  folderBtn.className = "kaio-create-btn";
  folderBtn.textContent = "+ Folder";
  folderBtn.addEventListener("click", () => createFolder(lorebookId));
  actions.appendChild(folderBtn);

  const entryBtn = document.createElement("button");
  entryBtn.type = "button";
  entryBtn.className = "kaio-create-btn";
  entryBtn.textContent = "+ Entry";
  entryBtn.addEventListener("click", () => createEntry(lorebookId));
  actions.appendChild(entryBtn);

  return actions;
}

async function createFolder(lorebookId) {
  if (await guardDirty() === false) return;
  try {
    const folder = await api("POST", "/lorebooks/" + lorebookId + "/folders", { name: "New Folder" });
    await loadLorebookFolders(lorebookId);
    if (folder && folder.id) {
      const fresh = (state.lorebookFolders[lorebookId] || []).find((f) => f.id === folder.id) || folder;
      inspectBlock({ kind: "folder", id: "folder-" + fresh.id, folder: fresh, lorebookId });
    }
    renderLeft();
    showToast("Folder created", "success");
  } catch (err) {
    console.error("[kolache-AIO] Create folder failed", err);
    showToast("Failed to create folder", "error");
  }
}

async function createEntry(lorebookId) {
  if (await guardDirty() === false) return;
  try {
    const entry = await api("POST", "/lorebooks/" + lorebookId + "/entries", { name: "New Entry" });
    await loadLorebookEntries(lorebookId);
    if (entry && entry.id) {
      if (!state.selectedEntryIdsByLorebook[lorebookId]) {
        state.selectedEntryIdsByLorebook[lorebookId] = new Set();
      }
      state.selectedEntryIdsByLorebook[lorebookId].add(entry.id);
      const fresh = (state.lorebookEntries[lorebookId] || []).find((e) => e.id === entry.id) || entry;
      inspectBlock({ kind: "lorebook-entry", id: "entry-" + fresh.id, section: null, entry: fresh });
    }
    renderAll();
    showToast("Entry created", "success");
  } catch (err) {
    console.error("[kolache-AIO] Create entry failed", err);
    showToast("Failed to create entry", "error");
  }
}

function syncFolderSelections(lorebookId) {
  const folderSet = state.selectedFolderIdsByLorebook[lorebookId];
  if (!folderSet || !folderSet.size) return;
  const entries = state.lorebookEntries[lorebookId] || [];
  const checkedSet = state.selectedEntryIdsByLorebook[lorebookId];
  if (!checkedSet) return;
  for (const e of entries) {
    if (e.folderId && folderSet.has(e.folderId)) {
      checkedSet.add(e.id);
    }
  }
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
      if (checked.has(e.id)) picked.push(e);
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

  // The filter bar is only useful once a preset's blocks are on screen.
  const searchRow = overlayEl && overlayEl.querySelector(".kaio-middle-search");
  const hasBlocks = !!(state.selectedPresetId && state.presetFull);
  if (searchRow) searchRow.hidden = !hasBlocks;

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
    renderTokenGauge(null);
    return;
  }

  const overlaps = computeEntryOverlaps(blocks);
  const q = (state.middleFilter || "").trim().toLowerCase();
  const shown = q ? blocks.filter((b) => blockMatchesFilter(b, q)) : blocks;
  if (!shown.length) {
    middleBodyEl.innerHTML =
      `<div class="kaio-middle-empty"><div>No blocks match “${escapeHTML(state.middleFilter.trim())}”.</div></div>`;
  } else {
    for (const b of shown) {
      middleBodyEl.appendChild(renderBlock(b, overlaps));
    }
  }
  // The gauge always reflects the full prompt, not the filtered subset.
  renderTokenGauge(blocks);
}

// True when a block matches the Simulated Prompt filter (case-insensitive,
// already lower-cased). Chat-history matches on its depth-injected items too.
function blockMatchesFilter(block, q) {
  if (!q) return true;
  const hay = [
    blockTitle(block),
    blockTagText(block),
    block.kind === "chat-history" ? "" : blockPreviewRaw(block),
    (block.entry && block.entry.role) || (block.section && block.section.role) || "",
  ];
  if (block.kind === "chat-history") {
    for (const s of block.depthSections || []) hay.push(s.name || "", s.content || "");
    for (const e of block.depthEntries || []) hay.push(e.name || "", e.content || "");
  }
  return hay.join("\n").toLowerCase().includes(q);
}

// Context-window size the gauge fills toward (rough; 0 hides the bar).
function getTokenGaugeContext() {
  const v = parseInt(getSettings().tokenGaugeContext, 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
// Renders the "~N tokens" readout + usage bar into the middle column header.
// Pass null/empty to clear it (no preset, still loading, nothing to show).
function renderTokenGauge(blocks) {
  if (!tokenGaugeEl) return;
  if (!blocks || !blocks.length) {
    tokenGaugeEl.innerHTML = "";
    tokenGaugeEl.dataset.empty = "true";
    return;
  }
  tokenGaugeEl.dataset.empty = "false";
  const total = totalPromptTokens(blocks);
  const ctx = getTokenGaugeContext();
  let html = `<span class="kaio-token-gauge-count">~${total.toLocaleString()} tokens</span>`;
  if (ctx > 0) {
    const ratio = total / ctx;
    const pct = Math.min(100, Math.round(ratio * 100));
    const level = ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";
    html +=
      `<div class="kaio-token-gauge-bar" data-level="${level}" ` +
      `title="≈${total.toLocaleString()} of ${ctx.toLocaleString()} tokens (${Math.round(ratio * 100)}%)">` +
      `<div class="kaio-token-gauge-fill" style="width:${pct}%"></div></div>` +
      `<span class="kaio-token-gauge-pct" data-level="${level}">${Math.round(ratio * 100)}%</span>`;
  }
  html +=
    `<span class="kaio-token-gauge-info" ` +
    `title="Rough estimate (~4 characters per token). Excludes the live chat transcript (injected at runtime) and any wrap formatting.">ⓘ</span>`;
  tokenGaugeEl.innerHTML = html;
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
  const isReadonly = block.kind === "marker" || block.kind === "chat-history";
  el.dataset.readonly = isReadonly ? "true" : "false";
  el.dataset.selected =
    state.inspecting && state.inspecting.id === block.id ? "true" : "false";

  const isOverlapping =
    block.kind === "lorebook-entry" && overlaps && overlaps.has(block.entry.id);
  if (isOverlapping) el.dataset.overlap = "true";

  const isDisabled = block.kind === "lorebook-entry" && block.entry.enabled === false;
  if (isDisabled) el.dataset.disabled = "true";

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

  // Drag-and-drop for section and marker blocks in the simulated prompt
  const isDraggableKind = block.kind === "section" || block.kind === "marker" || block.kind === "chat-history";
  if (isDraggableKind && block.section && state.presetFull) {
    el.draggable = true;
    el.dataset.sectionId = block.section.id;
    el.addEventListener("dragstart", (ev) => {
      draggedSectionId = block.section.id;
      ev.dataTransfer.setData("text/plain", block.section.id);
      ev.dataTransfer.effectAllowed = "move";
      el.dataset.dragging = "true";
    });
    el.addEventListener("dragend", () => {
      draggedSectionId = null;
      delete el.dataset.dragging;
      middleBodyEl.querySelectorAll(".kaio-block").forEach((b) => delete b.dataset.dragover);
    });
    el.addEventListener("dragover", (ev) => {
      if (!draggedSectionId || draggedSectionId === block.section.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      middleBodyEl.querySelectorAll(".kaio-block").forEach((b) => delete b.dataset.dragover);
      el.dataset.dragover = "true";
    });
    el.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const fromId = ev.dataTransfer.getData("text/plain");
      if (!fromId || fromId === block.section.id) return;
      const sectionOrder = tryParseJSON(state.presetFull.preset.sectionOrder, []);
      const order = sectionOrder.length ? [...sectionOrder] : (state.presetFull.sections || []).map((s) => s.id);
      const fromIdx = order.indexOf(fromId);
      const toIdx = order.indexOf(block.section.id);
      if (fromIdx < 0 || toIdx < 0) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, fromId);
      reorderPresetSections(state.presetFull.preset.id, order);
    });
  }

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

  const subDisabled = sub.kind === "lorebook-entry" && sub.entry.enabled === false;
  if (subDisabled) subEl.dataset.disabled = "true";

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

  // Group badge for sections/markers that belong to a group
  let groupHTML = "";
  if (block.section && block.section.groupId && state.presetFull && state.presetFull.groups) {
    const group = state.presetFull.groups.find((g) => g.id === block.section.groupId);
    if (group) {
      groupHTML = `<span class="kaio-group-badge">${escapeHTML(group.name || "Group")}</span>`;
    }
  }

  // Folder badge for lorebook entries that belong to a folder
  let folderHTML = "";
  if (block.kind === "lorebook-entry" && block.entry.folderId) {
    const lbId = block.entry.lorebookId;
    const folders = (lbId && state.lorebookFolders[lbId]) || [];
    const folder = folders.find((f) => f.id === block.entry.folderId);
    if (folder) {
      folderHTML = `<span class="kaio-folder-badge">${escapeHTML(folder.name || "Folder")}</span>`;
    }
  }

  // Disabled badge for disabled lorebook entries (rightmost indicator)
  let disabledHTML = "";
  if (block.kind === "lorebook-entry" && block.entry.enabled === false) {
    disabledHTML = `<span class="kaio-disabled-badge">disabled</span>`;
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

  // Rough per-block token estimate (skipped for empty / runtime blocks).
  const tok = blockOwnTokens(block);
  const tokenHTML = tok > 0
    ? `<span class="kaio-block-tokens" title="≈${tok} tokens (rough estimate, ~4 characters each)">~${tok}</span>`
    : "";

  head.innerHTML = `
    <span class="kaio-block-tag" data-kind="${block.kind}">${tagText}</span>
    <span class="kaio-block-name">${escapeHTML(blockTitle(block))}</span>
    ${tokenHTML}
    ${hintHTML}
    ${groupHTML}
    ${folderHTML}
    ${orderHTML}
    ${disabledHTML}
    ${depthLabel}
    ${role && !isSubblock ? `<span class="kaio-block-role">${escapeHTML(role)}</span>` : ""}
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

// ── Token estimation (rough heuristic: ~4 characters per token) ──
// Not a real tokenizer — providers differ — but close enough to gauge how
// much of the context window the static prompt fills.
function estimateTokens(text) {
  const s = String(text || "");
  return s ? Math.ceil(s.length / 4) : 0;
}
// A single block's own resolved text (no descent into a chat-history block's
// depth sub-blocks). Markers and the chat-history shell carry no static text.
function blockOwnTokens(block) {
  if (!block || block.kind === "chat-history" || block.kind === "marker") return 0;
  return estimateTokens(blockPreviewRaw(block));
}
// Total across the simulated prompt, descending into the depth-injected
// sections/entries a chat-history block carries. The chat-history placeholder
// itself is excluded — the real transcript is injected at runtime.
function totalPromptTokens(blocks) {
  let total = 0;
  for (const b of blocks || []) {
    if (b.kind === "chat-history") {
      for (const s of b.depthSections || []) total += estimateTokens(s.content || "");
      for (const e of b.depthEntries || []) total += estimateTokens(e.content || "");
    } else {
      total += blockOwnTokens(b);
    }
  }
  return total;
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

// ── Mobile tab helper ────────────────────────────────────────
function switchMobileTab(key) {
  if (!overlayEl) return;
  const mq = window.matchMedia("(max-width: 768px)");
  if (!mq.matches) return;
  const body = overlayEl.querySelector(".kaio-body");
  if (body) body.dataset.activeTab = key;
  for (const t of overlayEl.querySelectorAll(".kaio-mobile-tab")) {
    t.dataset.active = t.dataset.tab === key ? "true" : "";
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
  state.folderBatchAdd = { showNested: false, selected: new Set() };
  renderMiddle();   // re-paint selection state
  renderRight();
  switchMobileTab("right");
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
          groupId: block.section.groupId || "",
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
    case "folder":
      return {
        kind: "folder",
        sourceId: block.folder.id,
        lorebookId: block.lorebookId,
        fields: {
          name: block.folder.name || "",
          enabled: block.folder.enabled !== false,
          order: block.folder.order ?? 0,
        },
      };
    case "preset-editor":
      {
        const p = state.presetFull && state.presetFull.preset;
        if (!p) return null;
        return {
          kind: "preset-editor",
          sourceId: p.id,
          fields: {
            name: p.name || "",
            description: p.description || "",
            wrapFormat: p.wrapFormat || "xml",
            author: p.author || "",
          },
        };
      }
    case "lorebook-editor":
      {
        const lb = block.lorebook;
        if (!lb) return null;
        const arrCSV = (a) => Array.isArray(a) ? a.join(", ") : "";
        return {
          kind: "lorebook-editor",
          sourceId: lb.id,
          fields: {
            name: lb.name || "",
            description: lb.description || "",
            tags: arrCSV(lb.tags),
            category: lb.category || "uncategorized",
            enabled: lb.enabled !== false,
            isGlobal: !!lb.isGlobal,
            scanDepth: lb.scanDepth ?? 2,
            tokenBudget: lb.tokenBudget ?? 2048,
            recursiveScanning: !!lb.recursiveScanning,
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
    empty.innerHTML = "Click a block in the simulated prompt to edit it here.";
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
      rightBodyEl.appendChild(groupSelectField(f.groupId));
      break;

    case "lorebook-entry": {
      const matchMode = f.constant ? "constant" : (f.selective ? "selective" : "normal");
      const lbC = { stateObj: state.lbInspectorCollapsed };

      // ── Basic ─────────────────────────────────────
      rightBodyEl.appendChild(renderCollapsible("Basic", "basic", () => {
        const c = document.createElement("div");
        c.appendChild(field("Name", f.name, "name", "input"));
        c.appendChild(field("Content", f.content, "content", "textarea", null, 6));
        c.appendChild(field("Description", f.description, "description", "textarea",
          "Brief summary used by the Knowledge Router to decide whether to inject this entry. Not sent to the AI as content.", 3));
        c.appendChild(field("Primary keys", f.keys, "keys", "input",
          "Comma-separated keywords that trigger this entry when found in recent chat messages."));
        c.appendChild(field("Secondary keys", f.secondaryKeys, "secondaryKeys", "input",
          "Comma-separated secondary keywords. Used with Selective matching to further filter when this entry fires."));
        c.appendChild(rowOf(
          selectField("Position", String(f.position), "position",
            [["0","before char"],["1","after char"],["2","depth"]]),
          selectField("Role", f.role, "role", ["system", "user", "assistant"]),
        ));
        c.appendChild(rowOf(
          numberField("Depth", f.depth, "depth",
            "How many messages deep to insert this entry when Position is set to depth."),
          numberField("Order", f.order, "order",
            "Insertion order relative to other lorebook entries at the same position. Lower numbers insert first."),
        ));
        c.appendChild(checkboxField("Enabled", f.enabled, "enabled"));
        c.appendChild(rowOf(
          checkboxField("Prevent recursion", f.preventRecursion, "preventRecursion",
            "Stop this entry's content from being scanned for additional lorebook keyword matches."),
          checkboxField("Locked", f.locked, "locked",
            "Lock this entry to prevent it from being edited in the regular lorebook UI."),
        ));
        c.appendChild(matchingModeField(matchMode));
        if (matchMode === "selective") {
          c.appendChild(
            selectField("Selective logic", f.selectiveLogic, "selectiveLogic", ["and", "or", "not"],
              "How primary and secondary keys are combined. AND = both must match, OR = either, NOT = primary matches but secondary does not."),
          );
        }
        return c;
      }, lbC));

      // ── Matching options ──────────────────────────
      rightBodyEl.appendChild(renderCollapsible("Matching options", "matching", () => {
        const c = document.createElement("div");
        c.appendChild(rowOf(
          nullableNumberField("Probability", f.probability, "probability",
            { step: "0.05", min: 0, max: 1 },
            "Chance this entry is injected each time it triggers (0–100%). Leave empty to always inject when matched."),
          nullableNumberField("Scan depth", f.scanDepth, "scanDepth",
            { step: "1", min: 0 },
            "How many messages back to scan for keywords. Leave empty to use the global lorebook default."),
        ));
        c.appendChild(rowOf(
          checkboxField("Match whole words", f.matchWholeWords, "matchWholeWords",
            "Only trigger on whole-word matches. Prevents partial matches like 'cat' matching 'scatter'."),
          checkboxField("Case sensitive", f.caseSensitive, "caseSensitive"),
        ));
        c.appendChild(checkboxField("Treat keys as regex", f.useRegex, "useRegex",
          "Interpret primary and secondary keys as regular expressions instead of plain text."));
        return c;
      }, lbC));

      // ── Context filters ───────────────────────────
      rightBodyEl.appendChild(renderCollapsible("Context filters", "contextFilters", () => {
        const c = document.createElement("div");
        c.appendChild(rowOf(
          selectField("Character mode", f.characterFilterMode, "characterFilterMode",
            ["any", "include", "exclude"]),
          field("Character IDs", f.characterFilterIds, "characterFilterIds", "input",
            "Comma-separated character IDs. Used when Character mode is include or exclude."),
        ));
        c.appendChild(rowOf(
          selectField("Tag mode", f.characterTagFilterMode, "characterTagFilterMode",
            ["any", "include", "exclude"]),
          field("Character tags", f.characterTagFilters, "characterTagFilters", "input",
            "Comma-separated character tags. Used when Tag mode is include or exclude."),
        ));
        c.appendChild(rowOf(
          selectField("Trigger mode", f.generationTriggerFilterMode, "generationTriggerFilterMode",
            ["any", "include", "exclude"]),
          field("Generation triggers", f.generationTriggerFilters, "generationTriggerFilters", "input",
            "Comma-separated generation contexts to filter on, e.g. chat, game."),
        ));
        return c;
      }, lbC));

      // ── Matching sources ─────────────────────────
      rightBodyEl.appendChild(renderCollapsible("Additional matching sources", "matchingSources", () => {
        const c = document.createElement("div");
        c.appendChild(multiSelectField(
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
        return c;
      }, lbC));

      // ── Timing ───────────────────────────────────
      rightBodyEl.appendChild(renderCollapsible("Timing", "timing", () => {
        const c = document.createElement("div");
        c.appendChild(rowOf(
          nullableNumberField("Sticky", f.sticky, "sticky", { step: "1", min: 0 },
            "Keep this entry injected for N turns after it triggers, even if keywords stop matching."),
          nullableNumberField("Cooldown", f.cooldown, "cooldown", { step: "1", min: 0 },
            "Block this entry from triggering again for N turns after it was last injected."),
        ));
        c.appendChild(rowOf(
          nullableNumberField("Delay", f.delay, "delay", { step: "1", min: 0 },
            "Wait N turns after a keyword match before injecting this entry."),
          nullableNumberField("Ephemeral", f.ephemeral, "ephemeral", { step: "1", min: 0 },
            "Automatically remove this entry from context after N turns."),
        ));
        return c;
      }, lbC));

      // ── Group & Tag ──────────────────────────────
      rightBodyEl.appendChild(renderCollapsible("Group & Tag", "groupTag", () => {
        const c = document.createElement("div");
        c.appendChild(rowOf(
          field("Group", f.group, "group", "input",
            "Group name for mutual-exclusion logic. Only one entry per group fires per turn."),
          nullableNumberField("Group weight", f.groupWeight, "groupWeight", { step: "0.1" },
            "Weighted probability for selection within a group. Higher = more likely to be chosen."),
        ));
        c.appendChild(rowOf(
          field("Tag", f.tag, "tag", "input"),
          folderSelectField(d.lorebookId, f.folderId),
        ));
        return c;
      }, lbC));

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

    case "preset-editor":
      rightBodyEl.appendChild(renderPresetEditorPanel());
      break;

    case "lorebook-editor":
      rightBodyEl.appendChild(renderLorebookEditorPanel());
      break;

    case "folder":
      rightBodyEl.appendChild(sectionHeader("Basic"));
      rightBodyEl.appendChild(field("Name", f.name, "name", "input"));
      rightBodyEl.appendChild(checkboxField("Enabled", f.enabled, "enabled",
        "When disabled, all entries in this folder are excluded from activation regardless of their individual enabled state."));
      rightBodyEl.appendChild(numberField("Order", f.order, "order",
        "Display order among folders. Lower values appear first."));
      rightBodyEl.appendChild(renderFolderEntries(d.sourceId, d.lorebookId));
      rightBodyEl.appendChild(renderFolderBatchAdd(d.sourceId, d.lorebookId));
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

  if (d.kind === "lorebook-entry" || d.kind === "folder") {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "kaio-btn kaio-btn-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.title = "Permanently delete this " + (d.kind === "folder" ? "folder" : "entry");
    deleteBtn.addEventListener("click", () => deleteInspected());
    rightFooterEl.appendChild(deleteBtn);
  }

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

function folderSelectField(lorebookId, currentValue) {
  const folders = state.lorebookFolders[lorebookId] || [];
  const options = [["", "(none)"], ...folders.map((f) => [f.id, f.name || "(unnamed folder)"])];
  return selectField("Folder", currentValue || "", "folderId", options);
}

function renderFolderEntries(folderId, lorebookId) {
  const wrap = document.createElement("div");
  const entries = (state.lorebookEntries[lorebookId] || []).filter((e) => e.folderId === folderId);
  wrap.appendChild(sectionHeader("Entries in this folder"));
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "kaio-field-help";
    empty.textContent = "No entries assigned to this folder.";
    wrap.appendChild(empty);
    return wrap;
  }
  const list = document.createElement("div");
  list.className = "kaio-folder-entries";
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "kaio-folder-entry-row";
    const nameEl = document.createElement("span");
    nameEl.className = "kaio-folder-entry-name";
    nameEl.textContent = e.name || "(unnamed)";
    row.appendChild(nameEl);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "kaio-folder-entry-remove";
    removeBtn.textContent = "Remove";
    removeBtn.title = "Unassign entry from this folder";
    removeBtn.addEventListener("click", async () => {
      try {
        await api("PATCH", "/lorebooks/" + lorebookId + "/entries/" + e.id, { folderId: null });
        await loadLorebookEntries(lorebookId);
        const folderSet = state.selectedFolderIdsByLorebook[lorebookId];
        if (folderSet && folderSet.has(folderId)) {
          const checkedSet = state.selectedEntryIdsByLorebook[lorebookId];
          if (checkedSet) checkedSet.delete(e.id);
        }
        renderAll();
        showToast("Entry removed from folder", "info");
      } catch (err) {
        console.error("[kolache-AIO] Remove from folder failed", err);
        showToast("Failed to remove entry", "error");
      }
    });
    row.appendChild(removeBtn);
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}

function renderFolderBatchAdd(folderId, lorebookId) {
  const wrap = document.createElement("div");
  wrap.appendChild(sectionHeader("Add entries to this folder"));

  const entries = state.lorebookEntries[lorebookId] || [];
  const folders = state.lorebookFolders[lorebookId] || [];
  const available = entries.filter((e) => !e.folderId);
  const nested = entries.filter((e) => e.folderId && e.folderId !== folderId);
  const inThisFolder = entries.filter((e) => e.folderId === folderId);

  if (!available.length && !nested.length) {
    const msg = document.createElement("div");
    msg.className = "kaio-field-help";
    msg.textContent = inThisFolder.length
      ? "All entries are already in this folder."
      : "This lorebook has no entries yet.";
    wrap.appendChild(msg);
    return wrap;
  }

  // "Show already nested" toggle
  if (nested.length) {
    const toggleWrap = document.createElement("label");
    toggleWrap.className = "kaio-checkbox kaio-batch-toggle";
    const toggleCb = document.createElement("input");
    toggleCb.type = "checkbox";
    toggleCb.checked = state.folderBatchAdd.showNested;
    toggleCb.addEventListener("change", () => {
      state.folderBatchAdd.showNested = toggleCb.checked;
      renderRight();
    });
    toggleWrap.appendChild(toggleCb);
    const toggleText = document.createElement("span");
    toggleText.textContent = "Show already nested";
    toggleWrap.appendChild(toggleText);
    wrap.appendChild(toggleWrap);
  }

  const listEl = document.createElement("div");
  listEl.className = "kaio-batch-list";

  // Available (unassigned) entries — selectable
  for (const e of available) {
    const row = document.createElement("label");
    row.className = "kaio-batch-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.folderBatchAdd.selected.has(e.id);
    cb.addEventListener("change", () => {
      if (cb.checked) state.folderBatchAdd.selected.add(e.id);
      else state.folderBatchAdd.selected.delete(e.id);
      const btn = wrap.querySelector(".kaio-batch-add-btn");
      if (btn) {
        const n = state.folderBatchAdd.selected.size;
        btn.textContent = n ? "Add selected (" + n + ")" : "Add selected";
        btn.disabled = !n;
      }
    });
    row.appendChild(cb);
    const nameEl = document.createElement("span");
    nameEl.className = "kaio-batch-item-name";
    nameEl.textContent = e.name || "(unnamed)";
    row.appendChild(nameEl);
    listEl.appendChild(row);
  }

  // Already-nested entries — grayed out, unselectable, folder name on right
  if (state.folderBatchAdd.showNested) {
    for (const e of nested) {
      const ownerFolder = folders.find((f) => f.id === e.folderId);
      const row = document.createElement("div");
      row.className = "kaio-batch-item kaio-batch-nested";
      const dummyCb = document.createElement("input");
      dummyCb.type = "checkbox";
      dummyCb.disabled = true;
      row.appendChild(dummyCb);
      const nameEl = document.createElement("span");
      nameEl.className = "kaio-batch-item-name kaio-batch-nested-name";
      nameEl.textContent = e.name || "(unnamed)";
      row.appendChild(nameEl);
      const folderLabel = document.createElement("span");
      folderLabel.className = "kaio-batch-nested-folder";
      folderLabel.textContent = ownerFolder ? ownerFolder.name : "(unknown)";
      row.appendChild(folderLabel);
      listEl.appendChild(row);
    }
  }

  if (!available.length) {
    const msg = document.createElement("div");
    msg.className = "kaio-batch-empty";
    msg.textContent = "No unassigned entries available.";
    listEl.appendChild(msg);
  }

  wrap.appendChild(listEl);

  // "Add selected" button
  const n = state.folderBatchAdd.selected.size;
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "kaio-btn kaio-btn-primary kaio-batch-add-btn";
  addBtn.textContent = n ? "Add selected (" + n + ")" : "Add selected";
  addBtn.disabled = !n;
  addBtn.addEventListener("click", async () => {
    const ids = [...state.folderBatchAdd.selected];
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) =>
        api("PATCH", "/lorebooks/" + lorebookId + "/entries/" + id, { folderId: folderId })
      ));
      await loadLorebookEntries(lorebookId);
      const folderSelectSet = state.selectedFolderIdsByLorebook[lorebookId];
      if (folderSelectSet && folderSelectSet.has(folderId)) {
        const checkedSet = state.selectedEntryIdsByLorebook[lorebookId];
        if (checkedSet) for (const id of ids) checkedSet.add(id);
      }
      state.folderBatchAdd.selected.clear();
      renderAll();
      showToast("Added " + ids.length + " entr" + (ids.length === 1 ? "y" : "ies") + " to folder", "success");
    } catch (err) {
      console.error("[kolache-AIO] Batch add failed", err);
      showToast("Failed to add entries", "error");
    }
  });
  wrap.appendChild(addBtn);
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
      key === "matchingMode" || key === "wrapFormat" || key === "category") {
    renderRight();
    return;
  }
  const dot = rightFooterEl.querySelector(".kaio-dirty-dot");
  if (dot) dot.dataset.dirty = state.isDirty ? "true" : "false";
  const txt = rightFooterEl.querySelector("span:nth-child(2)");
  if (txt) txt.textContent = state.isDirty ? "Unsaved changes" : "No changes";
  const footerBtns = rightFooterEl.querySelectorAll("button:not(.kaio-btn-delete)");
  if (footerBtns[0]) footerBtns[0].disabled = !state.isDirty;
  if (footerBtns[1]) footerBtns[1].disabled = !state.isDirty;
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
          groupId: d.fields.groupId ? d.fields.groupId : null,
        };
        await api("PATCH", "/prompts/" + presetId + "/sections/" + d.sourceId, body);
        await loadPresetFull(presetId);
        break;
      }
      case "lorebook-entry": {
        const f = d.fields;
        const csv = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
        const oldFolderId = state.inspecting?.entry?.folderId || null;
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
        // Sync folder selection: auto-select/deselect entry if it moved between folders
        const folderSet = state.selectedFolderIdsByLorebook[d.lorebookId];
        const checkedSet = state.selectedEntryIdsByLorebook[d.lorebookId];
        if (folderSet && checkedSet) {
          const saved = (state.lorebookEntries[d.lorebookId] || []).find((e) => e.id === d.sourceId);
          if (saved) {
            const newFolderId = saved.folderId || null;
            if (newFolderId && folderSet.has(newFolderId)) checkedSet.add(saved.id);
            if (oldFolderId && folderSet.has(oldFolderId) && oldFolderId !== newFolderId) checkedSet.delete(saved.id);
          }
        }
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
      case "preset-editor": {
        const presetId = d.sourceId;
        const body = {
          name: d.fields.name,
          description: d.fields.description,
          wrapFormat: d.fields.wrapFormat,
          author: d.fields.author,
        };
        await api("PATCH", "/prompts/" + presetId, body);
        await loadPresetFull(presetId);
        state.presets = await api("GET", "/prompts/").catch(() => state.presets);
        state.inspecting = { kind: "preset-editor", id: "preset-editor" };
        state.draft = makeDraft(state.inspecting);
        state.isDirty = false;
        renderAll();
        showToast("Saved ✓", "success");
        return;
      }
      case "lorebook-editor": {
        const lbId = d.sourceId;
        const tagsArr = typeof d.fields.tags === "string"
          ? d.fields.tags.split(",").map((t) => t.trim()).filter(Boolean)
          : [];
        const body = {
          name: d.fields.name,
          description: d.fields.description,
          tags: tagsArr,
          category: d.fields.category,
          enabled: d.fields.enabled,
          isGlobal: d.fields.isGlobal,
          scanDepth: Number(d.fields.scanDepth),
          tokenBudget: Number(d.fields.tokenBudget),
          recursiveScanning: d.fields.recursiveScanning,
        };
        await api("PATCH", "/lorebooks/" + lbId, body);
        state.lorebooks = await api("GET", "/lorebooks").catch(() => state.lorebooks);
        const freshLb = state.lorebooks.find((l) => l.id === lbId);
        if (freshLb) {
          state.inspecting = { kind: "lorebook-editor", id: "lorebook-editor-" + lbId, lorebook: freshLb };
          state.draft = makeDraft(state.inspecting);
        } else {
          state.inspecting = null;
          state.draft = null;
        }
        state.isDirty = false;
        renderAll();
        showToast("Saved ✓", "success");
        return;
      }
      case "folder": {
        const body = { name: d.fields.name, enabled: d.fields.enabled, order: Number(d.fields.order) };
        await api("PATCH", "/lorebooks/" + d.lorebookId + "/folders/" + d.sourceId, body);
        await loadLorebookFolders(d.lorebookId);
        const freshFolder = (state.lorebookFolders[d.lorebookId] || []).find((f) => f.id === d.sourceId);
        if (freshFolder) {
          state.inspecting = { kind: "folder", id: "folder-" + freshFolder.id, folder: freshFolder, lorebookId: d.lorebookId };
          state.draft = makeDraft(state.inspecting);
        } else {
          state.inspecting = null;
          state.draft = null;
        }
        state.isDirty = false;
        renderAll();
        showToast("Saved ✓", "success");
        return;
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
async function deleteInspected() {
  if (!state.inspecting) return;
  const kind = state.inspecting.kind;
  if (kind !== "lorebook-entry" && kind !== "folder") return;
  const confirmed = await showDeleteConfirm(kind);
  if (!confirmed) return;
  try {
    if (kind === "lorebook-entry") {
      const entry = state.inspecting.entry;
      const lorebookId = entry.lorebookId;
      await api("DELETE", "/lorebooks/" + lorebookId + "/entries/" + entry.id);
      await loadLorebookEntries(lorebookId);
      const checkedSet = state.selectedEntryIdsByLorebook[lorebookId];
      if (checkedSet) checkedSet.delete(entry.id);
    } else if (kind === "folder") {
      const folder = state.inspecting.folder;
      const lorebookId = state.inspecting.lorebookId;
      await api("DELETE", "/lorebooks/" + lorebookId + "/folders/" + folder.id);
      await loadLorebookFolders(lorebookId);
      await loadLorebookEntries(lorebookId);
      const folderSet = state.selectedFolderIdsByLorebook[lorebookId];
      if (folderSet) folderSet.delete(folder.id);
    }
    state.inspecting = null;
    state.draft = null;
    state.isDirty = false;
    renderAll();
    if (kind === "folder") switchMobileTab("left");
    showToast(kind === "folder" ? "Folder deleted" : "Entry deleted", "success");
  } catch (err) {
    console.error("[kolache-AIO] Delete failed", err);
    showToast("Delete failed — see console", "error");
  }
}
function showDeleteConfirm(kind) {
  return new Promise((resolve) => {
    const label = kind === "folder" ? "folder" : "entry";
    const extra = kind === "folder" ? " Entries inside will be moved to root level." : "";
    const bg = document.createElement("div");
    bg.className = "kaio-confirm-bg";
    bg.innerHTML = '<div class="kaio-confirm"><div class="kaio-confirm-title">Delete ' + label + '?</div><div class="kaio-confirm-msg">This will permanently delete this ' + label + '.' + extra + ' This cannot be undone.</div><div class="kaio-confirm-actions"><button class="kaio-btn kaio-btn-ghost" data-act="cancel">Cancel</button><button class="kaio-btn kaio-btn-danger" data-act="delete">Delete</button></div></div>';
    overlayEl.querySelector(".kaio-shell").appendChild(bg);
    const close = () => bg.remove();
    bg.querySelector('[data-act="cancel"]').addEventListener("click", () => { close(); resolve(false); });
    bg.querySelector('[data-act="delete"]').addEventListener("click", () => { close(); resolve(true); });
  });
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
// ── Lorebook editor panel ─────────────────────────────────────
function renderLorebookEditorPanel() {
  const wrap = document.createElement("div");
  wrap.className = "kaio-preset-editor";
  const lb = state.inspecting && state.inspecting.lorebook;
  if (!lb) return wrap;
  const f = state.draft && state.draft.fields;

  wrap.appendChild(renderCollapsible("Overview", "overview", () => {
    const content = document.createElement("div");
    if (!f) return content;
    content.appendChild(field("Name", f.name, "name", "input"));
    content.appendChild(field("Description", f.description, "description", "textarea",
      "Brief description of this lorebook.", 3));
    content.appendChild(field("Tags", f.tags, "tags", "input",
      "Comma-separated tags for organizing lorebooks."));
    content.appendChild(lorebookCategoryField(f.category));
    content.appendChild(rowOf(
      numberField("Scan Depth", f.scanDepth, "scanDepth",
        "How many messages back to scan for keyword matches. Entries can override this."),
      numberField("Token Budget", f.tokenBudget, "tokenBudget",
        "Maximum tokens allocated to this lorebook's injected entries."),
    ));
    content.appendChild(checkboxField("Recursive", f.recursiveScanning, "recursiveScanning",
      "When enabled, activated entries are re-scanned for keywords that may trigger additional entries."));
    content.appendChild(checkboxField("Enabled", f.enabled, "enabled",
      "Master switch — when off, no entries from this lorebook will activate."));
    content.appendChild(checkboxField("Global", f.isGlobal, "isGlobal",
      "When on, this lorebook is active in every chat regardless of linked characters or personas."));
    return content;
  }, { stateObj: state.lbEditorCollapsed }));

  return wrap;
}

function lorebookCategoryField(value) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  applyLabel(lab, "Category");
  wrap.appendChild(lab);
  const row = document.createElement("div");
  row.className = "kaio-match-mode";
  for (const [val, label, icon] of [
    ["world", "World", "🌐"],
    ["character", "Character", "👥"],
    ["npc", "NPC", "👤"],
    ["spellbook", "Spellbook", "✨"],
    ["uncategorized", "Uncategorized", "🗂️"],
  ]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kaio-match-btn kaio-wrap-btn";
    btn.dataset.active = String(value === val);
    const iconEl = document.createElement("span");
    iconEl.style.marginRight = "0.25rem";
    iconEl.textContent = icon;
    btn.appendChild(iconEl);
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener("click", () => onFieldChange("category", val));
    row.appendChild(btn);
  }
  wrap.appendChild(row);
  return wrap;
}

// ── Preset editor panel (3 collapsibles: Overview / Sections / Variables) ──
function renderPresetEditorPanel() {
  const wrap = document.createElement("div");
  wrap.className = "kaio-preset-editor";
  const p = state.presetFull && state.presetFull.preset;
  if (!p) return wrap;
  const f = state.draft && state.draft.fields;

  // ── Overview collapsible ──
  wrap.appendChild(renderCollapsible("Overview", "overview", () => {
    const content = document.createElement("div");
    if (!f) return content;
    content.appendChild(field("Name", f.name, "name", "input"));
    content.appendChild(field("Description", f.description, "description", "textarea",
      "Brief description of this preset. Shown in the preset picker.", 3));
    content.appendChild(wrapFormatField(f.wrapFormat));
    content.appendChild(field("Author", f.author, "author", "input"));
    const stats = document.createElement("div");
    stats.className = "kaio-preset-stats";
    const secCount = (state.presetFull.sections || []).length;
    const grpCount = (state.presetFull.groups || []).length;
    stats.innerHTML = `<span class="kaio-preset-stat"><strong>${secCount}</strong> Sections</span>` +
      `<span class="kaio-preset-stat"><strong>${grpCount}</strong> Groups</span>`;
    content.appendChild(stats);
    return content;
  }));

  // ── Sections collapsible ──
  const secCount = (state.presetFull.sections || []).length;
  wrap.appendChild(renderCollapsible("Sections", "sections", () => renderPresetSectionsPanel(), { count: secCount }));

  // ── Preset Variables collapsible ──
  const varCount = (state.presetFull.choiceBlocks || []).length;
  wrap.appendChild(renderCollapsible("Preset Variables", "variables", () => renderPresetVariablesPanel(), { count: varCount }));

  return wrap;
}

function renderCollapsible(title, key, contentFn, opts) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-collapsible";
  const stateObj = (opts && opts.stateObj) || state.presetEditorCollapsed;
  const collapsed = stateObj[key];
  if (collapsed) wrap.dataset.collapsed = "true";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "kaio-collapsible-header";
  const countHTML = (opts && opts.count != null) ? `<span class="kaio-collapsible-count">${opts.count}</span>` : "";
  header.innerHTML = `<span class="kaio-collapsible-caret">▾</span><span class="kaio-collapsible-title">${escapeHTML(title)}</span>${countHTML}`;
  header.addEventListener("click", () => {
    stateObj[key] = !stateObj[key];
    renderRight();
  });
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "kaio-collapsible-body";
  body.appendChild(contentFn());
  wrap.appendChild(body);
  return wrap;
}

function wrapFormatField(value) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-field";
  const lab = document.createElement("label");
  lab.className = "kaio-field-label";
  applyLabel(lab, "Wrap format", "Sections wrapped in <xml_tags>, ## Markdown headings, or no wrapping.");
  wrap.appendChild(lab);
  const row = document.createElement("div");
  row.className = "kaio-match-mode";
  for (const [val, label, icon] of [["xml", "XML", "</\>"], ["markdown", "Markdown", "#"], ["none", "None", "T"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kaio-match-btn kaio-wrap-btn";
    btn.dataset.active = String(value === val);
    const iconEl = document.createElement("span");
    iconEl.className = "kaio-wrap-icon";
    iconEl.textContent = icon;
    btn.appendChild(iconEl);
    btn.appendChild(document.createTextNode(label.toUpperCase()));
    btn.addEventListener("click", () => onFieldChange("wrapFormat", val));
    row.appendChild(btn);
  }
  wrap.appendChild(row);
  return wrap;
}

function groupSelectField(currentValue) {
  const groups = (state.presetFull && state.presetFull.groups) || [];
  const options = [["", "(none)"], ...groups.map((g) => [g.id, g.name || "(unnamed group)"])];
  return selectField("Group", currentValue || "", "groupId", options,
    "Assign this section to a group. Groups organize related sections visually.");
}

// ── Sections management panel ─────────────────────────────────
function renderPresetSectionsPanel() {
  const wrap = document.createElement("div");
  const presetId = state.presetFull.preset.id;
  const sections = state.presetFull.sections || [];
  const groups = state.presetFull.groups || [];
  const sectionOrder = tryParseJSON(state.presetFull.preset.sectionOrder, []);
  const sectionsById = Object.fromEntries(sections.map((s) => [s.id, s]));
  const orderedIds = sectionOrder.length ? sectionOrder : sections.map((s) => s.id);

  // Create button with dropdown
  const actions = document.createElement("div");
  actions.className = "kaio-create-actions";
  actions.style.position = "relative";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "kaio-create-btn";
  addBtn.textContent = "+ Section";
  addBtn.addEventListener("click", () => {
    const existing = actions.querySelector(".kaio-add-section-menu");
    if (existing) { existing.remove(); return; }
    const menu = document.createElement("div");
    menu.className = "kaio-add-section-menu";
    const items = [
      { label: "Prompt Block", marker: false },
      { divider: true, label: "Markers" },
      { label: "Character Info", type: "character" },
      { label: "Lorebook Marker (All)", type: "lorebook" },
      { label: "Persona", type: "persona" },
      { label: "Chat History", type: "chat_history" },
      { label: "Chat Summary", type: "chat_summary" },
      { label: "Lorebook Marker (Before)", type: "world_info_before" },
      { label: "Lorebook Marker (After)", type: "world_info_after" },
      { label: "Dialogue Examples", type: "dialogue_examples" },
    ];
    for (const it of items) {
      if (it.divider) {
        const d = document.createElement("div");
        d.className = "kaio-add-section-divider";
        d.textContent = it.label;
        menu.appendChild(d);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kaio-add-section-item";
      btn.textContent = it.label;
      btn.addEventListener("click", async () => {
        menu.remove();
        if (it.marker === false) {
          await createPresetSection(presetId);
        } else {
          await createPresetMarker(presetId, it.label, it.type);
        }
      });
      menu.appendChild(btn);
    }
    actions.appendChild(menu);
    const dismiss = (ev) => { if (!menu.contains(ev.target) && ev.target !== addBtn) { menu.remove(); document.removeEventListener("click", dismiss, true); } };
    setTimeout(() => document.addEventListener("click", dismiss, true), 0);
  });
  actions.appendChild(addBtn);

  // Groups management (above section order)
  wrap.appendChild(renderPresetGroupsUI(presetId, groups, sections));

  // Section order list
  wrap.appendChild(sectionHeader("Section order"));
  if (!orderedIds.length) {
    const empty = document.createElement("div");
    empty.className = "kaio-field-help";
    empty.textContent = "No sections in this preset yet.";
    wrap.appendChild(empty);
    wrap.appendChild(actions);
    return wrap;
  }

  const list = document.createElement("div");
  list.className = "kaio-preset-section-list";
  list.dataset.presetId = presetId;

  for (const id of orderedIds) {
    const s = sectionsById[id];
    if (!s) continue;
    const row = document.createElement("div");
    row.className = "kaio-preset-section-row";
    row.draggable = true;
    row.dataset.sectionId = s.id;

    // Drag handle
    const handle = document.createElement("span");
    handle.className = "kaio-drag-handle";
    handle.textContent = "⠿";
    row.appendChild(handle);

    // Tag
    const tag = document.createElement("span");
    tag.className = "kaio-block-tag";
    const isMarker = s.isMarker === true || s.isMarker === "true";
    tag.dataset.kind = isMarker ? "marker" : "section";
    tag.textContent = isMarker ? "MARKER" : "SECTION";
    row.appendChild(tag);

    // Name
    const name = document.createElement("span");
    name.className = "kaio-preset-section-name";
    name.textContent = s.name || s.identifier || "(unnamed)";
    row.appendChild(name);

    // Group badge
    if (s.groupId) {
      const group = groups.find((g) => g.id === s.groupId);
      if (group) {
        const badge = document.createElement("span");
        badge.className = "kaio-group-badge";
        badge.textContent = group.name || "Group";
        row.appendChild(badge);
      }
    }

    // Role
    const role = document.createElement("span");
    role.className = "kaio-preset-section-role";
    role.textContent = s.role || "system";
    row.appendChild(role);

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "kaio-preset-section-delete";
    delBtn.textContent = "✕";
    delBtn.title = "Delete this section";
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deletePresetSection(presetId, s.id, s.name || s.identifier || "this section");
    });
    row.appendChild(delBtn);

    // Drag events
    row.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/plain", s.id);
      ev.dataTransfer.effectAllowed = "move";
      row.dataset.dragging = "true";
    });
    row.addEventListener("dragend", () => {
      delete row.dataset.dragging;
      list.querySelectorAll(".kaio-preset-section-row").forEach((r) => delete r.dataset.dragover);
    });
    row.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      list.querySelectorAll(".kaio-preset-section-row").forEach((r) => delete r.dataset.dragover);
      row.dataset.dragover = "true";
    });
    row.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const draggedId = ev.dataTransfer.getData("text/plain");
      if (!draggedId || draggedId === s.id) return;
      const currentOrder = [...orderedIds];
      const fromIdx = currentOrder.indexOf(draggedId);
      const toIdx = currentOrder.indexOf(s.id);
      if (fromIdx < 0 || toIdx < 0) return;
      currentOrder.splice(fromIdx, 1);
      currentOrder.splice(toIdx, 0, draggedId);
      reorderPresetSections(presetId, currentOrder);
    });

    list.appendChild(row);
  }
  wrap.appendChild(list);
  // + Section button below the section list
  wrap.appendChild(actions);
  return wrap;
}

// ── Groups UI ─────────────────────────────────────────────────
function renderPresetGroupsUI(presetId, groups, sections) {
  const wrap = document.createElement("div");
  wrap.appendChild(sectionHeader("Groups"));

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "kaio-field-help";
    empty.textContent = "No groups defined. Groups let you organize related sections.";
    wrap.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "kaio-preset-group-list";
    for (const g of groups) {
      list.appendChild(renderPresetGroupRow(presetId, g, groups, sections));
    }
    wrap.appendChild(list);
  }

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "kaio-create-btn";
  createBtn.style.marginTop = "0.375rem";
  createBtn.textContent = "+ Group";
  createBtn.addEventListener("click", () => createPresetGroup(presetId));
  wrap.appendChild(createBtn);
  return wrap;
}

function renderPresetGroupRow(presetId, group, allGroups, allSections) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-preset-group-row";
  const isExpanded = state.presetGroupBatchAdd.groupId === group.id;

  const header = document.createElement("div");
  header.className = "kaio-preset-group-header";

  const caret = document.createElement("span");
  caret.className = "kaio-collapsible-caret kaio-group-caret";
  if (!isExpanded) caret.style.transform = "rotate(-90deg)";
  header.appendChild(caret);

  const icon = document.createElement("span");
  icon.textContent = "📁";
  icon.className = "kaio-folder-icon";
  header.appendChild(icon);

  // Editable name
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "kaio-input kaio-group-name-input";
  nameInput.value = group.name || "";
  nameInput.placeholder = "(unnamed group)";
  let renameTimer = null;
  nameInput.addEventListener("input", () => {
    clearTimeout(renameTimer);
    renameTimer = setTimeout(() => {
      renamePresetGroup(presetId, group.id, nameInput.value);
    }, 600);
  });
  nameInput.addEventListener("click", (ev) => ev.stopPropagation());
  header.appendChild(nameInput);

  const memberCount = allSections.filter((s) => s.groupId === group.id).length;
  const count = document.createElement("span");
  count.className = "kaio-folder-count";
  count.textContent = String(memberCount);
  header.appendChild(count);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "kaio-preset-section-delete";
  delBtn.textContent = "✕";
  delBtn.title = "Delete group";
  delBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    deletePresetGroup(presetId, group.id);
  });
  header.appendChild(delBtn);

  header.addEventListener("click", () => {
    if (state.presetGroupBatchAdd.groupId === group.id) {
      state.presetGroupBatchAdd = { groupId: null, selected: new Set() };
    } else {
      state.presetGroupBatchAdd = { groupId: group.id, selected: new Set() };
    }
    renderRight();
  });

  wrap.appendChild(header);

  if (isExpanded) {
    wrap.appendChild(renderGroupSectionsBatchAdd(presetId, group.id, allSections));
  }
  return wrap;
}

function renderGroupSectionsBatchAdd(presetId, groupId, allSections) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-group-batch-body";

  // Current members
  const members = allSections.filter((s) => s.groupId === groupId);
  if (members.length) {
    const memberList = document.createElement("div");
    memberList.className = "kaio-folder-entries";
    for (const s of members) {
      const row = document.createElement("div");
      row.className = "kaio-folder-entry-row";
      const nameEl = document.createElement("span");
      nameEl.className = "kaio-folder-entry-name";
      nameEl.textContent = s.name || s.identifier || "(unnamed)";
      row.appendChild(nameEl);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "kaio-folder-entry-remove";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        try {
          await api("PATCH", "/prompts/" + presetId + "/sections/" + s.id, { groupId: null });
          await loadPresetFull(presetId);
          renderRight();
          renderMiddle();
          showToast("Removed from group", "info");
        } catch (err) {
          console.error("[kolache-AIO] Remove from group failed", err);
          showToast("Failed to remove", "error");
        }
      });
      row.appendChild(removeBtn);
      memberList.appendChild(row);
    }
    wrap.appendChild(memberList);
  }

  // Available to add
  const available = allSections.filter((s) => !s.groupId || s.groupId === "");
  if (available.length) {
    const listEl = document.createElement("div");
    listEl.className = "kaio-batch-list";
    listEl.style.marginTop = "0.375rem";
    for (const s of available) {
      const row = document.createElement("label");
      row.className = "kaio-batch-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.presetGroupBatchAdd.selected.has(s.id);
      cb.addEventListener("change", () => {
        if (cb.checked) state.presetGroupBatchAdd.selected.add(s.id);
        else state.presetGroupBatchAdd.selected.delete(s.id);
        const btn = wrap.querySelector(".kaio-batch-add-btn");
        if (btn) {
          const n = state.presetGroupBatchAdd.selected.size;
          btn.textContent = n ? "Add selected (" + n + ")" : "Add selected";
          btn.disabled = !n;
        }
      });
      row.appendChild(cb);
      const nameEl = document.createElement("span");
      nameEl.className = "kaio-batch-item-name";
      nameEl.textContent = s.name || s.identifier || "(unnamed)";
      row.appendChild(nameEl);
      listEl.appendChild(row);
    }
    wrap.appendChild(listEl);

    const n = state.presetGroupBatchAdd.selected.size;
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "kaio-btn kaio-btn-primary kaio-batch-add-btn";
    addBtn.style.marginTop = "0.375rem";
    addBtn.style.width = "100%";
    addBtn.style.fontSize = "0.6875rem";
    addBtn.textContent = n ? "Add selected (" + n + ")" : "Add selected";
    addBtn.disabled = !n;
    addBtn.addEventListener("click", async () => {
      const ids = [...state.presetGroupBatchAdd.selected];
      if (!ids.length) return;
      try {
        await Promise.all(ids.map((id) =>
          api("PATCH", "/prompts/" + presetId + "/sections/" + id, { groupId: groupId })
        ));
        await loadPresetFull(presetId);
        state.presetGroupBatchAdd.selected.clear();
        renderRight();
        renderMiddle();
        showToast("Added " + ids.length + " section" + (ids.length === 1 ? "" : "s") + " to group", "success");
      } catch (err) {
        console.error("[kolache-AIO] Group batch add failed", err);
        showToast("Failed to add sections", "error");
      }
    });
    wrap.appendChild(addBtn);
  } else if (!members.length) {
    const msg = document.createElement("div");
    msg.className = "kaio-field-help";
    msg.textContent = "No ungrouped sections available.";
    wrap.appendChild(msg);
  }
  return wrap;
}

// ── Preset variables management ───────────────────────────────
function renderPresetVariablesPanel() {
  const wrap = document.createElement("div");
  const presetId = state.presetFull.preset.id;
  const cbs = state.presetFull.choiceBlocks || [];

  if (!cbs.length) {
    const empty = document.createElement("div");
    empty.className = "kaio-field-help";
    empty.textContent = "No variables defined. Variables let users select options that substitute into the prompt.";
    wrap.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "kaio-preset-var-list";
    for (const cb of cbs) {
      list.appendChild(renderPresetVariableRow(presetId, cb));
    }
    wrap.appendChild(list);
  }

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "kaio-create-btn";
  createBtn.style.marginTop = "0.375rem";
  createBtn.textContent = "+ Variable";
  createBtn.addEventListener("click", () => createPresetVariable(presetId));
  wrap.appendChild(createBtn);
  return wrap;
}

function renderPresetVariableRow(presetId, cb) {
  const wrap = document.createElement("div");
  wrap.className = "kaio-preset-var-row";
  const isExpanded = state.presetExpandedVariableId === cb.id;

  const header = document.createElement("div");
  header.className = "kaio-preset-var-header";
  header.addEventListener("click", () => {
    state.presetExpandedVariableId = isExpanded ? null : cb.id;
    renderRight();
  });

  const caret = document.createElement("span");
  caret.className = "kaio-collapsible-caret";
  if (!isExpanded) caret.style.transform = "rotate(-90deg)";
  header.appendChild(caret);

  const varTag = document.createElement("span");
  varTag.className = "kaio-preset-var-tag";
  varTag.textContent = "#";
  header.appendChild(varTag);

  const nameEl = document.createElement("span");
  nameEl.className = "kaio-preset-var-name";
  nameEl.textContent = cb.variableName || "(unnamed)";
  header.appendChild(nameEl);

  const opts = choiceBlockOptions(cb);
  const optCount = document.createElement("span");
  optCount.className = "kaio-folder-count";
  optCount.style.background = "rgba(251, 191, 36, 0.15)";
  optCount.style.color = "#fbbf24";
  optCount.textContent = opts.length + " option" + (opts.length === 1 ? "" : "s");
  header.appendChild(optCount);

  const macroTag = document.createElement("span");
  macroTag.className = "kaio-preset-var-macro";
  macroTag.textContent = "{{" + (cb.variableName || "") + "}}";
  header.appendChild(macroTag);

  wrap.appendChild(header);

  if (isExpanded) {
    wrap.appendChild(renderPresetVariableEditor(presetId, cb));
  }
  return wrap;
}

function renderPresetVariableEditor(presetId, cb) {
  const body = document.createElement("div");
  body.className = "kaio-preset-var-body";
  const opts = choiceBlockOptions(cb);
  // Ensure subsequent re-renders see in-progress mutations (added/removed options)
  cb.options = opts;

  // Variable name
  const nameField = document.createElement("div");
  nameField.className = "kaio-field";
  const nameLab = document.createElement("label");
  nameLab.className = "kaio-field-label";
  applyLabel(nameLab, "Variable name", "Used as {{variableName}} macro in sections.");
  nameField.appendChild(nameLab);
  const nameInput = document.createElement("input");
  nameInput.className = "kaio-input";
  nameInput.value = cb.variableName || "";
  nameField.appendChild(nameInput);
  body.appendChild(nameField);

  // Question
  const qField = document.createElement("div");
  qField.className = "kaio-field";
  const qLab = document.createElement("label");
  qLab.className = "kaio-field-label";
  applyLabel(qLab, "Question", "Prompt shown to the user when selecting an option.");
  qField.appendChild(qLab);
  const qInput = document.createElement("textarea");
  qInput.className = "kaio-textarea";
  qInput.rows = 2;
  qInput.value = cb.question || "";
  qField.appendChild(qInput);
  body.appendChild(qField);

  // Multi-select, separator, random
  const optRow = document.createElement("div");
  optRow.className = "kaio-field kaio-field-row";
  optRow.style.gridTemplateColumns = "1fr 1fr 1fr";

  const msWrap = document.createElement("label");
  msWrap.className = "kaio-checkbox";
  const msCb = document.createElement("input");
  msCb.type = "checkbox";
  msCb.checked = cb.multiSelect === true || cb.multiSelect === "true";
  msWrap.appendChild(msCb);
  const msTxt = document.createElement("span");
  msTxt.textContent = "Multi-select";
  msWrap.appendChild(msTxt);
  optRow.appendChild(msWrap);

  const rpWrap = document.createElement("label");
  rpWrap.className = "kaio-checkbox";
  const rpCb = document.createElement("input");
  rpCb.type = "checkbox";
  rpCb.checked = cb.randomPick === true || cb.randomPick === "true";
  rpWrap.appendChild(rpCb);
  const rpTxt = document.createElement("span");
  rpTxt.textContent = "Random pick";
  rpWrap.appendChild(rpTxt);
  optRow.appendChild(rpWrap);

  const sepField = document.createElement("div");
  sepField.className = "kaio-field";
  sepField.style.marginBottom = "0";
  const sepLab = document.createElement("label");
  sepLab.className = "kaio-field-label";
  sepLab.textContent = "Separator";
  sepField.appendChild(sepLab);
  const sepInput = document.createElement("input");
  sepInput.className = "kaio-input";
  sepInput.value = cb.separator ?? ", ";
  sepField.appendChild(sepInput);
  optRow.appendChild(sepField);
  body.appendChild(optRow);

  // Options list
  body.appendChild(sectionHeader("Options"));
  const optsList = document.createElement("div");
  optsList.className = "kaio-preset-var-opts";
  for (let i = 0; i < opts.length; i++) {
    optsList.appendChild(renderVariableOptionRow(opts, i));
  }
  body.appendChild(optsList);

  const addOptBtn = document.createElement("button");
  addOptBtn.type = "button";
  addOptBtn.className = "kaio-create-btn";
  addOptBtn.style.marginTop = "0.25rem";
  addOptBtn.textContent = "+ Option";
  addOptBtn.addEventListener("click", () => {
    opts.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), label: "", value: "" });
    renderRight();
  });
  body.appendChild(addOptBtn);

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "kaio-preset-var-actions";

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "kaio-btn kaio-btn-delete";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", () => deletePresetVariable(presetId, cb.id));
  actions.appendChild(delBtn);

  const spacer = document.createElement("span");
  spacer.className = "kaio-spacer";
  actions.appendChild(spacer);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "kaio-btn kaio-btn-primary";
  saveBtn.textContent = "Save variable";
  saveBtn.addEventListener("click", async () => {
    try {
      const body = {
        variableName: nameInput.value.trim(),
        question: qInput.value,
        options: opts,
        multiSelect: msCb.checked,
        randomPick: rpCb.checked,
        separator: sepInput.value,
      };
      await api("PATCH", "/prompts/" + presetId + "/variables/" + cb.id, body);
      await loadPresetFull(presetId);
      renderRight();
      renderMiddle();
      showToast("Variable saved ✓", "success");
    } catch (err) {
      console.error("[kolache-AIO] Save variable failed", err);
      showToast("Save failed — see console", "error");
    }
  });
  actions.appendChild(saveBtn);
  body.appendChild(actions);

  return body;
}

function renderVariableOptionRow(opts, index) {
  const opt = opts[index];
  const row = document.createElement("div");
  row.className = "kaio-preset-var-opt-row";

  const labelInput = document.createElement("input");
  labelInput.className = "kaio-input";
  labelInput.placeholder = "Label";
  labelInput.value = opt.label || "";
  labelInput.addEventListener("input", () => { opt.label = labelInput.value; });
  row.appendChild(labelInput);

  const valueInput = document.createElement("input");
  valueInput.className = "kaio-input";
  valueInput.placeholder = "Value";
  valueInput.value = opt.value || "";
  valueInput.addEventListener("input", () => { opt.value = valueInput.value; });
  row.appendChild(valueInput);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "kaio-preset-section-delete";
  delBtn.textContent = "✕";
  delBtn.title = "Remove option";
  delBtn.addEventListener("click", () => {
    opts.splice(index, 1);
    renderRight();
  });
  row.appendChild(delBtn);
  return row;
}

// ── Preset management API actions ─────────────────────────────
function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function createPresetSection(presetId) {
  try {
    await api("POST", "/prompts/" + presetId + "/sections", {
      identifier: generateId(),
      name: "New Section",
      content: "",
      role: "system",
    });
    await loadPresetFull(presetId);
    renderRight();
    renderMiddle();
    showToast("Section created", "success");
  } catch (err) {
    console.error("[kolache-AIO] Create section failed", err);
    showToast("Failed to create section", "error");
  }
}

async function createPresetMarker(presetId, name, type) {
  try {
    await api("POST", "/prompts/" + presetId + "/sections", {
      identifier: generateId(),
      name: name || "New Marker",
      content: "",
      role: "system",
      isMarker: true,
      markerConfig: { type: type || "world_info_before" },
    });
    await loadPresetFull(presetId);
    renderRight();
    renderMiddle();
    showToast("Marker created", "success");
  } catch (err) {
    console.error("[kolache-AIO] Create marker failed", err);
    showToast("Failed to create marker", "error");
  }
}

async function deletePresetSection(presetId, sectionId, label) {
  const confirmed = await new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "kaio-confirm-bg";
    bg.innerHTML = '<div class="kaio-confirm"><div class="kaio-confirm-title">Delete section?</div><div class="kaio-confirm-msg">Permanently delete "' + escapeHTML(label) + '"? This cannot be undone.</div><div class="kaio-confirm-actions"><button class="kaio-btn kaio-btn-ghost" data-act="cancel">Cancel</button><button class="kaio-btn kaio-btn-danger" data-act="delete">Delete</button></div></div>';
    overlayEl.querySelector(".kaio-shell").appendChild(bg);
    bg.querySelector('[data-act="cancel"]').addEventListener("click", () => { bg.remove(); resolve(false); });
    bg.querySelector('[data-act="delete"]').addEventListener("click", () => { bg.remove(); resolve(true); });
  });
  if (!confirmed) return;
  try {
    await api("DELETE", "/prompts/" + presetId + "/sections/" + sectionId);
    await loadPresetFull(presetId);
    renderRight();
    renderMiddle();
    showToast("Section deleted", "success");
  } catch (err) {
    console.error("[kolache-AIO] Delete section failed", err);
    showToast("Failed to delete section", "error");
  }
}

async function reorderPresetSections(presetId, sectionIds) {
  try {
    await api("PUT", "/prompts/" + presetId + "/sections/reorder", { sectionIds });
    await loadPresetFull(presetId);
    renderRight();
    renderMiddle();
  } catch (err) {
    console.error("[kolache-AIO] Reorder sections failed", err);
    showToast("Failed to reorder sections", "error");
  }
}

async function createPresetGroup(presetId) {
  try {
    await api("POST", "/prompts/" + presetId + "/groups", { name: "New Group" });
    await loadPresetFull(presetId);
    renderRight();
    showToast("Group created", "success");
  } catch (err) {
    console.error("[kolache-AIO] Create group failed", err);
    showToast("Failed to create group", "error");
  }
}

async function renamePresetGroup(presetId, groupId, name) {
  try {
    await api("PATCH", "/prompts/" + presetId + "/groups/" + groupId, { name });
    await loadPresetFull(presetId);
    renderMiddle();
  } catch (err) {
    console.error("[kolache-AIO] Rename group failed", err);
  }
}

async function deletePresetGroup(presetId, groupId) {
  try {
    await api("DELETE", "/prompts/" + presetId + "/groups/" + groupId);
    await loadPresetFull(presetId);
    if (state.presetGroupBatchAdd.groupId === groupId) {
      state.presetGroupBatchAdd = { groupId: null, selected: new Set() };
    }
    renderRight();
    renderMiddle();
    showToast("Group deleted", "success");
  } catch (err) {
    console.error("[kolache-AIO] Delete group failed", err);
    showToast("Failed to delete group", "error");
  }
}

async function createPresetVariable(presetId) {
  try {
    const result = await api("POST", "/prompts/" + presetId + "/variables", {
      variableName: "new_variable",
      question: "Select an option",
      options: [{ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), label: "Option 1", value: "" }],
    });
    await loadPresetFull(presetId);
    if (result && result.id) state.presetExpandedVariableId = result.id;
    renderRight();
    showToast("Variable created", "success");
  } catch (err) {
    console.error("[kolache-AIO] Create variable failed", err);
    showToast("Failed to create variable", "error");
  }
}

async function deletePresetVariable(presetId, variableId) {
  const confirmed = await new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "kaio-confirm-bg";
    bg.innerHTML = '<div class="kaio-confirm"><div class="kaio-confirm-title">Delete variable?</div><div class="kaio-confirm-msg">Permanently delete this variable? Any {{macro}} references to it in sections will stop resolving.</div><div class="kaio-confirm-actions"><button class="kaio-btn kaio-btn-ghost" data-act="cancel">Cancel</button><button class="kaio-btn kaio-btn-danger" data-act="delete">Delete</button></div></div>';
    overlayEl.querySelector(".kaio-shell").appendChild(bg);
    bg.querySelector('[data-act="cancel"]').addEventListener("click", () => { bg.remove(); resolve(false); });
    bg.querySelector('[data-act="delete"]').addEventListener("click", () => { bg.remove(); resolve(true); });
  });
  if (!confirmed) return;
  try {
    await api("DELETE", "/prompts/" + presetId + "/variables/" + variableId);
    await loadPresetFull(presetId);
    if (state.presetExpandedVariableId === variableId) state.presetExpandedVariableId = null;
    renderRight();
    showToast("Variable deleted", "success");
  } catch (err) {
    console.error("[kolache-AIO] Delete variable failed", err);
    showToast("Failed to delete variable", "error");
  }
}

// ── Drag-and-drop state for simulated prompt section reordering ──
let draggedSectionId = null;

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── Prompt Inspector ────────────────────────────────────────────
// Captures the entire prompt for the active chat as it would be sent to the
// API (via the engine's dry-run preview), or a structural preview of the
// console's current selection when history is omitted or no chat is open.

// The Marinara client persists the open chat's id to localStorage as a bare
// string; the key is removed when no chat is open.
function getActiveChatId() {
  try {
    const id = localStorage.getItem("marinara-active-chat-id");
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

// ── AIO settings (persisted in localStorage) ────────────────────
const KAIO_SETTINGS_KEY = "kaio-settings";
const KAIO_DEFAULT_SETTINGS = {
  connectionlessHistoryLimit: 0,
  inspectHistoryDefault: "ask",
  tokenGaugeContext: 8192,
  piShowRoleLabels: false,
  piColorSystem: "#22d3ee",    // cyan
  piColorAssistant: "#e879f9", // magenta
  piColorUser: "#facc15",      // yellow
  piBorderWidth: 3,
};
function getSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KAIO_SETTINGS_KEY) || "{}");
    return { ...KAIO_DEFAULT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) };
  } catch {
    return { ...KAIO_DEFAULT_SETTINGS };
  }
}
function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  try { localStorage.setItem(KAIO_SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function showSettings() {
  const shell = overlayEl && overlayEl.querySelector(".kaio-shell");
  if (!shell) return;
  const prev = shell.querySelector(".kaio-settings-bg");
  if (prev) { if (typeof prev._kaioClose === "function") prev._kaioClose(); else prev.remove(); }

  const s = getSettings();
  const bg = document.createElement("div");
  bg.className = "kaio-confirm-bg kaio-settings-bg";
  bg.innerHTML = `
    <div class="kaio-settings" role="dialog" aria-label="AIO settings">
      <div class="kaio-settings-head">
        <span class="kaio-settings-title">⚙️ AIO Settings</span>
        <span class="kaio-spacer"></span>
        <button class="kaio-iconbtn" data-set="close" title="Close (Esc)">✕</button>
      </div>
      <div class="kaio-settings-body">
        <div class="kaio-set-field">
          <label class="kaio-set-label" for="kaio-set-histdefault">Inspect — chat history default</label>
          <select id="kaio-set-histdefault" class="kaio-set-input kaio-set-select" data-set="histDefault">
            <option value="ask">Always ask</option>
            <option value="include">Include history</option>
            <option value="omit">Omit history</option>
          </select>
          <div class="kaio-set-hint">What 🔍 Inspect does when a chat is open. "Always ask" shows the Include / Omit prompt each time.</div>
        </div>
        <div class="kaio-set-field">
          <label class="kaio-set-label" for="kaio-set-histlimit">Connection-free Inspect — max history messages</label>
          <input id="kaio-set-histlimit" type="number" min="0" step="1" class="kaio-set-input" data-set="historyLimit" />
          <div class="kaio-set-hint">When a chat has no API connection, the Prompt Inspector inserts the raw chat history. This caps how many of the most recent turns are shown. <strong>0 = all.</strong></div>
        </div>
        <div class="kaio-set-field">
          <label class="kaio-set-label" for="kaio-set-ctxsize">Token gauge — context window size</label>
          <input id="kaio-set-ctxsize" type="number" min="0" step="256" class="kaio-set-input" data-set="ctxSize" />
          <div class="kaio-set-hint">The Simulated Prompt header shows a rough token estimate (~4 chars each) and a usage bar filling toward this size. Set it to your model's context length. <strong>0 = hide the bar</strong> (the count still shows).</div>
        </div>
        <div class="kaio-set-divider"></div>
        <div class="kaio-set-group-label">Prompt Inspector appearance</div>
        <div class="kaio-set-field">
          <label class="kaio-set-checkrow">
            <input type="checkbox" data-set="roleLabels" />
            <span class="kaio-set-label">Show role labels (System / User / Assistant)</span>
          </label>
          <div class="kaio-set-hint">Off by default — roles are shown by the coloured left border instead.</div>
        </div>
        <div class="kaio-set-field">
          <span class="kaio-set-label">Role colours</span>
          <div class="kaio-set-colorrow">
            <label class="kaio-set-color"><input type="color" data-set="colorSystem" /> System</label>
            <label class="kaio-set-color"><input type="color" data-set="colorAssistant" /> Assistant</label>
            <label class="kaio-set-color"><input type="color" data-set="colorUser" /> User</label>
          </div>
        </div>
        <div class="kaio-set-field">
          <label class="kaio-set-label" for="kaio-set-borderw">Role border thickness (px)</label>
          <input id="kaio-set-borderw" type="number" min="1" max="16" step="1" class="kaio-set-input" data-set="borderWidth" />
          <div class="kaio-set-hint">Thicker borders can help tell roles apart at a glance.</div>
        </div>
      </div>
    </div>`;
  shell.appendChild(bg);

  const histDefault = bg.querySelector('[data-set="histDefault"]');
  histDefault.value = s.inspectHistoryDefault || "ask";
  histDefault.addEventListener("change", () => setSetting("inspectHistoryDefault", histDefault.value));

  const input = bg.querySelector('[data-set="historyLimit"]');
  input.value = String(s.connectionlessHistoryLimit || 0);
  const commit = () => {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < 0) v = 0;
    input.value = String(v);
    setSetting("connectionlessHistoryLimit", v);
  };
  input.addEventListener("change", commit);

  const ctxSize = bg.querySelector('[data-set="ctxSize"]');
  ctxSize.value = String(s.tokenGaugeContext ?? KAIO_DEFAULT_SETTINGS.tokenGaugeContext);
  ctxSize.addEventListener("change", () => {
    let v = parseInt(ctxSize.value, 10);
    if (!Number.isFinite(v) || v < 0) v = 0;
    ctxSize.value = String(v);
    setSetting("tokenGaugeContext", v);
    renderMiddle(); // refresh the gauge against the new context size
  });

  const roleLabels = bg.querySelector('[data-set="roleLabels"]');
  roleLabels.checked = !!s.piShowRoleLabels;
  roleLabels.addEventListener("change", () => setSetting("piShowRoleLabels", roleLabels.checked));

  const colorMap = { colorSystem: "piColorSystem", colorAssistant: "piColorAssistant", colorUser: "piColorUser" };
  for (const attr of Object.keys(colorMap)) {
    const el = bg.querySelector('[data-set="' + attr + '"]');
    el.value = s[colorMap[attr]] || KAIO_DEFAULT_SETTINGS[colorMap[attr]];
    el.addEventListener("input", () => setSetting(colorMap[attr], el.value));
  }

  const borderW = bg.querySelector('[data-set="borderWidth"]');
  borderW.value = String(s.piBorderWidth || 3);
  borderW.addEventListener("change", () => {
    let v = parseInt(borderW.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    if (v > 16) v = 16;
    borderW.value = String(v);
    setSetting("piBorderWidth", v);
  });

  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); }
  }
  function close() {
    commit();
    document.removeEventListener("keydown", onKey, true);
    bg.remove();
  }
  bg._kaioClose = close;
  document.addEventListener("keydown", onKey, true);
  bg.querySelector('[data-set="close"]').addEventListener("click", close);
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
}

// Plain-text variant of blockPreviewHTML's variable substitution — no HTML,
// no <mark>. Non-variable macros ({{char}}, {{user}}, …) are left untouched.
function substituteVars(text, subs) {
  if (!text || !subs.length) return text || "";
  const pattern = subs
    .map((s) => `\\{\\{(?:getvar::)?${escapeRegex(s.name)}\\}\\}`)
    .join("|");
  const re = new RegExp(pattern, "gi");
  return text.replace(re, (mm) => {
    const name = mm.slice(2, -2).replace(/^getvar::/i, "");
    const sub = subs.find((s) => s.name.toLowerCase() === name.toLowerCase());
    return sub ? sub.value : "";
  });
}

// Serialize the console's current selection (the Simulated Prompt assembly)
// into a flat, role-tagged message list. At the chat-history anchor:
//   • historyMessages omitted → a single {{chat_history}} placeholder with the
//     depth-injected blocks stacked above it (higher depth first). Used for the
//     "omit history" choice and the no-chat-open case.
//   • historyMessages provided (an array of {role, content}) → the real chat
//     turns, with each depth injection interleaved `depth` turns from the end
//     (depth 1 = just before the last turn), mirroring runtime depth injection.
//     Used as the connection-free fallback when the engine dry-run can't run.
function buildPromptMessagesFromSimulation(historyMessages) {
  const blocks = buildSimulatedPrompt();
  const subs = activeVariableSubs();
  const out = [];
  const roleOf = (b) =>
    (b.section && b.section.role) || (b.entry && b.entry.role) || "system";
  const textOf = (b) => substituteVars(blockPreviewRaw(b), subs);

  for (const b of blocks) {
    if (b.kind === "chat-history") {
      const depth = [
        ...(b.depthSections || []).map((s) => ({
          role: s.role || "system",
          content: textOf({ kind: "section", section: s }),
          depth: s.injectionDepth ?? 0,
        })),
        ...(b.depthEntries || []).map((e) => ({
          role: e.role || "system",
          content: textOf({ kind: "lorebook-entry", entry: e }),
          depth: e.depth ?? 0,
        })),
      ].filter((d) => d.content);

      if (Array.isArray(historyMessages)) {
        const L = historyMessages.length;
        const byBoundary = {};
        for (const d of depth) {
          const idx = Math.max(0, Math.min(L, L - (d.depth || 0)));
          (byBoundary[idx] = byBoundary[idx] || []).push(d);
        }
        for (let i = 0; i <= L; i++) {
          for (const d of byBoundary[i] || []) {
            out.push({ role: d.role, content: d.content, depthInjection: true, depth: d.depth });
          }
          if (i < L) {
            const m = historyMessages[i] || {};
            const role = m.role === "user" || m.role === "assistant" ? m.role : "system";
            out.push({ role, content: m.content || "", isHistory: true });
          }
        }
      } else {
        depth.sort((x, y) => (y.depth ?? 0) - (x.depth ?? 0));
        for (const d of depth) {
          out.push({ role: d.role, content: d.content, depthInjection: true, depth: d.depth });
        }
        out.push({ role: "system", content: "{{chat_history}}", historyPlaceholder: true });
      }
      continue;
    }
    if (b.kind === "marker") continue; // runtime-only placeholder, no content
    const content = textOf(b);
    if (!content) continue;
    out.push({ role: roleOf(b), content });
  }
  return out;
}

// Fetch a chat's messages directly (no API connection required) for the
// connection-free history fallback. Returns [] on any failure.
async function fetchChatMessages(chatId) {
  try {
    const list = await api("GET", "/chats/" + chatId + "/messages");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error("[kolache-AIO] couldn't load chat messages", e);
    return [];
  }
}

// Capture the exact prompt the engine would send for a chat, via the dry-run
// preview endpoint. Returns { messages, meta }. CSRF is added by Marinara's
// global fetch shim (same path as every other api() call).
async function dryRunPrompt(chatId) {
  const data = await api("POST", "/generate/dryRun", { chatId, returnPrompt: true });
  const msgs = (data && data.prompt && data.prompt.messages) || [];
  const p = (data && data.parameters) || {};
  return {
    messages: msgs.map((m) => ({
      role: m.role,
      content: m.content || "",
      images: Array.isArray(m.images) ? m.images.length : 0,
      files: Array.isArray(m.files) ? m.files.length : 0,
    })),
    meta: {
      mode: "live",
      wrapFormat: data && data.prompt && data.prompt.wrapFormat,
      provider: p.provider,
      model: p.model,
      maxContext: p.maxContext,
    },
  };
}

// Include / Omit history dialog (only shown when a chat is open).
// Resolves "include" | "omit" | null (cancel).
function askIncludeHistory() {
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "kaio-confirm-bg";
    bg.innerHTML =
      '<div class="kaio-confirm">' +
      '<div class="kaio-confirm-title">Inspect prompt</div>' +
      "<div class=\"kaio-confirm-msg\">A chat is open. Include its chat history (fit to the preset's context limit) in the captured prompt, or omit it and show a placeholder instead?</div>" +
      '<div class="kaio-confirm-actions">' +
      '<button class="kaio-btn kaio-btn-ghost" data-act="cancel">Cancel</button>' +
      '<button class="kaio-btn" data-act="omit">Omit history</button>' +
      '<button class="kaio-btn kaio-btn-primary" data-act="include">Include history</button>' +
      "</div></div>";
    overlayEl.querySelector(".kaio-shell").appendChild(bg);
    let onKey;
    const done = (v) => {
      document.removeEventListener("keydown", onKey, true);
      bg.remove();
      resolve(v);
    };
    // Capture-phase Esc resolves to cancel and stops the console's own Esc
    // handler from firing (which would close the whole console under us).
    onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); done(null); } };
    bg._kaioClose = () => done(null);
    document.addEventListener("keydown", onKey, true);
    bg.querySelector('[data-act="cancel"]').addEventListener("click", () => done(null));
    bg.querySelector('[data-act="omit"]').addEventListener("click", () => done("omit"));
    bg.querySelector('[data-act="include"]').addEventListener("click", () => done("include"));
    bg.addEventListener("click", (e) => { if (e.target === bg) done(null); });
  });
}

let piBusy = false;
async function openPromptInspector() {
  if (piBusy) return; // ignore re-entrant clicks while a dialog/capture is pending
  piBusy = true;
  try {
    const chatId = getActiveChatId();
    let messages, meta;
    if (chatId) {
      const def = getSettings().inspectHistoryDefault;
      const choice = (def === "include" || def === "omit") ? def : await askIncludeHistory();
      if (!choice) return;
      if (choice === "include") {
        showToast("Capturing prompt…", "info");
        try {
          const res = await dryRunPrompt(chatId);
          messages = res.messages;
          meta = res.meta;
        } catch (e) {
          const errMsg = (e && e.message) ? String(e.message) : String(e);
          // The dry-run needs an API connection (to resolve the model + context
          // window). When the chat has none, fall back to a connection-free view:
          // fetch the raw chat history and interleave it into the structural
          // prompt. It isn't trimmed to a model context window, but it shows the
          // real turns (with depth prompts placed between them).
          if (/No API connection/i.test(errMsg)) {
            const all = await fetchChatMessages(chatId);
            const limit = getSettings().connectionlessHistoryLimit;
            const limited = limit > 0 && all.length > limit;
            const history = limited ? all.slice(-limit) : all;
            messages = buildPromptMessagesFromSimulation(history);
            meta = {
              mode: "structural",
              note: "No API connection on this chat, so this is a structural approximation — not the exact request. "
                + "Preset macros (e.g. {{user}}, {{char}}) are left unresolved, wrap formatting (XML/markdown) isn't applied, "
                + "the messages aren't merged/ordered exactly as the provider would receive them, and the history isn't "
                + "trimmed to a model's context window. Showing "
                + (limited ? ("the most recent " + limit + " of " + all.length + " chat turns") : "the raw chat history")
                + " (cap in ⚙ Settings). Add a connection and choose Include for the exact, resolved prompt — and Copy JSON for the real messages array.",
            };
          } else {
            console.error("[kolache-AIO] dryRun failed", e);
            showPromptInspectorModal([], { mode: "error", error: errMsg });
            return;
          }
        }
      } else {
        messages = buildPromptMessagesFromSimulation();
        meta = { mode: "structural" };
      }
    } else {
      messages = buildPromptMessagesFromSimulation();
      meta = { mode: "structural" };
    }
    showPromptInspectorModal(messages, meta);
  } finally {
    piBusy = false;
  }
}

// Visible-line-break preference, persisted across opens.
function piShowBreaks() {
  try { return localStorage.getItem("kaio-pi-breaks") === "1"; } catch { return false; }
}
function setPiShowBreaks(v) {
  try { localStorage.setItem("kaio-pi-breaks", v ? "1" : "0"); } catch { /* ignore */ }
}
// View mode preference (plaintext default), persisted across opens.
function piView() {
  try { return localStorage.getItem("kaio-pi-view") === "json" ? "json" : "plaintext"; } catch { return "plaintext"; }
}
function setPiView(v) {
  try { localStorage.setItem("kaio-pi-view", v === "json" ? "json" : "plaintext"); } catch { /* ignore */ }
}
function piRoleLabel(role) {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  return "System";
}

function showPromptInspectorModal(messages, meta) {
  const shell = overlayEl && overlayEl.querySelector(".kaio-shell");
  if (!shell) return;
  const prev = shell.querySelector(".kaio-pi-bg");
  if (prev) { if (typeof prev._kaioClose === "function") prev._kaioClose(); else prev.remove(); }

  const bg = document.createElement("div");
  bg.className = "kaio-pi-bg";
  bg.innerHTML = `
    <div class="kaio-pi-modal" role="dialog" aria-label="Prompt Inspector">
      <div class="kaio-pi-head">
        <span class="kaio-pi-title">🔍 Prompt Inspector</span>
        <span class="kaio-pi-badge"></span>
        <span class="kaio-spacer"></span>
        <div class="kaio-pi-actions">
          <button class="kaio-btn" data-pi="view" title="Toggle between plaintext and a JSON messages array (colour-coding kept either way)">{ } JSON</button>
          <button class="kaio-btn kaio-btn-ghost" data-pi="breaks" title="Toggle visible line breaks">¶ Line breaks</button>
          <button class="kaio-btn" data-pi="copy" title="Copy as readable text (### role headers — not the wire format)">Copy</button>
          <button class="kaio-btn" data-pi="copyjson" title="Copy the messages array as JSON — the structure actually sent to chat APIs">Copy JSON</button>
        </div>
        <button class="kaio-iconbtn" data-pi="close" title="Close (Esc)">✕</button>
      </div>
      <div class="kaio-pi-body"></div>
    </div>`;
  shell.appendChild(bg);

  // Apply user appearance settings (role colours, border width, label visibility)
  // as CSS variables / a data-attr on the modal root.
  const piSettings = getSettings();
  const modal = bg.querySelector(".kaio-pi-modal");
  modal.style.setProperty("--pi-system", piSettings.piColorSystem || KAIO_DEFAULT_SETTINGS.piColorSystem);
  modal.style.setProperty("--pi-assistant", piSettings.piColorAssistant || KAIO_DEFAULT_SETTINGS.piColorAssistant);
  modal.style.setProperty("--pi-user", piSettings.piColorUser || KAIO_DEFAULT_SETTINGS.piColorUser);
  modal.style.setProperty("--pi-border-width", (piSettings.piBorderWidth || 3) + "px");
  modal.dataset.roleLabels = piSettings.piShowRoleLabels ? "true" : "false";

  const badge = bg.querySelector(".kaio-pi-badge");
  if (meta.mode === "live") {
    const bits = [];
    if (meta.provider || meta.model) bits.push(`${meta.provider ? meta.provider + "/" : ""}${meta.model || ""}`);
    if (meta.maxContext) bits.push(`ctx ${meta.maxContext}`);
    if (meta.wrapFormat) bits.push(meta.wrapFormat);
    badge.textContent = "Live · " + bits.join(" · ");
    badge.dataset.mode = "live";
  } else if (meta.mode === "error") {
    badge.textContent = "Live capture failed";
    badge.dataset.mode = "error";
  } else {
    badge.textContent = meta.note ? "Raw chat history · no connection" : "Structural preview · console selection";
    badge.dataset.mode = "structural";
  }
  if (messages.length && meta.mode !== "error") {
    const piTokens = messages.reduce((n, m) => n + estimateTokens(m.content || ""), 0);
    badge.textContent += " · ~" + piTokens.toLocaleString() + " tok";
  }

  const body = bg.querySelector(".kaio-pi-body");
  const breaksBtn = bg.querySelector('[data-pi="breaks"]');
  const viewBtn = bg.querySelector('[data-pi="view"]');

  function renderBody() {
    const view = piView();
    const show = piShowBreaks();
    modal.dataset.view = view;
    viewBtn.dataset.active = view === "json" ? "true" : "";
    breaksBtn.dataset.active = show ? "true" : "";
    body.innerHTML = "";
    if (meta.note) {
      const note = document.createElement("div");
      note.className = "kaio-pi-note";
      note.textContent = meta.note;
      body.appendChild(note);
    }
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "kaio-pi-empty";
      if (meta.mode === "error") {
        const title = document.createElement("div");
        title.className = "kaio-pi-error-title";
        title.textContent = "Couldn't capture the live prompt";
        const msg = document.createElement("pre");
        msg.className = "kaio-pi-error-msg";
        msg.textContent = meta.error || "Unknown error";
        const hint = document.createElement("div");
        hint.className = "kaio-pi-error-hint";
        hint.textContent =
          "403 → add this browser's origin to BOTH CORS_ORIGINS and CSRF_TRUSTED_ORIGINS in the engine .env. " +
          "400 → the chat has no API connection configured. " +
          "\"Failed to fetch\" → the request was blocked before reaching the server (CORS, or an interfering browser extension).";
        empty.appendChild(title);
        empty.appendChild(msg);
        empty.appendChild(hint);
      } else {
        empty.textContent = meta.mode === "structural"
          ? "Nothing to preview yet — open Sources and pick a preset (plus optional character, persona, and lorebook entries) to see its assembled structure."
          : "The engine returned an empty prompt.";
      }
      body.appendChild(empty);
      return;
    }
    if (view === "json") {
      const open = document.createElement("div");
      open.className = "kaio-pi-json-bracket";
      open.textContent = "[";
      body.appendChild(open);
    }
    messages.forEach((m, i) => {
      const blk = document.createElement("div");
      blk.className = "kaio-pi-msg";
      blk.dataset.role = m.role || "system";
      if (m.historyPlaceholder) blk.dataset.placeholder = "true";
      if (m.depthInjection) blk.dataset.depth = "true";

      const label = document.createElement("div");
      label.className = "kaio-pi-msg-role";
      let labelText = m.historyPlaceholder
        ? "Chat history"
        : piRoleLabel(m.role) + (m.depthInjection ? " · depth " + (m.depth ?? 0) : "");
      const att = [];
      if (m.images) att.push(m.images + " img");
      if (m.files) att.push(m.files + " file");
      if (att.length) labelText += " · " + att.join(", ");
      label.textContent = labelText;

      const pre = document.createElement("pre");
      pre.className = "kaio-pi-pre";
      if (view === "json") {
        // Per-message JSON object, colour-coded by the block's left border.
        // Copy JSON still yields the full valid array; this view keeps the
        // role colour-coding for visual comprehension.
        const obj = { role: m.role || "system", content: m.content || "" };
        pre.textContent = JSON.stringify(obj, null, 2) + (i < messages.length - 1 ? "," : "");
      } else {
        const content = m.content || "";
        pre.textContent = show ? content.replace(/\n/g, "↵\n") : content;
      }

      blk.appendChild(label);
      blk.appendChild(pre);
      body.appendChild(blk);
    });
    if (view === "json") {
      const close = document.createElement("div");
      close.className = "kaio-pi-json-bracket";
      close.textContent = "]";
      body.appendChild(close);
    }
  }
  renderBody();

  breaksBtn.addEventListener("click", () => { setPiShowBreaks(!piShowBreaks()); renderBody(); });
  viewBtn.addEventListener("click", () => { setPiView(piView() === "json" ? "plaintext" : "json"); renderBody(); });
  bg.querySelector('[data-pi="copy"]').addEventListener("click", async () => {
    const text = messages.map((m) => {
      const head = m.historyPlaceholder
        ? "### Chat history"
        : "### " + piRoleLabel(m.role) + (m.depthInjection ? " (depth " + (m.depth ?? 0) + ")" : "");
      return head + "\n" + (m.content || "");
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast("Prompt copied", "success");
    } catch {
      showToast("Copy failed — clipboard unavailable", "error");
    }
  });
  bg.querySelector('[data-pi="copyjson"]').addEventListener("click", async () => {
    const json = JSON.stringify(
      messages.map((m) => ({ role: m.role || "system", content: m.content || "" })),
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(json);
      showToast("Copied as JSON", "success");
    } catch {
      showToast("Copy failed — clipboard unavailable", "error");
    }
  });

  function onPiKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); }
  }
  function close() {
    document.removeEventListener("keydown", onPiKey, true);
    bg.remove();
  }
  bg._kaioClose = close; // let closeConsoleNow tear this down cleanly
  document.addEventListener("keydown", onPiKey, true);
  bg.querySelector('[data-pi="close"]').addEventListener("click", close);
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
}

console.log("[kolache-AIO] v1.8.1 loaded — Marinara Engine 2.0.0 (REST /api)");
injectTopbarButton();
tryInjectExtensionLauncher();
marinara.observe(document.body, () => { injectTopbarButton(); tryInjectExtensionLauncher(); });
marinara.onCleanup(() => {
  if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
  document.removeEventListener("keydown", onKeydown);
  document.querySelectorAll(".kaio-tab-btn, .kaio-ext-launcher").forEach((b) => b.remove());
});
