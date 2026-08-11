# Rendering — hitting a modern look inside a Quest 3 frame budget

The brief was "2017 AAA, or at least modern, while running on a Quest 3." This document is what that translated into, what was traded away, and where the ceiling actually is.

---

## 1. The honest version of the target

A Quest 3 renders **two eyes at 90 Hz**. That is a frame budget of about **11 ms for both eyes combined**, on a mobile Adreno 740. The same silicon class runs a phone. A 2017 AAA console game had roughly 33 ms for *one* 1080p eye on hardware with an order of magnitude more bandwidth.

So the literal comparison is not winnable, and any document promising it is lying. What *is* winnable is the thing that actually makes those games read as expensive, which is not polygon count:

- a filmic response curve instead of raw linear light
- physically-plausible materials lit by a real environment, so reflections agree with the sky
- a committed colour script — here green, blue and purple, and near-nothing else
- believable light sources with falloff and bloom-like bleed
- depth cueing through fog and parallax

All five of those are cheap. Geometry and texture density, which is what people usually reach for first, are the expensive ones and contribute least. This project spends everything on the first list and almost nothing on the second.

Running in the **browser** rather than natively costs perhaps another 15–20% on top, and rules out some native-only wins (application spacewarp, aggressive fixed-foveation tuning, compute shaders). That is the price of you being able to open a URL in the headset and play the thing today.

---

## 2. What the frame actually does

### Tone mapping and colour
`ACESFilmicToneMapping` with exposure 1.05, sRGB output. Every colour in the codebase is authored in sRGB and converted to linear at construction. This single pair of settings is the largest visual-quality lever in the entire project.

A trap worth recording: **custom shaders are not tone mapped or colour-encoded for you.** A `ShaderMaterial` gets neither unless its fragment shader ends with `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`, and a `RawShaderMaterial` cannot use those includes at all. The skydome and the glow field both shipped broken in a first pass — writing raw linear values into an sRGB framebuffer rendered the entire sky near-black — until both were switched to `ShaderMaterial` with the includes appended.

### Lighting: two lights, total
- One directional key, pale blue (`#9fd4ff`), casting the only shadow map.
- One hemisphere fill, blue-green sky over purple ground bounce.

That is it. Every other apparent light in the city — every window, sign, lamp, lantern, beacon, rail and boost gate — is emissive material or an additive billboard. Real point lights are the fastest way to destroy a mobile frame budget, and they buy almost nothing here, because a neon sign's job is to *be* bright, not to light the street correctly.

Colour contrast between lit and shadowed surfaces reads as production value far more reliably than light count does. See the colour script below for how that contrast is built without a warm/cool split.

### Reflections: one baked environment map
The procedural skydome is rendered once at boot into a PMREM cubemap (128px at the Balanced preset), which becomes `scene.environment`. Every metal, every wet surface, the reflecting pool and the road all get their reflections from that single texture.

This replaces reflection probes, screen-space reflections and planar reflections — none of which are affordable here — with one texture generated in a few milliseconds at startup. The wet road catching the horizon is entirely this.

The flip side is that the environment map *is* the sky, so whatever the sky's strongest colour is will be smeared across every reflective surface in the world. Keeping `envMapIntensity` low on the road (0.5) is what stops it becoming a mirror of one hue — see the colour script below.

### The sky
An analytic three-stop gradient (zenith → mid → horizon) plus a sun disc, a forward-scatter halo, and a hash-based star field, in about 30 lines of GLSL. The stars cost no texture, no geometry and no draw call.

The horizon term needs a **very** steep exponent. The horizon colour is far brighter in at least one channel than the zenith is in any, so a gentle falloff bleeds it across the whole dome and the entire city ends up sitting inside one flat wash — which is exactly what the first version did. The exponent is 9.

### The colour script
The palette is green, blue and purple, and it lives in exactly one module (`src/world/palette.js`). Centralising it is not tidiness for its own sake: a limited palette only reads as *deliberate* if it is enforced, and the fastest way for one to rot is a stray hex code in a mesh constructor six files away.

The roles are fixed. **Purple** is the zenith and the shadows, so nothing unlit is ever neutral grey. **Blue** is the mid-tone and the key light, so most surfaces read blue. **Green** is the horizon and every affordance — the race pad, the boost gates, the lit edge of a walkable ramp. Green is the rarest of the three, which is precisely why it works as the "look here" colour.

This replaces the warm-key/cool-fill split a daylight scene would normally use with a green/purple split across a blue mid-tone. That is a wider hue spread than the amber/navy it replaced, and it holds up better in a headset.

Two calibration traps, both hit during this pass:

- **A saturated hemisphere fill tints every upward-facing surface.** At the intensity a neutral fill would want, a green one turns the entire street into a lawn. It is now at 0.42 and exists for hue separation in shadow, not for brightness — the key light and the emissive city do the lifting.
- **A low sun means the ground is lit by the environment map alone.** At 0.16 elevation the key light grazed so shallowly that N·L was near zero, and the road rendered as a flat mirror of the sky's single strongest colour. Raising it to 0.3 keeps the dusk angle on the tower faces while actually keying the ground.

