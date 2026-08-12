# Kaisei — Godot 4 (the APK path)

This is how Kaisei gets onto a Quest as an installable `.apk`.

## Why Godot and not Unity

Unity's build path needs a Unity account, a license activation flow, and
three GitHub secrets carrying that license into CI. Godot is MIT-licensed:
**no account, no login, no license file, no activation — ever**, for the
editor or for anything built with it. Every input the build needs is a
public download.

The practical consequence is that `.github/workflows/godot-android-build.yml`
runs with **zero secrets**. Open the Actions tab, pick "Godot Android APK",
click "Run workflow", and download `kaisei-quest-apk` when it finishes.
Nothing is required from anyone first.

The `unity/` folder stays in the repo as a reference port — the colour
script, quality tiers, city generator, facade shader and combat state
machine all translated to C#/HLSL — but it is not the path to a headset
build any more.

## Installing the APK

The workflow signs with a **debug** keystore generated during the run.
Android refuses to install an unsigned APK; a debug-signed one sideloads
fine, which is what a Quest wants:

- **SideQuest**: drag the `.apk` onto the connected-headset window, or
- **adb**: `adb install -r kaisei.apk`

A release keystore is only needed to publish to a store. That is a store
requirement, not an engine one, and it is the single point at which a secret
would ever enter this pipeline.

## Layout

```
godot/
  project.godot          renderer/XR/quality config, autoloads
  export_presets.cfg     the "Quest" Android preset the workflow exports
  icon.svg
  scenes/main.tscn       XROrigin3D rig + city
  scripts/
    main.gd              XR session bring-up, lighting, ground
    player.gd            snap turn + gaze-relative locomotion
    city.gd              tiered massing via MultiMesh
    palette.gd           the colour script (autoloaded as `Palette`)
    facade.gdshader      procedural facades
```

## What carries over from the WebXR build unchanged

These are properties of the hardware, not of any engine, so they survived
both ports:

| Decision | Why it still holds |
|---|---|
| Draw calls are the budget, not triangles | Still a tile-based mobile GPU. `MultiMesh` replaces `InstancedMesh`, same goal |
| No full-screen post stack | A post pass costs bandwidth a standalone headset does not have. "Bloom" is emissive materials |
| Mobile renderer, not Forward+ | Forward+ assumes bandwidth for clustered lighting and a depth prepass. Picking it is the most common cause of an inexplicable 30fps Quest build |
| MSAA, never FXAA/TAA | MSAA resolves inside tile memory and is nearly free; screen-space AA is another full-screen pass |
| World-space facade UVs | The whole reason the city reads as built rather than textured. A storey is 3.6m on every building |
| Two real lights, everything else emissive | Unchanged arithmetic |
| Snap turn, capped speed, comfort vignette | Design constraints, not engine constraints |

## Status

**The APK builds.** ~77MB installed, ~27MB as the downloaded artifact.

Everything here was written without a Godot install in the development
sandbox (its egress policy blocks the Godot downloads, and the only Godot in
apt is 3.5, which cannot open a Godot 4 project), so the CI runner was the
first machine to open this project. The workflow was therefore also the
test, and it earned that role — every failure below was real:

| Failure | Cause |
|---|---|
| `Android build template not installed` | gradle builds need the template unpacked into `res://android/`, a separate step from installing export templates |
| That step hung 30+ min | `--install-android-build-template` does not return in headless CI; the workflow unzips `android_source.zip` directly instead |
| `"Min SDK" should be >= 24` | the mobile renderer requires it (Vulkan) |
| `curl: (56) Connection died` | CDN hiccup; fixed with retries, caching and a concurrency group |
| `Cannot infer the type of "dx"` | `Array.duplicate()` returns an *untyped* array, so the loop variable was Variant |
| **Configuration error naming nothing** | **`import_etc2_astc` was off** |
| **Built, installed, launched — as a flat 2D app** | **the OpenXR vendors plugin was missing** |

That last one cost the most rounds and deserves the detail: Godot refuses an
Android export unless
`rendering/textures/vram_compression/import_etc2_astc` is enabled, because
mobile GPUs cannot sample the desktop-oriented S3TC/BPTC formats the
importer otherwise emits. It **defaults to false**, and the resulting export
error prints an empty list of problems — so the log says only that
configuration is wrong, never what. If you hit an empty configuration error
on an Android export, check this setting first.

The flat-launch one is the one to internalise: **a build succeeding says
nothing about whether a headset will treat the result as immersive.** That
APK compiled, installed and ran, and was still wrong. Godot 4.2+ moved
Meta/Quest OpenXR support out of core into
[godot_openxr_vendors](https://github.com/GodotVR/godot_openxr_vendors), so
`xr_features/xr_mode=1` on its own did nothing: the APK shipped with no
`libopenxr_loader.so` and no VR intent categories, OpenXR failed to
initialise, and `main.gd` took its "running flat" fallback.

`tools/verify_vr_apk.py` now unzips the built APK and fails the build unless
the loader and both intent categories are present. It was tested against the
known-bad APK first — a check that has never rejected anything is not yet
known to work.

**Open question: the plugin version.** The workflow picks the newest `3.x`
release, on the reasoning that the repo's `5.x` tags cannot be Godot
versions (there is no Godot 5), so its tags are plugin versions and `3.x` is
the generation matching Godot 4.3. That produces an APK that passes
verification, but packaging correctly and running correctly are different
claims — a GDExtension built against a different Godot ABI can still fail to
load at runtime. If the headset ever launches this flat again, check
`adb logcat | grep -i openxr` and try `WANTED_MAJOR = "4"` in
`tools/pick_vendors_release.py`.

`scripts/smoke.gd` exists because of that loop. It builds the scene
headlessly and steps both games, so parse errors and broken geometry surface
in seconds instead of a multi-minute CI round trip, and it asserts what the
design actually claims:

```
ok  city built 2 MultiMesh draw calls
ok  city placed 1216 instanced boxes
ok  lounge has 6 seats
ok  deck is walkable at 6.0m
ok  ramp mid-point at 3.00m, between street and deck
ok  rivals start behind the line (lap -1)
ok  top speed 132 km/h stays a car, not a missile
ok  opponents closed from 6.5m to 1.9m
ok  opponents reached striking distance (1.90m)
```

The last two are there because opponents once converged on the arena origin
instead of the player and stopped short — a bug that reached a real player.
It is an assertion now, so it cannot come back quietly.

Still to port from the WebXR build: audio, the boost-gate scoring and HUD
for the race, and hooking the sword and race entry to the pads rather than
having both always live. The city, palette, facade shader, locomotion,
comfort rules, lounge, both games and the wrist panel are here.
