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
      Palette.cs            colour script, ported from src/world/palette.js
      KaiseiQuality.cs      quality tiers + live/rebuild split, from core/settings.js
      CityGenerator.cs      tiered massing + instancing, from world/city.js
      PlayerLocomotion.cs   collision, ground-snap, seat, comfort vignette, from src/player/player.js
    Shaders/
      KaiseiFacade.shader   procedural facade, from world/facade.js
```

`PlayerLocomotion.cs` is intentionally not a drop-in `player.js`: it takes
already-resolved move/turn/sit intent rather than reading a controller
itself, because raw WebXR gamepad polling is exactly the plumbing that does
not transfer (see the XR input row in the table above). Whatever wires up
XRITK's action-based input calls `Tick(dt, moveX, moveZ, turnX, sitPressed)`
once a frame. Its class comment documents a real hazard the port hit: three.js
is right-handed and Unity is left-handed, so the JS file's
`crossVectors(forward, up)` for the sideways-movement axis does not
transliterate literally — the operand order has to swap or "left" and
"right" swap underfoot. That was reasoned through by hand; there is no
Unity runtime here to confirm it against, so it is worth checking on the
first play test specifically.

## Compile-check harness

There is no Unity install in this environment, so "compiles" cannot mean
"opens in the editor without errors." What it can mean, and what
`unity/.compilecheck/` actually verifies: the C# is valid C# against a
hand-written stand-in for the UnityEngine API surface this port touches.

```
mcs -target:library -langversion:latest -out:/tmp/kaisei.dll \
  unity/.compilecheck/UnityStubs.cs unity/Assets/Kaisei/Scripts/*.cs
```

This passes (exit 0) as of this commit — `CityGenerator.cs`, `Palette.cs`
and `KaiseiQuality.cs` are syntactically valid, fully typed C#, with every
called method existing at the arity and argument types the caller uses.

**What that does and does not prove** is written at the top of
`UnityStubs.cs` itself, and is worth restating here because it is easy to
overclaim: the stub's method signatures were transcribed by hand from
documented Unity 2022.3 behaviour, not generated from the real assemblies. A
mistake there becomes a mistake this check happily agrees with — it catches
"this file cannot compile at all," not "this overload doesn't exist on the
real `Mathf`." One already surfaced during this pass: the stub was missing
`Mathf.Abs(int)`, so `Mathf.Abs(anIndex)` silently resolved to the `float`
overload and truncated an array index. That is exactly the class of bug a
real Unity compile would also catch, and exactly the class this
hand-maintained stub can *introduce* by omission — so treat a clean run here
as "no syntax-level rot," not as "will build in the editor."

`mcs` (Mono 6.8, the version available here) also caps out below what a
current Unity's C# actually accepts: no C# 9 target-typed `new()`, and no
local functions at all (the compiler accepts the syntax and then fails to
resolve the call — confirmed by isolating it in a 4-line test file). Both
constructs were avoided in the ported scripts specifically so this checker
could run; neither is a Unity requirement, only an `mcs` one, so real Unity
would be strictly more permissive here, not less.

**The shader is unchecked.** `KaiseiFacade.shader` has no offline compiler
available in this environment — there is no `mcs` equivalent for HLSL/URP
ShaderLab, and the include chain (`Packages/com.unity.render-pipelines.
universal/...`) only resolves inside a real Unity project with URP
installed. It was reviewed by hand instead: the two known-sharp edges in a
port like this are stereo instancing and shadow/depth passes borrowed by
name from another shader, both worth checking explicitly on the next actual
editor compile —
- `UNITY_VERTEX_OUTPUT_STEREO` / `UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO` /
  `UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX` are present in the forward and
  depth-only passes, which single-pass instanced VR needs to render both
  eyes rather than silently drawing the second eye from the first eye's data.
- The ShadowCaster and DepthOnly passes are written directly against this
  shader's own vertex layout rather than pulled in with
  `UsePass "Universal Render Pipeline/Lit/ShadowCaster"`. `UsePass` reuses
  the *compiled* Lit shader's passes, which brings along Lit's own
  `_ALPHATEST_ON` / `_BaseMap` expectations; a Lit rewrite upstream can
  silently break the borrowed pass with no compile error on this shader —
  just missing shadows discovered at runtime.
- `_WindowTint` is declared in `Properties` as well as in the instancing
  buffer, so `UNITY_ACCESS_INSTANCED_PROP` has a real default when GPU
  instancing is off instead of reading zero.

None of that substitutes for an actual editor compile and a play test on
device. Treat it as "reviewed for the failure modes this kind of port
usually has," not as "verified."

## Getting it into a project

1. Unity 2022.3 LTS or newer, **URP**, Android build target.
2. Install *XR Plugin Management* → **OpenXR**, enable the Meta Quest feature group.
3. Copy `Assets/Kaisei` into your project's `Assets/`.
4. Project Settings → Player → Android: IL2CPP, ARM64, **Multithreaded Rendering** on, and set Graphics APIs to **Vulkan** only.
5. URP asset: **Render Scale 1.0**, MSAA 4×, HDR **off** (the tone mapping is done in-shader here and HDR costs bandwidth we do not have), shadow cascades 1, shadow distance ~60m.
6. Put `CityGenerator` on an empty GameObject and press play.

Step 5 is the one people get wrong. Every default in a fresh URP mobile project is tuned for a phone game running at 60Hz on one screen, not two eyes at 90.

## Building the APK in CI

`.github/workflows/unity-android-build.yml` uses [GameCI](https://game.ci)'s
Unity Editor Docker image to produce a `.apk` as a downloadable workflow
artifact, since neither this repo's dev environment nor its existing GitHub
Pages deploy has a Unity install anywhere in them. Trigger it manually from
the Actions tab (`workflow_dispatch`) once the two things below are true —
running it before then will fail, correctly, since there is nothing valid
to build yet.

**1. It needs a real Unity project checked in, and `unity/` is partway there.**
`Packages/manifest.json` (URP, XR Plugin Management, OpenXR, XR Interaction
Toolkit, Input System) and `ProjectSettings/ProjectVersion.txt` now exist —
those are plain declarative text, safe to hand-write the same way a `package.json`
is. Two caveats on them specifically: the package versions are a best-effort
pin for the Unity 2022.3 LTS era, not verified against the live registry from
here, so expect Package Manager to want to bump a patch version or two on
first resolve; and `ProjectVersion.txt`'s revision hash is a placeholder —
Unity ignores a stale hash and silently rewrites the file with the real one
the moment it opens the project with a matching-version Editor, so this only
matters if Unity Hub tries to use it to *auto-install* an Editor, in which
case fetch the real hash for whatever 2022.3.x LTS patch you use instead.

What is still missing, and is not something to hand-write here: an actual
`ProjectSettings.asset` (Player settings, URP asset assignment, Android
target — a few hundred fields, normally generated and validated by the
Editor itself) and at least one scene with an XR Origin, wired-up
locomotion, and something worth walking around in a headset for. Guessing
at `ProjectSettings.asset`'s contents with no Editor here to open the
result in is more likely to produce a project that silently fails to
import than one that builds. The honest path is: open Unity 2022.3 LTS
once, follow the six steps above (the manifest above already does step 2's
dependency declarations), commit the resulting `ProjectSettings/` and a
scene, and from then on this workflow can build every subsequent push.

**2. It needs a Unity license as three GitHub Actions secrets** —
`UNITY_LICENSE`, `UNITY_EMAIL`, `UNITY_PASSWORD` — which is not something
this session can obtain on your behalf; it has to come from your own Unity
ID. A Unity Personal license is free and works for this. The short version
of GameCI's activation flow (full docs at
https://game.ci/docs/github/activation):
   1. Run GameCI's `activate` job locally or via a throwaway Actions run —
      it produces an `.alf` license-request file.
   2. Upload that `.alf` at https://license.unity3d.com/manual while signed
      into your Unity ID; it returns a `.ulf` license file.
   3. Add the `.ulf` file's contents as the `UNITY_LICENSE` repo secret, and
      your Unity ID email/password as `UNITY_EMAIL` / `UNITY_PASSWORD`.

Until both of those are done, treat "port it to Unity and build an APK" as
tracked but not yet actionable — the C# and shader are ported and reviewed,
but there is real Unity-Editor-in-hand work (assembling the scene, XR rig,
UI, minigames) between here and a headset install, and no way to shortcut
that from inside this environment.
