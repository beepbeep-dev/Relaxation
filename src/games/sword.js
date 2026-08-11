import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { library, neonMaterial } from '../world/materials.js';
import { PALETTE } from '../world/palette.js';
import { makeRNG, range } from '../core/rng.js';

const UP = new THREE.Vector3(0, 1, 0);

// Arena geometry. Enemies only ever approach through a frontal arc, which is
// what makes the whole mode seated-playable — see §4.2 of the design doc.
const ARENA_R = 6.5;
const FRONT_ARC = Math.PI * 0.62;    // ±56° from straight ahead

const TELEGRAPH = 0.75;   // seconds of warning before a strike lands
const PARRY_WINDOW = 0.28;
const BLADE_LENGTH = 0.92;

/**
 * STEEL GARDEN — the sword game.
 *
 * The failure mode this design exists to avoid is flailing being optimal.
 * Almost every VR sword game degenerates into windmilling because swing speed
 * is the only input that matters. Here it is the *angle* of your blade at the
 * moment of contact, and wild swinging actively costs you:
 *
 *  - The blade carries simulated inertia. It lags your hand, so a fast
 *    reversal leaves the tip somewhere you did not intend, and you cannot
 *    present a stable angle while swinging hard.
 *  - Enemies telegraph a coloured slash line 750ms ahead. You parry by holding
 *    the blade roughly perpendicular to that line — reading, not reflexes.
 *  - The parry window is generous (280ms). The difficulty is in noticing which
 *    of three enemies is about to commit, not in frame-perfect timing.
 *
 * Enemies are angular holograms — no faces, no gore, no death. They dissolve.
 * That keeps a combat mode tonally compatible with a game whose other two
 * modes are a rooftop deck and a hover race.
 */
export class Sword {
  constructor(engine, glow, opts = {}) {
    this.engine = engine;
    this.glow = glow;
    this.audio = opts.audio ?? null;
    this.mats = library();
    this.rand = makeRNG(5150);
    this.onExit = opts.onExit ?? (() => {});

    this.group = new THREE.Group();
    this.group.visible = false;
    engine.scene.add(this.group);

    this.active = false;
    this.state = 'idle';        // idle | ready | fighting | cleared | defeated
    this.wave = 0;
    this.score = 0;
    this.parries = 0;
    this.health = 3;
    this.best = Number(localStorage.getItem('steelgarden.best') || 0) || 0;

    this.enemies = [];
    this._spawnTimer = 0;
    this._messageTimer = 0;

    // Scratch, hoisted: this runs at 90Hz.
    this._scratch = {
      tipPrev: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      base: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      head: new THREE.Vector3(),
      toEnemy: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      m: new THREE.Matrix4(),
      v: new THREE.Vector3(),
    };

    this._buildArena();
    this._buildBlade();
    this._buildHUD();
  }

  // ------------------------------------------------------------------ arena

