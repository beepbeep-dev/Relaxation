/**
 * Graphics settings: schema, persistence, and the live/rebuild split.
 *
 * Two classes of setting, and the distinction matters more than it looks:
 *
 *  - **live** settings can be applied to a running frame. Render scale,
 *    shadows, fog, glow, exposure, draw distance, comfort options.
 *  - **rebuild** settings change how the world is *constructed* — city
 *    density, prop counts, texture sizes. Applying those means tearing the
 *    scene down and building it again, so they are staged and applied on
 *    reload rather than mid-session. Rebuilding the world while someone is
 *    wearing a headset is a multi-second black screen, which is worse than
 *    asking them to press a button.
 *
 * A tier is auto-detected on first run and becomes the default preset. After
 * that the user's choice wins and is persisted.
 */

const STORAGE_KEY = 'kaisei.settings.v1';

function detectTier() {
  const ua = navigator.userAgent || '';
  if (/OculusBrowser|Quest/i.test(ua)) return 'balanced';
  const cores = navigator.hardwareConcurrency || 4;
  if (cores >= 12) return 'ultra';
  return cores >= 8 ? 'high' : 'low';
}

/**
 * Presets. Every field here is overridable individually; a preset is just a
 * named starting point, and changing any field moves the user to "custom".
 */
export const PRESETS = {
  low: {
    label: 'Low',
    note: 'Weak hardware, or when you want every frame you can get',
    renderScale: 0.8, foveation: 1.0, msaa: false,
    shadows: false, shadowMapSize: 512,
    envMapSize: 64, drawDistance: 260, fogDensity: 0.0075,
    cityBlocks: 6, propDensity: 0.35, trafficCount: 10,
    rain: false, rainDensity: 0.3,
    glowIntensity: 0.85, exposure: 3.4,
    skylineRings: 1,
  },
  balanced: {
    label: 'Balanced',
    note: 'Tuned for Quest 3 at 90Hz — the default in a headset',
    renderScale: 1.0, foveation: 1.0, msaa: true,
    shadows: true, shadowMapSize: 1024,
    envMapSize: 128, drawDistance: 440, fogDensity: 0.0052,
    cityBlocks: 8, propDensity: 0.7, trafficCount: 26,
    rain: true, rainDensity: 0.7,
    glowIntensity: 1.0, exposure: 3.4,
    skylineRings: 2,
  },
  high: {
    label: 'High',
    note: 'PCVR, or desktop. More props, denser city, softer shadows',
    renderScale: 1.0, foveation: 0.5, msaa: true,
    shadows: true, shadowMapSize: 2048,
    envMapSize: 256, drawDistance: 650, fogDensity: 0.0042,
    cityBlocks: 10, propDensity: 1.0, trafficCount: 40,
    rain: true, rainDensity: 1.0,
    glowIntensity: 1.0, exposure: 3.4,
    skylineRings: 3,
  },
  ultra: {
    label: 'Ultra',
    note: 'Desktop with headroom. Not recommended standalone',
    renderScale: 1.25, foveation: 0, msaa: true,
    shadows: true, shadowMapSize: 4096,
    envMapSize: 512, drawDistance: 900, fogDensity: 0.0034,
    cityBlocks: 12, propDensity: 1.4, trafficCount: 60,
    rain: true, rainDensity: 1.4,
    glowIntensity: 1.05, exposure: 3.4,
    skylineRings: 4,
  },
};

/** Which fields can be applied to a live frame, and how they present. */
export const SCHEMA = [
  { key: 'preset', label: 'Quality preset', kind: 'preset', live: false },

  { key: 'renderScale', label: 'Render scale', kind: 'range', min: 0.6, max: 1.4, step: 0.05, live: true,
    help: 'Resolution multiplier. The single biggest performance lever in VR.' },
  { key: 'foveation', label: 'Foveated rendering', kind: 'range', min: 0, max: 1, step: 0.25, live: true,
    help: 'Renders the lens edges at lower resolution. Nearly free quality in a headset.' },
  { key: 'shadows', label: 'Shadows', kind: 'bool', live: true },
  { key: 'shadowMapSize', label: 'Shadow resolution', kind: 'choice', options: [512, 1024, 2048, 4096], live: true },
  { key: 'drawDistance', label: 'Draw distance', kind: 'range', min: 200, max: 900, step: 20, live: true },
  { key: 'fogDensity', label: 'Fog density', kind: 'range', min: 0.001, max: 0.012, step: 0.0002, live: true },
  { key: 'glowIntensity', label: 'Glow intensity', kind: 'range', min: 0, max: 1.6, step: 0.05, live: true },
  { key: 'exposure', label: 'Exposure', kind: 'range', min: 0.5, max: 1.6, step: 0.05, live: true },
  { key: 'rain', label: 'Rain', kind: 'bool', live: true },

  { key: 'msaa', label: 'Anti-aliasing (MSAA)', kind: 'bool', live: false },
  { key: 'envMapSize', label: 'Reflection quality', kind: 'choice', options: [64, 128, 256, 512], live: false },
  { key: 'cityBlocks', label: 'City size', kind: 'range', min: 6, max: 12, step: 1, live: false },
  { key: 'propDensity', label: 'Detail density', kind: 'range', min: 0.2, max: 1.5, step: 0.05, live: false,
    help: 'Rooftop clutter, street props, signage.' },
  { key: 'trafficCount', label: 'Air traffic', kind: 'range', min: 0, max: 60, step: 2, live: false },
  { key: 'rainDensity', label: 'Rain density', kind: 'range', min: 0.2, max: 1.5, step: 0.1, live: false },
  { key: 'skylineRings', label: 'Distant skyline', kind: 'range', min: 0, max: 4, step: 1, live: false },

  { key: 'showStats', label: 'Show performance stats', kind: 'bool', live: true },
  { key: 'comfortVignette', label: 'Comfort vignette', kind: 'range', min: 0, max: 1, step: 0.05, live: true,
    help: 'Darkens the periphery while moving. Raise it if motion bothers you.' },
  { key: 'snapDegrees', label: 'Snap turn angle', kind: 'choice', options: [15, 30, 45, 90], live: true },
];

