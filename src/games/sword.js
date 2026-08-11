import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { library, neonMaterial } from '../world/materials.js';
import { PALETTE } from '../world/palette.js';
import { makeRNG, range } from '../core/rng.js';

const ARENA_R = 7.0;
const FRONT_ARC = Math.PI * 0.7;     // enemies only come from in front — seated-viable
const MAX_ENEMIES = 8;               // fixed pool, so body parts can be instanced

const STRIKE_RANGE = 1.9;
const WINDUP = 0.85;                 // seconds with the sword raised before it falls
const RECOVER = 0.7;
const BLOCK_RADIUS = 0.45;           // how close your blade must be to theirs
const KILL_SPEED = 2.6;              // m/s of blade tip needed to cut, not nudge

const BLADE_LENGTH = 0.95;
const START_HEALTH = 5;

/**
 * STEEL GARDEN — sword fighting, endless, until you die.
 *
 * The first version of this was an abstract parry puzzle against floating
 * holograms, which is not what a sword game is. This is the corrected one:
 * humanoid opponents walk at you with swords, you cut them by actually
 * swinging, they cut you back, and it does not stop until you are dead.
 *
 * Two rules keep it from being a windmill:
 *
 *  - A cut needs real blade speed (KILL_SPEED). Resting your sword inside
 *    someone does nothing, so you have to swing properly.
 *  - A block is positional: when their blade comes down, yours has to be near
 *    it. Not an angle puzzle — just put your sword in the way, which is what
 *    everyone tries to do instinctively anyway.
 *
 * Every body part is an InstancedMesh across the whole enemy pool, so eight
 * opponents cost four draw calls rather than forty.
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
    this.inputLocked = false;
    this.state = 'idle';        // idle | ready | fighting | dead
    this.wave = 1;
    this.kills = 0;
    this.score = 0;
    this.health = START_HEALTH;
    this.best = Number(localStorage.getItem('steelgarden.best') || 0) || 0;

    this.enemies = [];
    this._spawnTimer = 0;

    this._scratch = {
      tipPrev: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      base: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      head: new THREE.Vector3(),
      v: new THREE.Vector3(),
      v2: new THREE.Vector3(),
      bladeA: new THREE.Vector3(),
      bladeB: new THREE.Vector3(),
      enemyM: new THREE.Matrix4(),
      partM: new THREE.Matrix4(),
      localM: new THREE.Matrix4(),
      q: new THREE.Quaternion(),
      e: new THREE.Euler(),
      p: new THREE.Vector3(),
      s: new THREE.Vector3(1, 1, 1),
      zero: new THREE.Matrix4().makeScale(0, 0, 0),
    };

    this._buildArena();
    this._buildEnemyPool();
    this._buildBlade();
    this._buildHUD();
  }

  // ------------------------------------------------------------------ arena

  _buildArena() {
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_R + 2.5, ARENA_R + 2.5, 9, 40, 1, true),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#0a0a18'),
        roughness: 0.9, metalness: 0.1,
        side: THREE.BackSide, envMapIntensity: 0.25,
      })
    );
    shell.position.y = 3.6;
    this.group.add(shell);

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
    this.group.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPts),
      new THREE.LineBasicMaterial({
        color: new THREE.Color(PALETTE.accentBlue),
        transparent: true, opacity: 0.16, toneMapped: false, fog: false,
      })
    ));

    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA_R, ARENA_R, 0.3, 48),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#0a0d1c'),
        roughness: 0.62, metalness: 0.16, envMapIntensity: 0.14,
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
    this.group.add(rim);

    // A ring at strike range, so you can see how close is too close.
    const danger = new THREE.Mesh(
      new THREE.TorusGeometry(STRIKE_RANGE + 0.5, 0.02, 4, 48),
      neonMaterial(PALETTE.accentPurple, 1.4)
    );
    danger.rotation.x = -Math.PI / 2;
    danger.position.y = 0.02;
    this.group.add(danger);
  }

  // ------------------------------------------------------------ enemy pool

  /**
   * One InstancedMesh per body part, sized to the pool. Unused slots are
   * scaled to zero rather than removed, so nothing allocates mid-fight.
   */
  _buildEnemyPool() {
    const skin = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#2b2f52'),
      roughness: 0.7, metalness: 0.15, envMapIntensity: 0.6,
    });
    const trim = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#141838'),
      emissive: new THREE.Color(PALETTE.accentPurple),
      emissiveIntensity: 0.45,
      roughness: 0.6, metalness: 0.3,
    });

    const mk = (geo, mat, count) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.castShadow = QUALITY.shadows;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    };

    this.parts = {
      head: mk(new THREE.BoxGeometry(0.21, 0.24, 0.21), skin, MAX_ENEMIES),
      torso: mk(new THREE.BoxGeometry(0.42, 0.58, 0.24), trim, MAX_ENEMIES),
      // Four limbs each — two legs, two arms — packed into one mesh.
      limb: mk(new THREE.BoxGeometry(0.13, 0.52, 0.13), skin, MAX_ENEMIES * 4),
      sword: mk(new THREE.BoxGeometry(0.05, 0.9, 0.014),
        neonMaterial(PALETTE.accentPurple, 2.4), MAX_ENEMIES),
    };
    this._hideAllParts();
  }

  _hideAllParts() {
    const zero = this._scratch.zero;
    for (const key of ['head', 'torso', 'sword']) {
      for (let i = 0; i < MAX_ENEMIES; i++) this.parts[key].setMatrixAt(i, zero);
      this.parts[key].instanceMatrix.needsUpdate = true;
    }
    for (let i = 0; i < MAX_ENEMIES * 4; i++) this.parts.limb.setMatrixAt(i, zero);
    this.parts.limb.instanceMatrix.needsUpdate = true;
  }

  _spawnEnemy() {
    if (this.enemies.length >= MAX_ENEMIES) return null;
    const used = new Set(this.enemies.map((e) => e.slot));
    let slot = 0;
    while (used.has(slot)) slot++;

    const angle = range(this.rand, -FRONT_ARC, FRONT_ARC);
    const spawnR = ARENA_R - 0.5;
    const e = {
      slot,
      angle,
      speed: 0.9 + this.wave * 0.08 + range(this.rand, -0.15, 0.25),
      state: 'approach',       // approach | windup | strike | recover | falling
      timer: 0,
      gait: range(this.rand, 0, Math.PI * 2),
      swing: 0,                // 0 = sword raised, 1 = fully swung down
      fall: 0,
      hp: this.wave > 4 ? 2 : 1,
      // Position is authoritative and steers straight at the player. An
      // earlier version shrank a radius about the arena origin while measuring
      // distance to the player's head — so with the player standing off-centre
      // the opponents converged on the middle of the room and stopped, never
      // reaching striking distance. They walked at a point nobody was at.
      pos: new THREE.Vector3(Math.sin(angle) * spawnR, 0, -Math.cos(angle) * spawnR),
      yaw: 0,
      halo: this.glow.add(new THREE.Vector3(), PALETTE.accentPurple, 1.0, 0.22),
    };
    this.enemies.push(e);
    return e;
  }

  _removeEnemy(e) {
    this.glow.release(e.halo);
    const zero = this._scratch.zero;
    this.parts.head.setMatrixAt(e.slot, zero);
    this.parts.torso.setMatrixAt(e.slot, zero);
    this.parts.sword.setMatrixAt(e.slot, zero);
    for (let k = 0; k < 4; k++) this.parts.limb.setMatrixAt(e.slot * 4 + k, zero);
    this.parts.head.instanceMatrix.needsUpdate = true;
    this.parts.torso.instanceMatrix.needsUpdate = true;
    this.parts.sword.instanceMatrix.needsUpdate = true;
    this.parts.limb.instanceMatrix.needsUpdate = true;
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
  }

  // ------------------------------------------------------------------ blade

  _buildBlade() {
    this.bladeRoot = new THREE.Group();
    this.engine.rig.add(this.bladeRoot);
    this.bladeRoot.visible = false;

    const hilt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.028, 0.18, 8), this.mats.darkMetal
    );
    hilt.position.y = -0.09;
    this.bladeRoot.add(hilt);
    this.bladeRoot.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.17, 0.022, 0.045), this.mats.darkMetal
    ));

    this.bladeMat = neonMaterial(PALETTE.accentBlue, 2.6);
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.048, BLADE_LENGTH, 0.013), this.bladeMat
    );
    blade.position.y = BLADE_LENGTH / 2;
    this.bladeRoot.add(blade);

    this.trailLength = 14;
    this._trailPts = Array.from({ length: this.trailLength }, () => new THREE.Vector3());
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(this.trailLength * 3), 3));
    this.trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
      color: new THREE.Color(PALETTE.accentBlue),
      transparent: true, opacity: 0.5, toneMapped: false, fog: false,
    }));
    this.trail.frustumCulled = false;
    this.group.add(this.trail);

    this._bladeQuat = new THREE.Quaternion();
    this._bladePos = new THREE.Vector3();
    this._tipVel = 0;
  }

  // -------------------------------------------------------------------- HUD

  _buildHUD() {
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
    panel.position.set(0, 3.0, -ARENA_R + 1.4);
    panel.rotation.x = 0.12;
    this.group.add(panel);
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
      c.fillText('STEEL GARDEN', 256, 28);
      c.fillStyle = '#a8c4e8';
      c.font = '400 21px ui-sans-serif, system-ui, sans-serif';
      c.fillText('Swing to cut. Put your blade in theirs to block.', 256, 96);
      c.fillText('It does not stop. Trigger to begin.', 256, 130);
      if (this.best) {
        c.fillStyle = '#7f93b8';
        c.font = '400 19px ui-sans-serif, system-ui, sans-serif';
        c.fillText(`best  ${this.best}`, 256, 190);
      }
    } else if (this.state === 'dead') {
      c.textAlign = 'center';
      c.fillStyle = PALETTE.accentPurple;
      c.font = '700 48px ui-sans-serif, system-ui, sans-serif';
      c.fillText('YOU DIED', 256, 26);
      c.fillStyle = '#eaf4ff';
      c.font = '500 30px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`${this.kills} felled  ·  wave ${this.wave}`, 256, 98);
      c.fillStyle = '#7f93b8';
      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`score ${this.score}    best ${this.best}`, 256, 146);
      c.fillText('trigger to fight again  ·  grip to leave', 256, 192);
    } else {
      c.textAlign = 'left';
      c.fillStyle = '#eaf4ff';
      c.font = '600 30px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`WAVE ${this.wave}`, 26, 22);
      c.font = '600 52px ui-sans-serif, system-ui, sans-serif';
      c.fillText(String(this.score), 26, 62);
      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = '#7f93b8';
      c.fillText(`${this.kills} felled`, 26, 132);

      for (let i = 0; i < START_HEALTH; i++) {
        c.fillStyle = i < this.health ? PALETTE.accentGreen : '#243049';
        c.fillRect(26 + i * 40, 176, 30, 12);
      }

      c.textAlign = 'right';
      c.fillStyle = '#7f93b8';
      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`${this.enemies.length} closing`, 486, 22);
    }
    this.hudTex.needsUpdate = true;
  }

  // -------------------------------------------------------------------- flow

  enter() {
    this.active = true;
    this.group.visible = true;
    this.bladeRoot.visible = true;
    this.state = 'ready';
    this.wave = 1;
    this.kills = 0;
    this.score = 0;
    this.health = START_HEALTH;
    this._spawnTimer = 0;
    for (const e of [...this.enemies]) this._removeEnemy(e);
    this.audio?.setRacing(true);
    this._drawHUD();
  }

  begin() {
    this.state = 'fighting';
    this._spawnTimer = 0.5;
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

  _die() {
    this.state = 'dead';
    if (this.score > this.best) {
      this.best = this.score;
      try { localStorage.setItem('steelgarden.best', String(this.score)); } catch { /* quota */ }
    }
    for (const e of [...this.enemies]) this._removeEnemy(e);
    this.audio?.ping(140);
  }

  // ------------------------------------------------------------------ input

  bindKeys(keys) { this._keys = keys; }
  bindControllers(list) { this._controllers = list; }

  _readInput() {
    if (this.inputLocked) {
      return { trigger: false, grip: false, hand: this._controllers?.[0] ?? null };
    }
    let trigger = false, grip = false, hand = null;
    const session = this.engine.renderer.xr.getSession?.();
    if (session) {
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (gp?.buttons[0]?.pressed) trigger = true;
        if (gp?.buttons[1]?.pressed) grip = true;
      }
      hand = this._controllers?.find((c) => c.userData.handedness === 'right')
          ?? this._controllers?.[0] ?? null;
    }
    if (this._keys) {
      if (this._keys.has('Space')) trigger = true;
      // Not Escape — see the identical fix and comment in racing.js. The
      // browser's own pointer-lock-release binding on Escape meant tapping
      // it for that (no intent to leave the fight at all) silently ejected
      // the player from the dojo mid-combat.
      if (this._keys.has('KeyQ')) grip = true;
    }
    return { trigger, grip, hand };
  }

  _updateBlade(dt) {
    const sc = this._scratch;
    const xr = this.engine.renderer.xr.isPresenting;
    const { hand } = this._readInput();

    sc.tipPrev.copy(sc.tip);

    if (xr && hand) {
      sc.v.setFromMatrixPosition(hand.matrix);
      sc.q.setFromRotationMatrix(hand.matrix);
      // Position tracks hard, rotation only slightly softened. Enough weight
      // to feel like steel, not so much that the sword fights you — the first
      // version lagged rotation so heavily you could not aim a cut.
      this._bladePos.lerp(sc.v, Math.min(1, dt * 34));
      this._bladeQuat.slerp(sc.q, Math.min(1, dt * 22));
    } else {
      const cam = this.engine.camera;
      sc.v.set(0.24, -0.26, -0.5).applyQuaternion(cam.quaternion).add(cam.position);
      this._bladePos.lerp(sc.v, Math.min(1, dt * 22));
      sc.q.copy(cam.quaternion);
      this._bladeQuat.slerp(sc.q, Math.min(1, dt * 14));
    }

    this.bladeRoot.position.copy(this._bladePos);
    this.bladeRoot.quaternion.copy(this._bladeQuat);
    this.bladeRoot.updateMatrixWorld();

    sc.base.setFromMatrixPosition(this.bladeRoot.matrixWorld);
    sc.tip.set(0, BLADE_LENGTH, 0).applyMatrix4(this.bladeRoot.matrixWorld);
    sc.dir.subVectors(sc.tip, sc.base).normalize();
    this._tipVel = dt > 0 ? sc.tip.distanceTo(sc.tipPrev) / dt : 0;

    // Cache the blade in arena space once per frame; every hit test reuses it.
    sc.bladeA.copy(sc.base);
    sc.bladeB.copy(sc.tip);
    this.group.worldToLocal(sc.bladeA);
    this.group.worldToLocal(sc.bladeB);

    for (let i = this.trailLength - 1; i > 0; i--) this._trailPts[i].copy(this._trailPts[i - 1]);
    this._trailPts[0].copy(sc.tip);
    const arr = this.trail.geometry.attributes.position.array;
    for (let i = 0; i < this.trailLength; i++) {
      arr[i * 3] = this._trailPts[i].x;
      arr[i * 3 + 1] = this._trailPts[i].y;
      arr[i * 3 + 2] = this._trailPts[i].z;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.material.opacity = THREE.MathUtils.clamp(this._tipVel * 0.06, 0.06, 0.75);
    this.bladeMat.emissiveIntensity = 2.2 + Math.min(this._tipVel * 0.14, 2.2);
  }

  // ----------------------------------------------------------------- update

  update(dt, ctx) {
    if (!this.active) return;
    const input = this._readInput();
    this._updateBlade(dt);

    if (this.state === 'ready' || this.state === 'dead') {
      if (input.trigger && !this._triggerHeld) {
        if (this.state === 'ready') this.begin();
        else this.enter();
      }
      this._triggerHeld = input.trigger;
      if (input.grip) this.exit();
      this._drawHUD();
      return;
    }
    this._triggerHeld = input.trigger;
    if (input.grip) { this.exit(); return; }

    // Waves ramp with kills. The pressure never stops, it only grows.
    this.wave = 1 + Math.floor(this.kills / 5);
    const target = Math.min(2 + Math.floor(this.wave / 2), MAX_ENEMIES);
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0 && this.enemies.length < target) {
      this._spawnEnemy();
      this._spawnTimer = Math.max(0.7, 2.4 - this.wave * 0.14);
    }

    this._updateEnemies(dt, ctx);
    if (this.health <= 0) this._die();
    this._drawHUD();
  }

  _updateEnemies(dt, ctx) {
    const sc = this._scratch;
    // The arena is a child group, so bring the head into arena space once
    // rather than pushing every enemy out into world space.
    const headLocal = sc.v2.copy(ctx.engine.headPosition(sc.head));
    this.group.worldToLocal(headLocal);

    for (const e of [...this.enemies]) {
      if (e.state === 'falling') {
        e.fall += dt * 2.2;
        if (e.fall >= 1) { this._removeEnemy(e); continue; }
        this._poseEnemy(e);
        continue;
      }

      let dx = headLocal.x - e.pos.x;
      let dz = headLocal.z - e.pos.z;
      let distance = Math.hypot(dx, dz) || 1e-4;
      e.yaw = Math.atan2(dx, dz);

      if (e.state === 'approach') {
        if (distance > STRIKE_RANGE) {
          const stepLen = Math.min(e.speed * dt, distance - STRIKE_RANGE);
          e.pos.x += (dx / distance) * stepLen;
          e.pos.z += (dz / distance) * stepLen;
          e.gait += dt * e.speed * 5.5;
          distance -= stepLen;
        } else {
          e.state = 'windup';
          e.timer = 0;
          e.swing = 0;
        }
      } else if (e.state === 'windup') {
        e.timer += dt;
        e.swing = 0;
        if (e.timer >= WINDUP) { e.state = 'strike'; e.timer = 0; }
      } else if (e.state === 'strike') {
        e.timer += dt;
        e.swing = Math.min(1, e.timer / 0.16);
        if (e.swing >= 1) {
          this._resolveEnemyStrike(e, headLocal, distance);
          e.state = 'recover';
          e.timer = 0;
        }
      } else if (e.state === 'recover') {
        e.timer += dt;
        e.swing = Math.max(0, 1 - e.timer / RECOVER);
        if (e.timer >= RECOVER) {
          e.state = 'approach';
          this._stepBack(e, headLocal, 0.7);
        }
      }

      // Your cut. Needs speed — resting the blade on someone does nothing.
      sc.v.set(e.pos.x, 1.05, e.pos.z);
      if (this._distanceToBlade(sc.v) < 0.55 && this._tipVel > KILL_SPEED) this._cut(e);
      if (e.knockback) { this._stepBack(e, headLocal, e.knockback); e.knockback = 0; }

      this._poseEnemy(e);
    }
  }

  /** Push an opponent directly away from the player, staying inside the arena. */
  _stepBack(e, headLocal, amount) {
    const dx = e.pos.x - headLocal.x;
    const dz = e.pos.z - headLocal.z;
    const d = Math.hypot(dx, dz) || 1;
    e.pos.x += (dx / d) * amount;
    e.pos.z += (dz / d) * amount;
    const r = Math.hypot(e.pos.x, e.pos.z);
    if (r > ARENA_R - 0.5) {
      e.pos.x *= (ARENA_R - 0.5) / r;
      e.pos.z *= (ARENA_R - 0.5) / r;
    }
  }

  /** Shortest distance from an arena-space point to the player's blade segment. */
  _distanceToBlade(pointLocal) {
    const { bladeA: a, bladeB: b } = this._scratch;
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const apx = pointLocal.x - a.x, apy = pointLocal.y - a.y, apz = pointLocal.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz;
    const t = len2 > 0
      ? THREE.MathUtils.clamp((apx * abx + apy * aby + apz * abz) / len2, 0, 1)
      : 0;
    return Math.hypot(
      pointLocal.x - (a.x + abx * t),
      pointLocal.y - (a.y + aby * t),
      pointLocal.z - (a.z + abz * t)
    );
  }

  _cut(e) {
    e.hp--;
    this.audio?.ping(900 + this.rand() * 300);
    if (e.hp > 0) {
      // Staggered: knocked out of whatever they were doing, pushed back.
      e.state = 'recover';
      e.timer = 0;
      e.knockback = 0.9;
      this.score += 25;
      return;
    }
    e.state = 'falling';
    e.fall = 0;
    this.kills++;
    this.score += 100;
  }

  /**
   * Their blade comes down. You block by having your sword near theirs — a
   * positional test, because putting your sword in the way is what every
   * player instinctively tries to do.
   */
  _resolveEnemyStrike(e, headLocal, distance) {
    const sc = this._scratch;
    const dx = headLocal.x - e.pos.x;
    const dz = headLocal.z - e.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    // Where their sword ends the swing: in front of them, at chest height, on
    // the line towards you.
    const impact = sc.v.set(
      e.pos.x + (dx / d) * 0.9,
      1.15,
      e.pos.z + (dz / d) * 0.9
    );

    if (this._distanceToBlade(impact) < BLOCK_RADIUS) {
      this.audio?.ping(520);
      this.score += 15;
      this.bladeMat.emissive.set(PALETTE.accentGreen);
      setTimeout(() => this.bladeMat.emissive.set(PALETTE.accentBlue), 140);
    } else if (distance < STRIKE_RANGE + 0.6) {
      this.health--;
      this.audio?.ping(200);
    }
  }

  /** Write every body part's matrix for one enemy. */
  _poseEnemy(e) {
    const sc = this._scratch;
    const fallen = e.state === 'falling' ? e.fall : 0;

    sc.e.set(fallen * -1.35, e.yaw, 0, 'YXZ');
    sc.q.setFromEuler(sc.e);
    sc.p.set(e.pos.x, e.pos.y + fallen * 0.1, e.pos.z);
    sc.s.setScalar(1);
    sc.enemyM.compose(sc.p, sc.q, sc.s);

    const put = (mesh, index, x, y, z, rx, rz, sx = 1, sy = 1, sz = 1) => {
      sc.e.set(rx, 0, rz, 'YXZ');
      sc.q.setFromEuler(sc.e);
      sc.p.set(x, y, z);
      sc.s.set(sx, sy, sz);
      sc.localM.compose(sc.p, sc.q, sc.s);
      sc.partM.multiplyMatrices(sc.enemyM, sc.localM);
      mesh.setMatrixAt(index, sc.partM);
    };

    const step = e.state === 'approach' ? Math.sin(e.gait) * 0.5 : 0;

    put(this.parts.torso, e.slot, 0, 1.05, 0, 0, 0);
    put(this.parts.head, e.slot, 0, 1.48, 0, 0, 0);
    put(this.parts.limb, e.slot * 4 + 0, -0.11, 0.5, 0, step, 0);
    put(this.parts.limb, e.slot * 4 + 1, 0.11, 0.5, 0, -step, 0);
    put(this.parts.limb, e.slot * 4 + 2, -0.28, 1.12, 0, -step * 0.5, 0.25, 0.8, 0.85, 0.8);

    // Sword arm: raised through the windup, chops down through the strike.
    const armPitch = THREE.MathUtils.lerp(-2.1, 0.65, e.swing);
    put(this.parts.limb, e.slot * 4 + 3, 0.28, 1.12, 0, armPitch, -0.2, 0.8, 0.85, 0.8);
    const handY = 1.12 - Math.cos(armPitch) * 0.26;
    const handZ = -Math.sin(armPitch) * 0.26;
    put(this.parts.sword, e.slot, 0.3, handY, handZ, armPitch, -0.2);

    this.parts.head.instanceMatrix.needsUpdate = true;
    this.parts.torso.instanceMatrix.needsUpdate = true;
    this.parts.limb.instanceMatrix.needsUpdate = true;
    this.parts.sword.instanceMatrix.needsUpdate = true;

    // The halo brightens through the windup — the tell that a blow is coming.
    e.halo.opacity = e.state === 'falling'
      ? 0.22 * (1 - fallen)
      : (e.state === 'windup' ? 0.25 + (e.timer / WINDUP) * 0.85 : 0.22);
    const world = sc.p.set(e.pos.x, 1.2, e.pos.z);
    this.group.localToWorld(world);
    e.halo.setPosition(world.x, world.y, world.z);
  }
}

export { ARENA_R, MAX_ENEMIES };
