import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { library, neonMaterial } from '../world/materials.js';
import { PALETTE } from '../world/palette.js';
import { makeRNG, range } from '../core/rng.js';

const UP = new THREE.Vector3(0, 1, 0);

const LAPS = 3;
const TRACK_HALF_WIDTH = 7.5;
const BASE_SPEED = 26;      // m/s cruise
const MAX_SPEED = 62;       // m/s with boost, at full throttle
const BOOST_GAIN = 16;

// Gate ring tints, written straight into instanceColor. Deliberately over 1.0
// on the lit states: the tone mapper turns the overshoot into a hot core.
const GATE_IDLE = new THREE.Color(PALETTE.gate).convertSRGBToLinear().multiplyScalar(3.2);
const GATE_HIT = new THREE.Color('#e8fff4').convertSRGBToLinear().multiplyScalar(9.0);
const GATE_MISS = new THREE.Color(PALETTE.gate).convertSRGBToLinear().multiplyScalar(0.35);

/**
 * NEON LINE — the racing game.
 *
 * Rail-relative, not free-flight. The craft is locked to a spline and the
 * player controls throttle and lateral position on the ribbon. This is a
 * comfort decision before it is a design one: free 6DoF flight through a
 * dense city is the most nauseating thing you can put in a headset, while a
 * fixed rail with a rigid cockpit frame is one of the most tolerable forms of
 * fast VR motion there is.
 */
export class Racing {
  constructor(engine, glow, opts = {}) {
    this.engine = engine;
    this.glow = glow;
    this.audio = opts.audio ?? null;
    this.mats = library();
    this.rand = makeRNG(99);
    this.onExit = opts.onExit ?? (() => {});

    this.group = new THREE.Group();
    this.group.visible = false;
    engine.scene.add(this.group);

    this.active = false;
    this.state = 'idle';        // idle | countdown | racing | finished
    this.t = 0;                 // normalised distance along the curve
    this.offset = 0;            // metres left/right of the centreline
    this.speed = 0;
    this.boost = 0;
    this.lap = 0;
    this.lapTimes = [];
    this._lapClock = 0;
    this._countdown = 0;
    this._bank = 0;

    // Scratch objects for the per-frame path. Allocating vectors and
    // quaternions inside _place() is garbage at 90Hz, and a GC pause is
    // visible as a hitch when you are moving at 60 m/s.
    this._scratch = {
      pos: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      euler: new THREE.Euler(0, 0, 0, 'YXZ'),
      ghostEuler: new THREE.Euler(0, 0, 0, 'YXZ'),
      curvePoint: new THREE.Vector3(),
    };

    this._buildCurve();
    this._buildRibbon();
    this._buildGates();
    this._buildCraft();
    this._buildHUD();

    this.best = Number(localStorage.getItem('neonline.best') || 0) || null;
    this._ghost = this._loadGhost();
    this._recording = [];
  }

  // ---------------------------------------------------------------- track

  _buildCurve() {
    // A closed ring threaded around the city at rooftop height, with enough
    // vertical variation that the horizon moves without the craft ever
    // pitching hard enough to be uncomfortable.
    const pts = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = 118 + Math.sin(a * 3) * 26 + range(this.rand, -8, 8);
      pts.push(new THREE.Vector3(
        Math.cos(a) * r,
        26 + Math.sin(a * 2 + 0.6) * 9 + Math.sin(a * 5) * 3,
        Math.sin(a) * r
      ));
    }
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
    this.length = this.curve.getLength();

