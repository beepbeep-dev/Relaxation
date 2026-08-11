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
  uniform float uIntensity;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpacity;

  void main() {
    float a = texture2D(uMap, vUv).r * vOpacity * uIntensity;
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
  constructor(texture, intensity = 1, reserve = 96) {
    this.texture = texture;
    this._entries = [];
    this.mesh = null;
    this._intensity = intensity;

    // Spare slots for glows created *after* build — enemy halos, anything
    // spawned during play. Without a pool, a late add() hands back an index
    // past the end of the instance buffers and the first write walks off the
    // array, which is exactly what a runtime spawn did.
    this._reserve = reserve;
    this._free = [];
    this._capacity = 0;
  }

  /** Global multiplier, driven live from the graphics settings. */
  setIntensity(v) {
    this._intensity = v;
    if (this.mesh) this.mesh.material.uniforms.uIntensity.value = v;
  }

  /**
   * Reserve a glow. Before build() this appends to the static set; after
   * build() it claims a pooled slot, so systems that spawn during play use the
   * identical call and still cost no extra draw call.
   */
  add(position, color, size, opacity = 1) {
    const pos = position.clone ? position.clone() : new THREE.Vector3(...position);
    const col = new THREE.Color(color).convertSRGBToLinear();

    if (!this.mesh) {
      const index = this._entries.length;
      this._entries.push({ pos, color: col, size, opacity });
      return new GlowHandle(this, index);
    }

    const index = this._free.pop();
    if (index === undefined) {
      // Pool exhausted. Hand back an inert handle rather than corrupting the
      // buffers — a missing halo is a cosmetic loss, a stray write is a crash.
      return new GlowHandle(this, -1);
    }
    this.aOffset.setXYZ(index, pos.x, pos.y, pos.z);
    this.aColor.setXYZ(index, col.r, col.g, col.b);
    this.aOffset.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.setSize(index, size);
    this.setOpacity(index, opacity);
    return new GlowHandle(this, index);
  }

  /** Return a pooled slot so it can be reused. Static slots are never freed. */
  release(handle) {
    if (!handle || handle.index < this._staticCount || handle.index < 0) return;
    this.setOpacity(handle.index, 0);
    this._free.push(handle.index);
  }

  build(scene) {
    this._staticCount = this._entries.length;
    const n = this._entries.length + this._reserve;
    if (n === 0) return null;
    this._capacity = n;
    for (let i = this._staticCount; i < n; i++) this._free.push(i);

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
    // Pooled slots start invisible.
    for (let i = this._staticCount; i < n; i++) { size[i] = 1; opacity[i] = 0; }

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
      uniforms: {
        uMap: { value: this.texture },
        uIntensity: { value: this._intensity },
      },
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
    if (!this.aOpacity || i < 0 || i >= this._capacity) return;
    this.aOpacity.array[i] = v;
    this.aOpacity.needsUpdate = true;
  }

  setSize(i, v) {
    if (!this.aSize || i < 0 || i >= this._capacity) return;
    this.aSize.array[i] = v;
    this.aSize.needsUpdate = true;
  }

  setPosition(i, x, y, z) {
    if (!this.aOffset || i < 0 || i >= this._capacity) return;
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
