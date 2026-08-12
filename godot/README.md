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

## Status, honestly

Everything here was written without a Godot install available in the
development sandbox (the environment's egress policy blocks
`github.com`/`godotengine.org` downloads, and the only Godot in apt is
3.5, which cannot open a Godot 4 project). **The CI runner is therefore the
first machine that actually opens this project** — it has unrestricted
network access, so it can fetch the real engine and export templates.

That means the workflow is also the test: a red run is real information
about a real error, and iterating against those logs is how this gets to a
working APK. Do not read a green checkmark on the scaffolding commit as
proof the project opens — read the workflow run.

Still to port from the WebXR build: the two minigames, the wrist settings
panel, audio, and the lounge. The city, palette, facade shader, locomotion
and comfort rules are here.
