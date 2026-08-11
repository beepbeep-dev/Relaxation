import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';

const skyVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Analytic dusk gradient. Cheaper and more art-directable than a physical sky
// model, and we only need one hour of one day: permanent golden hour.
const skyFrag = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;

  void main() {
    vec3 d = normalize(vDir);

    float h = d.y;
    float up = clamp(1.0 - max(h, 0.0), 0.0, 1.0);

    // Three-stop ramp with a *very* steep horizon term. The warm colour is
    // roughly two orders of magnitude brighter in red than the zenith is in
    // any channel, so a gentle falloff bleeds red across the entire dome and
    // the whole city ends up sitting inside a furnace. The exponent has to be
    // steep enough to confine it to a band just above the skyline.
    vec3 col = mix(uZenith, uMid, pow(up, 2.5));
    col = mix(col, uHorizon, pow(up, 9.0));
    col = mix(col, uGround, clamp(-h * 3.0, 0.0, 1.0));

    // Sun disc plus a wide forward-scatter halo.
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

export const SUN_DIRECTION = new THREE.Vector3(-0.55, 0.16, -0.82).normalize();

/**
 * Builds the skydome and bakes it into a PMREM environment map.
 *
 * The env map is what actually sells the materials: every metal and wet
 * surface in the city gets its reflections from this one texture, so a single
 * 128px cubemap replaces what would otherwise be reflection probes we cannot
 * afford on a standalone headset.
 */
export function createSky(renderer, scene) {
  const uniforms = {
    uZenith: { value: new THREE.Color('#0b1430').convertSRGBToLinear() },
    uMid: { value: new THREE.Color('#37507f').convertSRGBToLinear() },
    uHorizon: { value: new THREE.Color('#ffab6b').convertSRGBToLinear() },
    uGround: { value: new THREE.Color('#080a11').convertSRGBToLinear() },
    uSunDir: { value: SUN_DIRECTION.clone() },
    uSunColor: { value: new THREE.Color('#ffb27a').convertSRGBToLinear() },
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
  scene.environmentIntensity = 1.0;
  pmrem.dispose();
  // Only the material: Object3D.clone() shares the geometry with the original,
  // so disposing the clone's would tear down the real skydome's buffers too.
  bakeSky.material.dispose();

  // Distance fog does the heavy lifting for depth separation between towers.
  scene.fog = new THREE.FogExp2(new THREE.Color('#16203c').convertSRGBToLinear(), 0.0052);

  return { sky, uniforms, envMap: envRT.texture };
}

/** Key light + fill. Four lights total is the whole budget for the city. */
export function createLighting(scene) {
  const sun = new THREE.DirectionalLight(new THREE.Color('#ffd0ac'), 1.5);
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

  // Cool sky bounce against the warm key — the colour contrast reads as
  // "expensive" far more than extra light count would.
  const fill = new THREE.HemisphereLight(
    new THREE.Color('#7396d8'),
    new THREE.Color('#1c1620'),
    0.85
  );
  scene.add(fill);

  return { sun, fill };
}
