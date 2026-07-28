#!/usr/bin/env node
/**
 * docs-check — assert that the domain context docs still describe reality.
 *
 * Context docs go stale silently, and a confidently wrong doc is worse than no doc:
 * the agent acts on a lie. Each domain ships a manifest under context/assert/ listing
 * the files, symbols and patterns its doc claims exist. This script verifies them
 * against real checkouts, so a rename breaks the build instead of the next agent.
 *
 * Usage:
 *   node scripts/docs-check.js --repo shoofi-server=/path/to/shoofi-server \
 *                              --repo shoofi-app=/path/to/shoofi-app
 *   node scripts/docs-check.js --repo shoofi-server=.        # single repo
 *
 * Repos that are not supplied are skipped (and reported), so this is useful from
 * inside any one repo's CI without needing every checkout.
 *
 * Exit code 0 = all supplied repos check out, 1 = at least one assertion failed.
 * Zero dependencies on purpose — it must run in any repo's CI without an install.
 */

const fs = require("fs");
const path = require("path");

const ASSERT_DIR = path.join(__dirname, "..", "context", "assert");

function parseArgs(argv) {
  const repos = {};
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo" && argv[i + 1]) {
      const [name, ...rest] = argv[++i].split("=");
      repos[name] = rest.join("=") || ".";
    } else if (argv[i] === "--strict") {
      // --strict: a repo named by a manifest but not supplied is a failure
      strict = true;
    }
  }
  return { repos, strict };
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Assert a file exists in the repo. */
function checkFile(root, rel) {
  return fs.existsSync(path.join(root, rel))
    ? null
    : `missing file: ${rel}`;
}

/**
 * Assert a symbol still appears in a file. Deliberately a substring check rather
 * than a parse: it survives refactors of surrounding code but catches renames and
 * deletions, which is the drift that actually misleads an agent.
 */
function checkSymbol(root, rel, symbol) {
  const body = readFileSafe(path.join(root, rel));
  if (body === null) return `missing file: ${rel} (expected symbol "${symbol}")`;
  return body.includes(symbol) ? null : `symbol not found: "${symbol}" in ${rel}`;
}

/** Assert a regex still matches a file (for constants, enum values, config keys). */
function checkPattern(root, { file, regex, desc }) {
  const body = readFileSafe(path.join(root, file));
  if (body === null) return `missing file: ${file} (expected pattern ${regex})`;
  let re;
  try {
    re = new RegExp(regex, "m");
  } catch (e) {
    return `invalid regex in manifest: ${regex} (${e.message})`;
  }
  return re.test(body) ? null : `pattern not found: ${desc || regex} in ${file}`;
}

function checkRepo(root, spec) {
  const failures = [];
  for (const rel of spec.files || []) {
    const f = checkFile(root, rel);
    if (f) failures.push(f);
  }
  for (const [rel, symbols] of Object.entries(spec.symbols || {})) {
    for (const symbol of symbols) {
      const f = checkSymbol(root, rel, symbol);
      if (f) failures.push(f);
    }
  }
  for (const pattern of spec.patterns || []) {
    const f = checkPattern(root, pattern);
    if (f) failures.push(f);
  }
  return failures;
}

function main() {
  const { repos, strict } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(ASSERT_DIR)) {
    console.error(`No manifests directory at ${ASSERT_DIR}`);
    process.exit(1);
  }
  const manifests = fs
    .readdirSync(ASSERT_DIR)
    .filter((f) => f.endsWith(".assert.json"))
    .sort();

  if (!manifests.length) {
    console.error("No .assert.json manifests found.");
    process.exit(1);
  }
  if (!Object.keys(repos).length) {
    console.error(
      "No repos supplied. Example:\n" +
        "  node scripts/docs-check.js --repo shoofi-server=/path/to/shoofi-server"
    );
    process.exit(1);
  }

  let totalFailures = 0;
  const skipped = [];

  for (const file of manifests) {
    const manifest = JSON.parse(readFileSafe(path.join(ASSERT_DIR, file)));
    const domain = manifest.doc || file.replace(".assert.json", "");
    const lines = [];

    for (const [repoName, spec] of Object.entries(manifest.repos || {})) {
      const root = repos[repoName];
      if (!root) {
        skipped.push(`${domain}/${repoName}`);
        continue;
      }
      if (!fs.existsSync(root)) {
        lines.push(`  ✗ ${repoName}: path does not exist (${root})`);
        totalFailures++;
        continue;
      }
      const failures = checkRepo(root, spec);
      if (failures.length) {
        lines.push(`  ✗ ${repoName}`);
        failures.forEach((f) => lines.push(`      ${f}`));
        totalFailures += failures.length;
      } else {
        lines.push(`  ✓ ${repoName}`);
      }
    }

    if (lines.length) {
      console.log(`\n${domain}  (last-verified: ${manifest.lastVerified || "unknown"})`);
      lines.forEach((l) => console.log(l));
    }
  }

  if (skipped.length) {
    console.log(`\nSkipped (repo not supplied): ${skipped.join(", ")}`);
    if (strict) {
      console.error("\n--strict: every repo named by a manifest must be supplied.");
      process.exit(1);
    }
  }

  if (totalFailures) {
    console.error(
      `\n${totalFailures} assertion(s) failed. The context docs no longer match the code.\n` +
        "Fix the doc (and this manifest) in the same PR as the code change."
    );
    process.exit(1);
  }
  console.log("\nAll supplied repos match their context docs.");
}

main();
