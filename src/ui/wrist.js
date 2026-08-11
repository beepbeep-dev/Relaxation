import * as THREE from 'three';
import { PRESETS } from '../core/settings.js';
import { PALETTE } from '../world/palette.js';

const W = 512;
const H = 640;
const ROW_TOP = 118;
// Rows are deliberately tall. A 6DoF pointer at arm's length has maybe a
// degree of jitter, and the first version's 42px rows meant a shaking hand
// slid between them — it was genuinely hard to hit the setting you wanted.
const ROW_H = 60;

/**
 * The in-headset graphics panel.
 *
 * A DOM overlay is completely invisible inside an XR session, so the settings
 * a player can reach in VR have to be geometry. This is a slab strapped to the
 * left wrist — diegetically the same handheld device DRIFT is designed around,
 * which keeps it inside the "no floating UI panels" pillar.
 *
 * You aim the right controller at it and pull the trigger. Ranges are split
 * down the middle: tap the left half to decrease, the right half to increase.
 * That is a coarser control than a slider, and deliberately so — fine dragging
 * with a 6DoF pointer at arm's length is miserable, while a two-target tap is
 * reliable even with shaky hands.
 */
export class WristPanel {
  constructor(engine, settings, { onLiveChange, stats } = {}) {
    this.engine = engine;
    this.settings = settings;
    this.stats = stats;
    this.onLiveChange = onLiveChange ?? (() => {});
    this.visible = false;

    this.rows = [
      { key: 'preset', label: 'Preset', kind: 'preset' },
      { key: 'renderScale', label: 'Render scale', kind: 'range', min: 0.6, max: 1.4, step: 0.05 },
      { key: 'foveation', label: 'Foveation', kind: 'range', min: 0, max: 1, step: 0.25 },
      { key: 'shadows', label: 'Shadows', kind: 'bool' },
      { key: 'glowIntensity', label: 'Glow', kind: 'range', min: 0, max: 1.6, step: 0.1 },
      { key: 'exposure', label: 'Exposure', kind: 'range', min: 0.5, max: 1.6, step: 0.05 },
      { key: 'fogDensity', label: 'Fog', kind: 'range', min: 0.001, max: 0.012, step: 0.001 },
      { key: 'drawDistance', label: 'Draw distance', kind: 'range', min: 200, max: 900, step: 50 },
      { key: 'rain', label: 'Rain', kind: 'bool' },
      { key: 'comfortVignette', label: 'Vignette', kind: 'range', min: 0, max: 1, step: 0.1 },
      { key: 'snapDegrees', label: 'Snap turn', kind: 'choice', options: [15, 30, 45, 90] },
      { key: 'showStats', label: 'Stats', kind: 'bool' },
    ];

    this._buildMesh();
    this._raycaster = new THREE.Raycaster();
    this._tmpMatrix = new THREE.Matrix4();
    this._lastDraw = 0;
  }

