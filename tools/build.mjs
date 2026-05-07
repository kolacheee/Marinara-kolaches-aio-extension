#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────
// Bundles src/kolaches-aio.{js,css} into kolaches-aio.json — the
// single-file manifest format Marinara Engine's extension loader
// imports. Run with:  node tools/build.mjs
// ──────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const css = readFileSync(resolve(root, "src/kolaches-aio.css"), "utf-8");
const js  = readFileSync(resolve(root, "src/kolaches-aio.js"),  "utf-8");

// Sanity: parse the JS as a Function body the same way Marinara will.
try {
  // eslint-disable-next-line no-new, no-new-func
  new Function("marinara", js);
} catch (err) {
  console.error("✗ JS does not parse:", err.message);
  process.exit(1);
}

const manifest = {
  name: "kolache's AIO Prompt Viewer and Editor",
  description:
    "All-in-one console for viewing and editing presets, lorebook entries, " +
    "characters, and personas in the order they would assemble.",
  css,
  js,
};

const out = JSON.stringify(manifest, null, 2);
writeFileSync(resolve(root, "kolaches-aio.json"), out, "utf-8");

console.log(
  `✓ kolaches-aio.json — ${out.length} bytes ` +
  `(JS: ${js.length}, CSS: ${css.length})`
);
