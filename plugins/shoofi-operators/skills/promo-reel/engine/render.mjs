#!/usr/bin/env node
/**
 * Render a promo-reel spec to an MP4 (1080x1920, 30 fps, H.264).
 *
 *   node render.mjs <spec.json> <out.mp4> [--frames=N] [--still=T out.png]
 *
 * Loads stage.html in headless Chromium (Playwright), calls prepare(spec), then renderAt(t)
 * for every frame and pipes the screenshots into ffmpeg. Optional `spec.audio` (a file) is
 * muxed and trimmed to the video. Relative paths in the spec resolve from the spec's folder.
 *
 * Playwright: PLAYWRIGHT=<path to a node_modules/playwright> if it is not resolvable here.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const [specPath, outPath, ...rest] = process.argv.slice(2);
if (!specPath || !outPath) {
  console.error('usage: render.mjs <spec.json> <out.mp4> [--still=T]');
  process.exit(2);
}
const FPS = 30;
const still = rest.find((a) => a.startsWith('--still='));
const base = path.dirname(path.resolve(specPath));
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

// Every file path in the spec becomes a file:// URL the page can load.
const isPath = (v) => typeof v === 'string' && /\.(png|jpe?g|webp|gif|mp4|ttf)$/i.test(v) && !/^(https?|file|data):/.test(v);
const urls = (o) => {
  if (Array.isArray(o)) return o.map(urls);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, urls(v)]));
  return isPath(o) ? pathToFileURL(path.resolve(base, o)).href : o;
};
const pageSpec = urls(spec);

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const [vw, vh] = spec.size || [1080, 1920];
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), 'stage.html')).href);
const duration = await page.evaluate((s) => window.prepare(s), pageSpec);

// --review: the creative director's measurable checks, at 12 moments (or the still's), as JSON.
if (rest.includes('--review')) {
  const isReel = vh > vw;
  const times = still ? [Number(still.split('=')[1])] : Array.from({ length: 12 }, (_, i) => +(((i + 0.5) * duration) / 12).toFixed(2));
  const safe = isReel ? { top: 250, bottom: 1450, right: 1080 - 200 } : null;
  const report = await page.evaluate(([ts, sf]) => window.review(ts, sf), [times, safe]);
  const fail = report.resolution.length + report.duplicates.length + report.text.length;
  console.log(JSON.stringify({ spec: path.basename(specPath), pass: fail === 0, ...report }, null, 1));
  await browser.close();
  process.exit(fail ? 3 : 0);
}

if (still) {
  await page.evaluate((t) => window.renderAt(t), Number(still.split('=')[1]));
  await page.screenshot({ path: outPath, type: 'png' });
  await browser.close();
  process.exit(0);
}

const frames = Math.round(duration * FPS);
const args = ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-'];
if (spec.audio) args.push('-i', path.resolve(base, spec.audio));
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'medium', '-r', String(FPS));
if (spec.audio) args.push('-c:a', 'aac', '-b:a', '160k', '-shortest');
args.push('-movflags', '+faststart', outPath);
const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });

for (let f = 0; f < frames; f += 1) {
  await page.evaluate((t) => window.renderAt(t), f / FPS);
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise((r, j) => ff.on('close', (code) => (code === 0 ? r() : j(new Error(`ffmpeg ${code}`)))));
await browser.close();
console.log(`${outPath} ${duration.toFixed(2)}s ${frames} frames`);
