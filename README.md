# Relaxation

A VR game where the point is to not have a point.

You live in **Kaisei** — a neon city under a purple sky, lit green at the horizon. Walk the wet streets. Sit on a rooftop deck and watch lanterns drift past. And when you want intensity, you walk to it: a hover-craft race launching from the plaza, a sword-combat dojo up a side stair, an AR layer over the whole city.

The city is the game. No quests, no levels, no timers, nothing that expires.

## What's playable right now

| | |
|---|---|
| **Kaisei, street level** | Procedural neon city — walkable, wet, raining if you want it to. Aircars, rooftop plant, lit vending machines, a distant skyline |
| **The Lantern** | The chill space. A rooftop deck up a lit ramp: cushions you can sit on, a reflecting pool, paper lanterns, and deliberately nothing to do |
| **NEON LINE** | The racing game. Three laps of a hover-craft circuit over the rooftops, with boost gates, lap timing, and a ghost of your best run |

Designed but not yet built: **STEEL GARDEN** (sword combat) and **DRIFT** (the AR game). See the design doc.

## Running it

```bash
npm install
npm run dev
```

The dev server runs over HTTPS with a self-signed certificate, because WebXR requires a secure context.

**On a Quest 3:** open the LAN address it prints (`https://<your-machine-ip>:5173`) in the headset browser, accept the certificate warning, and press **Enter VR**.

**On desktop:** open the same URL. WASD to walk, mouse to look (click to capture), **Space** on the green pad to race, **R** to toggle rain, **Tab** or **G** for graphics settings.

**In VR:** left stick walks, right stick snap-turns, trigger sits you on a cushion or launches you from the race pad, and squeezing the left grip raises a graphics panel on your wrist. Everything is seated-playable.

## Graphics settings

Four presets — Low, **Balanced** (the Quest 3 target), High, Ultra — plus individual control over roughly twenty values. Your choice is remembered.

Settings split into two kinds. **Live** ones (render scale, foveation, shadows, draw distance, fog, glow, exposure, rain, comfort vignette, snap-turn angle) take effect on the next frame. **Rebuild** ones (city size, detail density, traffic, reflection quality, MSAA) change how the world is constructed, so the panel stages them and offers a reload rather than blacking out a headset mid-session.

Reachable from the boot screen, from a Tab overlay on desktop, and from a slab on your left wrist in VR — a DOM overlay is invisible inside an XR session, so anything reachable in a headset has to be geometry.

## Deploying

Live at **https://beepbeep-dev.github.io/Relaxation/**

Every push builds, runs the smoke test and the subpath check against the built output, and — from the default branch — publishes to GitHub Pages via `.github/workflows/deploy.yml`. The workflow also claims the Pages source for Actions, so no manual setting is required.

Pages serves over HTTPS, which is all WebXR needs, so the deployed URL works in the Quest browser directly with no dev server and nothing to sideload.

Two things this setup is deliberately careful about, both because they failed silently the first time:

- **The workflow does not filter on a branch called `main`.** A branch filter that matches nothing produces no runs *and no error*, so a deploy can look configured while it has never once executed. Publishing is gated on `github.event.repository.default_branch` instead, whatever that is named.
- **The build is verified from a project subpath, not just from `/`.** Serving at a domain root makes every absolute asset URL work, which hides exactly the bug that breaks a project Pages site. `npm run pages-check` serves `dist/` under `/Relaxation/` and fails if anything 404s or the app does not boot.

```bash
npm run build         # production build
npm run smoke         # headless verification + screenshots
npm run pages-check    # boot the bundle from a Pages-style subpath
```

## Docs

- [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) — the full design: city, districts, all three games-in-game, social and comfort rules, scope
- [`docs/GRAPHICS.md`](docs/GRAPHICS.md) — how the rendering hits a modern look inside a Quest 3 frame budget, the colour script, the settings architecture, and what was traded away

## Layout

```
src/
  core/       engine, settings, quality resolution, stats, procedural audio, RNG
  world/      palette, sky and IBL, materials, city, the Lantern, glow batching
  player/     locomotion, collision, comfort
  games/      NEON LINE
  ui/         settings panel and overlay, in-VR wrist panel
tools/        headless smoke test and visual probes
```

## Status

Prototype. Built with Three.js + WebXR so it runs in the Quest 3 browser without a store build — see `docs/GRAPHICS.md` §5 for the Unity migration path if this graduates.
