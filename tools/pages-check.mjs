/**
 * Simulates GitHub Pages: serves dist/ under a project subpath ("/Relaxation/")
 * rather than at the domain root, and asserts the app still boots.
 *
 * This is the failure mode a root-served local preview cannot catch — any
 * absolute asset URL works fine at "/" and 404s under a subpath.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const PREFIX = '/Relaxation';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const requested = [];
const server = createServer(async (req, res) => {
  requested.push(req.url);
  if (!req.url.startsWith(PREFIX)) {
    res.writeHead(404).end('outside the project subpath');
    return;
  }
  try {
    const rel = normalize(decodeURI(req.url.slice(PREFIX.length).split('?')[0]))
      .replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' || rel === '' ? 'index.html' : rel);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}${PREFIX}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });

const errors = [];
const failed = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => failed.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

console.log('serving dist/ at', url);
await page.goto(url, { waitUntil: 'load' });

let booted = false;
try {
  await page.waitForFunction(() => !!window.__kaisei, null, { timeout: 45000 });
  booted = true;
} catch { /* reported below */ }

const state = booted ? await page.evaluate(() => ({
  towers: window.__kaisei.city.towers.length,
  calls: window.__kaisei.engine.renderer.info.render.calls,
})) : null;

console.log('\nrequests:', requested.join('\n           '));
if (failed.length) console.log('\nfailed responses:\n  ' + failed.join('\n  '));
if (errors.length) console.log('\nconsole errors:\n  ' + errors.slice(0, 5).join('\n  '));

const ok = booted && !failed.length && !errors.length;
console.log(booted ? `\nbooted under ${PREFIX}/ — ${state.towers} towers, ${state.calls} draw calls` : '\nDID NOT BOOT');
console.log(ok ? 'PAGES-CHECK PASSED' : 'PAGES-CHECK FAILED');
if (!ok) process.exitCode = 1;

await browser.close();
server.close();
