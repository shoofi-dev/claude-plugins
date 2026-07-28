#!/usr/bin/env node
/**
 * docs-touch-check — warn when a PR changes code a domain doc describes.
 *
 * `docs-check` catches STRUCTURAL drift: a renamed symbol, a deleted file, a changed
 * status constant. It cannot catch SEMANTIC drift — someone changing what a function
 * does while keeping its name. Nothing fails, and the doc is now confidently wrong.
 *
 * This closes part of that gap at the only moment when the person with the context is
 * still looking: the PR. It maps changed files to owning domains (context/ownership.json)
 * and prints which domain docs may need revisiting.
 *
 * Deliberately NON-BLOCKING (always exit 0). Most changes don't invalidate a doc, and a
 * gate that cries wolf gets ignored. This is a prompt, not a wall.
 *
 * Usage (from a code repo's CI):
 *   node docs-touch-check.js --repo shoofi-server --files "$(git diff --name-only origin/main...)"
 *   node docs-touch-check.js --repo shoofi-server --base origin/main
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OWNERSHIP = path.join(__dirname, "..", "context", "ownership.json");

function parseArgs(argv) {
  const out = { repo: null, files: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") out.repo = argv[++i];
    else if (argv[i] === "--files") out.files = argv[++i];
    else if (argv[i] === "--base") out.base = argv[++i];
  }
  return out;
}

function changedFiles({ files, base }) {
  if (files) return files.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
  const ref = base || "origin/main";
  try {
    return execFileSync("git", ["diff", "--name-only", `${ref}...`], { encoding: "utf8" })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args.repo) {
  console.log("docs-touch-check: --repo <name> is required; skipping.");
  process.exit(0);
}
if (!fs.existsSync(OWNERSHIP)) {
  console.log("docs-touch-check: ownership map not found; skipping.");
  process.exit(0);
}

const { domains } = JSON.parse(fs.readFileSync(OWNERSHIP, "utf8"));
const files = changedFiles(args);
if (!files.length) {
  console.log("docs-touch-check: no changed files detected; nothing to check.");
  process.exit(0);
}

const hits = {};
for (const [domain, repos] of Object.entries(domains)) {
  const prefixes = repos[args.repo] || [];
  const matched = files.filter((f) => prefixes.some((p) => f.startsWith(p)));
  if (matched.length) hits[domain] = matched;
}

if (!Object.keys(hits).length) {
  console.log(
    `docs-touch-check: none of the ${files.length} changed file(s) are owned by a domain doc.`
  );
  process.exit(0);
}

console.log("\n────────────────────────────────────────────────────────────");
console.log(" docs-touch-check — this PR touches domain-owned code");
console.log("────────────────────────────────────────────────────────────");
for (const [domain, matched] of Object.entries(hits)) {
  console.log(`\n  ${domain}`);
  matched.slice(0, 8).forEach((f) => console.log(`    - ${f}`));
  if (matched.length > 8) console.log(`    … and ${matched.length - 8} more`);
}
console.log(
  "\n  If this change alters anything the domain doc CLAIMS — a flow, an invariant,\n" +
    "  a formula, a status value, a known-status verdict — update the doc.\n" +
    "  Docs live in shoofi-dev/claude-plugins under plugins/shoofi-domains/context/<domain>/.\n" +
    "  Open a COMPANION PR there and cross-link it from this one.\n" +
    "  (Structural drift is already caught by docs:check; this is about meaning.)\n"
);
process.exit(0);