  _buildMesh() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.mesh = new THREE.Mesh(
      // Roughly doubled in area from the first version, for the same reason.
      new THREE.PlaneGeometry(0.34, 0.42),
      new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, toneMapped: false, fog: false,
        side: THREE.DoubleSide, depthTest: false,
      })
    );
    this.mesh.renderOrder = 2000;

    // Sits above the back of the left hand, tilted towards the face at roughly
    // the angle you would hold a watch to read it.
    this.group = new THREE.Group();
    this.group.position.set(0, 0.09, -0.10);
    this.group.rotation.set(-0.75, 0, 0);
    this.group.add(this.mesh);
    this.group.visible = false;

    // A dot showing exactly where the pointer lands. Aiming at a panel you
    // cannot see yourself aiming at is guesswork, which is most of why the
    // first version felt unusable.
    this.cursor = new THREE.Mesh(
      new THREE.CircleGeometry(0.006, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE.accentGreen),
        toneMapped: false, fog: false, depthTest: false, transparent: true,
      })
    );
    this.cursor.renderOrder = 2001;
    this.cursor.visible = false;
    this.mesh.add(this.cursor);
  }

  /** Project the pointing controller onto the panel; returns local UV or null. */
  _aim(controller) {
    if (!controller) return null;
    this._tmpMatrix.identity().extractRotation(controller.matrixWorld);
    this._raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this._raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._tmpMatrix);
    const hits = this._raycaster.intersectObject(this.mesh, false);
    return hits.length ? hits[0] : null;
  }

  /** Called every frame with the pointing controller so the cursor tracks it. */
  updateCursor(controller) {
    if (!this.visible) { this.cursor.visible = false; return; }
    const hit = this._aim(controller);
    if (!hit) { this.cursor.visible = false; return; }
    this.cursor.visible = true;
    this.mesh.worldToLocal(this.cursor.position.copy(hit.point));
    this.cursor.position.z = 0.001;
  }

  /** Parent to the left grip once controllers have reported handedness. */
  attachTo(grip) {
    if (this._attached === grip) return;
    grip.add(this.group);
    this._attached = grip;
  }

  toggle() {
    this.visible = !this.visible;
    this.group.visible = this.visible;
    if (this.visible) this.draw(true);
  }

  /**
   * Handle a trigger press from a controller. Returns true if the press landed
   * on the panel, so the caller can suppress the world interaction it would
   * otherwise have triggered.
   */
  handleSelect(controller) {
    if (!this.visible) return false;
    const hit = this._aim(controller);
    if (!hit) return false;

    const uv = hit.uv;
    const y = (1 - uv.y) * H;
    const index = Math.floor((y - ROW_TOP) / ROW_H);
    if (index < 0 || index >= this.rows.length) return true;   // hit the panel, missed a row

    this._activate(this.rows[index], uv.x > 0.5);
    return true;
  }

  _activate(row, increase) {
    const v = this.settings.values;

    if (row.kind === 'bool') {
      this.settings.set(row.key, !v[row.key]);
    } else if (row.kind === 'preset') {
      const names = Object.keys(PRESETS);
      const at = names.indexOf(v.preset);
      const next = names[(at + (increase ? 1 : names.length - 1) + names.length) % names.length];
      this.settings.applyPreset(next);
    } else if (row.kind === 'choice') {
      const at = row.options.indexOf(v[row.key]);
      const next = row.options[(at + (increase ? 1 : row.options.length - 1)) % row.options.length];
      this.settings.set(row.key, next);
    } else {
      const step = increase ? row.step : -row.step;
      const raw = v[row.key] + step;
      // Round to the step so repeated presses cannot accumulate float drift.
      const snapped = Math.round(raw / row.step) * row.step;
      this.settings.set(row.key, THREE.MathUtils.clamp(snapped, row.min, row.max));
    }

    this.onLiveChange();
    this.draw(true);
  }

  _format(row, value) {
    if (row.kind === 'bool') return value ? 'ON' : 'OFF';
    if (row.kind === 'preset') return String(value).toUpperCase();
    if (row.key === 'foveation') return value === 0 ? 'off' : `${Math.round(value * 100)}%`;
    if (row.key === 'fogDensity') return value.toFixed(3);
    if (row.key === 'drawDistance') return `${value}m`;
    if (row.key === 'snapDegrees') return `${value}°`;
    return Number(value).toFixed(2);
  }

  draw(force = false) {
    const c = this.ctx;
    const v = this.settings.values;

    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(10,8,26,0.93)';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = PALETTE.accentPurple;
    c.lineWidth = 3;
    c.strokeRect(4, 4, W - 8, H - 8);

    c.textBaseline = 'middle';
    c.fillStyle = PALETTE.accentGreen;
    c.font = '600 24px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'left';
    c.fillText('GRAPHICS', 20, 34);

    if (this.stats) {
      c.font = '400 15px ui-monospace, monospace';
      c.fillStyle = '#8fa8d8';
      c.fillText(this.stats.line(), 24, 78);
    }

    this.rows.forEach((row, i) => {
      const y = ROW_TOP + i * ROW_H + ROW_H / 2;
      if (i % 2 === 0) {
        c.fillStyle = 'rgba(255,255,255,0.035)';
        c.fillRect(12, ROW_TOP + i * ROW_H, W - 24, ROW_H);
      }
      c.font = '400 22px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = '#d6e2f5';
      c.textAlign = 'left';
      c.fillText(row.label, 26, y);

      c.font = '600 22px ui-sans-serif, system-ui, sans-serif';
      c.fillStyle = row.kind === 'bool' && !v[row.key] ? '#6b7ba5' : PALETTE.accentBlue;
      c.textAlign = 'right';
      c.fillText(this._format(row, v[row.key]), W - 76, y);

      // The two tap targets, drawn faintly so the split is discoverable.
      // Half-row tap targets, drawn as real buttons rather than hints. Each is
      // now ~90px wide instead of a 14px glyph.
      c.fillStyle = 'rgba(185,140,255,0.16)';
      c.fillRect(W / 2, ROW_TOP + i * ROW_H + 3, W / 2 - 14, ROW_H - 6);
      c.strokeStyle = 'rgba(185,140,255,0.30)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(W * 0.75, ROW_TOP + i * ROW_H + 6);
      c.lineTo(W * 0.75, ROW_TOP + i * ROW_H + ROW_H - 6);
      c.stroke();
      c.fillStyle = 'rgba(220,200,255,0.5)';
      c.font = '600 26px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('–', W * 0.625, y);
      c.fillText('+', W * 0.875, y);
    });

    if (this.settings.needsReload) {
      c.fillStyle = PALETTE.accentPurple;
      c.font = '500 14px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('some changes apply on reload', W / 2, H - 22);
    }

    this.texture.needsUpdate = true;
  }

  update(dt, ctx) {
    if (!this.visible) return;
    // Redraw once a second for the stats line; every frame would upload a
    // 384×512 texture 90 times a second for a number that changes once.
    this._lastDraw += dt;
    if (this._lastDraw > 1) {
      this._lastDraw = 0;
      this.draw();
    }
  }
}
