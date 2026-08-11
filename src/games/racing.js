import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { library, neonMaterial } from '../world/materials.js';
import { PALETTE } from '../world/palette.js';
import { makeRNG, range } from '../core/rng.js';
import { BLOCK, STREET } from '../world/city.js';

const UP = new THREE.Vector3(0, 1, 0);

// Rival liveries, inside the palette.
const RIVAL_COLORS = ['#48d6ff', '#b98cff', '#3dffa8', '#7c5cff', '#5cf2d6'];

const LAPS = 3;
const TRACK_HALF_WIDTH = STREET / 2 - 1.2;   // fits between the kerbs

// Real car numbers. The first pass ran at 62 m/s — 223 km/h — down a ribbon
// eight metres wide, which is not exhilarating, it is just a blur you cannot
// read. A racing car on a tight city circuit lives around 100–150 km/h, and at
// that speed you can actually see the corner you are about to take.
const IDLE_SPEED = 8;       // m/s off-throttle, ~29 km/h
const CRUISE_SPEED = 26;    // m/s part-throttle, ~94 km/h
const MAX_SPEED = 38;       // m/s flat out, ~137 km/h
const BRAKE_RATE = 26;      // m/s² — brakes are far stronger than the engine
const ACCEL_RATE = 7.5;     // m/s² — and acceleration is not instant
const BOOST_GAIN = 4;   // boost tops out around 150 km/h, not 220
const OPPONENTS = 5;

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
    this._buildRivals();
    this._buildHUD();

    this.best = Number(localStorage.getItem('neonline.best') || 0) || null;
    this._ghost = this._loadGhost();
    this._recording = [];
  }

  // ---------------------------------------------------------------- track

  _buildCurve() {
    /**
     * A street circuit, laid on the road grid at ground level.
     *
     * The first version was a ribbon floating at rooftop height on a wobbling
     * radius, and it drove straight through tower blocks — the track and the
     * city were generated independently and nothing reconciled them. Routing
     * the circuit down the streets fixes that by construction: the streets are
     * the one part of the map guaranteed to be clear, because that is where
     * the buildings are not.
     *
     * It is also the honest answer to "make it realistic". Real city races are
     * run on closed public roads, between the buildings, not on a skyway.
     */
    const S = BLOCK * 2.5;     // half-extent, landing on a street centreline
    const CORNER = 26;         // corner radius
    const Y = 0.28;            // just proud of the road surface
    const pts = [];

    const straight = (x0, z0, x1, z1, n = 4) => {
      for (let i = 0; i < n; i++) {
        const k = i / n;
        pts.push(new THREE.Vector3(
          THREE.MathUtils.lerp(x0, x1, k), Y, THREE.MathUtils.lerp(z0, z1, k)
        ));
      }
    };
    const corner = (cx, cz, a0, a1, n = 5) => {
      for (let i = 0; i <= n; i++) {
        const a = THREE.MathUtils.lerp(a0, a1, i / n);
        pts.push(new THREE.Vector3(cx + Math.cos(a) * CORNER, Y, cz + Math.sin(a) * CORNER));
      }
    };

    const I = S - CORNER;
    straight(S, -I, S, I);
    corner(I, I, 0, Math.PI / 2);
    straight(I, S, -I, S);
    corner(-I, I, Math.PI / 2, Math.PI);
    straight(-S, I, -S, -I);
    corner(-I, -I, Math.PI, Math.PI * 1.5);
    straight(-I, -S, I, -S);
    corner(I, -I, Math.PI * 1.5, Math.PI * 2);

    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
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
        p.x + right.x * offset, p.y + 2.6, p.z + right.z * offset
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

  /**
   * The field you are racing. Five rivals on the same circuit, each with its
   * own pace and preferred line, all in one InstancedMesh.
   *
   * They are not on rails relative to you: there is no rubber-banding that
   * drags them back when you pull ahead. A rival who is quicker than you stays
   * ahead, which is the only way finishing second means anything.
   */
  _buildRivals() {
    this.rivals = [];
    const body = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.9, 0.62, 4.2),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#11162c'),
        roughness: 0.35, metalness: 0.7, envMapIntensity: 1.1,
      }),
      OPPONENTS
    );
    body.castShadow = QUALITY.shadows;
    body.frustumCulled = false;
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(body);
    this.rivalBody = body;

    // Tail lights, so you can read a rival's distance in the dark.
    const tail = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.5, 0.12, 0.06),
      new THREE.MeshBasicMaterial({ toneMapped: true }),
      OPPONENTS
    );
    tail.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(OPPONENTS * 3), 3);
    tail.frustumCulled = false;
    tail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(tail);
    this.rivalTail = tail;

    const c = new THREE.Color();
    for (let i = 0; i < OPPONENTS; i++) {
      this.rivals.push({
        t: 0,
        lap: 0,
        // Spread across the grid behind the player, alternating sides.
        gridOffset: (i % 2 === 0 ? -1 : 1) * (1.6 + (i >> 1) * 1.4),
        gridBack: 0.004 + i * 0.0035,
        offset: 0,
        speed: 0,
        // Each rival has a different flat-out pace, so the field spreads out
        // over a lap the way a real one does.
        pace: 0.80 + i * 0.055 + range(this.rand, -0.02, 0.02),
        line: range(this.rand, -0.55, 0.55),
        colour: RIVAL_COLORS[i % RIVAL_COLORS.length],
      });
      c.set(this.rivals[i].colour).convertSRGBToLinear().multiplyScalar(2.4);
      tail.setColorAt(i, c);
    }
    tail.instanceColor.needsUpdate = true;
  }

  _resetRivals() {
    for (const r of this.rivals) {
      // The grid sits just *behind* the start line, which means a t near 1 on
      // the previous lap. Leaving lap at 0 here put the whole field 99.6% of a
      // lap ahead of the player before the lights went out, and you finished
      // last no matter how you drove.
      r.t = (1 - r.gridBack) % 1;
      r.lap = -1;
      r.offset = r.gridOffset;
      r.speed = 0;
    }
  }

  _updateRivals(dt) {
    const sc = this._scratch;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const look = new THREE.Matrix4();

    for (let i = 0; i < this.rivals.length; i++) {
      const r = this.rivals[i];
      // Rivals lift off the throttle for the tighter parts of the lap, which
      // is what makes them catchable through the corners rather than uniformly
      // faster or uniformly slower.
      const corner = 0.82 + 0.18 * Math.abs(Math.sin(r.t * Math.PI * 6));
      const target = MAX_SPEED * r.pace * corner;
      r.speed += THREE.MathUtils.clamp(target - r.speed, -BRAKE_RATE * dt, ACCEL_RATE * dt);

      const prev = r.t;
      r.t = (r.t + (r.speed * dt) / this.length) % 1;
      if (r.t < prev) r.lap++;

      // Drift towards their preferred line.
      r.offset += (r.line * (TRACK_HALF_WIDTH - 2) - r.offset) * Math.min(1, dt * 0.8);

      const p = this.curve.getPointAt(r.t, sc.curvePoint);
      const right = this._rightAt(r.t, sc.right);
      const { tangent } = this._frameAt(r.t);
      pos.set(p.x + right.x * r.offset, p.y + 0.55, p.z + right.z * r.offset);
      look.lookAt(new THREE.Vector3(), tangent, UP);
      q.setFromRotationMatrix(look);

      m.compose(pos, q, one);
      this.rivalBody.setMatrixAt(i, m);

      pos.addScaledVector(tangent, -2.05);
      pos.y += 0.16;
      m.compose(pos, q, one);
      this.rivalTail.setMatrixAt(i, m);
    }
    this.rivalBody.instanceMatrix.needsUpdate = true;
    this.rivalTail.instanceMatrix.needsUpdate = true;
  }

  /** 1-based finishing order, counting laps then distance around the lap. */
  _position() {
    const mine = this.lap + this.t;
    let ahead = 0;
    for (const r of this.rivals) if (r.lap + r.t > mine) ahead++;
    return ahead + 1;
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
      const place = this._finishPlace ?? 1;
      c.fillStyle = place === 1 ? PALETTE.accentGreen : PALETTE.accentBlue;
      c.font = '700 46px ui-sans-serif, system-ui, sans-serif';
      c.fillText(place === 1 ? 'WON' : `FINISHED P${place}`, 256, 40);
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

      // Position, large and on the right. In a race it is the only number that
      // matters, and it should be readable without hunting for it.
      const place = this._position();
      c.textAlign = 'right';
      c.fillStyle = place === 1 ? PALETTE.accentGreen : '#eaf6ff';
      c.font = '700 66px ui-sans-serif, system-ui, sans-serif';
      c.fillText(`P${place}`, 486, 18);
      c.font = '400 20px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = '#93b6dd';
      c.fillText(`of ${this.rivals.length + 1}`, 486, 92);
      c.textAlign = 'left';

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
    this._resetRivals();
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

    // Throttle and brakes, rate-limited rather than eased to a target. A car
    // that snaps to its target speed has no weight; one that accelerates at a
    // fixed rate and brakes harder than it accelerates feels like a car.
    const throttle = input.trigger ? 1 : 0.25;
    const target = IDLE_SPEED + (MAX_SPEED - IDLE_SPEED) * throttle + this.boost;

    if (input.brake) {
      this.speed = Math.max(IDLE_SPEED * 0.35, this.speed - BRAKE_RATE * dt);
    } else if (this.speed < target) {
      // Power falls off towards the top end, so the last 20 km/h is work.
      const headroom = 1 - Math.min(this.speed / MAX_SPEED, 1) * 0.55;
      this.speed = Math.min(target, this.speed + ACCEL_RATE * headroom * dt);
    } else {
      // Engine braking and drag.
      this.speed = Math.max(target, this.speed - 9 * dt);
    }
    // Cap the boost pool as well as its decay, so stacking gates cannot walk
    // the car past the speed the mode is designed to be readable at.
    this.boost = Math.min(this.boost, 6);
    this.boost = Math.max(0, this.boost - dt * 4);

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
        this._finishPlace = this._position();
        this._saveRun(this.lapTimes.reduce((a, b) => a + b, 0));
      }
    }

    this.audio?.setSpeed(THREE.MathUtils.clamp(this.speed / MAX_SPEED, 0, 1));

    this._updateRivals(dt);
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
      p.y + 1.05,
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
    const f = THREE.MathUtils.clamp((this.speed - IDLE_SPEED) / (MAX_SPEED - IDLE_SPEED), 0, 1);
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
    let trigger = false, grip = false, steer = 0, brake = false;
    // The wrist panel takes priority; otherwise its grip-to-open doubles as
    // this mode's grip-to-leave and you exit the moment you open settings.
    if (this.inputLocked) return { trigger: false, grip: false, steer: 0, brake: false };
    const session = this.engine.renderer.xr.getSession?.();
    if (session) {
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp) continue;
        if (gp.buttons[0]?.pressed) trigger = true;
        if (gp.buttons[1]?.pressed) grip = true;
        const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] ?? 0;
        if (Math.abs(ax) > Math.abs(steer)) steer = ax;
        // Pulling the stick back is the brake — the same gesture as easing off.
        const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] ?? 0;
        if (ay > 0.55) brake = true;
      }
    }
    if (this._keys) {
      if (this._keys.has('Space')) trigger = true;
      if (this._keys.has('Escape')) grip = true;
      if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) steer = -1;
      if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) steer = 1;
      if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) brake = true;
    }
    return { trigger, grip, brake, steer: THREE.MathUtils.clamp(steer, -1, 1) };
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
