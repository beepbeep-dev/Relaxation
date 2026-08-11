import * as THREE from 'three';
import { PALETTE } from './palette.js';

/**
 * All textures are generated at runtime on a 2D canvas. No image downloads,
 * no atlas budget, and every surface variation is a parameter we can tune
 * rather than an asset we have to re-export.
 */

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { c, ctx: c.getContext('2d') };
}

function finish(c, { repeat = 1, srgb = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Value noise, splatted as soft blobs. Fast enough to run at boot. */
function noiseInto(ctx, size, { cells = 24, contrast = 1, seed = 1 } = {}) {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const step = size / cells;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < cells * cells * 3; i++) {
    const v = 128 + (rand() - 0.5) * 255 * contrast;
    const r = step * (0.6 + rand() * 1.4);
    ctx.fillStyle = `rgba(${v | 0},${v | 0},${v | 0},0.10)`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Grey-scale roughness variation — keeps large flat surfaces from reading as plastic. */
export function roughnessTexture(size = 256, opts) {
  const { c, ctx } = canvas(size);
  noiseInto(ctx, size, opts);
  return finish(c, { repeat: opts?.repeat ?? 1 });
}

/**
 * Sobel-derived normal map from the same noise field. Cheap, and enough to
 * break up specular highlights on concrete and asphalt at grazing angles.
 */
export function normalTexture(size = 256, strength = 2.0, opts) {
  const { c, ctx } = canvas(size);
  noiseInto(ctx, size, opts);
  const src = ctx.getImageData(0, 0, size, size);
  const dst = ctx.createImageData(size, size);
  const at = (x, y) => src.data[((y & (size - 1)) * size + (x & (size - 1))) * 4] / 255;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      dst.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      dst.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      dst.data[i + 2] = (1 / len) * 0.5 * 255 + 127;
      dst.data[i + 3] = 255;
    }
  }
  ctx.putImageData(dst, 0, 0);
  return finish(c, { repeat: opts?.repeat ?? 1 });
}

/**
 * Window grid used as an emissive mask on tower facades.
 *
 * Two passes beyond a plain grid, both cheap and both worth it: some floors
 * are lit as a whole run (an office corridor), and a minority of windows get a
 * brighter inner core (a lamp near the glass). Without them a facade reads as
 * noise rather than as a building with people in it.
 */
export function facadeTexture(size = 512, { cols = 18, rows = 28, lit = 0.4, seed = 7 } = {}) {
  const { c, ctx } = canvas(size);
  let s = seed;
  const rand = () => (s = (s * 48271) % 2147483647) / 2147483647;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  const cw = size / cols;
  const ch = size / rows;
  const tint = PALETTE.windows;

  for (let y = 0; y < rows; y++) {
    const floorLit = rand() < 0.16;
    for (let x = 0; x < cols; x++) {
      if (!floorLit && rand() > lit) continue;
      ctx.fillStyle = tint[(rand() * tint.length) | 0];
      ctx.globalAlpha = floorLit ? 0.45 + rand() * 0.25 : 0.5 + rand() * 0.5;
      const px = x * cw + cw * 0.2;
      const py = y * ch + ch * 0.22;
      const pw = cw * 0.6;
      const ph = ch * 0.5;
      ctx.fillRect(px, py, pw, ph);

      if (rand() < 0.18) {
        ctx.globalAlpha = 1;
        ctx.fillRect(px + pw * 0.25, py + ph * 0.2, pw * 0.5, ph * 0.55);
      }
    }
  }
  ctx.globalAlpha = 1;
  return finish(c, { srgb: true });
}

/**
 * Radial falloff sprite, used for every glow, lamp halo and boost flare.
 *
 * Written per-pixel rather than with a canvas radial gradient: the 2D context
 * dithers gradients, and since these quads are magnified to several metres
 * across in world space, that dithering shows up as a ring of speckles around
 * every light. An analytic falloff is both smooth and exactly art-directable.
 */
export function glowTexture(size = 128) {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      // Tight core with a hard cut at the quad edge, so the quad's square
      // boundary is never visible.
      const core = Math.max(0, 1 - d);
      const a = Math.pow(core, 3.2) * 0.85 + Math.pow(core, 12) * 0.15;
      const v = Math.round(Math.min(1, a) * 255);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = finish(c, { srgb: true });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * Puddle mask driving roughness on the road. Standing water is patchy, and a
 * uniformly mirrored street reads as polished stone rather than as wet ground.
 */
export function puddleTexture(size = 256) {
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  let s = 991;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  ctx.filter = 'blur(5px)';
  for (let i = 0; i < 80; i++) {
    const r = size * (0.02 + rand() * 0.07);
    // Dark in the mask == low roughness == glossy puddle.
    ctx.fillStyle = `rgba(0,0,0,${0.5 + rand() * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(rand() * size, rand() * size, r, r * (0.5 + rand()), rand() * 6.28, 0, 6.28);
    ctx.fill();
  }
  ctx.filter = 'none';
  // Repeat is set against the *ground plane's* extent, which is several
  // hundred metres. At a low repeat each "puddle" ends up tens of metres
  // across and the road reads as one uniform sheet mirroring the sky, which is
  // exactly the failure this mask exists to prevent.
  return finish(c, { repeat: 48 });
}

const col = (hex) => new THREE.Color(hex);

/**
 * Photographic surface textures, generated offline with sdxl-turbo and made
 * tileable (see tools/imagegen/make_textures.py). Covers every surface that
 * is both seen close up and tiled across a large area — road, building
 * podium/concrete, dark metal trim, lounge decking, lounge cushions. Glossy
 * car paint and the low-poly foliage blobs stay procedural: a photographic
 * map on a smooth painted panel, or on an icosahedron's default UVs, reads
 * worse than a flat colour, not better.
 *
 * They load *after* the world is already on screen and swap in when ready, so
 * a slow connection costs detail rather than a black screen — the procedural
 * noise maps below stay in place until the real thing arrives. That matters in
 * a headset, where a blocking load is several seconds of staring at nothing.
 *
 * BASE_URL rather than a leading slash: the build is served from a project
 * subpath on GitHub Pages, and an absolute path would 404 there.
 */
const SURFACE_TEXTURES = {
  asphalt: { file: 'asphalt.jpg', repeat: 90 },
  concrete: { file: 'concrete.jpg', repeat: 9 },
  panel: { file: 'panel.jpg', repeat: 3 },
  wood: { file: 'wood.jpg', repeat: 6 },
  fabric: { file: 'fabric.jpg', repeat: 4 },
};

export function loadSurfaceTextures(onReady) {
  const loader = new THREE.TextureLoader();
  const base = import.meta.env?.BASE_URL ?? './';
  const out = {};
  let pending = Object.keys(SURFACE_TEXTURES).length;

  for (const [name, { file, repeat }] of Object.entries(SURFACE_TEXTURES)) {
    loader.load(
      `${base}textures/${file}`,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeat, repeat);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        out[name] = tex;
        if (--pending === 0) onReady?.(out);
      },
      undefined,
      () => { if (--pending === 0) onReady?.(out); }   // missing file is not fatal
    );
  }
  return out;
}

/**
 * Swap the photographic maps onto the standing materials.
 *
 * They go on as `map` only. The albedo is near-greyscale by construction, so
 * multiplying it against each material's palette colour adds grain without
 * letting a texture bring its own hue into a strict three-colour script — and
 * the existing roughness and normal maps keep doing their jobs untouched.
 */
export function applySurfaceTextures(tex) {
  const lib = library();
  if (tex.asphalt) { lib.wetGround.map = tex.asphalt; lib.wetGround.needsUpdate = true; }
  if (tex.concrete) { lib.concrete.map = tex.concrete; lib.concrete.needsUpdate = true; }
  if (tex.panel) { lib.darkMetal.map = tex.panel; lib.darkMetal.needsUpdate = true; }
  if (tex.wood) { lib.deckWood.map = tex.wood; lib.deckWood.needsUpdate = true; }
  if (tex.fabric) { lib.cushion.map = tex.fabric; lib.cushion.needsUpdate = true; }
}

let cache = null;

export function library() {
  if (cache) return cache;

  const concreteRough = roughnessTexture(256, { cells: 18, contrast: 0.8, seed: 3, repeat: 4 });
  const concreteNormal = normalTexture(256, 1.6, { cells: 18, contrast: 0.8, seed: 3, repeat: 4 });
  const groundNormal = normalTexture(256, 2.4, { cells: 30, contrast: 1.3, seed: 11, repeat: 70 });
  const puddles = puddleTexture();

  cache = {
    glow: glowTexture(),
    facade: facadeTexture(),
    facadeAlt: facadeTexture(512, { cols: 12, rows: 20, lit: 0.3, seed: 31 }),
    puddles,

    // Wet asphalt, not a mirror. envMapIntensity is deliberately low: the
    // baked environment is dominated by a bright saturated horizon band, and
    // at anything near 1.0 the road stops being a surface and becomes a
    // reflection of the sky's single strongest colour.
    wetGround: new THREE.MeshStandardMaterial({
      color: col(PALETTE.wetGround),
      roughness: 0.6,
      metalness: 0.22,
      roughnessMap: puddles,
      normalMap: groundNormal,
      normalScale: new THREE.Vector2(0.4, 0.4),
      envMapIntensity: 0.5,
    }),

    concrete: new THREE.MeshStandardMaterial({
      color: col(PALETTE.concrete),
      roughness: 0.82,
      metalness: 0.05,
      roughnessMap: concreteRough,
      normalMap: concreteNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      envMapIntensity: 0.55,
    }),

    darkMetal: new THREE.MeshStandardMaterial({
      color: col(PALETTE.darkMetal),
      roughness: 0.38,
      metalness: 0.85,
      envMapIntensity: 1.2,
    }),

    glass: new THREE.MeshStandardMaterial({
      color: col(PALETTE.glass),
      roughness: 0.08,
      metalness: 1.0,
      envMapIntensity: 2.0,
    }),

    deckWood: new THREE.MeshStandardMaterial({
      color: col(PALETTE.deckWood),
      roughness: 0.62,
      metalness: 0.0,
      envMapIntensity: 0.8,
    }),

    cushion: new THREE.MeshStandardMaterial({
      color: col(PALETTE.cushion),
      roughness: 0.92,
      metalness: 0.0,
    }),

    foliage: new THREE.MeshStandardMaterial({
      color: col('#1d6b52'),
      roughness: 0.85,
      metalness: 0.0,
      envMapIntensity: 0.7,
    }),
  };
  return cache;
}

/** Emissive surface that survives tone mapping as a believable light source. */
export function neonMaterial(color, intensity = 3) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#000000'),
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    roughness: 1,
    metalness: 0,
    toneMapped: true,
  });
}

/**
 * Unlit vertex-coloured material for merged self-lit geometry — signage, strip
 * lighting, anything whose job is to be bright rather than to be lit. One of
 * these over a merged buffer replaces one draw call per sign.
 */
export function emissiveVertexMaterial() {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    toneMapped: true,
    fog: true,
  });
}
