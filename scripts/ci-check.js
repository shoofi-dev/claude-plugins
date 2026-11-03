#!/usr/bin/env node
'use strict';

/**
 * What breaks an agent silently, checked on every PR (no dependencies):
 *   - a JSON file that does not parse (plugin.json, marketplace.json, assert files);
 *   - an agent file without `name` / `description` frontmatter, or a duplicate name;
 *   - a `context/….md` path an agent or skill reads that does not exist in its plugin;
 *   - a marketplace entry whose source folder or plugin.json is missing.
 *
 * Shoofi HQ runs these agents by name (shoofi-server services/hq/agents.js); a
 * broken one answers "not available" at 07:20 instead of failing here.
 *
 *   node scripts/ci-check.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === '.git' || e.name === 'node_modules') return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const rel = (p) => path.relative(ROOT, p);
const files = walk(ROOT);

for (const f of files.filter((x) => x.endsWith('.json'))) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { problems.push(`${rel(f)}: not valid JSON (${err.message})`); }
}

const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
for (const p of market.plugins || []) {
  const dir = path.join(ROOT, p.source);
  if (!fs.existsSync(dir)) { problems.push(`marketplace: ${p.name} → ${p.source} does not exist`); continue; }
  if (!fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) problems.push(`${p.source}: no .claude-plugin/plugin.json`);

  const names = new Map();
  const readers = files.filter((f) => f.startsWith(dir + path.sep) && (/[\\/]agents[\\/][^\\/]+\.md$/.test(f) || /[\\/]SKILL\.md$/.test(f)));
  for (const f of readers) {
    const text = fs.readFileSync(f, 'utf8');
    if (/[\\/]agents[\\/]/.test(f)) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(text);
      const name = fm && /^name:\s*(\S+)/m.exec(fm[1]);
      if (!fm || !name || !/^description:/m.test(fm[1])) problems.push(`${rel(f)}: frontmatter needs name and description`);
      else if (names.has(name[1])) problems.push(`${rel(f)}: agent name "${name[1]}" also in ${names.get(name[1])}`);
      else names.set(name[1], rel(f));
    }
    // Plugin-relative (`${CLAUDE_PLUGIN_ROOT}/context/…`) or bare (`context/…`);
    // not a path inside another repo (`docs/context/…`).
    for (const m of text.matchAll(/(?:\$\{CLAUDE_PLUGIN_ROOT\}\/|(?<![\w/.-]))(context\/[A-Za-z0-9_./-]+\.md)/g)) {
      if (!fs.existsSync(path.join(dir, m[1]))) problems.push(`${rel(f)}: reads ${m[1]}, which is not in ${p.source}`);
    }
  }
}

if (problems.length) {
  console.log(`ci-check: ${problems.length} problem(s)\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`ci-check: ok (${files.filter((x) => x.endsWith('.json')).length} JSON files, ${(market.plugins || []).length} plugins)`);
