# Kaisei — Unity port scaffold

This folder is the migration path described in [`docs/GRAPHICS.md`](../docs/GRAPHICS.md) §5, started rather than merely described.

## Read this first: what this is and is not

**It is** the parts of the project that are engine-independent, ported to C# and HLSL: the colour script, the quality tiers, the procedural city generator, and the facade shader — the four things that actually carry the look. Each is a direct translation of a JavaScript file that is running and verified in the WebXR build.

**It is not** a compiled, tested Unity project. There is no Unity on this machine, so none of this has been opened in the editor, compiled by Burst, or run on a headset. Treat every file here as a reviewed first draft that will need a compile pass and a play test. I would rather hand you an honest scaffold than claim a port I could not run.

That distinction matters for the shader especially: the WebGL facade is verified by screenshots; the HLSL translation below is line-for-line faithful but has never been through Unity's shader compiler.

## Why a port at all

The WebXR build exists because it runs in the Quest browser from a URL, with nothing to install — that is genuinely valuable for iterating and for sharing. What it cannot reach is the native-only performance work: application spacewarp, fine control over fixed-foveated rendering, SRP batching, GPU occlusion culling, and Burst/Jobs for the simulation. Those are the difference between "runs at 90Hz with headroom" and "runs at 90Hz".

Nothing in the architecture changes. The engine changes; the budget does not.

## What transfers unchanged

| Decision | Why it still holds in Unity |
|---|---|
| Draw calls are the budget, not triangles | Still a tile-based mobile GPU. SRP batching replaces manual instancing, same goal |
| No full-screen post stack | Post in URP breaks single-pass instanced rendering the same way it breaks multiview |
| One baked environment map for all reflections | A single baked reflection probe; probe blending is the affordable upgrade |
| Two real lights, everything else emissive | Unchanged. Mobile forward rendering, same arithmetic |
| Facade computed in the fragment shader | Ported below. Still resolution-independent and still zero texture memory |
| World-space facade UVs | The whole reason the city reads as built. Unchanged |
| Comfort rules — snap turn, vignette, capped roll, frontal-arc combat | Design constraints, not engine constraints |

## What has to be rebuilt rather than translated

- **XR input.** WebXR's `inputSources` becomes the XR Interaction Toolkit. The mapping is the same (left stick walks, right snaps, trigger acts, left grip opens the wrist panel) but none of the plumbing survives.
- **The wrist panel.** A world-space Canvas with an XR Ray Interactor replaces the hand-rolled raycast-onto-a-canvas-texture. Keep the tall rows and the visible cursor — those were fixes for a real usability failure, not decoration.
- **Audio.** The procedural WebAudio graph maps onto an AudioMixer plus a small DSP script, or is replaced with authored loops. Reconsider from scratch.
- **Persistence.** `localStorage` becomes `PlayerPrefs`.

## Layout

```
unity/
  Assets/Kaisei/
    Scripts/
      Palette.cs           colour script, ported from src/world/palette.js
      KaiseiQuality.cs     quality tiers + live/rebuild split, from core/settings.js
      CityGenerator.cs     tiered massing + instancing, from world/city.js
    Shaders/
      KaiseiFacade.shader  procedural facade, from world/facade.js
```

## Getting it into a project

1. Unity 2022.3 LTS or newer, **URP**, Android build target.
2. Install *XR Plugin Management* → **OpenXR**, enable the Meta Quest feature group.
3. Copy `Assets/Kaisei` into your project's `Assets/`.
4. Project Settings → Player → Android: IL2CPP, ARM64, **Multithreaded Rendering** on, and set Graphics APIs to **Vulkan** only.
5. URP asset: **Render Scale 1.0**, MSAA 4×, HDR **off** (the tone mapping is done in-shader here and HDR costs bandwidth we do not have), shadow cascades 1, shadow distance ~60m.
6. Put `CityGenerator` on an empty GameObject and press play.

Step 5 is the one people get wrong. Every default in a fresh URP mobile project is tuned for a phone game running at 60Hz on one screen, not two eyes at 90.
