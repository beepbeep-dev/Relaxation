import * as THREE from 'three';
import { PALETTE } from './palette.js';

/**
 * Procedural building facades, evaluated in the fragment shader.
 *
 * The previous towers were scaled boxes wearing a 512px emissive window
 * texture, and they looked it. Stretching one texture across buildings that
 * range from 8m to 60m wide means the "windows" are a different physical size
 * on every building, which is the single most obvious tell that a city is
 * fake — real buildings all share a storey height.
 *
 * So the facade is computed instead of sampled:
 *
 *  - UVs are derived from **world-space metres**, not the mesh's own UVs, so a
 *    storey is 3.6m and a window bay is 2.6m on every building regardless of
 *    its size. This is the thing that makes the city read as built rather than
 *    as textured.
 *  - The vertical axis uses world Y, so floor lines run continuously across
 *    the separate boxes that make up a tiered tower.
 *  - Glass and spandrel get genuinely different material response: glass is
 *    smooth and metallic and picks up the environment map, concrete is rough.
 *    A texture cannot do that — roughness has to vary per-pixel.
 *  - Window recess is faked with a directional edge term rather than a normal
 *    map: lit along the top reveal, shadowed along the bottom, which is what
 *    the eye actually reads as depth.
 *
 * It also costs no texture memory and stays crisp at any distance, where the
 * old atlas turned to mush from across the plaza.
 */

const FACADE_PARS = /* glsl */ `
  varying vec3 vFacadeLocal;   // position in metres, centred on the box
  varying vec3 vFacadeNormal;  // object-space normal
  varying float vFacadeY;      // world height, for floor alignment and grime
  varying float vFacadeSeed;   // per-instance variation
`;

// Injected after <begin_vertex> so `transformed` is available.
const FACADE_VERTEX = /* glsl */ `
  #ifdef USE_INSTANCING
    // Recover the instance's world size from the matrix columns. The geometry
    // is a unit box, so position * scale is the real extent in metres.
    vec3 facadeScale = vec3(
      length(instanceMatrix[0].xyz),
      length(instanceMatrix[1].xyz),
      length(instanceMatrix[2].xyz)
    );
    // A cheap per-instance seed from the translation column, so two towers of
    // identical size still light different windows.
    vFacadeSeed = fract(dot(instanceMatrix[3].xyz, vec3(0.0731, 0.1379, 0.0517)));
  #else
    vec3 facadeScale = vec3(1.0);
    vFacadeSeed = 0.0;
  #endif

  vFacadeLocal = transformed * facadeScale;
  vFacadeNormal = normal;

  vec4 facadeWorld = modelMatrix
    #ifdef USE_INSTANCING
      * instanceMatrix
    #endif
    * vec4(transformed, 1.0);
  vFacadeY = facadeWorld.y;
`;

const FACADE_COMMON = /* glsl */ `
  float facadeHash(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  // Storey and bay sizes, in metres. Everything below keys off these two
  // numbers, which is what keeps the whole city on one consistent scale.
  const float FLOOR_H = 3.6;
  const float BAY_W = 2.6;

  struct Facade {
    float glass;     // 1 inside a window pane
    float mullion;   // vertical divider between bays
    float slab;      // horizontal floor band
    float lit;       // window is lit from inside
    float reveal;    // signed edge term used to fake recess depth
    vec3 litColor;
    float podium;    // 1 on the ground-floor shopfront band
  };

  Facade facadeAt(vec2 uv, float seed, float worldY) {
    Facade f;

    vec2 cell = vec2(uv.x / BAY_W, worldY / FLOOR_H);
    vec2 id = floor(cell);
    vec2 g = fract(cell);

    // Window pane, inset within its bay.
    float px = smoothstep(0.13, 0.17, g.x) * (1.0 - smoothstep(0.83, 0.87, g.x));
    float py = smoothstep(0.17, 0.21, g.y) * (1.0 - smoothstep(0.74, 0.78, g.y));
    f.glass = px * py;

    // Structure between the panes.
    f.mullion = 1.0 - smoothstep(0.03, 0.07, abs(g.x - 0.5) - 0.42);
    f.slab = 1.0 - smoothstep(0.02, 0.06, abs(g.y - 0.9) - 0.06);

    // The reveal: positive just under the head of the window, negative just
    // above the sill. Reads as a recessed pane without a normal map.
    f.reveal = smoothstep(0.78, 0.72, g.y) * smoothstep(0.66, 0.74, g.y)
             - smoothstep(0.17, 0.23, g.y) * smoothstep(0.29, 0.23, g.y);

    // Lit windows. A run of a whole floor is lit occasionally, which reads as
    // an office corridor and breaks up pure per-window noise.
    float floorRand = facadeHash(vec2(id.y, seed * 71.3));
    float cellRand = facadeHash(id + seed * 37.1);
    float floorLit = step(0.86, floorRand);
    f.lit = max(step(0.62, cellRand), floorLit * step(0.25, cellRand));

    // Colour picked from the palette by hash, so a building's windows vary
    // without leaving the green/blue/purple script.
    float pick = facadeHash(id.yx + seed * 11.7);
    vec3 a = vec3(0.78, 0.96, 0.90);   // pale mint
    vec3 b = vec3(0.62, 0.83, 1.00);   // pale blue
    vec3 c = vec3(0.76, 0.71, 1.00);   // pale violet
    f.litColor = pick < 0.4 ? a : (pick < 0.75 ? b : c);
    // A few windows burn brighter, as if a lamp sits against the glass. Kept
    // modest: this multiplies an already-bright emissive, and at high values
    // every pane clips to white through the tone mapper.
    f.litColor *= 1.0 + step(0.93, facadeHash(id + seed * 5.3)) * 0.7;

    // Ground-floor shopfronts. Confined to roughly one storey — spilling it
    // over two made every building wear a solid white band at eye level, which
    // is the first thing you see and the last thing you want.
    f.podium = (1.0 - smoothstep(FLOOR_H * 0.8, FLOOR_H * 1.4, worldY))
             * (0.45 + 0.55 * step(0.35, cellRand));

    return f;
  }
`;

