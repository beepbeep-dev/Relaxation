import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aOpacity;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;

  void main() {
    vUv = uv;
    vColor = aColor;
    vOpacity = aOpacity;

    // Flat on the ground, not camera-facing. The quad's own XY is rotated into
    // the world XZ plane, so the pool stays pinned to the road as you walk
    // past it — a billboard would swing around and read as a floating sprite.
    vec3 local = vec3(position.x, 0.0, position.y) * aSize;
    vec4 world = modelMatrix * vec4(aOffset + local, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAG = /* glsl */ `
  #include <common>

  uniform float uIntensity;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;

  void main() {
    // A broad, soft falloff computed here rather than sampled from the shared
    // glow sprite. That sprite is tuned for point sources — a tight core with
    // a fast rolloff — which as a ground pool reads as a small hot dot instead
    // of the wide wash a light actually throws across wet asphalt.
    float d = length(vUv - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 1.8) * vOpacity * uIntensity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor * a, a);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Pools of coloured light lying on the wet road.
 *
 * The street material reflects the baked environment map, which is the sky —
 * so a city full of neon had a road that reflected none of it. Real wet
 * asphalt under a neon sign is mostly a smeared pool of that sign's colour.
 *
 * Doing this properly means planar reflections or SSR, and neither is
 * affordable on a standalone headset. This is the cheap version that reads
 * almost as well: one additive quad per light source, laid flat on the ground
 * in its own colour. The whole city's worth is a single instanced draw call.
 *
 * Kept separate from GlowField because these are ground-plane oriented rather
 * than camera-facing, and mixing the two orientations in one buffer would mean
 * branching per vertex for no benefit.
 */
export class LightPools {
  constructor(texture, intensity = 1) {
    this.texture = texture;
    this._entries = [];
    this.mesh = null;
    this._intensity = intensity;
  }

  add(position, color, size, opacity = 1) {
    this._entries.push({
      pos: position.clone ? position.clone() : new THREE.Vector3(...position),
      color: new THREE.Color(color).convertSRGBToLinear(),
      size,
      opacity,
    });
  }

  setIntensity(v) {
    this._intensity = v;
    if (this.mesh) this.mesh.material.uniforms.uIntensity.value = v;
  }

  build(scene) {
    const n = this._entries.length;
    if (n === 0) return null;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    geo.instanceCount = n;

    const offset = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const opacity = new Float32Array(n);

    this._entries.forEach((e, i) => {
      offset.set([e.pos.x, e.pos.y, e.pos.z], i * 3);
      color.set([e.color.r, e.color.g, e.color.b], i * 3);
      size[i] = e.size;
      opacity[i] = e.opacity;
    });

    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offset, 3));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1));
    geo.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(opacity, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uIntensity: { value: this._intensity } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      // Swapping the quad's y into world z is a reflection, not a rotation, so
      // it reverses triangle winding — every pool was back-facing when viewed
      // from above and got culled. A ground decal should be visible from both
      // sides anyway.
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    // Drawn after the road so it lands on top of it, before the camera-facing
    // glows so a lamp's halo still reads as nearer than its pool.
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    return this.mesh;
  }
}