    // Cached frames: sampling the curve every frame for tangent and normal is
    // the single most expensive thing this mode could do.
    this.frames = this.curve.computeFrenetFrames(600, true);
    this._frameCount = 600;
  }

  _frameAt(t) {
    const i = Math.min(this._frameCount - 1, Math.max(0, Math.floor(t * this._frameCount)));
    return {
      tangent: this.frames.tangents[i],
      normal: this.frames.normals[i],
      binormal: this.frames.binormals[i],
    };
  }

  /** Right vector of the ribbon, flattened so lateral movement stays level. */
  _rightAt(t, out = new THREE.Vector3()) {
    const { tangent } = this._frameAt(t);
    out.crossVectors(tangent, UP).normalize();
    if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
    return out;
  }

  _buildRibbon() {
    const segments = 600;
    const verts = [];
    const idx = [];
    const right = new THREE.Vector3();
    const p = new THREE.Vector3();

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      this.curve.getPointAt(t % 1, p);
      this._rightAt(t % 1, right);
      verts.push(
        p.x - right.x * TRACK_HALF_WIDTH, p.y, p.z - right.z * TRACK_HALF_WIDTH,
        p.x + right.x * TRACK_HALF_WIDTH, p.y, p.z + right.z * TRACK_HALF_WIDTH
      );
      if (i < segments) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const deck = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: new THREE.Color('#080c1c'),
      roughness: 0.28,
      metalness: 0.8,
      side: THREE.DoubleSide,
      envMapIntensity: 1.4,
    }));
    this.group.add(deck);

    // Emissive edge rails. These are the primary speed cue — at 60 m/s the
    // city itself is too distant to convey velocity, but the rails streaking
    // past in peripheral vision do it perfectly.
    for (const side of [-1, 1]) {
      const railPts = [];
      for (let i = 0; i <= segments; i++) {
        const t = (i / segments) % 1;
        this.curve.getPointAt(t, p);
        this._rightAt(t, right);
        railPts.push(new THREE.Vector3(
          p.x + right.x * TRACK_HALF_WIDTH * side,
          p.y + 0.35,
          p.z + right.z * TRACK_HALF_WIDTH * side
        ));
      }
      const railGeo = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(railPts, true), segments, 0.14, 5, true
      );
      const rail = new THREE.Mesh(railGeo, neonMaterial(side < 0 ? PALETTE.railLeft : PALETTE.railRight, 3.4));
      this.group.add(rail);
    }

    // Centre dashes, so the player can read lateral drift without a HUD.
    const dash = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.24, 0.04, 3.0),
      neonMaterial('#dff7ff', 1.6),
      120
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const look = new THREE.Matrix4();
    for (let i = 0; i < 120; i++) {
      const t = i / 120;
      this.curve.getPointAt(t, p);
      const { tangent } = this._frameAt(t);
      look.lookAt(new THREE.Vector3(), tangent, new THREE.Vector3(0, 1, 0));
      q.setFromRotationMatrix(look);
      m.compose(new THREE.Vector3(p.x, p.y + 0.06, p.z), q, one);
      dash.setMatrixAt(i, m);
    }
    dash.instanceMatrix.needsUpdate = true;
    this.group.add(dash);
  }

  _buildGates() {
    // Boost gates. Off-centre on purpose: the racing line is a choice, not a
    // straight pull, and hitting them is what separates a good lap.
    this.gates = [];
    const count = 22;

    // One instanced mesh for every ring; per-instance colour is how a gate
    // shows it was hit or missed without needing its own material.
    // Unlit, so the instance colour *is* the output — an emissive-only
    // material would leave the diffuse term black and swallow the tint.
    // Values above 1.0 survive as HDR into the tone mapper.
    const rings = new THREE.InstancedMesh(
      new THREE.TorusGeometry(2.2, 0.13, 6, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true, fog: true }),
      count
    );
    rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    rings.frustumCulled = false;
    this.group.add(rings);
    this.gateRings = rings;

    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    const look = new THREE.Matrix4();
    const q = new THREE.Quaternion();

    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const offset = Math.sin(i * 2.3) * TRACK_HALF_WIDTH * 0.62;
      const p = this.curve.getPointAt(t);
      const right = this._rightAt(t);
      const { tangent } = this._frameAt(t);

      const pos = new THREE.Vector3(
        p.x + right.x * offset, p.y + 2.3, p.z + right.z * offset
      );
      look.lookAt(new THREE.Vector3(), tangent, new THREE.Vector3(0, 1, 0));
      q.setFromRotationMatrix(look);
      m.compose(pos, q, one);
      rings.setMatrixAt(i, m);

      const halo = this.glow.add(pos, PALETTE.gate, 3.4, 0.5);
      this.gates.push({ t, offset, index: i, halo, taken: false, radius: 2.6 });
    }
    rings.instanceMatrix.needsUpdate = true;
    this._setAllGateColors(GATE_IDLE);
  }

  _setGateColor(i, color) {
    this.gateRings.instanceColor.setXYZ(i, color.r, color.g, color.b);
    this.gateRings.instanceColor.needsUpdate = true;
  }

  _setAllGateColors(color) {
    for (let i = 0; i < this.gates.length; i++) {
      this.gateRings.instanceColor.setXYZ(i, color.r, color.g, color.b);
    }
    this.gateRings.instanceColor.needsUpdate = true;
  }

  _buildCraft() {
    // Cockpit. Parented to the rig, so it is pixel-stable relative to the
    // player's head — that fixed frame is the whole comfort strategy.
    this.cockpit = new THREE.Group();
    this.cockpit.visible = false;
    this.engine.rig.add(this.cockpit);

    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.16, 2.0),
      this.mats.darkMetal
    );
    shell.position.set(0, 0.5, -0.15);
    this.cockpit.add(shell);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.6, 4),
      this.mats.darkMetal
    );
    nose.rotation.x = -Math.PI / 2;
    nose.rotation.z = Math.PI / 4;
    nose.position.set(0, 0.5, -1.6);
    this.cockpit.add(nose);

    const glassCowl = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.5, 0.08),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#0e1830'), roughness: 0.06, metalness: 1,
        transparent: true, opacity: 0.42, envMapIntensity: 2.5,
      })
    );
    glassCowl.position.set(0, 0.82, -1.0);
    glassCowl.rotation.x = 0.42;
    this.cockpit.add(glassCowl);

    // Handlebars, at a natural resting grab position for a seated player.
    for (const s of [-1, 1]) {
      const bar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 0.3, 8),
        this.mats.darkMetal
      );
      bar.rotation.z = Math.PI / 2;
      bar.position.set(s * 0.42, 0.78, -0.62);
      this.cockpit.add(bar);
    }

    // Thruster glow behind the seat.
    this.thrusterMat = new THREE.MeshBasicMaterial({
      map: this.mats.glow,
      color: new THREE.Color(PALETTE.thruster),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.thruster = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), this.thrusterMat);
    this.thruster.position.set(0, 0.5, 0.9);
    this.cockpit.add(this.thruster);

    // Ghost craft — the player's own best lap, replayed.
    this.ghostMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.4, 2.4),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(PALETTE.ghost), emissive: new THREE.Color(PALETTE.ghost),
        emissiveIntensity: 0.8, transparent: true, opacity: 0.28,
        roughness: 0.4, metalness: 0.2,
      })
    );
    this.ghostMesh.visible = false;
    this.group.add(this.ghostMesh);
  }

  _buildHUD() {
    // Instrument panel, mounted on the craft rather than floating in vision.
    // Diegetic even here — the design doc forbids screen-space UI.
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 512;
    this.hudCanvas.height = 256;
    this.hudCtx = this.hudCanvas.getContext('2d');
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.31),
      new THREE.MeshBasicMaterial({
        map: this.hudTex, transparent: true, toneMapped: false, fog: false,
      })
    );
    panel.position.set(0, 0.72, -0.92);
    panel.rotation.x = -0.55;
    this.cockpit.add(panel);
    this._hudDirty = true;
  }

  _drawHUD() {
    const c = this.hudCtx;
    c.clearRect(0, 0, 512, 256);
    c.fillStyle = 'rgba(6,10,18,0.82)';
    c.fillRect(0, 0, 512, 256);
    c.strokeStyle = PALETTE.accentBlue;
    c.lineWidth = 3;
    c.strokeRect(6, 6, 500, 244);

    c.fillStyle = '#eaf6ff';
    c.font = '600 30px ui-sans-serif, system-ui, sans-serif';
    c.textBaseline = 'top';

    if (this.state === 'countdown') {
      c.font = '700 96px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = PALETTE.accentPurple;
      c.textAlign = 'center';
      c.fillText(Math.ceil(this._countdown) || 'GO', 256, 74);
      c.textAlign = 'left';
    } else if (this.state === 'finished') {
      c.textAlign = 'center';
      c.fillStyle = PALETTE.accentGreen;
      c.font = '700 46px ui-sans-serif, system-ui, sans-serif';
      c.fillText('FINISH', 256, 40);
      c.fillStyle = '#eaf6ff';
      c.font = '500 28px ui-sans-serif, system-ui, sans-serif';
      c.fillText(fmt(this.lapTimes.reduce((a, b) => a + b, 0)), 256, 106);
      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = '#93b6dd';
      c.fillText('trigger to race again  ·  grip to leave', 256, 170);
      c.textAlign = 'left';
    } else {
      c.fillText(`LAP ${Math.min(this.lap + 1, LAPS)}/${LAPS}`, 26, 22);
      c.font = '600 52px ui-sans-serif, system-ui, sans-serif';
      c.fillText(fmt(this._lapClock), 26, 62);

      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = '#93b6dd';
      c.fillText(`BEST  ${this.best ? fmt(this.best) : '--:--.--'}`, 26, 128);

      // Speed bar.
      const frac = THREE.MathUtils.clamp(this.speed / MAX_SPEED, 0, 1);
      c.fillStyle = '#141d38';
      c.fillRect(26, 176, 460, 22);
      c.fillStyle = this.boost > 0.1 ? PALETTE.accentGreen : PALETTE.accentBlue;
      c.fillRect(26, 176, 460 * frac, 22);
      c.fillStyle = '#eaf6ff';
      c.font = '600 22px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`${Math.round(this.speed * 3.6)} KM/H`, 26, 210);
    }
    this.hudTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- flow

  enter() {
    this.active = true;
    this.audio?.setRacing(true);
    this.group.visible = true;
    this.cockpit.visible = true;
    this.state = 'countdown';
    this._countdown = 3.999;
    this.t = 0;
    this.offset = 0;
    this.speed = 0;
    this.boost = 0;
    this.lap = 0;
    this.lapTimes = [];
    this._lapClock = 0;
    this._recording = [];
    this._gatesHitTotal = 0;
    for (const g of this.gates) { g.taken = false; g.halo.opacity = 0.5; }
    this._setAllGateColors(GATE_IDLE);
    this.ghostMesh.visible = !!this._ghost;
  }

  exit() {
    this.active = false;
    this.audio?.setRacing(false);
    this.audio?.setSpeed(0);
    this.group.visible = false;
    this.cockpit.visible = false;
    this.state = 'idle';
    this.onExit();
  }

  _loadGhost() {
    try {
      const raw = localStorage.getItem('neonline.ghost');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  _saveRun(total) {
    if (!this.best || total < this.best) {
      this.best = total;
      localStorage.setItem('neonline.best', String(total));
      try {
        localStorage.setItem('neonline.ghost', JSON.stringify(this._recording));
        this._ghost = this._recording;
      } catch { /* quota — a missing ghost is not worth failing the run over */ }
    }
  }

  update(dt, ctx) {
    if (!this.active) return;

    const input = this._input();

    if (this.state === 'countdown') {
      this._countdown -= dt;
      if (this._countdown <= 0) { this.state = 'racing'; this._lapClock = 0; }
      this._drawHUD();
      this._place();
      return;
    }

    if (this.state === 'finished') {
      if (input.trigger) this.enter();
      if (input.grip) this.exit();
      this._drawHUD();
      this._place();
      return;
    }

    // --- racing
    this._lapClock += dt;

    // Throttle. Holding the trigger accelerates; releasing coasts down to a
    // cruise rather than to a stop, so a nervous player is never stranded.
    const throttle = input.trigger ? 1 : 0.35;
    const target = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * throttle + this.boost;
    this.speed = THREE.MathUtils.damp(this.speed, target, 2.2, dt);
    this.boost = Math.max(0, this.boost - dt * 9);

    // Lateral. Rate-limited so the craft has weight and the player cannot
    // strobe side to side.
    const steer = input.steer;
    this._lateralVel = THREE.MathUtils.damp(this._lateralVel ?? 0, steer * 13, 6, dt);
    this.offset = THREE.MathUtils.clamp(
      this.offset + this._lateralVel * dt,
      -TRACK_HALF_WIDTH + 1.2,
      TRACK_HALF_WIDTH - 1.2
    );

    // Scraping a rail costs speed. No crash state, no respawn — losing time
    // is punishment enough and it keeps the mode relaxing.
    const edge = Math.abs(this.offset) - (TRACK_HALF_WIDTH - 1.6);
    if (edge > 0) this.speed *= (1 - Math.min(edge, 1) * 2.4 * dt);

    // Advance along the curve.
    const prevT = this.t;
    this.t = (this.t + (this.speed * dt) / this.length) % 1;

    if (this.state === 'racing') {
      this._recording.push([this.t, this.offset]);
    }

    // Gates.
    for (const g of this.gates) {
      if (g.taken) continue;
      const crossed = prevT <= g.t && (this.t >= g.t || this.t < prevT);
      if (!crossed) continue;
      g.taken = true;
      if (Math.abs(this.offset - g.offset) < g.radius) {
        this.boost += BOOST_GAIN;
        this._gatesHitTotal++;
        this.audio?.ping(760 + (this._gatesHitTotal % 5) * 90);
        this._setGateColor(g.index, GATE_HIT);
        g.halo.opacity = 1.4;
      } else {
        this._setGateColor(g.index, GATE_MISS);
        g.halo.opacity = 0.08;
      }
    }

    // Lap line.
    if (this.t < prevT) {
      this.lapTimes.push(this._lapClock);
      this.lap++;
      this._lapClock = 0;
      for (const g of this.gates) {
        g.taken = false;
        g.halo.opacity = 0.5;
      }
      this._setAllGateColors(GATE_IDLE);
      if (this.lap >= LAPS) {
        this.state = 'finished';
        this._saveRun(this.lapTimes.reduce((a, b) => a + b, 0));
      }
    }

    this.audio?.setSpeed(THREE.MathUtils.clamp(this.speed / MAX_SPEED, 0, 1));

    this._place();
    this._updateGhost();
    this._drawHUD();
  }

  /** Drive the rig from the track frame. Allocation-free. */
  _place() {
    const sc = this._scratch;
    const p = this.curve.getPointAt(this.t, sc.curvePoint);
    const right = this._rightAt(this.t, sc.right);
    const { tangent } = this._frameAt(this.t);

    this.engine.rig.position.set(
      p.x + right.x * this.offset,
      p.y + 1.1,
      p.z + right.z * this.offset
    );

    // Yaw only, plus a small cosmetic bank. Roll is capped low deliberately:
    // vestibular conflict scales with roll far faster than with yaw.
    const yaw = Math.atan2(tangent.x, tangent.z);
    const targetBank = THREE.MathUtils.clamp(-(this._lateralVel ?? 0) * 0.02, -0.14, 0.14);
    this._bank = THREE.MathUtils.damp(this._bank, targetBank, 5, 1 / 72);

    sc.euler.set(0, yaw, this._bank);
    this.engine.rig.quaternion.setFromEuler(sc.euler);

    // Thruster brightness tracks throttle.
    const f = THREE.MathUtils.clamp((this.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED), 0, 1);
    this.thrusterMat.opacity = 0.45 + f * 0.55;
    this.thruster.scale.setScalar(1.0 + f * 0.9);
  }

  _updateGhost() {
    if (!this._ghost || !this._ghost.length) { this.ghostMesh.visible = false; return; }
    // Replay by index against the live recording, which keeps the ghost at the
    // same point in elapsed time rather than the same point on the track.
    const sc = this._scratch;
    const i = Math.min(this._recording.length, this._ghost.length - 1);
    const [gt, go] = this._ghost[i];
    const p = this.curve.getPointAt(gt, sc.pos);
    const right = this._rightAt(gt, sc.right);
    const { tangent } = this._frameAt(gt);
    this.ghostMesh.visible = true;
    this.ghostMesh.position.set(p.x + right.x * go, p.y + 1.0, p.z + right.z * go);
    sc.ghostEuler.set(0, Math.atan2(tangent.x, tangent.z), 0);
    this.ghostMesh.quaternion.setFromEuler(sc.ghostEuler);
  }

  _input() {
    let trigger = false, grip = false, steer = 0;
    const session = this.engine.renderer.xr.getSession?.();
    if (session) {
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp) continue;
        if (gp.buttons[0]?.pressed) trigger = true;
        if (gp.buttons[1]?.pressed) grip = true;
        const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] ?? 0;
        if (Math.abs(ax) > Math.abs(steer)) steer = ax;
      }
    }
    if (this._keys) {
      if (this._keys.has('Space')) trigger = true;
      if (this._keys.has('Escape')) grip = true;
      if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) steer = -1;
      if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) steer = 1;
    }
    return { trigger, grip, steer: THREE.MathUtils.clamp(steer, -1, 1) };
  }

  /** Desktop input is owned by Player; it hands the key set over on entry. */
  bindKeys(keys) { this._keys = keys; }
}

function fmt(sec) {
  if (!sec && sec !== 0) return '--:--.--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

export { LAPS, MAX_SPEED };