/**
 * Builds the tower material. `onBeforeCompile` patches MeshStandardMaterial so
 * the facade drives diffuse, roughness, metalness and emissive together —
 * which is the whole point, since a map can only drive one of them.
 */
export function createFacadeMaterial({ seedOffset = 0 } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.concrete),
    roughness: 0.85,
    metalness: 0.05,
    envMapIntensity: 0.7,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSeedOffset = { value: seedOffset };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FACADE_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FACADE_VERTEX}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_PARS}\n${FACADE_COMMON}\nuniform float uSeedOffset;`)

      // Diffuse: concrete, grimier towards the street, with structure picked
      // out slightly lighter than the spandrel panels between floors.
      .replace('#include <map_fragment>', /* glsl */ `
        #include <map_fragment>

        vec3 an = abs(vFacadeNormal);
        bool isWall = an.y < 0.5;
        vec2 facadeUV = an.x > 0.5 ? vec2(vFacadeLocal.z, 0.0) : vec2(vFacadeLocal.x, 0.0);
        Facade fac = facadeAt(facadeUV, vFacadeSeed + uSeedOffset, vFacadeY);

        if (isWall) {
          vec3 spandrel = diffuseColor.rgb * 0.82;
          vec3 structure = diffuseColor.rgb * 1.22;
          vec3 glassTint = vec3(0.035, 0.055, 0.10);

          vec3 wall = mix(spandrel, structure, max(fac.mullion, fac.slab));
          diffuseColor.rgb = mix(wall, glassTint, fac.glass);

          // Recess shading, then street grime rising off the pavement.
          diffuseColor.rgb *= 1.0 + fac.reveal * 0.55;
          diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.0, 14.0, vFacadeY));
        } else {
          // Roof decks: plain, slightly darker than the walls.
          diffuseColor.rgb *= 0.7;
        }
      `)

      // Glass is smooth and metallic so it actually mirrors the sky; concrete
      // stays rough. This split is the part a texture atlas cannot express.
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        if (isWall) roughnessFactor = mix(roughnessFactor, 0.08, fac.glass);
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */ `
        #include <metalnessmap_fragment>
        if (isWall) metalnessFactor = mix(metalnessFactor, 0.9, fac.glass);
      `)

      // Emissive: the lit windows themselves, tinted per instance.
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        if (isWall) {
          float on = max(fac.lit, fac.podium * 0.8);
          vec3 windowLight = fac.litColor * fac.glass * on;
          // vColor carries the per-building tint from instanceColor.
          #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
            windowLight *= vColor.rgb;
          #endif
          totalEmissiveRadiance += windowLight * 0.55;

          // A warm-ish sill line under lit windows, so light appears to spill.
          totalEmissiveRadiance += fac.litColor * fac.slab * on * 0.05;
        }
      `);
  };

  // Distinct key per variant, otherwise three reuses one compiled program for
  // every material that shares the standard shader.
  mat.customProgramCacheKey = () => `kaisei-facade-${seedOffset}`;
  return mat;
}