  _buildArena() {
    // An enclosing shell, open at the top. Without it the arena is a disc in a
    // void, which reads as an unfinished level rather than as the holographic
    // training room the fiction describes — and a bounded space is also what
    // lets the player judge enemy distance at a glance.
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_R + 2.5, ARENA_R + 2.5, 9, 40, 1, true),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#0a0a18'),
        roughness: 0.9,
        metalness: 0.1,
        side: THREE.BackSide,
        envMapIntensity: 0.25,
      })
    );
    shell.position.y = 3.6;
    this.group.add(shell);

    // Faint grid on the shell: the holodeck read, and a parallax reference
    // that makes your own head movement legible while standing still.
    const gridPts = [];
    const R = ARENA_R + 2.45;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      gridPts.push(new THREE.Vector3(Math.cos(a) * R, 0.1, Math.sin(a) * R));
      gridPts.push(new THREE.Vector3(Math.cos(a) * R, 8.0, Math.sin(a) * R));
    }
    for (const y of [2.0, 4.0, 6.0]) {
      for (let i = 0; i < 40; i++) {
        const a0 = (i / 40) * Math.PI * 2;
        const a1 = ((i + 1) / 40) * Math.PI * 2;
        gridPts.push(new THREE.Vector3(Math.cos(a0) * R, y, Math.sin(a0) * R));
        gridPts.push(new THREE.Vector3(Math.cos(a1) * R, y, Math.sin(a1) * R));
      }
    }
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPts),
      new THREE.LineBasicMaterial({
        color: new THREE.Color(PALETTE.accentBlue),
        transparent: true, opacity: 0.16, toneMapped: false, fog: false,
      })
    );
    this.group.add(grid);

    // A dark disc with a lit rim. Deliberately austere — anything decorative
    // competes with the telegraph lines you need to read.
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_R, ARENA_R, 0.3, 48),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#0a0d1c'),
        // Low metalness on purpose: at 0.6 the floor mirrored the sun into a
        // blown-out smear that washed out half the arena.
        roughness: 0.62,
        metalness: 0.16,
        envMapIntensity: 0.14,
      })
    );
    floor.position.y = -0.15;
    floor.receiveShadow = QUALITY.shadows;
    this.group.add(floor);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(ARENA_R, 0.05, 6, 64),
      neonMaterial(PALETTE.accentGreen, 2.6)
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.02;
    this.group.add(rim);

    // Concentric guide rings, dimmer, so distance to an approaching enemy is
    // readable on the floor rather than only in stereo depth.
    for (const r of [2.2, 4.0]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.015, 4, 48),
        neonMaterial(PALETTE.accentBlue, 1.1)
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      this.group.add(ring);
    }

    // Pillars marking the edge of the frontal arc, so the player knows where
    // things can come from and can stop checking over their shoulder.
    const pillar = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6),
      neonMaterial(PALETTE.accentPurple, 0.8),
      2
    );
    const m = new THREE.Matrix4();
    [-1, 1].forEach((side, i) => {
      const a = side * FRONT_ARC;
      m.setPosition(Math.sin(a) * ARENA_R, 1.6, -Math.cos(a) * ARENA_R);
      pillar.setMatrixAt(i, m);
    });
    pillar.instanceMatrix.needsUpdate = true;
    this.group.add(pillar);
  }

  // ------------------------------------------------------------------ blade

  _buildBlade() {
    // Parented to the rig, positioned each frame from the controller pose, so
    // it stays correct whether the player is in XR or on a mouse.
    this.bladeRoot = new THREE.Group();
    this.engine.rig.add(this.bladeRoot);
    this.bladeRoot.visible = false;

    const hilt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.028, 0.18, 8),
      this.mats.darkMetal
    );
    hilt.position.y = -0.09;
    this.bladeRoot.add(hilt);

    const guard = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.02, 0.04), this.mats.darkMetal
    );
    this.bladeRoot.add(guard);

    this.bladeMat = neonMaterial(PALETTE.accentBlue, 2.8);
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, BLADE_LENGTH, 0.012), this.bladeMat
    );
    blade.position.y = BLADE_LENGTH / 2;
    this.bladeRoot.add(blade);

    // Trail: a short ribbon of the tip's recent positions. This is the main
    // feedback that the blade has weight, because it visibly lags the hand.
    this.trailLength = 14;
    this._trailPts = Array.from({ length: this.trailLength }, () => new THREE.Vector3());
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailLength * 3), 3));
    this.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
      color: new THREE.Color(PALETTE.accentBlue),
      transparent: true, opacity: 0.5, toneMapped: false, fog: false,
    }));
    this.trail.frustumCulled = false;
    this.group.add(this.trail);

    // Simulated blade state. `_swing` lags the controller, which is the
    // inertia the design leans on.
    this._bladeQuat = new THREE.Quaternion();
    this._bladePos = new THREE.Vector3();
    this._tipVel = 0;
  }

  // -------------------------------------------------------------------- HUD

  _buildHUD() {
    // Mounted on the arena rim rather than floating in vision, per the
    // diegetic-UI pillar.
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 512;
    this.hudCanvas.height = 256;
    this.hudCtx = this.hudCanvas.getContext('2d');
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(3.0, 1.5),
      new THREE.MeshBasicMaterial({
        map: this.hudTex, transparent: true, toneMapped: false, fog: false,
      })
    );
    panel.position.set(0, 2.9, -ARENA_R + 1.6);
    panel.rotation.x = 0.12;
    this.group.add(panel);
    this.hudPanel = panel;
  }

  _drawHUD() {
    const c = this.hudCtx;
    c.clearRect(0, 0, 512, 256);
    c.fillStyle = 'rgba(6,10,20,0.78)';
    c.fillRect(0, 0, 512, 256);
    c.strokeStyle = PALETTE.accentGreen;
    c.lineWidth = 3;
    c.strokeRect(6, 6, 500, 244);
    c.textBaseline = 'top';

    if (this.state === 'ready') {
      c.textAlign = 'center';
      c.fillStyle = PALETTE.accentGreen;
      c.font = '600 44px ui-sans-serif, system-ui, sans-serif';
      c.fillText('STEEL GARDEN', 256, 34);
      c.fillStyle = '#a8c4e8';
      c.font = '400 22px ui-sans-serif, system-ui, sans-serif';
      c.fillText('Match your blade to the warning line', 256, 104);
      c.fillText('Trigger to begin  ·  grip to leave', 256, 140);
      if (this.best) {
        c.fillStyle = '#7f93b8';
        c.font = '400 19px ui-sans-serif, system-ui, sans-serif';
        c.fillText(`best  ${this.best}`, 256, 190);
      }
    } else if (this.state === 'cleared' || this.state === 'defeated') {
      c.textAlign = 'center';
      c.fillStyle = this.state === 'cleared' ? PALETTE.accentGreen : PALETTE.accentPurple;
      c.font = '700 46px ui-sans-serif, system-ui, sans-serif';
      c.fillText(this.state === 'cleared' ? 'GARDEN CLEARED' : 'DISSOLVED', 256, 30);
      c.fillStyle = '#eaf4ff';
      c.font = '500 30px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`${this.score}   ·   wave ${this.wave}`, 256, 100);
      c.fillStyle = '#7f93b8';
      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`${this.parries} parries    best ${this.best}`, 256, 148);
      c.fillText('trigger to fight again  ·  grip to leave', 256, 192);
    } else {
      c.textAlign = 'left';
      c.fillStyle = '#eaf4ff';
      c.font = '600 30px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`WAVE ${this.wave}`, 26, 24);
      c.font = '600 52px ui-sans-serif, system-ui, sans-serif';
      c.fillText(String(this.score), 26, 66);

      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = '#7f93b8';
      c.fillText(`${this.parries} parries`, 26, 136);

      // Health as three marks, not a bar — discrete state is far easier to
      // read at a glance in a headset than a continuously shrinking bar.
      for (let i = 0; i < 3; i++) {
        c.fillStyle = i < this.health ? PALETTE.accentGreen : '#243049';
        c.fillRect(26 + i * 46, 178, 36, 12);
      }

      c.textAlign = 'right';
      c.fillStyle = '#7f93b8';
      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`${this.enemies.length} active`, 486, 24);
    }
    this.hudTex.needsUpdate = true;
  }

  // ----------------------------------------------------------------- enemies

  _spawnEnemy() {
    const angle = range(this.rand, -FRONT_ARC, FRONT_ARC);
    const g = new THREE.Group();

    // Angular hologram: an octahedron core inside a wireframe cage. No face,
    // nothing anatomical.
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#000000'),
        emissive: new THREE.Color(PALETTE.accentPurple),
        emissiveIntensity: 2.0,
        transparent: true, opacity: 0.55,
        roughness: 1, metalness: 0,
      })
    );
    g.add(core);

    const cage = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 0),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE.accentPurple),
        wireframe: true, transparent: true, opacity: 0.45,
        toneMapped: false, fog: false,
      })
    );
    g.add(cage);

    // The telegraph: a bar showing the angle the strike will arrive along.
    // The player must present the blade *across* it.
    const tell = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.06, 0.06),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE.accentGreen),
        transparent: true, opacity: 0, toneMapped: false, fog: false,
      })
    );
    g.add(tell);

    g.position.set(Math.sin(angle) * ARENA_R, 1.3, -Math.cos(angle) * ARENA_R);
    this.group.add(g);

    const halo = this.glow.add(g.position, PALETTE.accentPurple, 1.6, 0.35);

    const enemy = {
      group: g, core, cage, tell, halo,
      angle,
      radius: ARENA_R,
      speed: range(this.rand, 0.55, 0.95) + this.wave * 0.06,
      // Strike axis: the angle in the player's view plane along which the
      // blow travels. Parry by holding the blade perpendicular to it.
      strikeAngle: range(this.rand, 0, Math.PI),
      windup: 0,
      state: 'approach',      // approach | telegraph | struck | dying
      bob: range(this.rand, 0, Math.PI * 2),
      dissolve: 0,
    };
    this.enemies.push(enemy);
    return enemy;
  }

  _killEnemy(e, parried) {
    e.state = 'dying';
    e.dissolve = 0;
    this.score += parried ? 150 : 60;
    if (parried) this.parries++;
    this.audio?.ping(parried ? 1180 : 640);
  }

  _removeEnemy(e) {
    this.group.remove(e.group);
    e.core.geometry.dispose();
    e.core.material.dispose();
    e.cage.geometry.dispose();
    e.cage.material.dispose();
    e.tell.geometry.dispose();
    e.tell.material.dispose();
    this.glow.release(e.halo);
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
  }

  // -------------------------------------------------------------------- flow

  enter() {
    this.active = true;
    this.group.visible = true;
    this.bladeRoot.visible = true;
    this.state = 'ready';
    this.wave = 0;
    this.score = 0;
    this.parries = 0;
    this.health = 3;
    this._spawnTimer = 0;
    for (const e of [...this.enemies]) this._removeEnemy(e);
    this.audio?.setRacing(true);   // same ducking as the race: quiet the city
    this._drawHUD();
  }

  begin() {
    this.state = 'fighting';
    this.wave = 1;
    this._spawnTimer = 0.6;
  }

  exit() {
    this.active = false;
    this.group.visible = false;
    this.bladeRoot.visible = false;
    this.state = 'idle';
    for (const e of [...this.enemies]) this._removeEnemy(e);
    this.audio?.setRacing(false);
    this.onExit();
  }

  _finish(won) {
    this.state = won ? 'cleared' : 'defeated';
    if (this.score > this.best) {
      this.best = this.score;
      try { localStorage.setItem('steelgarden.best', String(this.score)); } catch { /* quota */ }
    }
    for (const e of [...this.enemies]) this._removeEnemy(e);
  }

  // ------------------------------------------------------------------- input

  _readInput() {
    let trigger = false, grip = false;
    let hand = null;
    const session = this.engine.renderer.xr.getSession?.();
    if (session) {
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (gp?.buttons[0]?.pressed) trigger = true;
        if (gp?.buttons[1]?.pressed) grip = true;
      }
      // The dominant hand holds the blade; default to right.
      hand = this._controllers?.find((c) => c.userData.handedness === 'right')
          ?? this._controllers?.[0] ?? null;
    }
    if (this._keys) {
      if (this._keys.has('Space')) trigger = true;
      if (this._keys.has('Escape')) grip = true;
    }
    return { trigger, grip, hand };
  }

  bindKeys(keys) { this._keys = keys; }
  bindControllers(list) { this._controllers = list; }

  /**
   * Blade pose. In XR it follows the controller with a lag; on desktop it
   * follows the mouse, so the mode is at least explorable without a headset.
   */
  _updateBlade(dt, ctx) {
    const sc = this._scratch;
    const xr = this.engine.renderer.xr.isPresenting;
    const { hand } = this._readInput();

    sc.tipPrev.copy(sc.tip);

    if (xr && hand) {
      // Rig-local target pose from the controller.
      sc.m.copy(hand.matrix);
      const targetPos = sc.v.setFromMatrixPosition(sc.m);
      const targetQuat = sc.q.setFromRotationMatrix(sc.m);

      // Position tracks tightly; rotation lags. That split is deliberate — a
      // laggy *position* feels broken, a laggy *angle* feels heavy.
      this._bladePos.lerp(targetPos, Math.min(1, dt * 26));
      this._bladeQuat.slerp(targetQuat, Math.min(1, dt * 13));
    } else {
      // Desktop: swing from the camera, driven by look direction.
      const cam = this.engine.camera;
      sc.v.set(0.22, -0.28, -0.55).applyQuaternion(cam.quaternion).add(cam.position);
      this._bladePos.lerp(sc.v, Math.min(1, dt * 20));
      sc.q.copy(cam.quaternion);
      this._bladeQuat.slerp(sc.q, Math.min(1, dt * 10));
    }

    this.bladeRoot.position.copy(this._bladePos);
    this.bladeRoot.quaternion.copy(this._bladeQuat);

    // World-space tip and base, for hit tests.
    this.bladeRoot.updateMatrixWorld();
    sc.base.setFromMatrixPosition(this.bladeRoot.matrixWorld);
    sc.tip.set(0, BLADE_LENGTH, 0).applyMatrix4(this.bladeRoot.matrixWorld);
    sc.dir.subVectors(sc.tip, sc.base).normalize();

    this._tipVel = dt > 0 ? sc.tip.distanceTo(sc.tipPrev) / dt : 0;

    // Trail, oldest first.
    for (let i = this.trailLength - 1; i > 0; i--) this._trailPts[i].copy(this._trailPts[i - 1]);
    this._trailPts[0].copy(sc.tip);
    const arr = this.trail.geometry.attributes.position.array;
    for (let i = 0; i < this.trailLength; i++) {
      arr[i * 3] = this._trailPts[i].x;
      arr[i * 3 + 1] = this._trailPts[i].y;
      arr[i * 3 + 2] = this._trailPts[i].z;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.material.opacity = THREE.MathUtils.clamp(this._tipVel * 0.06, 0.06, 0.7);

    // The blade brightens as it moves, which reads as charge without any UI.
    this.bladeMat.emissiveIntensity = 2.2 + Math.min(this._tipVel * 0.16, 2.4);
  }

  // ------------------------------------------------------------------ update

  update(dt, ctx) {
    if (!this.active) return;

    const input = this._readInput();
    this._updateBlade(dt, ctx);

    if (this.state === 'ready' || this.state === 'cleared' || this.state === 'defeated') {
      if (input.trigger && !this._triggerHeld) {
        if (this.state === 'ready') this.begin();
        else this.enter();
      }
      if (input.grip) this.exit();
      this._triggerHeld = input.trigger;
      this._drawHUD();
      return;
    }
    this._triggerHeld = input.trigger;
    if (input.grip) { this.exit(); return; }

    // --- spawning
    this._spawnTimer -= dt;
    const target = Math.min(2 + Math.floor(this.wave / 2), 5);
    if (this._spawnTimer <= 0 && this.enemies.length < target) {
      this._spawnEnemy();
      this._spawnTimer = Math.max(0.9, 2.6 - this.wave * 0.15);
    }

    this._updateEnemies(dt, ctx);

    // Wave advances on score, so a cautious player is not punished with an
    // endless stream while a fast one is not starved.
    const nextWave = 1 + Math.floor(this.score / 600);
    if (nextWave > this.wave) {
      this.wave = nextWave;
      this.audio?.ping(1400);
    }
    if (this.wave > 8) this._finish(true);
    if (this.health <= 0) this._finish(false);

    this._drawHUD();
  }

  _updateEnemies(dt, ctx) {
    const sc = this._scratch;
    const head = ctx.engine.headPosition(sc.head);
    // Head position is world-space; the arena is centred on the group origin.
    const originY = this.group.position.y;

    for (const e of [...this.enemies]) {
      if (e.state === 'dying') {
        e.dissolve += dt * 2.6;
        const k = 1 - e.dissolve;
        e.core.material.opacity = Math.max(0, 0.55 * k);
        e.cage.material.opacity = Math.max(0, 0.45 * k);
        e.group.scale.setScalar(1 + e.dissolve * 0.7);
        e.group.rotation.y += dt * 6;
        e.halo.opacity = Math.max(0, 0.35 * k);
        if (e.dissolve >= 1) this._removeEnemy(e);
        continue;
      }

      // Drift inward until inside strike range, then wind up.
      if (e.state === 'approach') {
        e.radius -= e.speed * dt;
        if (e.radius <= 2.3) {
          e.state = 'telegraph';
          e.windup = 0;
        }
      } else if (e.state === 'telegraph') {
        e.windup += dt;
        const k = Math.min(e.windup / TELEGRAPH, 1);
        e.tell.material.opacity = 0.25 + k * 0.75;
        e.tell.scale.setScalar(0.6 + k * 0.5);
        e.core.material.emissiveIntensity = 2.0 + k * 3.5;

        if (e.windup >= TELEGRAPH) {
          this._resolveStrike(e);
        }
      }

      e.bob += dt * 2.2;
      const x = Math.sin(e.angle) * e.radius;
      const z = -Math.cos(e.angle) * e.radius;
      e.group.position.set(x, 1.3 + Math.sin(e.bob) * 0.12, z);
      e.group.rotation.y += dt * 0.8;
      e.cage.rotation.x += dt * 0.5;
      e.halo.setPosition(x, originY + e.group.position.y, z);

      // Keep the telegraph bar facing the player, rotated to the strike axis.
      e.tell.rotation.set(0, 0, e.strikeAngle);
      e.tell.lookAt(head.x, head.y, head.z);
      e.tell.rotateZ(e.strikeAngle);
    }
  }

  /**
   * The moment of contact. A parry requires the blade to be roughly
   * perpendicular to the strike axis *and* reasonably still — you cannot
   * windmill your way through, because a fast blade is never presented at a
   * stable angle.
   */
  _resolveStrike(e) {
    const sc = this._scratch;

    // Strike axis in world space, in the plane facing the player.
    sc.toEnemy.copy(e.group.position).sub(sc.base).normalize();
    const right = sc.v.crossVectors(sc.toEnemy, UP).normalize();
    const upish = new THREE.Vector3().crossVectors(right, sc.toEnemy).normalize();
    const axis = right.multiplyScalar(Math.cos(e.strikeAngle))
      .addScaledVector(upish, Math.sin(e.strikeAngle))
      .normalize();

    // How perpendicular is the blade to the strike axis?
    const alignment = Math.abs(sc.dir.dot(axis));       // 0 = perpendicular
    const perpendicular = 1 - alignment;

    const inRange = sc.tip.distanceTo(e.group.position) < 2.2
                 || sc.base.distanceTo(e.group.position) < 2.2;
    const controlled = this._tipVel < 7.5;              // not windmilling

    if (perpendicular > 0.55 && inRange && controlled) {
      this._killEnemy(e, true);
      this.bladeMat.emissive.set(PALETTE.accentGreen);
      setTimeout(() => this.bladeMat.emissive.set(PALETTE.accentBlue), 160);
    } else if (perpendicular > 0.35 && inRange) {
      // Glancing block: the enemy survives and resets, no damage taken.
      e.state = 'approach';
      e.radius = 3.4;
      e.strikeAngle = range(this.rand, 0, Math.PI);
      e.tell.material.opacity = 0;
      e.core.material.emissiveIntensity = 2.0;
      this.audio?.ping(420);
    } else {
      this.health--;
      this._killEnemy(e, false);
      this.score = Math.max(0, this.score - 40);
      this.audio?.ping(180);
    }
  }
}

export { ARENA_R };
