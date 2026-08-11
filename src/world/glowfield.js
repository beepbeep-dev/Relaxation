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

    // Billboard in view space. Doing it per-vertex means it is correct in both
    // eyes of a stereo pair for free, with the CPU never touching it.
    vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
    mv.xy += position.xy * aSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  #include <common>

  uniform sampler2D uMap;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;

  void main() {
    float a = texture2D(uMap, vUv).r * vOpacity;
    if (a < 0.002) discard;
    // Premultiplied against additive blending: the alpha channel is unused by
    // the blend, so the colour carries the whole falloff.
    gl_FragColor = vec4(vColor * a, a);

    // ShaderMaterial (unlike RawShaderMaterial) resolves these includes, so
    // the glows go through the same ACES curve and sRGB encode as everything
    // else. Skipping them makes every light source blow out to a flat disc.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Every additive glow in the world, in one draw call.
 *
 * Standalone VR is draw-call bound long before it is fill or vertex bound, and
 * the first build of this city spent most of its calls on individual glow
 * sprites — street lamps, neon halos, lanterns, boost gates. Batching them
 * into one instanced quad buffer took the scene from over budget to well
 * inside it, and per-glow colour, size and opacity all survive as instance
 * attributes so they can still be animated.
 *
 * Usage: `add()` during world construction, `build()` once when everything is
 * registered, then animate through the returned handles.
 */
export class GlowField {
  constructor(texture) {
    this.texture = texture;
    this._entries = [];
    this.mesh = null;
  }

  /** Reserve a glow. Returns a handle for animating it after build(). */
  add(position, color, size, opacity = 1) {
    const index = this._entries.length;
    this._entries.push({
      pos: position.clone ? position.clone() : new THREE.Vector3(...position),
      color: new THREE.Color(color).convertSRGBToLinear(),
      size,
      opacity,
    });
    return new GlowHandle(this, index);
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

    this.aOffset = new THREE.InstancedBufferAttribute(offset, 3);
    this.aColor = new THREE.InstancedBufferAttribute(color, 3);
    this.aSize = new THREE.InstancedBufferAttribute(size, 1);
    this.aOpacity = new THREE.InstancedBufferAttribute(opacity, 1);

    geo.setAttribute('aOffset', this.aOffset);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aOpacity', this.aOpacity);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uMap: { value: this.texture } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;   // instances span the whole city
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
    return this.mesh;
  }

  setOpacity(i, v) {
    if (!this.aOpacity) return;
    this.aOpacity.array[i] = v;
    this.aOpacity.needsUpdate = true;
  }

  setSize(i, v) {
    if (!this.aSize) return;
    this.aSize.array[i] = v;
    this.aSize.needsUpdate = true;
  }

  setPosition(i, x, y, z) {
    if (!this.aOffset) return;
    this.aOffset.array.set([x, y, z], i * 3);
    this.aOffset.needsUpdate = true;
  }
}

class GlowHandle {
  constructor(field, index) {
    this.field = field;
    this.index = index;
  }
  set opacity(v) { this.field.setOpacity(this.index, v); }
  set size(v) { this.field.setSize(this.index, v); }
  setPosition(x, y, z) { this.field.setPosition(this.index, x, y, z); }
}
