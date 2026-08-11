import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Audio } from './core/audio.js';
import { Stats } from './core/stats.js';
import { Settings, applyLive } from './core/settings.js';
import { QUALITY, resolveQuality } from './core/quality.js';
import { createSky, createLighting } from './world/sky.js';
import { GlowField } from './world/glowfield.js';
import { LightPools } from './world/lightpools.js';
import { library } from './world/materials.js';
import { City } from './world/city.js';
import { Lounge } from './world/lounge.js';
import { RacePad } from './world/racepad.js';
import { Player } from './player/player.js';
import { Racing } from './games/racing.js';
import { Sword } from './games/sword.js';
import { PALETTE } from './world/palette.js';
import { SettingsPanel, SettingsOverlay } from './ui/panel.js';
import { WristPanel } from './ui/wrist.js';

const boot = document.getElementById('boot');
const bar = document.querySelector('#bar i');
const enterBtn = document.getElementById('enter');
const hint = document.getElementById('hint');
const settingsSlot = document.getElementById('boot-settings');
const settingsToggle = document.getElementById('boot-settings-toggle');

const progress = (pct) => { bar.style.width = `${pct}%`; };

async function main() {
  // Settings are read before anything is constructed: world density, texture
  // sizes and MSAA are all baked in at build time and cannot be changed later
  // without tearing the scene down.
  const settings = new Settings();
  resolveQuality(settings);

  const engine = new Engine();
  const stats = new Stats(engine.renderer);
  progress(10);
  await frame();

  const sky = createSky(engine.renderer, engine.scene);
  const { sun } = createLighting(engine.scene);
  progress(28);
  await frame();

  // Every additive glow in the world funnels into one batched draw call.
  const glow = new GlowField(library().glow, QUALITY.glowIntensity);
  // Flat pools of light on the wet road, in their own batch because they are
  // ground-oriented rather than camera-facing.
  const pools = new LightPools(library().glow, QUALITY.glowIntensity);

  const city = new City(engine.scene, glow, pools);
  progress(52);
  await frame();

  const lounge = new Lounge(engine.scene, glow);
  progress(68);
  await frame();

  // The player queries one merged world description rather than each system.
  const world = {
    colliders: [...city.colliders, ...lounge.colliders],
    platforms: [...lounge.platforms],
    ramps: [...lounge.ramps],
    seats: [...lounge.seats],
  };

  const player = new Player(engine, world);

  // Two entrances, flanking the plaza. Same ritual, different accent.
  const racePad = new RacePad(engine.scene, glow, new THREE.Vector3(-7, 0, 18), {
    label: 'NEON LINE', accent: PALETTE.accentGreen, secondary: PALETTE.accentBlue, pools,
  });
  const dojoPad = new RacePad(engine.scene, glow, new THREE.Vector3(9, 0, 18), {
    label: 'STEEL GARDEN', accent: PALETTE.accentPurple, secondary: PALETTE.accentGreen, pools,
  });
  progress(84);
  await frame();

  // Built here but silent until start(); browsers require a user gesture.
  const audio = new Audio();

  const savedRig = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

  // Both games take over the rig, so they share one save/restore of where the
  // player was standing when they stepped in.
  const restoreWalking = () => {
    engine.rig.position.copy(savedRig.position);
    engine.rig.quaternion.copy(savedRig.quaternion);
    racePad.group.visible = true;
    dojoPad.group.visible = true;
    city.group.visible = true;
  };

  const racing = new Racing(engine, glow, { audio, onExit: restoreWalking });

  // The arena floats well above the city, so the dojo's holographic framing
  // has somewhere to be that is not a room we would have to build.
  const sword = new Sword(engine, glow, { audio, onExit: restoreWalking });
  sword.group.position.set(0, 120, 0);

  // Glows are registered during construction and committed once, after every
  // system that contributes to them has been built.
  glow.build(engine.scene);
  pools.build(engine.scene);
  racing.bindKeys(player._keys);
  sword.bindKeys(player._keys);
  sword.bindControllers(player._controllers);

  // --- settings plumbing
  const liveCtx = {
    renderer: engine.renderer, scene: engine.scene, engine,
    city, player, glow, pools, audio, sun,
  };
  const applyNow = () => applyLive(settings, liveCtx);

  const panel = new SettingsPanel(settings, { onLiveChange: applyNow });
  const overlay = new SettingsOverlay(panel);
  const wrist = new WristPanel(engine, settings, { onLiveChange: applyNow, stats });

  if (settingsSlot) {
    panel.mount(settingsSlot);
    settingsToggle?.addEventListener('click', () => {
      const open = settingsSlot.classList.toggle('open');
      settingsToggle.textContent = open ? 'Hide graphics settings' : 'Graphics settings';
    });
  }

  applyNow();

  // --- systems, in update order
  engine.add({
    update(dt, ctx) {
      stats.update(dt);
      sky.update(dt, ctx);
      wrist.update(dt, ctx);
      if (racing.active || sword.active) return;
      player.update(dt, ctx);
      racePad.update(dt, ctx);
      dojoPad.update(dt, ctx);
      lounge.update(dt, ctx);
      city.update(dt, ctx);
    },
  });
  engine.add(racing);
  engine.add(sword);

  // --- interaction. The wrist panel gets first refusal on every trigger press,
  // so aiming at it never also sits you down or launches a race.
  const stash = () => {
    savedRig.position.copy(engine.rig.position);
    savedRig.quaternion.copy(engine.rig.quaternion);
    racePad.group.visible = false;
    dojoPad.group.visible = false;
  };

  const tryLaunch = () => {
    if (racing.active || sword.active) return;
    if (racePad.armed) {
      stash();
      racing.enter();
    } else if (dojoPad.armed) {
      stash();
      // Drop the rig into the arena; the city stays drawn far below.
      engine.rig.position.set(0, 120, 3.5);
      engine.rig.quaternion.identity();
      sword.enter();
    }
  };

  for (const ctrl of player._controllers) {
    ctrl.addEventListener('selectstart', () => {
      if (wrist.handleSelect(ctrl)) return;
      player.trySit();
      tryLaunch();
    });
    // Squeeze on the left controller raises the wrist device.
    ctrl.addEventListener('squeezestart', () => {
      if (ctrl.userData.handedness === 'left') wrist.toggle();
    });
    ctrl.addEventListener('connected', (e) => {
      if (e.data.handedness === 'left') {
        wrist.attachTo(engine.renderer.xr.getControllerGrip(ctrl.userData.index ?? 0));
      }
    });
  }

  // Grips report handedness asynchronously, so bind the wrist panel to
  // whichever grip ends up being the left one, once we know.
  engine.renderer.xr.addEventListener('sessionstart', () => {
    setTimeout(() => {
      for (let i = 0; i < 2; i++) {
        const ctrl = player._controllers[i];
        if (ctrl?.userData.handedness === 'left') {
          wrist.attachTo(engine.renderer.xr.getControllerGrip(i));
        }
      }
    }, 400);
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { player.trySit(); tryLaunch(); }
    if (e.code === 'KeyR') settings.set('rain', !settings.get('rain'));
    if (e.code === 'KeyG') { overlay.visible ? overlay.hide() : overlay.show(); }
  });
  settings.onChange((key) => { if (key === 'rain') applyNow(); });

  // --- performance readout, outside XR
  const statsEl = document.createElement('div');
  statsEl.className = 'stats-readout';
  document.body.appendChild(statsEl);
  setInterval(() => {
    const show = settings.get('showStats') && !engine.renderer.xr.isPresenting;
    statsEl.style.display = show ? 'block' : 'none';
    if (show) statsEl.textContent = stats.line();
  }, 500);

  engine.start();
  progress(100);

  // --- boot UI
  const supported = navigator.xr && await navigator.xr.isSessionSupported?.('immersive-vr');
  enterBtn.disabled = false;
  if (supported) {
    enterBtn.textContent = 'Enter VR';
    enterBtn.onclick = async () => {
      try {
        audio.start();
        await engine.enterVR();
        applyNow();          // framebuffer scale only takes effect in-session
        dismiss();
      } catch (err) {
        hint.textContent = `Could not start VR: ${err.message}`;
      }
    };
    hint.textContent =
      'In VR: left stick walks, right stick snap-turns, trigger sits or launches. Squeeze the left grip for graphics settings.';
  } else {
    enterBtn.textContent = 'Explore on desktop';
    enterBtn.onclick = () => { audio.start(); dismiss(); };
    hint.textContent =
      'No VR runtime detected. WASD to walk, mouse to look, Space on the green pad to race, R for rain, Tab or G for graphics settings.';
  }

  engine.renderer.xr.addEventListener('sessionend', () => {
    if (racing.active) racing.exit();
    if (sword.active) sword.exit();
    applyNow();
  });

  // Expose for the smoke test and for poking at from the console.
  window.__kaisei = {
    engine, city, lounge, player, racing, sword, racePad, dojoPad, glow, pools, audio, sky, sun,
    settings, stats, panel, overlay, wrist, applyNow,
    quality: QUALITY,
  };
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
