import * as THREE from 'three';

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
 * Window grid used as an emissive mask on tower facades. Lit cells are random
 * and warm; a proportion stay dark so the buildings read as occupied rather
 * than as a uniform light box.
 */
export function facadeTexture(size = 512, { cols = 16, rows = 24, lit = 0.42, seed = 7 } = {}) {
  const { c, ctx } = canvas(size);
  let s = seed;
  const rand = () => (s = (s * 48271) % 2147483647) / 2147483647;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  const cw = size / cols;
  const ch = size / rows;
  const warm = ['#ffd9a8', '#ffc27a', '#fff0d4', '#9fd4ff', '#ffb488'];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (rand() > lit) continue;
      ctx.fillStyle = warm[(rand() * warm.length) | 0];
      ctx.globalAlpha = 0.55 + rand() * 0.45;
      ctx.fillRect(x * cw + cw * 0.22, y * ch + ch * 0.24, cw * 0.56, ch * 0.46);
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
      // Tight inverse-square-ish core with a hard cut at the quad edge, so the
      // quad's square boundary is never visible.
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

let cache = null;

export function library() {
  if (cache) return cache;

  const concreteRough = roughnessTexture(256, { cells: 18, contrast: 0.8, seed: 3, repeat: 4 });
  const concreteNormal = normalTexture(256, 1.6, { cells: 18, contrast: 0.8, seed: 3, repeat: 4 });
  const groundRough = roughnessTexture(256, { cells: 30, contrast: 1.3, seed: 11, repeat: 26 });
  const groundNormal = normalTexture(256, 2.4, { cells: 30, contrast: 1.3, seed: 11, repeat: 26 });

  cache = {
    glow: glowTexture(),
    facade: facadeTexture(),

    // Wet asphalt. Low roughness plus the baked env map is what produces the
    // long vertical neon smears on the street.
    wetGround: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#0a0c12'),
      roughness: 0.34,
      metalness: 0.5,
      roughnessMap: groundRough,
      normalMap: groundNormal,
      normalScale: new THREE.Vector2(0.15, 0.15),
      envMapIntensity: 0.7,
    }),

    concrete: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#2b2f3a'),
      roughness: 0.82,
      metalness: 0.05,
      roughnessMap: concreteRough,
      normalMap: concreteNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      envMapIntensity: 0.9,
    }),

    darkMetal: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#161a24'),
      roughness: 0.38,
      metalness: 0.85,
      envMapIntensity: 1.2,
    }),

    glass: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#0d1524'),
      roughness: 0.08,
      metalness: 1.0,
      envMapIntensity: 2.0,
    }),

    warmWood: new THREE.MeshStandardMaterial({
      color: new THREE.Color('#4a2f22'),
      roughness: 0.62,
      metalness: 0.0,
      envMapIntensity: 0.8,
    }),
  };
  return cache;
}

/** Unlit additive billboard — our stand-in for a bloom pass. */
export function glowSprite(color, scale, tex, opacity = 1) {
  const mat = new THREE.SpriteMaterial({
    map: tex,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(scale);
  return s;
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
