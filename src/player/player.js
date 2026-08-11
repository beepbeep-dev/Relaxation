import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Locomotion, collision and comfort.
 *
 * The rig moves; the camera never does. Everything here is written so that a
 * seated player with one controller can reach every part of the world, which
 * is a hard requirement from the design doc rather than a nice-to-have.
 */
export class Player {
  constructor(engine, world) {
    this.engine = engine;
    this.rig = engine.rig;
    this.camera = engine.camera;
    this.world = world;             // { colliders, platforms, ramps, seats }

    this.speed = 3.0;               // m/s, walking pace — deliberately not fast
    this.snapAngle = Math.PI / 6;   // 30 degrees
    this._snapCooldown = 0;
    this.seated = false;

    this.velocityY = 0;
    this.radius = 0.32;

    this._controllers = [];
    this._gamepads = [];
    this._keys = new Set();
    this._yaw = 0;
    this._pitch = 0;
    this._moveAmount = 0;

    this._setupControllers();
    this._setupDesktop();
    this._setupVignette();
  }

  _setupControllers() {
    const factory = new XRControllerModelFactory();
    for (let i = 0; i < 2; i++) {
      const grip = this.engine.renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      this.rig.add(grip);

      const ctrl = this.engine.renderer.xr.getController(i);
      // A short ray, not an infinite laser: this is a place you inhabit, not a
      // menu you point at.
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({
          color: 0xff9c6e, transparent: true, opacity: 0.35, toneMapped: false,
        })
      );
      ray.scale.z = 1.2;
      ctrl.add(ray);
      this.rig.add(ctrl);

      ctrl.addEventListener('connected', (e) => {
        ctrl.userData.handedness = e.data.handedness;
        ctrl.userData.gamepad = e.data.gamepad;
      });
      ctrl.addEventListener('disconnected', () => {
        ctrl.userData.gamepad = null;
      });
      ctrl.addEventListener('selectstart', () => this._onSelect(ctrl));

      this._controllers.push(ctrl);
    }
  }

  _onSelect(ctrl) {
    // Trigger near a cushion sits you down; trigger again stands you up.
    if (this.seated) { this.stand(); return; }
    const head = this.engine.headPosition();
    let best = null;
    let bestD = 1.6;
    for (const s of this.world.seats ?? []) {
      const d = Math.hypot(s.x - head.x, s.z - head.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) this.sit(best);
  }

  sit(seat) {
    this.seated = true;
    this._standPos = this.rig.position.clone();
    // Offset by the head's local XZ so the player's body lands on the cushion
    // rather than the rig origin, which may be metres away in roomscale.
    const head = this.engine.headPosition();
    this.rig.position.x += seat.x - head.x;
    this.rig.position.z += seat.z - head.z;
    this.rig.position.y = seat.y - 0.45;   // seated eye height offset
  }

  stand() {
    this.seated = false;
    if (this._standPos) this.rig.position.copy(this._standPos);
  }

  _setupDesktop() {
    addEventListener('keydown', (e) => this._keys.add(e.code));
    addEventListener('keyup', (e) => this._keys.delete(e.code));

    const canvas = this.engine.renderer.domElement;
    canvas.addEventListener('click', () => {
      if (!this.engine.renderer.xr.isPresenting) canvas.requestPointerLock?.();
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this._yaw -= e.movementX * 0.0022;
      this._pitch = THREE.MathUtils.clamp(this._pitch - e.movementY * 0.0022, -1.4, 1.4);
    });
  }

  _setupVignette() {
    // Comfort tunnelling. An inverted cone welded to the camera, faded in
    // proportional to movement speed. Cheaper than a post pass and it works
    // per-eye for free.
    const geo = new THREE.RingGeometry(0.28, 1.6, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    });
    this.vignette = new THREE.Mesh(geo, mat);
    this.vignette.position.z = -0.35;
    this.vignette.renderOrder = 999;
    this.vignette.frustumCulled = false;
    this.camera.add(this.vignette);
  }

  /** Highest walkable surface under (x, z). */
  groundHeight(x, z) {
    let y = 0;
    for (const p of this.world.platforms ?? []) {
      if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ) y = Math.max(y, p.y);
    }
    for (const r of this.world.ramps ?? []) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) y = Math.max(y, r.yAt(z));
    }
    return y;
  }

  /** Push the position out of any collider it has entered, along the shallowest axis. */
  _resolveCollisions(pos) {
    for (const c of this.world.colliders ?? []) {
      const minX = c.minX - this.radius, maxX = c.maxX + this.radius;
      const minZ = c.minZ - this.radius, maxZ = c.maxZ + this.radius;
      if (pos.x < minX || pos.x > maxX || pos.z < minZ || pos.z > maxZ) continue;

      const dl = pos.x - minX, dr = maxX - pos.x;
      const db = pos.z - minZ, df = maxZ - pos.z;
      const m = Math.min(dl, dr, db, df);
      if (m === dl) pos.x = minX;
      else if (m === dr) pos.x = maxX;
      else if (m === db) pos.z = minZ;
      else pos.z = maxZ;
    }
  }

  _readAxes() {
    let moveX = 0, moveZ = 0, turnX = 0;

    for (const c of this._controllers) {
      const gp = c.userData.gamepad;
      if (!gp) continue;
      // WebXR standard mapping puts the thumbstick on axes 2/3; some runtimes
      // expose a touchpad on 0/1, so take whichever is actually deflected.
      const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] ?? 0;
      const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] ?? 0;
      if (c.userData.handedness === 'right') {
        if (Math.abs(ax) > 0.7) turnX = ax;
      } else {
        moveX = Math.abs(ax) > 0.15 ? ax : 0;
        moveZ = Math.abs(ay) > 0.15 ? ay : 0;
      }
    }

    if (!this.engine.renderer.xr.isPresenting) {
      if (this._keys.has('KeyW')) moveZ -= 1;
      if (this._keys.has('KeyS')) moveZ += 1;
      if (this._keys.has('KeyA')) moveX -= 1;
      if (this._keys.has('KeyD')) moveX += 1;
      if (this._keys.has('ArrowLeft')) turnX = -1;
      if (this._keys.has('ArrowRight')) turnX = 1;
    }
    return { moveX, moveZ, turnX };
  }

  update(dt) {
    this._snapCooldown = Math.max(0, this._snapCooldown - dt);
    const xr = this.engine.renderer.xr.isPresenting;
    const { moveX, moveZ, turnX } = this._readAxes();

    // Snap turn. Never smooth — smooth yaw is the single most reliable way to
    // make a player in a headset feel ill.
    if (Math.abs(turnX) > 0.7 && this._snapCooldown === 0) {
      this.rig.rotateY(-Math.sign(turnX) * this.snapAngle);
      this._snapCooldown = 0.28;
    }

    if (this.seated) {
      this._moveAmount = 0;
      this.vignette.material.opacity = 0;
      if (!xr) this._applyDesktopLook();
      return;
    }

    // Move relative to gaze in XR, relative to yaw on desktop.
    const forward = new THREE.Vector3();
    if (xr) {
      this.camera.getWorldDirection(forward);
    } else {
      forward.set(Math.sin(this._yaw), 0, -Math.cos(this._yaw));
    }
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize().negate();

    const step = new THREE.Vector3()
      .addScaledVector(forward, -moveZ)
      .addScaledVector(right, -moveX);

    const mag = Math.min(step.length(), 1);
    if (mag > 0.001) {
      step.normalize().multiplyScalar(this.speed * mag * dt);
      const next = this.rig.position.clone().add(step);
      this._resolveCollisions(next);
      this.rig.position.x = next.x;
      this.rig.position.z = next.z;
    }

    // Vertical: snap to the surface underfoot, with a short fall if it drops away.
    const head = this.engine.headPosition();
    const target = this.groundHeight(head.x, head.z);
    const dy = target - this.rig.position.y;
    if (dy > 0) {
      this.rig.position.y = target;              // step up instantly
      this.velocityY = 0;
    } else if (dy < -0.02) {
      this.velocityY -= 18 * dt;                 // fall
      this.rig.position.y = Math.max(target, this.rig.position.y + this.velocityY * dt);
      if (this.rig.position.y === target) this.velocityY = 0;
    }

    // Vignette tracks actual movement, and eases so it never pops.
    this._moveAmount = THREE.MathUtils.damp(this._moveAmount, mag, 8, dt);
    this.vignette.material.opacity = this._moveAmount * 0.55;

    if (!xr) this._applyDesktopLook();
  }

  _applyDesktopLook() {
    this.camera.rotation.set(this._pitch, this._yaw, 0, 'YXZ');
    this.camera.position.set(0, 1.65, 0);
  }
}
