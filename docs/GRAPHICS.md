# Rendering — hitting a modern look inside a Quest 3 frame budget

The brief was "2017 AAA, or at least modern, while running on a Quest 3." This document is what that translated into, what was traded away, and where the ceiling actually is.

---

## 1. The honest version of the target

A Quest 3 renders **two eyes at 90 Hz**. That is a frame budget of about **11 ms for both eyes combined**, on a mobile Adreno 740. The same silicon class runs a phone. A 2017 AAA console game had roughly 33 ms for *one* 1080p eye on hardware with an order of magnitude more bandwidth.

So the literal comparison is not winnable, and any document promising it is lying. What *is* winnable is the thing that actually makes those games read as expensive, which is not polygon count:

- a filmic response curve instead of raw linear light
- physically-plausible materials lit by a real environment, so reflections agree with the sky
- a committed colour script — one warm key, one cool fill, and near-nothing else
- believable light sources with falloff and bloom-like bleed
- depth cueing through fog and parallax

All five of those are cheap. Geometry and texture density, which is what people usually reach for first, are the expensive ones and contribute least. This project spends everything on the first list and almost nothing on the second.

Running in the **browser** rather than natively costs perhaps another 15–20% on top, and rules out some native-only wins (application spacewarp, aggressive fixed-foveation tuning, compute shaders). That is the price of you being able to open a URL in the headset and play the thing today.

---

## 2. What the frame actually does

### Tone mapping and colour
`ACESFilmicToneMapping` with exposure 0.95, sRGB output. Every colour in the codebase is authored in sRGB and converted to linear at construction. This single pair of settings is the largest visual-quality lever in the entire project.

A trap worth recording: **custom shaders are not tone mapped or colour-encoded for you.** A `ShaderMaterial` gets neither unless its fragment shader ends with `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`, and a `RawShaderMaterial` cannot use those includes at all. The skydome and the glow field both shipped broken in a first pass — writing raw linear values into an sRGB framebuffer rendered the entire sky near-black — until both were switched to `ShaderMaterial` with the includes appended.

### Lighting: four lights, total
- One directional key, warm (`#ffd0ac`), casting the only shadow map.
- One hemisphere fill, cool sky over warm ground bounce.

That is it. Every other apparent light in the city — every window, sign, lamp, lantern, rail and boost gate — is emissive material or an additive billboard. Real point lights are the fastest way to destroy a mobile frame budget, and they buy almost nothing here, because a neon sign's job is to *be* bright, not to light the street correctly.

The warm-key/cool-fill split is doing most of the work. Colour contrast between lit and shadowed surfaces reads as production value far more reliably than light count does.

### Reflections: one baked environment map
The procedural skydome is rendered once at boot into a **128px PMREM cubemap**, which becomes `scene.environment`. Every metal, every wet surface, the reflecting pool and the road all get their reflections from that single texture.

This replaces reflection probes, screen-space reflections and planar reflections — none of which are affordable here — with one texture generated in a few milliseconds at startup. The wet road catching the sunset is entirely this.

### The sky
An analytic three-stop gradient (zenith → mid → horizon) plus a sun disc and forward-scatter halo, in about 20 lines of GLSL.

The horizon term needs a **very** steep exponent. The warm horizon colour is roughly two orders of magnitude brighter in red than the zenith is in any channel, so a gentle falloff bleeds red across the whole dome and the entire city ends up sitting inside a furnace — which is exactly what the first version did. The exponent is 9.

### No post-processing, on purpose
There is no `EffectComposer`, no bloom pass, no SSAO, no colour-grade pass.

On a Quest, a full-screen post stack forces the renderer **off multiview** and onto two full-resolution offscreen passes per frame, plus the blur chain itself. That is roughly a third of the frame budget spent before a single building is drawn.

Instead, "bloom" is **emissive materials plus one batched field of additive billboards**. Multiview renders those for free, and the art direction — a dark city full of small bright sources — is exactly the case where fake bloom is indistinguishable from real bloom.

### Draw calls are the real budget
On a tile-based mobile GPU, **draw call count matters far more than triangle count**. The scene currently renders in:

```
34 draw calls, ~8,600 triangles
```

That number is asserted by the smoke test, which fails the build above 120.

