# Relaxation

A VR game where the point is to not have a point.

You live in **Kaisei** — a warm, futuristic city at permanent golden hour. Walk the wet streets. Sit on a rooftop deck and watch lanterns drift past. And when you want intensity, you walk to it: a hover-craft race launching from the plaza, a sword-combat dojo up a side stair, an AR layer over the whole city.

The city is the game. No quests, no levels, no timers, nothing that expires.

## What's playable right now

| | |
|---|---|
| **Kaisei, street level** | Procedural neon city — walkable, wet, raining if you want it to |
| **The Lantern** | The chill space. A rooftop deck up a lit ramp: cushions you can sit on, a reflecting pool, paper lanterns, and deliberately nothing to do |
| **NEON LINE** | The racing game. Three laps of a hover-craft circuit over the rooftops, with boost gates, lap timing, and a ghost of your best run |

Designed but not yet built: **STEEL GARDEN** (sword combat) and **DRIFT** (the AR game). See the design doc.

## Running it

```bash
npm install
npm run dev
```

Dev server runs over HTTPS with a self-signed certificate, because WebXR requires a secure context.

**On a Quest 3:** open the LAN address it prints (`https://<your-machine-ip>:5173`) in the headset browser, accept the certificate warning, and press **Enter VR**.

**On desktop:** open the same URL. WASD to walk, mouse to look (click to capture), **Space** on the green pad to race, **R** to toggle rain.

**In VR:** left stick walks, right stick snap-turns, trigger sits you on a cushion or launches you from the race pad. Everything is seated-playable.

```bash
npm run build     # production build
npm run smoke     # headless verification + screenshots
```

## Docs

- [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) — the full design: city, districts, all three games-in-game, social and comfort rules, scope
- [`docs/GRAPHICS.md`](docs/GRAPHICS.md) — how the rendering hits a modern look inside a Quest 3 frame budget, and what was traded away

## Layout

```
src/
  core/       engine, quality tiers, procedural audio, RNG
  world/      sky and IBL, materials, city, the Lantern, glow batching
  player/     locomotion, collision, comfort
  games/      NEON LINE
tools/        headless smoke test and visual probes
```

## Status

Prototype. Built with Three.js + WebXR so it runs in the Quest 3 browser without a store build — see `docs/GRAPHICS.md` §5 for the Unity migration path if this graduates.
