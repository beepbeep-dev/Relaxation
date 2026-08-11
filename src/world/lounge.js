import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { library, neonMaterial } from './materials.js';
import { PALETTE } from './palette.js';
import { makeRNG, range } from '../core/rng.js';

const DECK_Y = 6.0;
const DECK_W = 26;
const DECK_D = 20;
const DECK_Z = -30;

/**
 * THE LANTERN — the chill-out space.
 *
 * Design rules this scene holds to, from the design doc: no games, no
 * scoring, no prompts, and a long uninterrupted sightline over the city.
 * The only interaction is sitting down and the only event is the weather.
 */
export class Lounge {
  constructor(scene, glow) {
    this.scene = scene;
    this.glow = glow;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mats = library();
    this.rand = makeRNG(4242);

    this.platforms = [];
    this.ramps = [];
    this.colliders = [];
    this.seats = [];
    this._lanterns = [];

    this._buildDeck();
    this._buildRamp();
    this._buildPavilion();
    this._buildSeating();
    this._buildPool();
    this._buildLanterns();
    this._buildDetails();

    // Hoisted out of update(): allocating a matrix per frame is garbage at
    // 90Hz, and mobile GC pauses read as hitches in a headset.
    this._m = new THREE.Matrix4();
  }

  _buildDeck() {
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(DECK_W, 0.6, DECK_D),
      this.mats.deckWood
    );
    deck.position.set(0, DECK_Y - 0.3, DECK_Z);
    deck.receiveShadow = QUALITY.shadows;
    deck.castShadow = QUALITY.shadows;
    this.group.add(deck);

    this.platforms.push({
      minX: -DECK_W / 2, maxX: DECK_W / 2,
      minZ: DECK_Z - DECK_D / 2, maxZ: DECK_Z + DECK_D / 2,
      y: DECK_Y,
    });

