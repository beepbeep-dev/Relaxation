import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { TIER, QUALITY } from './core/quality.js';
import { createSky, createLighting } from './world/sky.js';
import { GlowField } from './world/glowfield.js';
import { library } from './world/materials.js';
import { City } from './world/city.js';
import { Lounge } from './world/lounge.js';
import { RacePad } from './world/racepad.js';
import { Player } from './player/player.js';
import { Racing } from './games/racing.js';

const boot = document.getElementById('boot');
const bar = document.querySelector('#bar i');
const enterBtn = document.getElementById('enter');
const hint = document.getElementById('hint');

const steps = [];
const progress = (pct) => { bar.style.width = `${pct}%`; };

async function main() {
  const engine = new Engine();
  progress(10);
  await frame();

  createSky(engine.renderer, engine.scene);
  createLighting(engine.scene);
  progress(30);
  await frame();

  // Every additive glow in the world funnels into one batched draw call.
  const glow = new GlowField(library().glow);

  const city = new City(engine.scene, glow);
  progress(55);
  await frame();

  const lounge = new Lounge(engine.scene, glow);
  progress(70);
  await frame();

  // The player queries one merged world description rather than each system.
  const world = {
    colliders: [...city.colliders, ...lounge.colliders],
    platforms: [...lounge.platforms],
    ramps: [...lounge.ramps],
    seats: [...lounge.seats],
  };

  const player = new Player(engine, world);
  const racePad = new RacePad(engine.scene, glow, new THREE.Vector3(0, 0, 18));
  progress(85);
  await frame();

  const racing = new Racing(engine, glow, {
    onExit: () => {
      // Restore the walking rig exactly where it was left.
      engine.rig.position.copy(savedRig.position);
      engine.rig.quaternion.copy(savedRig.quaternion);
      city.group.visible = true;
      lounge.group.visible = true;
      racePad.group.visible = true;
    },
  });
  // Glows are registered during construction and committed once, after every
  // system that contributes to them has been built.
  glow.build(engine.scene);

  racing.bindKeys(player._keys);
  const savedRig = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

  // --- systems, in update order
  engine.add({
    update(dt, ctx) {
      if (racing.active) return;
      player.update(dt, ctx);
      racePad.update(dt, ctx);
      lounge.update(dt, ctx);
      city.update(dt, ctx);
    },
  });
  engine.add(racing);

  // Launch: trigger (or Space) while standing on the pad.
  const tryLaunch = () => {
    if (racing.active || !racePad.armed) return;
    savedRig.position.copy(engine.rig.position);
    savedRig.quaternion.copy(engine.rig.quaternion);
    racePad.group.visible = false;
    racing.enter();
  };
  for (const ctrl of player._controllers) ctrl.addEventListener('selectstart', tryLaunch);
  addEventListener('keydown', (e) => { if (e.code === 'Space') tryLaunch(); });

  // Weather toggle — the only "setting" exposed in-world for now.
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyR') city.setRain(!city.rain.visible);
  });

  engine.start();
  progress(100);

  // --- boot UI
  const supported = navigator.xr && await navigator.xr.isSessionSupported?.('immersive-vr');
  enterBtn.disabled = false;
  if (supported) {
    enterBtn.textContent = 'Enter VR';
    enterBtn.onclick = async () => {
      try {
        await engine.enterVR();
        dismiss();
      } catch (err) {
        hint.textContent = `Could not start VR: ${err.message}`;
      }
    };
  } else {
    enterBtn.textContent = 'Explore on desktop';
    enterBtn.onclick = dismiss;
    hint.textContent =
      'No VR runtime detected. WASD to walk, mouse to look, Space on the green pad to race, R for rain.';
  }

  engine.renderer.xr.addEventListener('sessionend', () => {
    if (racing.active) racing.exit();
  });

  // Expose for the smoke test and for poking at from the console.
  window.__kaisei = { engine, city, lounge, player, racing, racePad, glow, tier: TIER, quality: QUALITY };
}

function dismiss() {
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 900);
}

/** Yield a frame so the loading bar actually paints between build steps. */
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

main().catch((err) => {
  console.error(err);
  hint.textContent = `Failed to start: ${err.message}`;
  enterBtn.textContent = 'Error';
});
