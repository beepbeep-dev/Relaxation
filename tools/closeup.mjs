/**
 * Ground-level close-up: stand on the pavement and look down at it.
 *
 * The pinned views in debug-shot.mjs all look out at the skyline, which is
 * exactly why a real problem hid for several rounds — the surface a player
 * actually stands on and stares at is the pavement slab, and none of those
 * views inspect it closely. "I see no textures" turned out to be literally
 * true of that surface while the skyline shots looked fine.
 *
 * Pass --tag to recolour every distinct material a flat colour instead of
 * rendering normally. That is how the confusion was settled: the ground
 * under the camera came back as a different colour than the road material,
 * proving the surface being tuned was not the surface being looked at.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TAG = process.argv.includes('--tag');
const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURI(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const p = join(ROOT, rel === '/' ? 'index.html' : rel);
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__kaisei, null, { timeout: 45000 });
await page.click('#enter');
// The photographic textures stream in after boot, so a shot taken too early
// reports the procedural placeholders and looks like a texture failure.
await page.waitForTimeout(4500);

const info = await page.evaluate((tag) => {
  const k = window.__kaisei;
  k.engine.camera.parent.position.set(20, 0, 20);
  k.engine.camera.position.set(0, 1.6, 0);
  k.engine.camera.rotation.set(-0.85, 0.4, 0, 'YXZ');
  k.engine.camera.updateMatrixWorld(true);

  const mats = k.city.mats;
  const named = new Map([[mats.wetGround, 'wetGround'], [mats.concrete, 'concrete'],
    [mats.darkMetal, 'darkMetal'], [mats.deckWood, 'deckWood'], [mats.cushion, 'cushion']]);

  if (tag) {
    const palette = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
    const seen = new Map();
    let i = 0;
    k.engine.scene.traverse((o) => {
      const m = o.material;
      if ((!o.isMesh && !o.isInstancedMesh) || !m || Array.isArray(m)) return;
      if (!seen.has(m)) seen.set(m, palette[i++ % palette.length]);
      if (m.color) m.color.set(seen.get(m));
      if (m.emissive) m.emissive.set('#000000');
      m.map = null;
      m.needsUpdate = true;
    });
    return [...seen].map(([m, c]) => `${c} = ${named.get(m) ?? 'other'}`);
  }

  return [...named].map(([m, n]) =>
    `${n}: map=${!!m.map} repeat=${m.map ? m.map.repeat.x : '-'} rough=${m.roughness} metal=${m.metalness}`);
}, TAG);

console.log(info.join('\n'));
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/shots/closeup-road.png' });
await browser.close();
server.close();
