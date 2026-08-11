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
  // Hold the throttle. Without it the car correctly coasts at part-throttle
  // and we would be measuring an idling lap, not a racing one.
  k.racing.bindKeys(k.player._keys);
  k.player._keys.add('Space');

  const ctx = { engine: k.engine, elapsed: 0, dt: 1 / 72 };
  let laps = 0;
  let topSpeed = 0;
  const rivalStart = k.racing.rivals.map((r) => r.t);
  for (let i = 0; i < 72 * 240 && k.racing.state !== 'finished'; i++) {
    ctx.elapsed += 1 / 72;
    k.racing.update(1 / 72, ctx);
    topSpeed = Math.max(topSpeed, k.racing.speed);
    laps = k.racing.lap;
  }
  k.player._keys.delete('Space');

  return {
    state: k.racing.state,
    advanced: k.racing.t !== before,
    topSpeed,
    topKmh: Math.round(topSpeed * 3.6),
    laps,
    lapTimes: k.racing.lapTimes.map((t) => +t.toFixed(2)),
    gatesHit: k.racing._gatesHitTotal ?? null,
    rigY: k.engine.rig.position.y,
    offsetInBounds: Math.abs(k.racing.offset) <= 8.5,
    rivals: k.racing.rivals.length,
    rivalsMoved: k.racing.rivals.filter((r, i) => r.t !== rivalStart[i] || r.lap > 0).length,
    rivalLaps: k.racing.rivals.map((r) => r.lap),
    finishPlace: k.racing._finishPlace,
  };
});
console.log('\nrace:', race, '\n');
race.advanced ? ok('craft advances along the track') : fail('craft did not move');
race.state === 'finished' ? ok('3-lap race completed') : fail(`race stalled in state "${race.state}"`);
race.laps === 3 ? ok(`${race.laps} laps counted`) : fail(`expected 3 laps, got ${race.laps}`);
race.lapTimes.length === 3 ? ok(`lap times ${race.lapTimes.join(' / ')}s`) : fail('lap times not recorded');
// A racing car on a city circuit, not a missile. The first pass topped out at
// 223 km/h down an 8m ribbon, which is unreadable rather than exciting.
race.topKmh > 100 && race.topKmh < 170
  ? ok(`tops out at ${race.topKmh} km/h — a car, not a missile`)
  : fail(`top speed ${race.topKmh} km/h is outside the realistic band`);
race.rivals === 5 ? ok('5 rivals on the grid') : fail(`expected 5 rivals, got ${race.rivals}`);
race.rivalsMoved === race.rivals
  ? ok(`all ${race.rivals} rivals raced (laps ${race.rivalLaps.join('/')})`)
  : fail(`only ${race.rivalsMoved} of ${race.rivals} rivals moved`);
// The grid starts behind the line, so rivals sit on lap -1 until they cross it.
race.rivalLaps.every((l) => l >= 1)
  ? ok('the whole field completed racing laps')
  : fail(`rivals stalled on laps ${race.rivalLaps.join('/')}`);
race.finishPlace >= 1 && race.finishPlace <= 6
  ? ok(`finished P${race.finishPlace} of 6`)
  : fail(`finish position ${race.finishPlace} is not a valid place`);
race.gatesHit > 0 ? ok(`${race.gatesHit} boost gates hit`) : fail('no boost gates registered');
// The circuit runs on the streets now, so the driver sits at road height —
// the old assertion checked for a skyway that no longer exists.
race.rigY > 0.6 && race.rigY < 3
  ? ok(`seated at road height (${race.rigY.toFixed(2)}m)`)
  : fail(`rig at ${race.rigY.toFixed(2)}m is not a driving position`);
race.offsetInBounds ? ok('craft stayed on the ribbon') : fail('craft left the track');

