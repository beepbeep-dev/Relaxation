import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { QUALITY } from '../core/quality.js';
import { makeRNG, range, pick } from '../core/rng.js';
import { library, neonMaterial, emissiveVertexMaterial } from './materials.js';
import { createFacadeMaterial } from './facade.js';
import { PALETTE } from './palette.js';

const BLOCK = 42;      // metres between street centrelines
const STREET = 14;     // street width

// Light pools sit just above the pavement slabs, not just above the road.
// At road height every pool near a kerb is buried under the 12cm pavement box
// and simply never appears.
const POOL_Y = 0.16;

/**
 * Kaisei's street level.
 *
 * Two rules govern everything here:
 *
 *  1. Anything repeated is an InstancedMesh, and anything static and varied is
 *     merged into one buffer. Standalone VR is draw-call bound long before it
 *     is triangle bound, so detail is only affordable if it is free of calls.
 *
 *  2. Anything that moves every frame is driven on the GPU from a time
 *     uniform, not from a JavaScript loop. Aircars and rain used to cost
 *     thousands of CPU operations and a matrix upload per frame; now they cost
 *     one uniform write each, which is what buys the headroom for the props.
 */
export class City {
  constructor(scene, glow, pools) {
    this.scene = scene;
    this.glow = glow;
    this.pools = pools;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.mats = library();
    this.rand = makeRNG(20260811);

    this.colliders = [];   // axis-aligned boxes the player cannot walk through
    this._uniformsWithTime = [];

    this._buildGround();
    this._buildTowers();
    this._buildRooftops();
    this._buildSkyline();
    this._buildSignage();
    this._buildStreetProps();
    this._buildTraffic();
    this._buildRain();
  }

  _blockX(x) { return (x - (QUALITY.cityBlocks - 1) / 2) * BLOCK; }
  _blockZ(z) { return (z - (QUALITY.cityBlocks - 1) / 2) * BLOCK; }

  // ------------------------------------------------------------------ ground

