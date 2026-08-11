/**
 * Headless smoke test.
 *
 * Boots the built site in Chromium with SwiftShader, asserts the world
 * actually constructed, walks the player, launches a race, and reports draw
 * calls and triangle counts. It cannot tell us the Quest frame rate — nothing
 * short of the headset can — but it catches the failures that matter in CI:
 * shader compile errors, exceptions during world build, and draw-call
 * regressions.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURI(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel === '/' ? 'index.html' : rel);
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

// The pinned Chromium in this environment may not match the Playwright build,
// so point at it explicitly when CHROMIUM_PATH is set.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__kaisei, null, { timeout: 45000 });

// Dismiss the boot overlay, otherwise every screenshot is of the title card.
await page.waitForFunction(() => !document.getElementById('enter').disabled);
await page.click('#enter');
await page.waitForSelector('#boot', { state: 'detached', timeout: 5000 });

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok    ${msg}`);

// --- world built
const built = await page.evaluate(() => {
  const k = window.__kaisei;
  return {
    tier: k.tier,
    towers: k.city.towers.length,
    colliders: k.city.colliders.length,
    seats: k.lounge.seats.length,
    gates: k.racing.gates.length,
    trackLength: Math.round(k.racing.length),
    sceneChildren: k.engine.scene.children.length,
  };
});
console.log('\nworld:', built, '\n');

built.towers > 20 ? ok(`${built.towers} towers`) : fail('too few towers');
built.seats === 6 ? ok('6 seats in the lounge') : fail(`expected 6 seats, got ${built.seats}`);
built.gates === 22 ? ok('22 boost gates') : fail(`expected 22 gates, got ${built.gates}`);
built.trackLength > 500 ? ok(`track ${built.trackLength}m`) : fail('track too short');

// --- render stats after settling
await page.waitForTimeout(1500);
const stats = await page.evaluate(() => {
  const r = window.__kaisei.engine.renderer.info.render;
  return { calls: r.calls, triangles: r.triangles };
});
console.log(`\nrender: ${stats.calls} draw calls, ${stats.triangles.toLocaleString()} triangles\n`);
stats.calls > 0 ? ok('scene is drawing') : fail('nothing drawn');
stats.calls < 120
  ? ok(`draw calls within standalone budget (${stats.calls} < 120)`)
  : fail(`draw call regression: ${stats.calls}`);

// --- locomotion moves the rig and collides
const walked = await page.evaluate(async () => {
  const k = window.__kaisei;
  const start = k.engine.rig.position.clone();
  k.player._keys.add('KeyW');
  await new Promise((r) => setTimeout(r, 1200));
  k.player._keys.delete('KeyW');
  return { moved: k.engine.rig.position.distanceTo(start) };
});
walked.moved > 0.5 ? ok(`walked ${walked.moved.toFixed(2)}m`) : fail('player did not move');

// --- the ramp lifts the player onto the lounge deck
const climbed = await page.evaluate(() => {
  const k = window.__kaisei;
  return { deck: k.player.groundHeight(0, -30), street: k.player.groundHeight(30, 30) };
});
climbed.deck > 5.5 ? ok(`lounge deck at ${climbed.deck}m`) : fail('lounge deck not walkable');
climbed.street === 0 ? ok('street at ground level') : fail('street height wrong');

// --- racing runs a full lap without throwing
const race = await page.evaluate(() => {
  const k = window.__kaisei;
  k.racing.enter();
  k.racing._countdown = 0;
  const before = k.racing.t;

  // Fixed 72Hz steps. Driving update() directly makes the result independent
  // of how slowly SwiftShader happens to be pacing frames, so this asserts the
  // simulation rather than the test machine.
  const ctx = { engine: k.engine, elapsed: 0, dt: 1 / 72 };
  let laps = 0;
  for (let i = 0; i < 72 * 240 && k.racing.state !== 'finished'; i++) {
    ctx.elapsed += 1 / 72;
    k.racing.update(1 / 72, ctx);
    laps = k.racing.lap;
  }

  return {
    state: k.racing.state,
    advanced: k.racing.t !== before,
    topSpeed: k.racing.speed,
    laps,
    lapTimes: k.racing.lapTimes.map((t) => +t.toFixed(2)),
    gatesHit: k.racing._gatesHitTotal ?? null,
    rigY: k.engine.rig.position.y,
    offsetInBounds: Math.abs(k.racing.offset) <= 7.5,
  };
});
console.log('\nrace:', race, '\n');
race.advanced ? ok('craft advances along the track') : fail('craft did not move');
race.state === 'finished' ? ok('3-lap race completed') : fail(`race stalled in state "${race.state}"`);
race.laps === 3 ? ok(`${race.laps} laps counted`) : fail(`expected 3 laps, got ${race.laps}`);
race.lapTimes.length === 3 ? ok(`lap times ${race.lapTimes.join(' / ')}s`) : fail('lap times not recorded');
race.topSpeed > 20 ? ok(`cruising at ${(race.topSpeed * 3.6).toFixed(0)} km/h`) : fail('craft not up to speed');
race.gatesHit > 0 ? ok(`${race.gatesHit} boost gates hit`) : fail('no boost gates registered');
race.rigY > 10 ? ok(`rig lifted onto the track at ${race.rigY.toFixed(1)}m`) : fail('rig not on track');
race.offsetInBounds ? ok('craft stayed on the ribbon') : fail('craft left the track');

// --- audio graph came up on the entry gesture
const audio = await page.evaluate(() => {
  const a = window.__kaisei.audio;
  return { started: a.started, state: a.ctx?.state, voices: Object.keys(a.nodes) };
});
audio.started ? ok(`audio running (${audio.state}): ${audio.voices.join(', ')}`) : fail('audio never started');

// --- screenshots for eyeballing the look
await page.evaluate(() => { if (window.__kaisei.racing.active) window.__kaisei.racing.exit(); });
await page.waitForTimeout(600);
await page.screenshot({ path: 'tools/shots/city.png' });
await page.evaluate(() => {
  const k = window.__kaisei;
  k.engine.rig.position.set(0, 6, -34);
  k.player._yaw = Math.PI;
  k.player._pitch = -0.05;
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/shots/lounge.png' });
await page.evaluate(() => { window.__kaisei.racing.enter(); window.__kaisei.racing._countdown = 0.01; });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'tools/shots/race.png' });
console.log('ok    screenshots written to tools/shots/');

if (errors.length) {
  console.error('\nconsole errors:');
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exitCode = 1;
} else {
  console.log('ok    no console errors');
}

await browser.close();
server.close();
console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