const LIVE_KEYS = new Set(SCHEMA.filter((f) => f.live).map((f) => f.key));

function defaults() {
  const tier = detectTier();
  return {
    preset: tier,
    ...PRESETS[tier],
    showStats: false,
    comfortVignette: 0.55,
    snapDegrees: 30,
  };
}

function load() {
  const base = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);

    // Resolve a stored preset name to its fields *before* layering the saved
    // values on top. Without this step a settings object that records only
    // `{preset: 'high'}` reports "High" in the UI while every actual field
    // still comes from whatever tier was auto-detected on this machine — the
    // label and the renderer disagree, silently.
    const preset = PRESETS[saved.preset];
    const fields = preset ? (({ label, note, ...rest }) => rest)(preset) : {};

    // Merge rather than replace, so a schema that gains a field does not
    // strand anyone on a stored object that predates it.
    return { ...base, ...fields, ...saved };
  } catch {
    return base;
  }
}

/** Live settings store. Subscribe for changes; `pending` tracks reload-needed edits. */
export class Settings {
  constructor() {
    this.values = load();
    this.pending = new Set();
    this._listeners = new Set();
    // Snapshot of what the world was actually built with, so `pending` can be
    // computed against reality rather than against the last save.
    this.builtWith = { ...this.values };
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;

    // Any manual edit moves the user off a named preset. Guard the lookup:
    // once the preset *is* 'custom' there is no PRESETS entry, and `key in
    // undefined` throws — which would take out the settings panel on the
    // second adjustment the player makes.
    const active = PRESETS[this.values.preset];
    if (key !== 'preset' && active && key in active) {
      this.values.preset = 'custom';
    }

    if (!LIVE_KEYS.has(key) && this.builtWith[key] !== value) this.pending.add(key);
    else this.pending.delete(key);

    this.save();
    this._emit(key, value);
  }

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    const { label, note, ...fields } = preset;
    for (const [k, v] of Object.entries(fields)) {
      this.values[k] = v;
      if (!LIVE_KEYS.has(k) && this.builtWith[k] !== v) this.pending.add(k);
      else this.pending.delete(k);
    }
    this.values.preset = name;
    this.save();
    this._emit('preset', name);
  }

  get needsReload() { return this.pending.size > 0; }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch { /* private mode */ }
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit(key, value) {
    for (const fn of this._listeners) fn(key, value, this.values);
  }
}

/**
 * The one place a live setting turns into renderer or scene state. Called on
 * boot and again on every live change, so there is no drift between the two
 * paths.
 */
export function applyLive(settings, ctx) {
  const { renderer, scene, engine, city, player, glow, pools } = ctx;
  const v = settings.values;

  renderer.toneMappingExposure = v.exposure;
  renderer.shadowMap.enabled = v.shadows;
  renderer.xr.setFoveation(v.foveation);

  if (renderer.xr.isPresenting) {
    renderer.xr.setFramebufferScaleFactor?.(v.renderScale);
  } else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * v.renderScale);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  if (scene.fog) scene.fog.density = v.fogDensity;

  engine.camera.far = v.drawDistance;
  engine.camera.updateProjectionMatrix();

  if (ctx.sun) {
    ctx.sun.castShadow = v.shadows;
    if (ctx.sun.shadow.mapSize.width !== v.shadowMapSize) {
      ctx.sun.shadow.mapSize.setScalar(v.shadowMapSize);
      ctx.sun.shadow.map?.dispose();
      ctx.sun.shadow.map = null;      // forces reallocation at the new size
    }
  }

  glow?.setIntensity(v.glowIntensity);
  pools?.setIntensity(v.glowIntensity);
  city?.setRain(v.rain);
  ctx.audio?.setRain(v.rain);

  if (player) {
    player.vignetteStrength = v.comfortVignette;
    player.snapAngle = (v.snapDegrees * Math.PI) / 180;
  }
}