    // Support columns.
    const col = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.34, 0.4, DECK_Y, 8),
      this.mats.darkMetal,
      6
    );
    col.castShadow = QUALITY.shadows;
    const m = new THREE.Matrix4();
    let i = 0;
    for (const x of [-DECK_W / 2 + 2, 0, DECK_W / 2 - 2]) {
      for (const z of [DECK_Z - DECK_D / 2 + 2, DECK_Z + DECK_D / 2 - 2]) {
        m.setPosition(x, DECK_Y / 2, z);
        col.setMatrixAt(i++, m);
      }
    }
    col.instanceMatrix.needsUpdate = true;
    this.group.add(col);

    // Railing on the three open edges. Deliberately low and thin — this deck
    // is about the view, and a heavy balustrade would cut the skyline exactly
    // at seated eye height.
    const railMat = this.mats.darkMetal;
    const rail = (w, d, x, z) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), railMat);
      r.position.set(x, DECK_Y + 1.0, z);
      this.group.add(r);
      const posts = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.06, 1.0, 0.06), railMat, 12
      );
      const mm = new THREE.Matrix4();
      for (let k = 0; k < 12; k++) {
        const t = (k / 11 - 0.5);
        mm.setPosition(x + t * (w - 0.2), DECK_Y + 0.5, z + t * (d - 0.2));
        posts.setMatrixAt(k, mm);
      }
      posts.instanceMatrix.needsUpdate = true;
      this.group.add(posts);
    };
    rail(DECK_W, 0.08, 0, DECK_Z - DECK_D / 2);
    rail(0.08, DECK_D, -DECK_W / 2, DECK_Z);
    rail(0.08, DECK_D, DECK_W / 2, DECK_Z);
  }

  _buildRamp() {
    // A ramp rather than stairs: stair stepping in VR either needs stair
    // collision we do not want to write, or it dry-heaves the player up in
    // discrete jolts. A 14-degree ramp is comfortable and readable.
    const len = 24;
    const startZ = DECK_Z + DECK_D / 2;
    const endZ = startZ + len;
    const angle = Math.atan2(DECK_Y, len);

    const ramp = new THREE.Mesh(
      new THREE.BoxGeometry(5, 0.4, Math.hypot(len, DECK_Y)),
      this.mats.concrete
    );
    ramp.position.set(0, DECK_Y / 2, (startZ + endZ) / 2);
    // Positive, not negative: a rotation of +angle about X sends the local +z
    // axis downwards, which is what carries the deck end down to the street.
    // Negated, the slab tilts the other way and hangs over the plaza — and it
    // silently disagrees with yAt() below, so the player walks on a surface
    // that is nowhere near the visible ramp.
    ramp.rotation.x = angle;
    ramp.receiveShadow = QUALITY.shadows;
    this.group.add(ramp);

    this.ramps.push({
      minX: -2.5, maxX: 2.5,
      minZ: startZ, maxZ: endZ,
      yAt: (z) => THREE.MathUtils.lerp(DECK_Y, 0, (z - startZ) / len),
    });

    // Edge lighting so the ramp reads as walkable without a HUD marker.
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const z = THREE.MathUtils.lerp(startZ, endZ, t);
      const y = THREE.MathUtils.lerp(DECK_Y, 0, t) + 0.25;
      for (const x of [-2.6, 2.6]) {
        this.glow.add(new THREE.Vector3(x, y, z), PALETTE.accentGreen, 0.55, 0.4);
      }
    }
  }

  _buildPavilion() {
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.25, 10),
      this.mats.deckWood
    );
    roof.position.set(0, DECK_Y + 3.4, DECK_Z - 3);
    roof.castShadow = QUALITY.shadows;
    this.group.add(roof);

    const beams = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.18, 3.4, 0.18), this.mats.deckWood, 4
    );
    const m = new THREE.Matrix4();
    let i = 0;
    for (const x of [-6.6, 6.6]) {
      for (const z of [DECK_Z - 7.6, DECK_Z + 1.6]) {
        m.setPosition(x, DECK_Y + 1.7, z);
        beams.setMatrixAt(i++, m);
      }
    }
    beams.instanceMatrix.needsUpdate = true;
    this.group.add(beams);

    // Paper-lantern strand along the roof edge.
    const strand = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.16, 8, 6),
      neonMaterial(PALETTE.lantern, 2.6),
      14
    );
    const mm = new THREE.Matrix4();
    for (let k = 0; k < 14; k++) {
      const t = k / 13;
      const x = THREE.MathUtils.lerp(-6.8, 6.8, t);
      const sag = Math.sin(t * Math.PI) * 0.35;
      mm.setPosition(x, DECK_Y + 3.1 - sag, DECK_Z + 1.9);
      strand.setMatrixAt(k, mm);

      const handle = this.glow.add(
        new THREE.Vector3(x, DECK_Y + 3.1 - sag, DECK_Z + 1.9), PALETTE.lantern, 0.7, 0.5
      );
      this._lanterns.push({ handle, phase: this.rand() * Math.PI * 2 });
    }
    strand.instanceMatrix.needsUpdate = true;
    this.group.add(strand);
  }

  _buildSeating() {
    const cushionMat = this.mats.cushion;

    const spots = [
      [-4.5, DECK_Z - 5.5, 0.4],
      [-1.5, DECK_Z - 6.0, 0.1],
      [1.8, DECK_Z - 5.6, -0.3],
      [4.6, DECK_Z - 4.8, -0.6],
      [-5.2, DECK_Z + 1.0, 1.9],
      [5.0, DECK_Z + 1.4, -1.9],
    ];

    for (const [x, z, rot] of spots) {
      const cushion = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.22, 1.1), cushionMat);
      cushion.position.set(x, DECK_Y + 0.11, z);
      cushion.rotation.y = rot;
      cushion.castShadow = QUALITY.shadows;
      cushion.receiveShadow = QUALITY.shadows;
      this.group.add(cushion);

      // Seats are recorded so locomotion can offer a sit — the only
      // interaction in the entire space.
      this.seats.push({ x, y: DECK_Y + 0.22, z, rot });
    }

    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.75, 0.36, 16), this.mats.deckWood);
    table.position.set(0, DECK_Y + 0.18, DECK_Z - 5.2);
    table.castShadow = QUALITY.shadows;
    this.group.add(table);

    // Tea, steaming. Not interactive yet — it is here because an empty table
    // reads as an unfinished level and an occupied one reads as a place.
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.045, 0.08, 10),
      new THREE.MeshStandardMaterial({ color: new THREE.Color('#dfe8ea'), roughness: 0.5 })
    );
    cup.position.set(0.22, DECK_Y + 0.4, DECK_Z - 5.05);
    this.group.add(cup);
  }

  _buildPool() {
    // Shallow reflecting pool. The env map plus near-zero roughness makes it
    // mirror the skyline, which is most of this deck's character.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 3.2, 24, 12),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#071824'),
        roughness: 0.04,
        metalness: 0.95,
        envMapIntensity: 2.2,
      })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, DECK_Y + 0.06, DECK_Z + 4.2);
    this.group.add(water);
    this.water = water;
    this._waterBase = water.geometry.attributes.position.array.slice();

    const kerb = new THREE.Mesh(
      new THREE.BoxGeometry(6.6, 0.18, 3.8),
      this.mats.concrete
    );
    kerb.position.set(0, DECK_Y + 0.02, DECK_Z + 4.2);
    this.group.add(kerb);
  }

  _buildLanterns() {
    // Free-floating lanterns drifting up past the deck. Slow, silent, and the
    // main reason to look up here.
    const count = 18;
    this.floaters = [];
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.22, 8, 6),
      neonMaterial(PALETTE.lanternDrift, 2.4),
      count
    );
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.floaterMesh = mesh;

    for (let i = 0; i < count; i++) {
      this.floaters.push({
        x: range(this.rand, -30, 30),
        y: range(this.rand, 2, 46),
        z: DECK_Z + range(this.rand, -26, 18),
        speed: range(this.rand, 0.5, 1.3),
        phase: range(this.rand, 0, Math.PI * 2),
      });
    }
  }

  /**
   * Small-object pass. None of this is interactive, and that is the point:
   * an empty deck reads as an unfinished level, an occupied one reads as a
   * place somebody left five minutes ago.
   */
  _buildDetails() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();

    // A rug under the seating group, to stop the deck reading as bare boards.
    const rug = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 6),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color('#241b3d'), roughness: 0.95, metalness: 0,
      })
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, DECK_Y + 0.02, DECK_Z - 5.2);
    rug.receiveShadow = QUALITY.shadows;
    this.group.add(rug);

    // Planters along the deck edges — instanced pot plus instanced foliage.
    const spots = [
      [-11.4, DECK_Z - 8.4], [11.4, DECK_Z - 8.4],
      [-11.4, DECK_Z + 7.6], [11.4, DECK_Z + 7.6],
      [-7.5, DECK_Z + 8.2], [7.5, DECK_Z + 8.2],
    ];
    const pot = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.42, 0.32, 0.55, 8), this.mats.concrete, spots.length
    );
    const leaves = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.55, 0), this.mats.foliage, spots.length
    );
    pot.castShadow = leaves.castShadow = QUALITY.shadows;
    spots.forEach(([x, z], i) => {
      q.identity();
      s.set(1, 1, 1);
      p.set(x, DECK_Y + 0.28, z);
      m.compose(p, q, s);
      pot.setMatrixAt(i, m);
      p.set(x, DECK_Y + 0.85, z);
      s.set(1, 0.85 + (i % 3) * 0.12, 1);
      m.compose(p, q, s);
      leaves.setMatrixAt(i, m);
    });
    pot.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    this.group.add(pot, leaves);

    // Books and a cup left on the low table.
    const bookMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#4a3b7a'), roughness: 0.8, metalness: 0,
    });
    const books = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 0.04, 0.17), bookMat, 3);
    for (let i = 0; i < 3; i++) {
      e.set(0, 0.3 * i, 0);
      q.setFromEuler(e);
      p.set(-0.26 + i * 0.01, DECK_Y + 0.38 + i * 0.045, DECK_Z - 5.3);
      s.set(1, 1, 1);
      m.compose(p, q, s);
      books.setMatrixAt(i, m);
    }
    books.instanceMatrix.needsUpdate = true;
    this.group.add(books);

    // A second lantern strand across the rear opening, hung lower.
    const strand = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.13, 8, 6), neonMaterial(PALETTE.accentBlue, 2.2), 10
    );
    for (let k = 0; k < 10; k++) {
      const t = k / 9;
      const x = THREE.MathUtils.lerp(-6.0, 6.0, t);
      const sag = Math.sin(t * Math.PI) * 0.5;
      const y = DECK_Y + 2.7 - sag;
      m.identity().setPosition(x, y, DECK_Z - 7.4);
      strand.setMatrixAt(k, m);
      this.glow.add(new THREE.Vector3(x, y, DECK_Z - 7.4), PALETTE.accentBlue, 0.6, 0.42);
    }
    strand.instanceMatrix.needsUpdate = true;
    this.group.add(strand);

    // Underside strip lighting, so the deck reads as a lit object from the
    // plaza below rather than as a dark slab hanging in the air.
    for (let i = 0; i <= 8; i++) {
      const x = THREE.MathUtils.lerp(-DECK_W / 2 + 1, DECK_W / 2 - 1, i / 8);
      this.glow.add(
        new THREE.Vector3(x, DECK_Y - 0.7, DECK_Z + DECK_D / 2 - 0.4),
        PALETTE.accentPurple, 1.1, 0.35
      );
    }
  }

  update(dt, ctx) {
    const t = ctx.elapsed;

    // Lantern flicker — small amplitude, irregular period.
    for (const l of this._lanterns) {
      l.handle.opacity =
        0.55 + Math.sin(t * 2.1 + l.phase) * 0.05 + Math.sin(t * 7.3 + l.phase) * 0.03;
    }

    // Pool ripple.
    const pos = this.water.geometry.attributes.position;
    const base = this._waterBase;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3];
      const y = base[i * 3 + 1];
      pos.array[i * 3 + 2] =
        Math.sin(x * 1.6 + t * 1.1) * 0.012 + Math.cos(y * 2.2 + t * 0.8) * 0.012;
    }
    pos.needsUpdate = true;

    // Drifting lanterns.
    const m = this._m;
    for (let i = 0; i < this.floaters.length; i++) {
      const f = this.floaters[i];
      f.y += f.speed * dt;
      if (f.y > 52) f.y = -2;
      m.setPosition(
        f.x + Math.sin(t * 0.4 + f.phase) * 0.8,
        f.y,
        f.z + Math.cos(t * 0.3 + f.phase) * 0.8
      );
      this.floaterMesh.setMatrixAt(i, m);
    }
    this.floaterMesh.instanceMatrix.needsUpdate = true;
  }
}

export { DECK_Y, DECK_Z, DECK_W, DECK_D };
