import * as THREE from 'three';
import { library, neonMaterial } from './materials.js';
import { PALETTE } from './palette.js';

/**
 * The launch pad in the plaza — how NEON LINE is entered.
 *
 * Diegetic entry, per the design pillars: no menu, no prompt panel. You walk
 * onto a lit pad and the ring above it spins up. Pulling the trigger while
 * standing on it launches you.
 */
export class RacePad {
  constructor(scene, glow, position = new THREE.Vector3(0, 0, 16)) {
    this.glow = glow;
    this.position = position.clone();
    this.radius = 3.2;
    this.armed = false;

    const mats = library();
    this.group = new THREE.Group();
    this.group.position.copy(this.position);
    scene.add(this.group);

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(this.radius, this.radius, 0.18, 32),
      mats.darkMetal
    );
    disc.position.y = 0.09;
    this.group.add(disc);

    this.ringMat = neonMaterial(PALETTE.accentGreen, 2.4);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(this.radius - 0.25, 0.09, 6, 40),
      this.ringMat
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;
    this.group.add(ring);

    // Floating arc that spins up when the player steps on.
    this.arc = new THREE.Mesh(
      new THREE.TorusGeometry(1.9, 0.07, 6, 32, Math.PI * 1.35),
      neonMaterial(PALETTE.accentBlue, 3.0)
    );
    this.arc.position.y = 2.6;
    this.arc.rotation.x = Math.PI / 2;
    this.group.add(this.arc);

    this.halo = glow.add(
      this.position.clone().setY(1.2), PALETTE.accentGreen, 7, 0.22
    );
    this._haloOpacity = 0.22;

    this.label = this._makeLabel('NEON LINE');
    this.label.position.set(0, 3.6, 0);
    this.group.add(this.label);
  }

  _makeLabel(text) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = PALETTE.accentGreen;
    ctx.font = '600 64px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '14px';
    ctx.fillText(text, 256, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, toneMapped: false, fog: false, depthWrite: false,
    }));
    sprite.scale.set(4, 1, 1);
    return sprite;
  }

  contains(pos) {
    return Math.hypot(pos.x - this.position.x, pos.z - this.position.z) < this.radius;
  }

  update(dt, ctx) {
    const head = ctx.engine.headPosition();
    const on = this.contains(head);
    this.armed = on;

    this.arc.rotation.z += dt * (on ? 3.4 : 0.5);
    const targetHalo = on ? 0.6 : 0.22;
    this._haloOpacity += (targetHalo - this._haloOpacity) * Math.min(1, dt * 6);
    this.halo.opacity = this._haloOpacity;
    this.ringMat.emissiveIntensity = on ? 5.0 : 2.4;
    this.label.material.opacity = on ? 1 : 0.55;
  }
}