How it stays there:
- **Instancing everywhere.** All towers are one `InstancedMesh`; so are pavements, lamp posts, aircars, deck columns, railings, lanterns, track dashes and boost gates.
- **Merged static geometry.** Every neon sign in the city merges into a single mesh carrying its colours as vertex attributes. They are self-lit, so an unlit vertex-coloured material is indistinguishable from an emissive one and costs one call instead of one per sign.
- **One glow field.** Every additive halo in the world — lamps, signs, lanterns, ramp lights, boost gates — is one instanced quad buffer with per-instance colour, size and opacity, billboarded in the vertex shader. This alone took the scene from 125 calls to 34.

Billboarding in the vertex shader rather than on the CPU matters in VR specifically: it is correct in both eyes of a stereo pair for free, and the CPU never touches it.

### Per-instance colour has one sharp edge
`instanceColor` multiplies the **diffuse** term, not emissive. Two features were silently dead until this was found: per-building window tint (on an emissive facade map) and the boost gates' hit/miss feedback (on an emissive neon material whose base colour is black — multiplying black by anything is black).

Fixes:
- Towers patch the shader via `onBeforeCompile` to move `vColor` off diffuse and onto `totalEmissiveRadiance`, so the tint lands on the lit windows where it was always meant to.
- Gate rings use an unlit `MeshBasicMaterial`, where the instance colour *is* the output, with values above 1.0 so the tone mapper turns the overshoot into a hot core.

### Textures are generated, not shipped
Every texture — concrete and asphalt roughness and normal maps, the window facade atlas, the glow falloff — is drawn on a 2D canvas at boot. No downloads, no atlas budget, and every surface is a tunable parameter rather than an asset needing re-export.

One caveat learned the hard way: **canvas radial gradients dither.** Since the glow quads are magnified to metres across in world space, that dithering showed up as a ring of speckles around every light. The falloff is now written per-pixel with an analytic curve.

---

## 3. Quality tiers

One tier is chosen at boot from the user agent and never changes mid-session — a resolution or shadow-map switch mid-flight is a visible hitch in a headset, which is worse than the frames it buys.

| | quest | desktop | low |
|---|---|---|---|
| Pixel ratio | 1 | up to 2 | 1 |
| Foveation | 1.0 (max) | 0 | 1.0 |
| Shadow map | 1024 | 2048 | off |
| Env map | 128 | 256 | 64 |
| City blocks | 8 | 10 | 6 |
| Aircars | 26 | 40 | 12 |
| Draw distance | 420 m | 700 m | 300 m |

MSAA is left **on** for the headset tier: on a tile-based GPU it resolves inside tile memory and is close to free, and aliasing on thin neon strips is one of the most immersion-breaking artifacts in VR.

---

## 4. What is deliberately not here

- **Shadows from anything but the sun.** One shadow map, 60 m across.
- **Transparency**, beyond the additive glows and one cockpit canopy. Sorted transparency is a mobile GPU's worst case.
- **Normal-mapped characters, skinning, cloth, particles at scale.** No characters exist yet.
- **Volumetric light.** The god-rays in the design doc are not implemented; the honest cheap version is billboard shafts, and they are not in this draft.

---

## 5. Where the ceiling is, and the migration path

The current draft is comfortably inside budget — which means there is real headroom left, and the next visual gains are known:

1. **Baked lightmaps** for the static city. The single biggest remaining win; static geometry currently pays for real-time lighting it does not need.
2. **A GPU-driven aircar and rain system**, moving the last per-frame CPU loops into shaders.
3. **Billboard light shafts** between towers, for the volumetric look the design doc asks for.
4. **Texture arrays for facades**, so towers stop sharing one window atlas.

If this graduates from prototype to production, the migration to **Unity + URP** is the point at which the native-only wins become available: application spacewarp, better fixed-foveated rendering control, GPU instancing with SRP batching, and proper occlusion culling. Every decision documented here — instancing strategy, no post stack, baked IBL, four lights, one shadow map, draw-call budget — transfers directly. The engine changes; the budget does not.

---

## 6. Verifying changes

```bash
npm run build && npm run smoke
```

The smoke test boots the built site in headless Chromium, asserts the world constructed, walks the player, simulates a full three-lap race at a fixed timestep, checks the audio graph came up, and **fails the build if draw calls regress past 120**. It also writes screenshots to `tools/shots/`.

`node tools/debug-shot.mjs` takes screenshots from named vantage points — useful for eyeballing a lighting change without putting a headset on.

Neither can tell you the real frame rate. **Nothing short of the headset can.** Both are guards against regression, not proof of performance.
