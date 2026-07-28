#!/usr/bin/env node
/**
 * test-touch-check — surface changes that shipped without a test.
 *
 * The constitution requires every change to cover the changed flow with a test. Nothing
 * enforced it, so it silently didn't happen — including on the settlement and VAT changes
 * that touched real payout arithmetic. An unenforced rule is not a rule.
 *
 * This makes the gap self-reporting: if a PR changes source files and touches no test,
 * it says so, and says which files went uncovered. It runs in every repo's CI.
 *
 * Deliberately NON-BLOCKING (always exit 0). Plenty of legitimate changes need no test —
 * config, copy, a rename — and a gate that cries wolf gets ignored. The point is that
 * skipping becomes VISIBLE at review instead of invisible. Ratchet it to blocking per repo
 * once coverage is healthy enough that a red build means something.
 *
 * Usage:
 *   node test-touch-check.js --files "$(git diff --name-only origin/main...)"
 *   node test-touch-check.js --base origin/main
 */

const { execFileSync } = require("child_process");

// Files whose change never implies a test.
const IGNORED = [
  /^docs?\//, /\.md$/, /^\.github\//, /^\.claude\//, /^scripts\//,
  /package(-lock)?\.json$/, /\.ya?ml$/, /\.lock$/, /^assets?\//,
  /^public\//, /\.(png|jpe?g|gif|svg|ico|webp|ttf|otf|woff2?)$/i,
  /^\.[^/]+$/, /^README/i, /^CHANGELOG/i,
];

const isTestFile = (f) =>
  /(^|\/)(tests?|__tests__|e2e|spec)\//.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f);

const isSource = (f) =>
  !isTestFile(f) && !IGNORED.some((re) => re.test(f)) && /\.[jt]sx?$/.test(f);

function parseArgs(argv) {
  const out = { files: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--files") out.files = argv[++i];
    else if (argv[i] === "--base") out.base = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
let files = [];
if (args.files) {
  files = args.files.split(/[\n,]/).map((f) => f.trim()).filter(Boolean);
} else {
  try {
    files = execFileSync("git", ["diff", "--name-only", `${args.base || "origin/main"}...`], {
      encoding: "utf8",
    })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    files = [];
  }
}

if (!files.length) {
  console.log("test-touch-check: no changed files detected; nothing to check.");
  process.exit(0);
}

const changedSource = files.filter(isSource);
const changedTests = files.filter(isTestFile);

if (!changedSource.length) {
  console.log("test-touch-check: no source files changed — no test expected.");
  process.exit(0);
}
if (changedTests.length) {
  console.log(
    `test-touch-check: ${changedSource.length} source file(s) changed, ` +
      `${changedTests.length} test file(s) changed. Looks covered.`
  );
  process.exit(0);
}

console.log("\n────────────────────────────────────────────────────────────");
console.log(" test-touch-check — source changed, no test changed");
console.log("────────────────────────────────────────────────────────────\n");
changedSource.slice(0, 12).forEach((f) => console.log(`    - ${f}`));
if (changedSource.length > 12) console.log(`    … and ${changedSource.length - 12} more`);
console.log(
  "\n  Add a test that covers the changed behaviour, or state plainly in the PR why\n" +
    "  none is needed (pure rename, config, copy change, untestable integration point).\n" +
    "  A good test FAILS on the bug you just fixed — verify that before trusting it.\n" +
    "  The /shoofi-testing:cover-changes skill will generate the slice for you.\n"
);
process.exit(0);
