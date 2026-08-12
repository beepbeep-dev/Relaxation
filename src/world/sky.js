import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { PALETTE } from './palette.js';

const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Analytic dusk gradient. Cheaper and more art-directable than a physical sky
// model, and we only need one hour of one day.
const skyFrag = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uTime;

  // Cheap hash-based star field. No texture, no geometry, no draw call.
  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = clamp(1.0 - max(h, 0.0), 0.0, 1.0);

    // Three-stop ramp with a *very* steep horizon term. The horizon colour is
    // far brighter than the zenith in at least one channel, so a gentle
    // falloff bleeds it across the entire dome and the whole city ends up
    // sitting in one flat wash. The exponent confines it to a band just above
    // the skyline.
    vec3 col = mix(uZenith, uMid, pow(up, 2.5));
    col = mix(col, uHorizon, pow(up, 9.0));
    col = mix(col, uGround, clamp(-h * 3.0, 0.0, 1.0));

    // Stars, fading out towards the bright horizon band.
    vec2 sp = d.xz / max(abs(d.y) + 0.28, 0.001);
    vec2 cell = floor(sp * 42.0);
    float star = hash21(cell);
    if (star > 0.9915 && h > 0.02) {
      vec2 f = fract(sp * 42.0) - 0.5;
      float tw = 0.65 + 0.35 * sin(uTime * 1.7 + star * 90.0);
      float s = smoothstep(0.14, 0.0, length(f)) * tw;
      col += vec3(0.75, 0.85, 1.0) * s * smoothstep(0.02, 0.55, h) * 0.9;
    }

    // Sun disc plus a tight forward-scatter halo.
    float sun = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(sun, 1400.0) * 5.0;
    col += uSunColor * pow(sun, 22.0) * 0.16;

    gl_FragColor = vec4(col, 1.0);

    // Custom shaders are not tone mapped or encoded for us. Without these two
    // chunks the sky is written as raw linear values into an sRGB framebuffer
    // and reads as near-black next to a correctly encoded city.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Elevation matters more than it looks. At 0.16 the key light grazes the
// ground so shallowly that N·L is near zero and the street is lit *entirely*
// by the environment map — which, with a saturated horizon, paints the whole
// road one flat colour. Lifting it to 0.3 keeps the low dusk angle on the
// tower faces while actually keying the ground.
export const SUN_DIRECTION = new THREE.Vector3(-0.55, 0.3, -0.78).normalize();

const linear = (hex) => new THREE.Color(hex).convertSRGBToLinear();

/**
 * Builds the skydome and bakes it into a PMREM environment map.
 *
 * The env map is what actually sells the materials: every metal and wet
 * surface in the city gets its reflections from this one texture, so a single
 * small cubemap replaces reflection probes we cannot afford on a standalone
 * headset.
 */
export function createSky(renderer, scene) {
  const uniforms = {
    uZenith: { value: linear(PALETTE.skyZenith) },
    uMid: { value: linear(PALETTE.skyMid) },
    uHorizon: { value: linear(PALETTE.skyHorizon) },
    uGround: { value: linear(PALETTE.skyGround) },
    uSunDir: { value: SUN_DIRECTION.clone() },
    uSunColor: { value: linear(PALETTE.sunColor) },
    uTime: { value: 0 },
  };

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: true,
    })
  );
  sky.scale.setScalar(800);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  // Bake IBL once. The sky never changes, so this never needs regenerating.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const bakeScene = new THREE.Scene();
  const bakeSky = sky.clone();
  bakeSky.material = sky.material.clone();
  bakeScene.add(bakeSky);
  const envRT = pmrem.fromScene(bakeScene, 0, 0.1, 1000);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.35;
  pmrem.dispose();
  // Only the material: Object3D.clone() shares the geometry with the original,
  // so disposing the clone's would tear down the real skydome's buffers too.
  bakeSky.material.dispose();

  // Distance fog does the heavy lifting for depth separation between towers.
  scene.fog = new THREE.FogExp2(linear(PALETTE.fog), QUALITY.fogDensity);

  return {
    sky,
    uniforms,
    envMap: envRT.texture,
    update(dt, ctx) { uniforms.uTime.value = ctx.elapsed; },
  };
}

/** Key light + fill. Two lights is the whole budget for the city. */
export function createLighting(scene) {
  // A player reported seeing "no textures". The textures were fine — the
  // frame was too dark to read them: median pixel brightness 4/255, with 78%
  // of the screen below 25/255. That is not a moody night scene, it is an
  // unreadable one.
  //
  // The fix was not here. Isolating each light source one at a time showed
  // the key light barely registers against the baked environment map, so
  // exposure (see core/settings.js) is what actually lifted the image, from
  // a median of 4 to 31. This value is raised anyway so the key light does
  // something on vertical faces, but do not expect it to move the ground.
  const sun = new THREE.DirectionalLight(linear(PALETTE.keyLight), 5.2);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(140);
  sun.castShadow = QUALITY.shadows;
  if (QUALITY.shadows) {
    sun.shadow.mapSize.set(QUALITY.shadowMapSize, QUALITY.shadowMapSize);
    const c = sun.shadow.camera;
    c.left = -60; c.right = 60; c.top = 60; c.bottom = -60;
    c.near = 1; c.far = 320;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.035;
  }
  scene.add(sun);
  scene.add(sun.target);

  // Hue separation in shadow only. Measurement settled a long-standing
  // misconception here: switching the environment map off drops the whole
  // frame to a median of 1/255, so the baked IBL — not these two lights — is
  // supplying essentially all the illumination. Raising this fill from 0.42
  // to 4.0 changed the rendered ground by one 8-bit level. It is here for the
  // green/purple split against neutral grey, and for nothing else.
  const fill = new THREE.HemisphereLight(
    linear(PALETTE.fillSky),
    linear(PALETTE.fillGround),
    0.32
  );
  scene.add(fill);

  return { sun, fill };
}
