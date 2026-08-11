/**
 * Ad-hoc visual probe. Boots the built site and takes screenshots from named
 * vantage points so lighting and shader changes can be eyeballed without a
 * headset. Not part of the smoke test — this is for iterating on the look.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURI(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' ? 'index.html' : rel);
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('x'); }
});
await new Promise((r) => server.listen(0, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('PAGEERROR', String(e)));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });

await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__kaisei, null, { timeout: 45000 });
await page.waitForFunction(() => !document.getElementById('enter').disabled);
await page.click('#enter');
await page.waitForSelector('#boot', { state: 'detached' });

// Report what the sky object actually is, before looking at pixels.
console.log(await page.evaluate(() => {
  const k = window.__kaisei;
  const sky = k.engine.scene.children.find((c) => c.material?.type === 'ShaderMaterial' && c.geometry?.type === 'SphereGeometry');
  return {
    skyFound: !!sky,
    skyVisible: sky?.visible,
    skyScale: sky?.scale.x,
    skySide: sky?.material.side,
    toneMapped: sky?.material.toneMapped,
    envSet: !!k.engine.scene.environment,
    fog: k.engine.scene.fog ? { type: k.engine.scene.fog.type ?? 'FogExp2', density: k.engine.scene.fog.density } : null,
    cameraFar: k.engine.camera.far,
    exposure: k.engine.renderer.toneMappingExposure,
  };
}));

const shots = {
  'up': { pos: [0, 2, 0], yaw: 0, pitch: 1.2 },
  'horizon': { pos: [0, 2, 0], yaw: 0, pitch: 0.15 },
  'sunward': { pos: [0, 2, 0], yaw: -0.59, pitch: 0.2 },
  'aerial': { pos: [0, 90, 120], yaw: 0, pitch: -0.55 },
  'street': { pos: [0, 1.7, 30], yaw: Math.PI, pitch: 0 },
  'lounge': { pos: [0, 6.2, -22], yaw: Math.PI, pitch: 0.05 },
  'lounge-view': { pos: [0, 7.2, -36], yaw: 0, pitch: 0.02 },
};

for (const [name, s] of Object.entries(shots)) {
  await page.evaluate(({ pos, yaw, pitch }) => {
    const k = window.__kaisei;
    k.player.seated = true;              // freeze locomotion for the shot
    k.engine.rig.position.set(...pos);
    k.player._yaw = yaw;
    k.player._pitch = pitch;
    k.engine.camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }, s);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `tools/shots/dbg-${name}.png` });
  console.log('shot', name);
}

await browser.close();
server.close();
