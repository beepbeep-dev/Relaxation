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
  // 5.6m per tile (repeat 90 across a 504m plane) is far larger than the
  // ~1-2m a real asphalt photograph covers, so the grain was stretched to
  // the point of invisibility at standing height. 220 puts a tile at ~2.3m.
  asphalt: { file: 'asphalt.jpg', normalFile: 'asphalt_n.jpg', repeat: 220, normalScale: 1.4 },
  // The pavement slabs are the surface a player actually stands on and looks
  // at for most of the game — 31m blocks, one per city block — so this is the
  // texture that decides whether the world reads as detailed at all. It is
  // also the one that was measured at std 5.1 (flat grey), which is why the
  // game looked untextured no matter what the road did.
  concrete: { file: 'concrete.jpg', normalFile: 'concrete_n.jpg', repeat: 16, normalScale: 1.5 },
  panel: { file: 'panel.jpg', normalFile: 'panel_n.jpg', repeat: 3, normalScale: 0.5 },
  wood: { file: 'wood.jpg', normalFile: 'wood_n.jpg', repeat: 6, normalScale: 0.6 },
  fabric: { file: 'fabric.jpg', normalFile: 'fabric_n.jpg', repeat: 4, normalScale: 0.7 },
};

export function loadSurfaceTextures(onReady) {
  const loader = new THREE.TextureLoader();
  const base = import.meta.env?.BASE_URL ?? './';
  const out = {};
  // Two files per surface (albedo + normal), each independently non-fatal.
  let pending = Object.keys(SURFACE_TEXTURES).length * 2;
  const settle = () => { if (--pending === 0) onReady?.(out); };

  for (const [name, { file, normalFile, repeat }] of Object.entries(SURFACE_TEXTURES)) {
    loader.load(
      `${base}textures/${file}`,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeat, repeat);
        tex.colorSpace = THREE.SRGBColorSpace;
        // 16, not 4. A road is viewed almost edge-on for most of the screen,
        // and that is precisely where low anisotropy collapses the grain into
        // a smear of average grey — the surface reads as polished, and the
        // texture may as well not be there.
        tex.anisotropy = 16;
        out[name] = tex;
        settle();
      },
      undefined,
      settle   // missing file is not fatal
    );
    loader.load(
      `${base}textures/${normalFile}`,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeat, repeat);
        // Normal maps are per-channel vector data, never sRGB-decoded.
        out[`${name}_n`] = tex;
        settle();
      },
      undefined,
      settle
    );
  }
  return out;
}

/**
 * Swap the photographic maps onto the standing materials.
 *
 * Albedo goes on as `map` only — it is near-greyscale by construction, so
 * multiplying it against each material's palette colour adds grain without
 * letting a texture bring its own hue into a strict three-colour script.
 * The normal map replaces whatever procedural bump (or none) the material
 * started with: it is a Sobel filter over this exact albedo's own grain
 * (see tools/imagegen/make_textures.py), so it is the one normal map that is
 * actually correlated with what is on screen rather than generic noise.
 */
export function applySurfaceTextures(tex) {
  const lib = library();
  const swap = (mat, name) => {
    if (tex[name]) { mat.map = tex[name]; mat.needsUpdate = true; }
    if (tex[`${name}_n`]) {
      mat.normalMap = tex[`${name}_n`];
      const s = SURFACE_TEXTURES[name].normalScale;
      mat.normalScale.set(s, s);
      mat.needsUpdate = true;
    }
  };
  swap(lib.wetGround, 'asphalt');
  swap(lib.concrete, 'concrete');
  swap(lib.darkMetal, 'panel');
  swap(lib.deckWood, 'wood');
  swap(lib.cushion, 'fabric');
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

    // Wet asphalt, not a mirror — and it was reading as a mirror. Standing on
    // the street and looking down showed a smooth glossy sheet with no grain
    // at all, which is exactly what a player meant by "I see no textures".
    //
    // Two things caused it. The roughness map drove large areas glossy, and
    // at metalness 0.22 a metallic surface has *no* diffuse term to show
    // albedo with — so the specular reflection of a bright saturated sky won,
    // and the texture underneath it was invisible regardless of its content.
    //
    // Asphalt is not metal. Metalness drops to near zero so the albedo
    // actually shows, roughness rises so the sky reflection becomes a sheen
    // rather than a mirror, and the puddle mask now varies roughness within
    // a wet-but-not-polished range instead of reaching glass.
    wetGround: new THREE.MeshStandardMaterial({
      color: col(PALETTE.wetGround),
      roughness: 0.78,
      metalness: 0.04,
      roughnessMap: puddles,
      normalMap: groundNormal,
      normalScale: new THREE.Vector2(0.85, 0.85),
      envMapIntensity: 0.45,
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
