import * as THREE from 'three';
import { QUALITY } from './quality.js';

/**
 * Renderer + XR session + frame loop.
 *
 * Deliberate omission: there is no full-screen post-processing stack. On a
 * Quest 3 an EffectComposer forces the renderer off multiview and onto two
 * full-resolution offscreen passes per frame, which costs roughly a third of
 * the frame budget before a single building is drawn. Bloom and glow are done
 * with emissive materials plus additive billboards instead, which multiview
 * renders for free. See docs/GRAPHICS.md.
 */
export class Engine {
  constructor() {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: QUALITY.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Filmic response curve + physical light falloff. This pair does more for
    // "modern AAA" read than any amount of geometry.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.renderer.shadowMap.enabled = QUALITY.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.setFoveation(QUALITY.foveation);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 900);
    this.camera.position.set(0, 1.6, 0);

    // The XR rig. Locomotion moves this, never the camera — the camera is
    // owned by the headset pose.
    this.rig = new THREE.Group();
    this.rig.add(this.camera);
    this.scene.add(this.rig);

    this.clock = new THREE.Clock();
    this._systems = [];
    this._tmpPos = new THREE.Vector3();

    addEventListener('resize', () => this._onResize());
  }

  _onResize() {
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Register anything with an `update(dt, ctx)` method. */
  add(system) {
    this._systems.push(system);
    return system;
  }

  /** World-space head position, valid in and out of XR. */
  headPosition(out = this._tmpPos) {
    return out.setFromMatrixPosition(this.camera.matrixWorld);
  }

  async enterVR() {
    if (!navigator.xr) throw new Error('WebXR unavailable in this browser.');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    await this.renderer.xr.setSession(session);
    return session;
  }

  start() {
    const ctx = {
      scene: this.scene,
      camera: this.camera,
      rig: this.rig,
      renderer: this.renderer,
      engine: this,
      elapsed: 0,
    };

    this.renderer.setAnimationLoop(() => {
      // Clamped so a GC hitch or a headset-off pause cannot teleport anything
      // across the world in one step.
      const dt = Math.min(this.clock.getDelta(), 0.1);
      ctx.dt = dt;
      ctx.elapsed += dt;

      for (const s of this._systems) s.update?.(dt, ctx);

      this.renderer.render(this.scene, this.camera);
    });
  }
}