// --- STEEL GARDEN: opponents walk in, swing, and kill an idle player
const sword = await page.evaluate(() => {
  const k = window.__kaisei;
  if (k.racing.active) k.racing.exit();
  k.sword.enter();
  const entered = k.sword.state;
  k.sword.begin();

  // Stand where the game actually puts you, and refresh the matrices by hand.
  // Driving update() without rendering leaves camera.matrixWorld frozen at the
  // last drawn frame — which here is wherever the race left it, 110m away —
  // so every distance check reads a stale head position.
  k.engine.rig.position.set(0, 120, 0);
  k.engine.rig.quaternion.identity();
  k.engine.rig.updateMatrixWorld(true);

  const ctx = { engine: k.engine, elapsed: 0, dt: 1 / 72 };
  const step = () => {
    ctx.elapsed += 1 / 72;
    k.engine.rig.updateMatrixWorld(true);
    k.sword.group.updateMatrixWorld(true);
    k.sword.update(1 / 72, ctx);
  };

  const seen = new Set();
  let maxEnemies = 0;
  let closest = 99;
  let headXZ = null;
  const V = k.engine.rig.position.constructor;
  for (let i = 0; i < 72 * 60 && k.sword.state === 'fighting'; i++) {
    step();
    maxEnemies = Math.max(maxEnemies, k.sword.enemies.length);
    const hl = k.engine.headPosition(new V()).clone();
    k.sword.group.worldToLocal(hl);
    headXZ = [+hl.x.toFixed(2), +hl.z.toFixed(2)];
    for (const e of k.sword.enemies) {
      seen.add(e.state);
      closest = Math.min(closest, Math.hypot(e.pos.x - hl.x, e.pos.z - hl.z));
    }
  }

  return {
    entered,
    maxEnemies,
    states: [...seen],
    closest: +closest.toFixed(2),
    headXZ,
    finalState: k.sword.state,
    health: k.sword.health,
    bladeVisible: k.sword.bladeRoot.visible,
    arenaY: k.sword.group.position.y,
    // Body parts are pooled instanced meshes, so the pool must exist and be
    // sized for the cap rather than growing per enemy.
    poolSizes: {
      head: k.sword.parts.head.count,
      limb: k.sword.parts.limb.count,
      sword: k.sword.parts.sword.count,
    },
  };
});
console.log('\nsword:', sword, '\n');
sword.entered === 'ready' ? ok('dojo opens on the ready screen') : fail(`entered as "${sword.entered}"`);
sword.maxEnemies > 0 ? ok(`${sword.maxEnemies} opponents at peak`) : fail('no opponents spawned');
sword.states.includes('windup') ? ok('opponents wind up to strike') : fail('no opponent ever wound up');
sword.states.includes('strike') ? ok('opponents complete a strike') : fail('no strike resolved');
sword.closest < 3 ? ok(`opponents close to ${sword.closest}m`) : fail('opponents never closed the distance');
sword.bladeVisible ? ok('blade is drawn') : fail('blade not visible');
sword.arenaY > 50 ? ok(`arena at ${sword.arenaY}m, clear of the city`) : fail('arena overlaps the city');
sword.finalState === 'dead'
  ? ok('an idle player is killed — it does not stop')
  : fail(`idle player survived 60s (state "${sword.finalState}", health ${sword.health})`);
sword.poolSizes.limb === sword.poolSizes.head * 4
  ? ok(`instanced body parts pooled (${sword.poolSizes.head} bodies, ${sword.poolSizes.limb} limbs)`)
  : fail('limb pool is not four per body');

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
await page.evaluate(() => {
  const k = window.__kaisei;
  if (k.sword.active) k.sword.exit();
  k.racing.enter();
  k.racing._countdown = 0;
  // Run the field forward so there are rivals in front of the camera.
  const ctx = { engine: k.engine, elapsed: 0, dt: 1 / 72 };
  for (let i = 0; i < 300; i++) { ctx.elapsed += 1 / 72; k.racing.update(1 / 72, ctx); }
});
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