### No post-processing, on purpose
There is no `EffectComposer`, no bloom pass, no SSAO, no colour-grade pass.

On a Quest, a full-screen post stack forces the renderer **off multiview** and onto two full-resolution offscreen passes per frame, plus the blur chain itself. That is roughly a third of the frame budget spent before a single building is drawn.

Instead, "bloom" is **emissive materials plus one batched field of additive billboards**. Multiview renders those for free, and the art direction — a dark city full of small bright sources — is exactly the case where fake bloom is indistinguishable from real bloom.

### Draw calls are the real budget
On a tile-based mobile GPU, **draw call count matters far more than triangle count**. The scene currently renders in:

```
51 draw calls, ~24,000 triangles
```

That number is asserted by the smoke test, which fails the build above 120.

How it stays there:
- **Instancing everywhere.** All towers are one `InstancedMesh`; so are pavements, lamp posts, aircars, deck columns, railings, lanterns, track dashes and boost gates.
- **Merged static geometry.** Every neon sign in the city merges into a single mesh carrying its colours as vertex attributes. They are self-lit, so an unlit vertex-coloured material is indistinguishable from an emissive one and costs one call instead of one per sign.
- **One glow field.** Every additive halo in the world — lamps, signs, lanterns, ramp lights, rooftop beacons, vending machines, boost gates — is one instanced quad buffer with per-instance colour, size and opacity, billboarded in the vertex shader. This alone took the scene from 125 calls to 34.
- **A merged skyline.** The ring of distant towers beyond the playable streets is one static mesh. Pure silhouette — no windows, no lighting response, just fog and parallax — for one draw call across the entire horizon.

Billboarding in the vertex shader rather than on the CPU matters in VR specifically: it is correct in both eyes of a stereo pair for free, and the CPU never touches it.

### Per-instance colour has one sharp edge
`instanceColor` multiplies the **diffuse** term, not emissive. Two features were silently dead until this was found: per-building window tint (on an emissive facade map) and the boost gates' hit/miss feedback (on an emissive neon material whose base colour is black — multiplying black by anything is black).

Fixes:
- Towers patch the shader via `onBeforeCompile` to move `vColor` off diffuse and onto `totalEmissiveRadiance`, so the tint lands on the lit windows where it was always meant to.
- Gate rings use an unlit `MeshBasicMaterial`, where the instance colour *is* the output, with values above 1.0 so the tone mapper turns the overshoot into a hot core.

### Facades are computed, not textured
Buildings were the weakest thing in the scene for a long time, and the reason was structural rather than a matter of tuning: they were scaled boxes wearing one 512px emissive window texture. Stretching a single texture across buildings from 9m to 60m wide gives every building a *different storey height*, and a skyline where storey height varies per building is the most obvious tell that a city is not real.

The facade is now evaluated in the fragment shader from **world-space metres**: a storey is 3.6m and a window bay 2.6m everywhere, and the vertical axis keys off world Y so floor lines run continuously across the separate boxes that make up one tiered tower. Glass and spandrel get genuinely different material response — glass is smooth and metallic and picks up the environment map, concrete stays rough — which no single map can express, since a map drives one channel. Window recess is a directional edge term, lit at the head and shadowed at the sill, rather than a normal map.

It also costs zero texture memory and stays crisp at any distance, where the atlas turned to mush from across the plaza.

**Massing** matters as much as surface. Each building is a wider street-level podium, one to three shaft tiers stepping back as they rise, a crown on the tall ones, and a parapet slab capping every tier. Setbacks are what make a skyline read as architecture rather than as a bar chart, and since every box lives in the same InstancedMesh they cost no draw calls.

### Light pools on the wet road
The road reflects the baked environment map, which is the *sky* — so a city full of neon had a street reflecting none of it. Proper planar reflections or SSR are both unaffordable here, so each light source also registers a flat additive quad lying on the road in its own colour. One instanced draw call for the whole city.

Two things went wrong building it, both worth recording. The pools were first placed just above the road, which buried every one of them under the 12cm pavement slabs. And mapping the quad's `(x, y, 0)` into `(x, 0, y)` is a **reflection, not a rotation** — it reverses triangle winding, so every pool was back-facing seen from above and silently culled. Ground decals want `DoubleSide`.

### Textures are generated, not shipped
Every texture — concrete and asphalt roughness and normal maps, two window facade variants, the puddle mask, the glow falloff — is drawn on a 2D canvas at boot. No downloads, no atlas budget, and every surface is a tunable parameter rather than an asset needing re-export.

Two caveats learned the hard way:

- **Canvas radial gradients dither.** Since the glow quads are magnified to metres across in world space, that dithering showed up as a ring of speckles around every light. The falloff is now written per-pixel with an analytic curve.
- **Texture repeat has to be set against world extent, not by feel.** The puddle mask repeated 4 times across a ground plane 500 m on a side, making each puddle 126 m wide — so the road was one uniform sheet rather than the patchy wet asphalt the mask exists to produce. It repeats 48 times now.

### Motion is driven on the GPU
Aircars and rain both used to run a JavaScript loop per frame — thousands of operations plus an instance-matrix upload. Both are now computed in the vertex shader from a single time uniform, with per-instance lane, speed and phase as attributes. The CPU cost of all city motion is now two float writes per frame regardless of how many cars or drops there are.

The update paths that remain are allocation-free. A `new THREE.Vector3()` inside a function that runs at 90 Hz is garbage, and mobile GC pauses are visible as hitches in a headset — so the racing, player, city and lounge update paths all use hoisted scratch objects.

---

## 3. Quality settings

A preset is auto-detected at boot and becomes the default; after that the player's choice wins and is persisted.

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Render scale | 0.8 | 1.0 | 1.0 | 1.25 |
| Foveation | max | max | half | off |
| Shadow map | off | 1024 | 2048 | 4096 |
| Env map | 64 | 128 | 256 | 512 |
| City blocks | 6 | 8 | 10 | 12 |
| Detail density | 0.35 | 0.7 | 1.0 | 1.4 |
| Aircars | 10 | 26 | 40 | 60 |
| Draw distance | 260 m | 440 m | 650 m | 900 m |
| Skyline rings | 1 | 2 | 3 | 4 |

**Balanced is the Quest 3 target.** High and Ultra are for PCVR and desktop.

MSAA is left **on** from Balanced up: on a tile-based GPU it resolves inside tile memory and is close to free, and aliasing on thin neon strips is one of the most immersion-breaking artifacts in VR.

### Live versus rebuild

Settings split into two classes, and the distinction matters more than it looks.

**Live** settings are applied to a running frame: render scale, foveation, shadows and shadow resolution, draw distance, fog, glow intensity, exposure, rain, comfort vignette, snap-turn angle. Changing one takes effect on the next frame.

**Rebuild** settings change how the world is *constructed* — city size, detail density, traffic count, rain density, skyline rings, reflection resolution, MSAA. These are staged and applied on reload. Tearing the scene down and rebuilding it mid-session is a multi-second black screen in a headset, which is worse than asking for a button press, so the panel stages them and shows a reload prompt instead.

`applyLive()` is the single place a live setting becomes renderer state, called both on boot and on every change, so the two paths cannot drift apart.

### Reaching the settings

Three surfaces, because a headset and a desktop have nothing in common here:

- **Boot screen** — the full panel, before entering VR.
- **Tab or G on desktop** — the same panel as an overlay.
- **A slab on your left wrist in VR** — squeeze the left grip to raise it. A DOM overlay is completely invisible inside an XR session, so anything reachable in VR has to be geometry. Aim the right controller and pull the trigger; ranges are split down the middle, left half to decrease and right half to increase. That is coarser than a slider and deliberately so — fine dragging with a 6DoF pointer at arm's length is miserable, while a two-target tap is reliable with shaky hands.

Diegetically the wrist slab is the same handheld device DRIFT is designed around, which keeps it inside the "no floating UI panels" pillar.

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
2. **Billboard light shafts** between towers, for the volumetric look the design doc asks for.
3. **Texture arrays for facades**, so towers stop sharing two window atlases.
4. **`BatchedMesh` for the prop set**, collapsing the per-type instanced meshes into a single multi-draw call.

If this graduates from prototype to production, the migration to **Unity + URP** is the point at which the native-only wins become available: application spacewarp, better fixed-foveated rendering control, GPU instancing with SRP batching, and proper occlusion culling. Every decision documented here — instancing strategy, no post stack, baked IBL, four lights, one shadow map, draw-call budget — transfers directly. The engine changes; the budget does not.

---

## 6. Verifying changes

```bash
npm run build && npm run smoke
```

The smoke test boots the built site in headless Chromium, asserts the world constructed, walks the player, simulates a full three-lap race at a fixed timestep, checks the audio graph came up, verifies that every live graphics setting actually reaches the renderer and that build-time ones are staged for reload, and **fails the build if draw calls regress past 120**. It also writes screenshots to `tools/shots/`.

`node tools/debug-shot.mjs` takes screenshots from named vantage points — useful for eyeballing a lighting change without putting a headset on. It pins the quality preset (`PRESET=high node tools/debug-shot.mjs`) so you are judging a known configuration rather than whatever the machine auto-detects, and prints the values that actually reached the renderer.

A note on that last point, learned by wasting a cycle on it: when a visual change appears to do nothing, **verify the values reached the renderer before touching the art**. A preset that failed to resolve its fields made three rounds of lighting edits look like no-ops.

Neither can tell you the real frame rate. **Nothing short of the headset can.** Both are guards against regression, not proof of performance.