  _buildGround() {
    const size = BLOCK * (QUALITY.cityBlocks + 4);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), this.mats.wetGround);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = QUALITY.shadows;
    this.group.add(ground);

    const n = QUALITY.cityBlocks;

    // Pavements sit 12cm proud of the road so the wet reflection breaks at the
    // kerb line rather than running unbroken to the building face.
    const pave = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BLOCK - STREET + 3, 0.12, BLOCK - STREET + 3),
      this.mats.concrete,
      n * n
    );
    pave.receiveShadow = QUALITY.shadows;
    const m = new THREE.Matrix4();
    let i = 0;
    for (let x = 0; x < n; x++) {
      for (let z = 0; z < n; z++) {
        m.setPosition(this._blockX(x), 0.06, this._blockZ(z));
        pave.setMatrixAt(i++, m);
      }
    }
    pave.instanceMatrix.needsUpdate = true;
    this.group.add(pave);

    // Road markings and kerb strip lights, merged into one unlit buffer.
    const marks = [];
    const half = (n * BLOCK) / 2;
    const markGeo = () => new THREE.PlaneGeometry(1, 1);
    const push = (geo, colour) => {
      const c = new THREE.Color(colour).convertSRGBToLinear();
      const arr = new Float32Array(geo.attributes.position.count * 3);
      for (let k = 0; k < geo.attributes.position.count; k++) arr.set([c.r, c.g, c.b], k * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      geo.deleteAttribute('normal');
      geo.deleteAttribute('uv');
      marks.push(geo);
    };
    const tmp = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

    for (let a = 0; a < n; a++) {
      const lane = this._blockX(a) + BLOCK / 2;
      if (Math.abs(lane) > half) continue;
      // Dashed centre lines along both axes.
      for (let d = -half; d < half; d += 14) {
        for (const axis of [0, 1]) {
          const g = markGeo();
          const pos = axis === 0
            ? new THREE.Vector3(lane, 0.02, d + 1.5)
            : new THREE.Vector3(d + 1.5, 0.02, lane);
          const scale = axis === 0
            ? new THREE.Vector3(0.18, 2.4, 1)
            : new THREE.Vector3(2.4, 0.18, 1);
          tmp.compose(pos, q, scale);
          g.applyMatrix4(tmp);
          push(g, '#174a3d');
        }
      }
    }
    if (marks.length) {
      const merged = mergeGeometries(marks);
      const mesh = new THREE.Mesh(merged, emissiveVertexMaterial());
      mesh.frustumCulled = false;
      this.group.add(mesh);
      for (const g of marks) g.dispose();
    }
  }

  // ------------------------------------------------------------------ towers

  /**
   * Tower massing.
   *
   * Each building is composed from several stacked boxes rather than being a
   * single scaled cube: a wider podium at street level, one to three shaft
   * tiers that step back as they rise, and a narrower crown. All of them live
   * in one InstancedMesh, so a city of far more interesting silhouettes still
   * costs exactly one draw call.
   *
   * Setbacks are what make a skyline read as architecture instead of as a bar
   * chart, and they cost nothing but a few more instances.
   */
  _buildTowers() {
    const n = QUALITY.cityBlocks;
    const towers = [];
    const centreKeepout = BLOCK * 1.2;   // the plaza the player spawns into

    for (let bx = 0; bx < n; bx++) {
      for (let bz = 0; bz < n; bz++) {
        const cx = this._blockX(bx);
        const cz = this._blockZ(bz);
        if (Math.hypot(cx, cz) < centreKeepout) continue;

        const count = 2 + ((this.rand() * 3) | 0);
        const usable = BLOCK - STREET;
        for (let k = 0; k < count; k++) {
          const w = range(this.rand, 9, usable * 0.55);
          const d = range(this.rand, 9, usable * 0.55);
          const distance = Math.hypot(cx, cz);
          // Taller towards the horizon: reads as a downtown core beyond the
          // playable streets without us having to build one.
          const h = range(this.rand, 18, 40) + distance * 0.45;
          const px = cx + range(this.rand, -1, 1) * (usable / 2 - w / 2);
          const pz = cz + range(this.rand, -1, 1) * (usable / 2 - d / 2);
          towers.push({ px, pz, w, d, h, seed: this.rand() });
        }
      }
    }
    this.towers = towers;

    // --- decompose each tower into stacked boxes
    const parts = [];    // { x, y, z, w, h, d, tint }
    const caps = [];     // parapet slabs capping each tier
    const tint = new THREE.Color();

    for (const t of towers) {
      // One hue for the whole building, so its tiers read as one structure.
      tint.setHSL(range(this.rand, 0.42, 0.75), 0.5, range(this.rand, 0.55, 0.9));
      const rgb = { r: tint.r, g: tint.g, b: tint.b };

      const podiumH = Math.min(7.2, t.h * 0.28);
      parts.push({
        x: t.px, y: podiumH / 2, z: t.pz,
        w: t.w * 1.14, h: podiumH, d: t.d * 1.14, tint: rgb,
      });
      caps.push({ x: t.px, y: podiumH, z: t.pz, w: t.w * 1.2, d: t.d * 1.2 });

      // Shaft tiers, each stepping in.
      const tiers = 1 + ((this.rand() * 3) | 0);
      let base = podiumH;
      let remaining = t.h - podiumH;
      let sw = t.w;
      let sd = t.d;

      for (let i = 0; i < tiers && remaining > 3; i++) {
        const last = i === tiers - 1;
        const tierH = last ? remaining : remaining * range(this.rand, 0.4, 0.7);
        parts.push({
          x: t.px, y: base + tierH / 2, z: t.pz,
          w: sw, h: tierH, d: sd, tint: rgb,
        });
        base += tierH;
        remaining -= tierH;
        if (!last) {
          caps.push({ x: t.px, y: base, z: t.pz, w: sw * 1.06, d: sd * 1.06 });
          const step = range(this.rand, 0.72, 0.9);
          sw *= step;
          sd *= step;
        }
      }

      // Crown, on the taller buildings only.
      if (t.h > 34) {
        const crownH = range(this.rand, 2.5, 6);
        parts.push({
          x: t.px, y: base + crownH / 2, z: t.pz,
          w: sw * 0.62, h: crownH, d: sd * 0.62, tint: rgb,
        });
        base += crownH;
      }
      caps.push({ x: t.px, y: base, z: t.pz, w: sw * 1.08, d: sd * 1.08 });
      t.roof = base;
    }

    // --- one instanced mesh for every box in the city
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      createFacadeMaterial({ seedOffset: 0 }),
      parts.length
    );
    mesh.castShadow = QUALITY.shadows;
    mesh.receiveShadow = QUALITY.shadows;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(parts.length * 3), 3);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sv = new THREE.Vector3();
    const pv = new THREE.Vector3();

    parts.forEach((b, i) => {
      pv.set(b.x, b.y, b.z);
      sv.set(b.w, b.h, b.d);
      m.compose(pv, q, sv);
      mesh.setMatrixAt(i, m);
      mesh.instanceColor.setXYZ(i, b.tint.r, b.tint.g, b.tint.b);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.towerMesh = mesh;

    // --- parapets: a thin slab overhanging each tier top. Cheap, and the
    // single strongest cue that a roof has an edge rather than just stopping.
    const cap = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1), this.mats.darkMetal, caps.length
    );
    cap.castShadow = QUALITY.shadows;
    caps.forEach((c, i) => {
      pv.set(c.x, c.y + 0.22, c.z);
      sv.set(c.w, 0.44, c.d);
      m.compose(pv, q, sv);
      cap.setMatrixAt(i, m);
    });
    cap.instanceMatrix.needsUpdate = true;
    this.group.add(cap);

    // Collision uses the podium, which is the widest part at walking height.
    for (const t of towers) {
      const hw = (t.w * 1.14) / 2;
      const hd = (t.d * 1.14) / 2;
      this.colliders.push({
        minX: t.px - hw, maxX: t.px + hw,
        minZ: t.pz - hd, maxZ: t.pz + hd,
      });
    }
  }

  /**
   * Rooftop clutter — the single highest-value detail pass in the city. A flat
   * roof line reads as a programmer placeholder from any elevated viewpoint,
   * and the race track spends its entire length at roof height.
   */
  _buildRooftops() {
    const density = QUALITY.propDensity;
    const units = [];      // AC housings and water tanks
    const masts = [];      // antennas
    const beacons = [];    // aviation lights

    for (const t of this.towers) {
      if (this.rand() > 0.85 * density) continue;
      const roof = t.roof ?? t.h;
      const count = 1 + ((this.rand() * 3 * density) | 0);
      for (let k = 0; k < count; k++) {
        units.push({
          x: t.px + range(this.rand, -0.35, 0.35) * t.w,
          y: roof + 0.7,
          z: t.pz + range(this.rand, -0.35, 0.35) * t.d,
          s: range(this.rand, 0.8, 2.0),
          r: this.rand() * Math.PI,
        });
      }
      if (this.rand() < 0.5 * density) {
        masts.push({ x: t.px, y: roof, z: t.pz, h: range(this.rand, 3, 9) });
      }
      // Only the tall ones get a beacon, which is what makes height readable.
      if (t.h > 40 && this.rand() < 0.8) {
        beacons.push({ x: t.px, y: roof + 1.2, z: t.pz });
      }
    }

    if (units.length) {
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 0.8, 1), this.mats.darkMetal, units.length
      );
      mesh.castShadow = QUALITY.shadows;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      units.forEach((u, i) => {
        e.set(0, u.r, 0);
        q.setFromEuler(e);
        p.set(u.x, u.y, u.z);
        s.set(u.s, u.s * 0.7, u.s);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    }

    if (masts.length) {
      const mesh = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.06, 0.1, 1, 5), this.mats.darkMetal, masts.length
      );
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      masts.forEach((t, i) => {
        p.set(t.x, t.y + t.h / 2, t.z);
        s.set(1, t.h, 1);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    }

    for (const b of beacons) {
      this.glow.add(new THREE.Vector3(b.x, b.y, b.z), PALETTE.accentPurple, 1.4, 0.55);
    }
  }

  /**
   * A ring of distant towers beyond the playable streets, merged into a single
   * static mesh. Pure silhouette — no windows, no lighting response, just fog
   * and parallax. One draw call for the entire horizon.
   */
  _buildSkyline() {
    const rings = QUALITY.skylineRings;
    if (rings <= 0) return;

    const parts = [];
    const inner = (QUALITY.cityBlocks * BLOCK) / 2 + 40;
    const tmp = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();

    for (let ring = 0; ring < rings; ring++) {
      const radius = inner + ring * 90;
      const count = 40 + ring * 16;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + this.rand() * 0.05;
        const r = radius + range(this.rand, -30, 30);
        const h = range(this.rand, 40, 130) + ring * 18;
        const w = range(this.rand, 12, 30);
        const g = new THREE.BoxGeometry(1, 1, 1);
        p.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
        s.set(w, h, w);
        tmp.compose(p, q, s);
        g.applyMatrix4(tmp);
        g.deleteAttribute('uv');
        parts.push(g);
      }
    }

    const merged = mergeGeometries(parts);
    for (const g of parts) g.dispose();

    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.skyZenith),
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.4,
      fog: true,
    }));
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.skyline = mesh;
  }

  // ---------------------------------------------------------------- signage

  _buildSignage() {
    const signs = [];
    const n = QUALITY.cityBlocks;
    const perBlock = Math.max(1, Math.round(4 * QUALITY.propDensity));

    for (let bx = 0; bx < n; bx++) {
      for (let bz = 0; bz < n; bz++) {
        const cx = this._blockX(bx);
        const cz = this._blockZ(bz);
        if (Math.hypot(cx, cz) > BLOCK * 3.6) continue;   // only near the player
        for (let k = 0; k < perBlock; k++) {
          signs.push({
            x: cx + range(this.rand, -1, 1) * (BLOCK - STREET) / 2,
            y: range(this.rand, 3, 13),
            z: cz + range(this.rand, -1, 1) * (BLOCK - STREET) / 2,
            color: pick(this.rand, PALETTE.neon),
            w: range(this.rand, 1.0, 3.4),
            h: range(this.rand, 0.35, 1.1),
            rot: (this.rand() * 4 | 0) * Math.PI / 2,
            vertical: this.rand() < 0.3,
          });
        }
      }
    }

    // All the sign strips merge into a single mesh carrying colour in vertex
    // attributes. They are self-lit, so an unlit vertex-coloured material is
    // indistinguishable from an emissive one and costs one call for the whole
    // city instead of one per sign.
    const parts = [];
    const tmp = new THREE.Matrix4();
    const euler = new THREE.Euler();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const pos = new THREE.Vector3();

    for (const s of signs) {
      const g = new THREE.PlaneGeometry(1, 1);
      euler.set(0, s.rot, 0);
      q.setFromEuler(euler);
      pos.set(s.x, s.y, s.z);
      scale.set(s.vertical ? s.h : s.w, s.vertical ? s.w * 1.6 : s.h, 1);
      tmp.compose(pos, q, scale);
      g.applyMatrix4(tmp);

      const c = new THREE.Color(s.color).convertSRGBToLinear();
      const colors = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < g.attributes.position.count; i++) colors.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.deleteAttribute('normal');
      g.deleteAttribute('uv');
      parts.push(g);

      this.glow.add(pos, s.color, Math.max(s.w, s.h) * 2.0, 0.34);
      // The sign's spill on the wet road below it. Height drives falloff: a
      // sign 12m up throws a wide faint pool, one at 3m a tight bright one.
      this.pools?.add(
        new THREE.Vector3(s.x, POOL_Y, s.z),
        s.color,
        6 + s.y * 0.9,
        0.42 / (1 + s.y * 0.10)
      );
    }

    if (parts.length) {
      const merged = mergeGeometries(parts);
      const signMesh = new THREE.Mesh(merged, emissiveVertexMaterial());
      signMesh.frustumCulled = false;
      this.group.add(signMesh);
      for (const p of parts) p.dispose();
    }
  }

  /**
   * Street-level furniture. Everything here is instanced by type, so the whole
   * pass costs five draw calls no matter how dense it gets.
   */
  _buildStreetProps() {
    const density = QUALITY.propDensity;
    const lamps = [];
    const bollards = [];
    const planters = [];
    const vendors = [];

    const reach = BLOCK * 3.2;
    const n = QUALITY.cityBlocks;

    for (let bx = 0; bx < n; bx++) {
      for (let bz = 0; bz < n; bz++) {
        const cx = this._blockX(bx);
        const cz = this._blockZ(bz);
        if (Math.hypot(cx, cz) > reach) continue;
        const edge = (BLOCK - STREET) / 2 + 1.4;

        // Lamps at block corners, along the kerb.
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          if (this.rand() > 0.8 * density) continue;
          lamps.push({ x: cx + sx * edge, z: cz + sz * edge });
        }
        for (let k = 0; k < Math.round(4 * density); k++) {
          bollards.push({
            x: cx + range(this.rand, -1, 1) * edge,
            z: cz + (this.rand() < 0.5 ? -1 : 1) * edge,
          });
        }
        if (this.rand() < 0.7 * density) {
          planters.push({
            x: cx + range(this.rand, -1, 1) * edge * 0.8,
            z: cz + (this.rand() < 0.5 ? -1 : 1) * edge,
            s: range(this.rand, 0.8, 1.3),
          });
        }
        if (this.rand() < 0.45 * density) {
          vendors.push({
            x: cx + range(this.rand, -0.7, 0.7) * edge,
            z: cz + (this.rand() < 0.5 ? -1 : 1) * edge,
            r: (this.rand() * 4 | 0) * Math.PI / 2,
            color: pick(this.rand, PALETTE.neon),
          });
        }
      }
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();

    if (lamps.length) {
      const post = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.08, 0.11, 5.2, 6), this.mats.darkMetal, lamps.length
      );
      post.castShadow = QUALITY.shadows;
      lamps.forEach((l, i) => {
        m.identity().setPosition(l.x, 2.6, l.z);
        post.setMatrixAt(i, m);
        this.glow.add(new THREE.Vector3(l.x, 5.3, l.z), PALETTE.accentBlue, 1.7, 0.5);
      this.pools?.add(new THREE.Vector3(l.x, POOL_Y, l.z), PALETTE.accentBlue, 11.0, 0.26);
      });
      post.instanceMatrix.needsUpdate = true;
      this.group.add(post);

      // The lamp head itself, so the glow has a visible source.
      const head = new THREE.InstancedMesh(
        new THREE.SphereGeometry(0.17, 8, 6), neonMaterial(PALETTE.accentBlue, 3.2), lamps.length
      );
      lamps.forEach((l, i) => {
        m.identity().setPosition(l.x, 5.3, l.z);
        head.setMatrixAt(i, m);
      });
      head.instanceMatrix.needsUpdate = true;
      this.group.add(head);
    }

    if (bollards.length) {
      const mesh = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.1, 0.12, 0.9, 6), this.mats.darkMetal, bollards.length
      );
      bollards.forEach((b, i) => {
        m.identity().setPosition(b.x, 0.51, b.z);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);

      // A lit ring near the base of each — low green marker lights along the
      // kerb, which is what gives the street its depth cue at ankle height.
      const ring = new THREE.InstancedMesh(
        new THREE.TorusGeometry(0.13, 0.02, 4, 10), neonMaterial(PALETTE.accentGreen, 2.6), bollards.length
      );
      e.set(-Math.PI / 2, 0, 0);
      q.setFromEuler(e);
      s.set(1, 1, 1);
      bollards.forEach((b, i) => {
        p.set(b.x, 0.86, b.z);
        m.compose(p, q, s);
        ring.setMatrixAt(i, m);
      });
      ring.instanceMatrix.needsUpdate = true;
      this.group.add(ring);
    }

    if (planters.length) {
      const box = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.4, 0.5, 1.4), this.mats.concrete, planters.length
      );
      const bush = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(0.55, 0), this.mats.foliage, planters.length
      );
      box.castShadow = bush.castShadow = QUALITY.shadows;
      planters.forEach((pl, i) => {
        q.identity();
        p.set(pl.x, 0.31, pl.z);
        s.set(pl.s, 1, pl.s);
        m.compose(p, q, s);
        box.setMatrixAt(i, m);
        p.set(pl.x, 0.75, pl.z);
        s.set(pl.s, pl.s * 0.8, pl.s);
        m.compose(p, q, s);
        bush.setMatrixAt(i, m);
      });
      box.instanceMatrix.needsUpdate = true;
      bush.instanceMatrix.needsUpdate = true;
      this.group.add(box, bush);
    }

    if (vendors.length) {
      // Vending machines: a dark shell with a bright face, which at street
      // level is one of the strongest reads that a city is inhabited.
      const shell = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.0, 1.9, 0.7), this.mats.darkMetal, vendors.length
      );
      shell.castShadow = QUALITY.shadows;
      const face = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.8, 1.4),
        new THREE.MeshBasicMaterial({ toneMapped: true, side: THREE.DoubleSide }),
        vendors.length
      );
      face.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(vendors.length * 3), 3);
      const c = new THREE.Color();

      vendors.forEach((v, i) => {
        e.set(0, v.r, 0);
        q.setFromEuler(e);
        s.set(1, 1, 1);
        p.set(v.x, 0.95, v.z);
        m.compose(p, q, s);
        shell.setMatrixAt(i, m);

        p.set(v.x + Math.sin(v.r) * 0.36, 1.05, v.z + Math.cos(v.r) * 0.36);
        m.compose(p, q, s);
        face.setMatrixAt(i, m);

        c.set(v.color).convertSRGBToLinear().multiplyScalar(1.7);
        face.setColorAt(i, c);

        this.glow.add(new THREE.Vector3(v.x, 1.2, v.z), v.color, 1.6, 0.3);
        this.pools?.add(new THREE.Vector3(v.x, POOL_Y, v.z), v.color, 5.5, 0.3);
      });
      shell.instanceMatrix.needsUpdate = true;
      face.instanceMatrix.needsUpdate = true;
      face.instanceColor.needsUpdate = true;
      this.group.add(shell, face);
    }
  }

  // ------------------------------------------------------- GPU-driven motion

  /**
   * Aircars. Position is computed in the vertex shader from a time uniform and
   * per-instance lane data, so the CPU cost per frame is a single float write
   * regardless of how many there are.
   */
  _buildTraffic() {
    const count = QUALITY.trafficCount;
    if (count <= 0) return;

    const limit = BLOCK * QUALITY.cityBlocks * 0.6;
    const src = new THREE.BoxGeometry(2.8, 0.4, 1.1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index;
    geo.setAttribute('position', src.attributes.position);
    geo.setAttribute('normal', src.attributes.normal);
    geo.instanceCount = count;

    const lane = new Float32Array(count);
    const height = new Float32Array(count);
    const speed = new Float32Array(count);
    const phase = new Float32Array(count);
    const axis = new Float32Array(count);
    const tint = new Float32Array(count * 3);
    const c = new THREE.Color();

    for (let i = 0; i < count; i++) {
      lane[i] = range(this.rand, -1, 1) * limit;
      height[i] = range(this.rand, 16, 52);
      speed[i] = range(this.rand, 14, 32) * (this.rand() > 0.5 ? 1 : -1);
      phase[i] = this.rand();
      axis[i] = this.rand() > 0.5 ? 1 : 0;
      c.set(this.rand() > 0.5 ? PALETTE.accentBlue : PALETTE.accentPurple)
        .convertSRGBToLinear().multiplyScalar(2.2);
      tint.set([c.r, c.g, c.b], i * 3);
    }

    geo.setAttribute('aLane', new THREE.InstancedBufferAttribute(lane, 1));
    geo.setAttribute('aHeight', new THREE.InstancedBufferAttribute(height, 1));
    geo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speed, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aAxis', new THREE.InstancedBufferAttribute(axis, 1));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));

    const uniforms = {
      uTime: { value: 0 },
      uLimit: { value: limit },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        attribute float aLane;
        attribute float aHeight;
        attribute float aSpeed;
        attribute float aPhase;
        attribute float aAxis;
        attribute vec3 aTint;

        uniform float uTime;
        uniform float uLimit;

        varying vec3 vTint;

        void main() {
          vTint = aTint;

          // Wrap into [-limit, limit] entirely on the GPU.
          float span = uLimit * 2.0;
          float t = mod(aPhase * span + uTime * aSpeed + uLimit, span) - uLimit;

          // Swap the local x and z axes for cars travelling the other way,
          // which rotates the body 90 degrees without a matrix.
          vec3 local = mix(position, vec3(position.z, position.y, position.x), aAxis);
          vec3 centre = mix(vec3(t, aHeight, aLane), vec3(aLane, aHeight, t), aAxis);

          vec4 mv = modelViewMatrix * vec4(centre + local, 1.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vTint;
        void main() {
          gl_FragColor = vec4(vTint, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.traffic = mesh;
    this._uniformsWithTime.push(uniforms);
  }

  /**
   * Rain. Also GPU-driven: the fall is `mod(time)` in the vertex shader and
   * the whole column is parented to a group that follows the head, so the CPU
   * writes one uniform and one position per frame instead of touching every
   * drop.
   */
  _buildRain() {
    const count = Math.round(4500 * QUALITY.rainDensity);
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      seeds[i * 3 + 0] = Math.random();          // x
      seeds[i * 3 + 1] = Math.random();          // phase
      seeds[i * 3 + 2] = Math.random();          // z
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3));

    const uniforms = {
      uTime: { value: 0 },
      uSpread: { value: 26 },
      uHeight: { value: 20 },
      uColor: { value: new THREE.Color('#a8d8ff').convertSRGBToLinear() },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSpread;
        uniform float uHeight;
        varying float vFade;

        void main() {
          float x = (position.x - 0.5) * uSpread;
          float z = (position.z - 0.5) * uSpread;
          float speed = 9.0 + position.y * 9.0;
          float y = uHeight - mod(uTime * speed + position.y * uHeight, uHeight);

          vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
          gl_Position = projectionMatrix * mv;
          // Clamped hard. An unbounded 1/z point size turns nearby drops into
          // screen-filling squares, which is what rain looked like before.
          gl_PointSize = clamp(46.0 / max(-mv.z, 0.5), 1.0, 7.0);
          // Fade the top of the column so drops appear rather than pop in.
          vFade = smoothstep(uHeight, uHeight * 0.72, y);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          // Shape the point into a soft vertical streak. A bare point sprite
          // is a hard-edged square, which at any visible size reads as debris
          // rather than as rain.
          vec2 pc = gl_PointCoord - 0.5;
          float streak = smoothstep(0.5, 0.05, abs(pc.x) * 3.2)
                       * smoothstep(0.55, 0.15, abs(pc.y));
          float a = streak * vFade * 0.5;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.rain = new THREE.Points(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.visible = QUALITY.rain;
    this.group.add(this.rain);
    this._uniformsWithTime.push(uniforms);
  }

  setRain(on) {
    if (this.rain) this.rain.visible = on;
  }

  /**
   * Per-frame cost of the entire city: two uniform writes and one position
   * copy. Everything else is static or driven on the GPU. Note the complete
   * absence of allocation here — a `new THREE.Matrix4()` in an update path is
   * garbage at 90Hz, and mobile GC pauses are visible as hitches in a headset.
   */
  update(dt, ctx) {
    const t = ctx.elapsed;
    for (const u of this._uniformsWithTime) u.uTime.value = t;

    if (this.rain.visible) {
      const head = ctx.engine.headPosition();
      this.rain.position.set(head.x, 0, head.z);
    }
  }
}

export { BLOCK, STREET };
