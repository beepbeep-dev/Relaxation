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

// --- STEEL GARDEN: enemies spawn, telegraph, and resolve into a parry or a hit
const sword = await page.evaluate(() => {
  const k = window.__kaisei;
  if (k.racing.active) k.racing.exit();
  k.sword.enter();
  const entered = k.sword.state;
  k.sword.begin();

  const ctx = { engine: k.engine, elapsed: 0, dt: 1 / 72 };
  const step = () => { ctx.elapsed += 1 / 72; k.sword.update(1 / 72, ctx); };

  // Run until enemies exist and at least one has reached the telegraph phase,
  // so we are asserting the state machine rather than the wall clock.
  let sawTelegraph = false;
  let maxEnemies = 0;
  for (let i = 0; i < 72 * 40; i++) {
    step();
    maxEnemies = Math.max(maxEnemies, k.sword.enemies.length);
    if (k.sword.enemies.some((e) => e.state === 'telegraph')) sawTelegraph = true;
    if (k.sword.state !== 'fighting') break;
  }

  return {
    entered,
    maxEnemies,
    sawTelegraph,
    finalState: k.sword.state,
    // A player who never moves the blade must lose health — if damage never
    // lands, the mode has no stakes and the parry check is not wired up.
    health: k.sword.health,
    score: k.sword.score,
    bladeVisible: k.sword.bladeRoot.visible,
    arenaY: k.sword.group.position.y,
  };
});
console.log('\nsword:', sword, '\n');
sword.entered === 'ready' ? ok('dojo opens on the ready screen') : fail(`entered as "${sword.entered}"`);
sword.maxEnemies > 0 ? ok(`${sword.maxEnemies} enemies active at peak`) : fail('no enemies spawned');
sword.sawTelegraph ? ok('enemies reach the telegraph phase') : fail('no enemy ever telegraphed');
sword.bladeVisible ? ok('blade is drawn') : fail('blade not visible');
sword.arenaY > 50 ? ok(`arena sits at ${sword.arenaY}m, clear of the city`) : fail('arena overlaps the city');
sword.health < 3 || sword.finalState === 'defeated'
  ? ok(`an idle blade takes damage (health ${sword.health}, ${sword.finalState})`)
  : fail('an idle player never took damage — strikes are not resolving');

await page.evaluate(() => { if (window.__kaisei.sword.active) window.__kaisei.sword.exit(); });

// --- audio graph came up on the entry gesture
const audio = await page.evaluate(() => {
  const a = window.__kaisei.audio;
  return { started: a.started, state: a.ctx?.state, voices: Object.keys(a.nodes) };
});
audio.started ? ok(`audio running (${audio.state}): ${audio.voices.join(', ')}`) : fail('audio never started');

// --- graphics settings actually reach the renderer
const settings = await page.evaluate(() => {
  const k = window.__kaisei;
  const before = {
    exposure: k.engine.renderer.toneMappingExposure,
    fog: k.engine.scene.fog.density,
    far: k.engine.camera.far,
    glow: k.glow.mesh.material.uniforms.uIntensity.value,
    snap: k.player.snapAngle,
  };

  // Live settings must take effect without a reload.
  k.settings.set('exposure', 1.35);
  k.settings.set('fogDensity', 0.009);
  k.settings.set('drawDistance', 600);
  k.settings.set('glowIntensity', 0.4);
  k.settings.set('snapDegrees', 45);
  k.applyNow();

  const after = {
    exposure: k.engine.renderer.toneMappingExposure,
    fog: k.engine.scene.fog.density,
    far: k.engine.camera.far,
    glow: k.glow.mesh.material.uniforms.uIntensity.value,
    snap: k.player.snapAngle,
  };

  // A build-time setting must be staged for reload, not silently ignored.
  k.settings.set('cityBlocks', 12);
  const pendingAfterBuildTimeEdit = k.settings.needsReload;

  // Presets must move every field, and survive a round trip through storage.
  k.settings.applyPreset('high');
  const preset = { name: k.settings.values.preset, blocks: k.settings.values.cityBlocks };
  const reloaded = JSON.parse(localStorage.getItem('kaisei.settings.v1'));

  return {
    before, after, pendingAfterBuildTimeEdit, preset,
    persistedPreset: reloaded.preset,
    persistedBlocks: reloaded.cityBlocks,
    panelRows: k.panel.el.querySelectorAll('.sp-row').length,
    wristRows: k.wrist.rows.length,
  };
});

console.log('\nsettings:', settings, '\n');
settings.after.exposure === 1.35 ? ok('exposure applies live') : fail(`exposure did not apply (${settings.after.exposure})`);
settings.after.fog === 0.009 ? ok('fog density applies live') : fail('fog did not apply');
settings.after.far === 600 ? ok('draw distance applies live') : fail('draw distance did not apply');
settings.after.glow === 0.4 ? ok('glow intensity applies live') : fail('glow did not apply');
Math.abs(settings.after.snap - Math.PI / 4) < 1e-6 ? ok('snap turn angle applies live') : fail('snap angle did not apply');
settings.pendingAfterBuildTimeEdit ? ok('build-time edits are staged for reload') : fail('build-time edit was not staged');
settings.preset.blocks === 10 ? ok('preset moves build-time fields') : fail(`preset did not apply (${settings.preset.blocks})`);
settings.persistedPreset === 'high' && settings.persistedBlocks === 10
  ? ok('settings persist to storage') : fail('settings did not persist');
settings.panelRows >= 15 ? ok(`settings panel built ${settings.panelRows} controls`) : fail('settings panel is empty');
settings.wristRows >= 10 ? ok(`wrist panel built ${settings.wristRows} rows`) : fail('wrist panel is empty');

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

// STEEL GARDEN, mid-fight: enter, run the sim far enough for enemies to be
// on approach, then look at it.
await page.evaluate(async () => {
  const k = window.__kaisei;
  if (k.racing.active) k.racing.exit();
  k.sword.enter();
  k.sword.begin();
  const ctx = { engine: k.engine, elapsed: 0, dt: 1 / 72 };
  for (let i = 0; i < 200; i++) { ctx.elapsed += 1 / 72; k.sword.update(1 / 72, ctx); }
  k.engine.rig.position.set(0, 120, 3.5);
  k.player._yaw = 0; k.player._pitch = -0.06;
  k.engine.camera.rotation.set(-0.06, 0, 0, 'YXZ');
});
await page.waitForTimeout(900);
await page.screenshot({ path: 'tools/shots/sword.png' });
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
