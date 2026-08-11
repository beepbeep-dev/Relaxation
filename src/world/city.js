import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { QUALITY } from '../core/quality.js';
import { makeRNG, range, pick } from '../core/rng.js';
import { library, neonMaterial } from './materials.js';

const BLOCK = 42;      // metres between street centrelines
const STREET = 14;     // street width
const NEON = ['#ff4d6d', '#48d6ff', '#ffb03a', '#b98cff', '#3dffa8'];

/**
 * Kaisei's street level.
 *
 * Everything repeated is an InstancedMesh. The whole city is roughly 20 draw
 * calls, which is what makes it viable on a standalone headset — on a
 * tile-based GPU the draw call count matters far more than the triangles.
 */
export class City {
  constructor(scene, glow) {
    this.scene = scene;
    this.glow = glow;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.mats = library();
    this.rand = makeRNG(20260811);

    this.colliders = [];   // axis-aligned boxes the player cannot walk through
    this._traffic = [];

    this._buildGround();
    this._buildTowers();
    this._buildStreetFurniture();
    this._buildTraffic();
    this._buildRain();
  }

  _buildGround() {
    const size = BLOCK * (QUALITY.cityBlocks + 4);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), this.mats.wetGround);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = QUALITY.shadows;
    this.group.add(ground);

    // Pavements sit 12cm proud of the road so the wet reflection breaks at the
    // kerb line rather than running unbroken to the building face.
    const n = QUALITY.cityBlocks;
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
  }

  _blockX(x) { return (x - (QUALITY.cityBlocks - 1) / 2) * BLOCK; }
  _blockZ(z) { return (z - (QUALITY.cityBlocks - 1) / 2) * BLOCK; }

  _buildTowers() {
    const n = QUALITY.cityBlocks;
    const towers = [];
    const centreKeepout = BLOCK * 1.2;   // the plaza the player spawns into

    for (let bx = 0; bx < n; bx++) {
      for (let bz = 0; bz < n; bz++) {
        const cx = this._blockX(bx);
        const cz = this._blockZ(bz);
        if (Math.hypot(cx, cz) < centreKeepout) continue;

        // Two to four towers per block, offset within the block footprint.
        const count = 2 + ((this.rand() * 3) | 0);
        const usable = BLOCK - STREET;
        for (let k = 0; k < count; k++) {
          const w = range(this.rand, 8, usable * 0.55);
          const d = range(this.rand, 8, usable * 0.55);
          const distance = Math.hypot(cx, cz);
          // Taller towards the horizon: reads as a downtown core beyond the
          // playable streets without us having to build one.
          const h = range(this.rand, 14, 34) + distance * 0.42;
          const px = cx + range(this.rand, -1, 1) * (usable / 2 - w / 2);
          const pz = cz + range(this.rand, -1, 1) * (usable / 2 - d / 2);
          towers.push({ px, pz, w, d, h });
        }
      }
    }

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = this.mats.concrete.clone();
    mat.emissive = new THREE.Color('#ffffff');
    mat.emissiveMap = this.mats.facade;
    mat.emissiveIntensity = 1.25;

    // Redirect the per-instance colour from diffuse onto emissive. Out of the
    // box `instanceColor` multiplies the base colour, which here would just
    // stain the concrete; what we actually want to vary per building is the
    // colour of its lit windows, so each tower reads as its own block of
    // tenants rather than a copy of the facade texture.
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', '')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;'
        );
    };
    mat.customProgramCacheKey = () => 'tower-emissive-tint';

    const mesh = new THREE.InstancedMesh(geo, mat, towers.length);
    mesh.castShadow = QUALITY.shadows;
    mesh.receiveShadow = QUALITY.shadows;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(towers.length * 3), 3);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const tint = new THREE.Color();

    towers.forEach((t, i) => {
      p.set(t.px, t.h / 2, t.pz);
      s.set(t.w, t.h, t.d);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);

      // Per-instance tint biases each tower's lit windows warm or cool, so the
      // shared facade texture does not read as a repeat.
      tint.setHSL(range(this.rand, 0.03, 0.11), 0.45, range(this.rand, 0.5, 0.85));
      mesh.setColorAt(i, tint);

      this.colliders.push({
        minX: t.px - t.w / 2, maxX: t.px + t.w / 2,
        minZ: t.pz - t.d / 2, maxZ: t.pz + t.d / 2,
      });
    });

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this.towers = towers;
  }

  _buildStreetFurniture() {
    const signs = [];
    const n = QUALITY.cityBlocks;

    for (let bx = 0; bx < n; bx++) {
      for (let bz = 0; bz < n; bz++) {
        const cx = this._blockX(bx);
        const cz = this._blockZ(bz);
        if (Math.hypot(cx, cz) > BLOCK * 3.2) continue;   // only near the player
        for (let k = 0; k < 3; k++) {
          signs.push({
            x: cx + range(this.rand, -1, 1) * (BLOCK - STREET) / 2,
            y: range(this.rand, 3, 11),
            z: cz + range(this.rand, -1, 1) * (BLOCK - STREET) / 2,
            color: pick(this.rand, NEON),
            w: range(this.rand, 1.2, 3.4),
            h: range(this.rand, 0.4, 1.1),
            rot: (this.rand() * 4 | 0) * Math.PI / 2,
          });
        }
      }
    }

    // All the sign strips merge into a single mesh carrying its colours in
    // vertex attributes. They are self-lit, so an unlit material with vertex
    // colours is indistinguishable from an emissive one and costs one call for
    // the whole city instead of one per sign.
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
      scale.set(s.w, s.h, 1);
      tmp.compose(pos, q, scale);
      g.applyMatrix4(tmp);

      const c = new THREE.Color(s.color).convertSRGBToLinear();
      const colors = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < g.attributes.position.count; i++) {
        colors.set([c.r, c.g, c.b], i * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.deleteAttribute('normal');
      g.deleteAttribute('uv');
      parts.push(g);

      this.glow.add(pos, s.color, Math.max(s.w, s.h) * 2.0, 0.34);
    }

    if (parts.length) {
      const merged = mergeGeometries(parts);
      const signMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        toneMapped: true,
        fog: true,
      }));
      signMesh.frustumCulled = false;
      this.group.add(signMesh);
      for (const p of parts) p.dispose();
    }

    // Street lamps: geometry is instanced, the bulbs go into the glow field.
    const lampCount = 40;
    const post = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.09, 0.12, 5.2, 6),
      this.mats.darkMetal,
      lampCount
    );
    post.castShadow = QUALITY.shadows;
    const m = new THREE.Matrix4();
    for (let i = 0; i < lampCount; i++) {
      const ring = 1 + ((i / 10) | 0);
      const a = (i % 10) / 10 * Math.PI * 2;
      const r = ring * BLOCK * 0.72;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      m.setPosition(x, 2.6, z);
      post.setMatrixAt(i, m);
      this.glow.add(new THREE.Vector3(x, 5.3, z), '#ffd9a0', 1.7, 0.5);
    }
    post.instanceMatrix.needsUpdate = true;
    this.group.add(post);
  }

  _buildTraffic() {
    // Aircars on fixed altitude lanes. Pure set dressing, but motion at the
    // edge of vision is most of what makes a city feel inhabited.
    const count = QUALITY.trafficCount;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.6, 0.5, 1.1),
      neonMaterial('#ffd0a0', 2.2),
      count
    );
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.trafficMesh = mesh;

    for (let i = 0; i < count; i++) {
      this._traffic.push({
        axis: this.rand() > 0.5 ? 'x' : 'z',
        lane: range(this.rand, -1, 1) * BLOCK * (QUALITY.cityBlocks / 2 - 1),
        t: range(this.rand, -260, 260),
        y: range(this.rand, 16, 46),
        speed: range(this.rand, 14, 30) * (this.rand() > 0.5 ? 1 : -1),
      });
    }
  }

  _buildRain() {
    // A single Points cloud that follows the player. The column is only 26m
    // across, so 4000 drops read as heavy rain everywhere the player looks.
    const count = QUALITY.shadows ? 4000 : 1500;
    const pos = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3 + 0] = (Math.random() - 0.5) * 26;
      pos[i * 3 + 1] = Math.random() * 18;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 26;
      speed[i] = 9 + Math.random() * 9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));

    const mat = new THREE.PointsMaterial({
      color: new THREE.Color('#9fc4ff'),
      size: 0.035,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });

    this.rain = new THREE.Points(geo, mat);
    this.rain.frustumCulled = false;
    this.group.add(this.rain);
  }

  setRain(on) {
    this.rain.visible = on;
  }

  update(dt, ctx) {
    // Traffic
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const limit = BLOCK * QUALITY.cityBlocks * 0.6;

    for (let i = 0; i < this._traffic.length; i++) {
      const c = this._traffic[i];
      c.t += c.speed * dt;
      if (c.t > limit) c.t = -limit;
      if (c.t < -limit) c.t = limit;

      if (c.axis === 'x') {
        p.set(c.t, c.y, c.lane);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
      } else {
        p.set(c.lane, c.y, c.t);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      }
      m.compose(p, q, s);
      this.trafficMesh.setMatrixAt(i, m);
    }
    this.trafficMesh.instanceMatrix.needsUpdate = true;

    // Rain follows the head and recycles vertically.
    if (this.rain.visible) {
      const head = ctx.engine.headPosition();
      this.rain.position.set(head.x, 0, head.z);
      const arr = this.rain.geometry.attributes.position.array;
      const spd = this.rain.geometry.attributes.aSpeed.array;
      for (let i = 0; i < spd.length; i++) {
        arr[i * 3 + 1] -= spd[i] * dt;
        if (arr[i * 3 + 1] < 0) {
          arr[i * 3 + 1] = 18;
          arr[i * 3 + 0] = (Math.random() - 0.5) * 26;
          arr[i * 3 + 2] = (Math.random() - 0.5) * 26;
        }
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
  }
}

export { BLOCK, STREET };
