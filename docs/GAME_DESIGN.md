# RELAXATION — Game Design Document (Draft v0.1)

**Genre:** VR social sandbox / chill-out space with embedded minigames
**Platform:** Standalone VR (Quest 3 / 3S as lead), PCVR + flatscreen companion later
**Session length:** 5 minutes to 5 hours — both should feel correct
**One-line pitch:** A futuristic city at permanent golden hour where the whole point is to *not* have a point — but every arcade cabinet, rooftop, and back alley hides a full game inside it.

---

## 1. Core Premise

You arrive in **Kaisei**, a clean, warm, low-density future city. No quests. No level. No health bar. You walk, sit, listen to rain on a noodle-shop awning, watch trains pass below.

The city is the *lobby*, but it never announces itself as one. Games are diegetic — you find them the way you'd find an arcade on a real walk. Two anchor experiences ship at launch:

- **STEEL GARDEN** — a physical VR sword-combat game, entered through a dojo/arcade in the city.
- **DRIFT** — an AR-style game you play on an in-world handheld device, overlaying creatures and puzzles onto the city itself.

The design thesis: *relaxation is the container, intensity is optional*. The player chooses their own arousal level, moment to moment, without ever hitting a menu.

---

## 2. Pillars

| Pillar | What it means | What it forbids |
|---|---|---|
| **No obligation** | Nothing expires, nothing decays, no daily login pressure | Timers, streaks, FOMO events |
| **Diegetic everything** | Menus are objects; games are places | Floating UI panels as primary interface |
| **Comfort first** | Seated-viable, motion-sickness-conscious, quiet by default | Forced locomotion, jump scares, loud stingers |
| **Earned intensity** | Combat exists but you walk to it | Ambushes in the relaxation space |
| **Presence over fidelity** | Stylized art, perfect audio, 90fps locked | Photoreal chasing at the cost of frame rate |

---

## 3. The City — Kaisei

### 3.1 Feel

Warm neon over wet concrete. Think *Shenmue* pacing with *Mirror's Edge* color and *Blade Runner* density dialed down 70%. Perpetual 6pm. Volumetric light through gaps between towers. Distant maglev hum. It is a city that is clearly *lived in* but never crowded — you see maybe 20 NPCs in a district, all going about their own business, none of whom need anything from you.

### 3.2 Districts (launch scope: 4)

**1. The Terrace** — Spawn. Rooftop garden district. Hammocks, koi pools, a ramen counter, a tea kiosk. Long sightlines over the city. Deliberately has *zero* games in it — a guaranteed calm zone.

**2. Low Market** — Street level. Food stalls, arcade parlor, record shop, laundromat with working dryers you can watch. Highest NPC density. **STEEL GARDEN** dojo is up a side stair here.

**3. The Rail Line** — Elevated transit ring. A slow train you can ride the full loop (11 minutes) with no stops required. Best passive experience in the game — many players will just live here. **DRIFT** hotspots cluster along the track.

**4. Undercity** — Below street level. Wet, blue, quiet, industrial. Fewer people. Fishing off the drainage canals. Slightly eerie but never threatening — a design line we hold hard.

### 3.3 Ambient Activities (non-game, no scoring)

These are the actual product for a large share of the audience. Each is a full mechanical toy, not a prop:

- **Ramen counter** — sit, order, the bowl is made in front of you in real time, steam, chopstick physics, you can actually eat it
- **Fishing** — canal + rooftop rain-catch pools; haptic line tension; catalog of 40 fish you can release or keep in your apartment tank
- **Rain** — a weather cycle you can also just *summon* from your apartment window controls
- **Cat** — one cat per district. Findable. Pettable. Remembers you. This will be more talked about than the combat.
- **The train** — ride it, forever, with a book
- **Sketchbook** — an in-world 3D drawing pad; your drawings persist as objects in your apartment
- **Vinyl / tape deck** — real playlist system, licensed + procedural ambient; music you carry between districts on a personal player

### 3.4 The Apartment

A small personal space, reachable from any district. Window seat, tank, shelf. Anything you catch, draw, win, or find ends up here. This is the game's only progression system: **your room fills up over time.** No XP. No levels. Just evidence you were here.

---

## 4. Game-in-Game #1 — STEEL GARDEN (VR Sword Combat)

### 4.1 Framing

Found in Low Market: a narrow stair, a paper door, a dojo with a single attendant. You pick up a physical practice sword from a rack. Putting it in the stand at the far wall enters the game. It's presented in-fiction as a *holographic training system* — so death is never death, it's a dissolve and a reset.

### 4.2 Combat Design

Physics-authentic but forgiving. The failure mode we must avoid is flailing being optimal.

- **Weight simulation** — the blade has real inertia; wild swings overshoot and leave you open. Controlled arcs are mechanically superior.
- **Directional defense** — enemies telegraph a colored slash line ~500ms before striking. Meet it with a matching blade angle to parry. Parry window is generous (250ms); the skill is reading, not reflexes.
- **No stamina bar.** Your *actual arms* are the stamina bar. Fights are designed to run 60–90 seconds so real fatigue is the pacing tool.
- **One-hit lethality both ways** at higher tiers — this makes fights tense without making them long.
- **Seated mode** is a first-class citizen: enemies approach in a 180° frontal arc, no flanking, no ducking required.

### 4.3 Enemies

Holographic constructs — angular, semi-transparent, no gore, no faces. Keeps it non-violent enough to sit inside a relaxation game without tonal whiplash.

| Tier | Enemy | Teaches |
|---|---|---|
| 1 | **Sprite** — floats, single slow slash | Parry timing |
| 2 | **Warden** — heavy, blocks, punishes wild swings | Blade control |
| 3 | **Twin** — mirrors your last three swings back at you | Varying your attacks |
| 4 | **Lattice** — splits into two on each hit | Spatial awareness |
| Boss | **The Gardener** — a duel, no adds, pure reading | Everything |

### 4.4 Modes

- **Kata** — solo, no enemies, slow-motion form practice. Meditative. Doubles as a relaxation activity.
- **Ascent** — endless waves, leaderboard optional and *off by default*
- **Duel** — 1v1 async ghost duels (fight a recording of another player's run), avoiding live-PvP toxicity at launch
- **Garden** — the story mode; 12 encounters, ~90 minutes, ends with The Gardener

### 4.5 Rewards

Cosmetic blades and a wall scroll for your apartment. Nothing that gates content. Nothing that expires.

---

## 5. Game-in-Game #2 — DRIFT (the AR game)

### 5.1 The Conceit

The cleanest way to do "AR inside VR": you carry an in-world **handheld device** (a phone-like slab clipped to your belt). Raise it and the city seen *through its screen* is augmented — creatures, data-ghosts, hidden geometry, other players' left-behind marks. Lower it and the city is normal.

This is genuinely novel in VR and costs the player nothing to enter or leave. It also makes the whole city into game content without adding a single loading screen.

### 5.2 Loop

1. Walk the city (which you were doing anyway)
2. Device buzzes near a **Drift** — a signal anomaly
3. Raise device, scan, and a creature/puzzle resolves in the AR layer
4. Resolve it with a small physical interaction (trace a shape, align two beams, catch it with a gesture)
5. It joins your **Index**; a specimen appears in your apartment tank

### 5.3 Content Types

- **Fauna** — ~60 collectible signal-creatures, region + weather + time gated (rain-only species, train-only species, Undercity-only species)
- **Echoes** — short optional story vignettes; overheard AR recordings of the city's past. This is where 100% of the narrative lives, and 0% of it is mandatory.
- **Glyphs** — light spatial puzzles; stand in the right place, align architecture through the screen to complete an image (an anamorphic-perspective puzzle, very strong in VR)
- **Marks** — asynchronous player-left drawings/notes at a location, visible only in AR. Moderated, rate-limited, opt-out toggle.

### 5.4 Why It Matters

DRIFT is the connective tissue. It gives the relaxation space *optional* texture, rewards walking a route you already love, and means no district is ever "done."

---

## 6. Social Design

- **Default: shared but silent.** Other players appear as soft-lit figures. Proximity voice is **off** by default and requires a mutual gesture (offering a hand) to open.
- **Max 12 players per district instance** — presence without crowding.
- **No text chat.** Emotes, marks, and a small set of in-world gestures.
- **Solo mode** is one toggle away and loses no content.

Rationale: the #1 killer of chill VR spaces is one loud stranger. We design defensively.

---

## 7. Comfort & Accessibility

- Locomotion: smooth (adjustable speed) + teleport + real-space walking, all switchable mid-session
- Vignette, snap-turn, and a static comfort frame, all independently configurable
- Full seated parity — every activity and both games are seated-playable
- One-handed play supported for STEEL GARDEN (parry-only defensive stance)
- Subtitles for all ambient dialogue and Echoes; no audio-only critical info
- Volume ceiling on all combat SFX; no sudden loud events in the city layer
- Photosensitivity mode dims the neon/parallax layers
- Colorblind-safe parry telegraphs (shape + color, never color alone)

---

## 8. Technical Notes

- **Engine:** Unity + URP (standalone VR maturity, Quest tooling)
- **Target:** 90fps locked on Quest 3, 72fps floor on 3S; foveated rendering
- **World streaming:** districts are separate scenes joined by short covered transitions (train car, stairwell, elevator) that mask loads diegetically
- **Physics:** custom sword solver rather than raw rigidbody — needed for stable parries at 90fps
- **Persistence:** cloud-saved apartment state, Index, and cosmetics
- **Networking:** authoritative-lite; positional + gesture sync only, no combat networking at launch (Duel is async ghosts)

---

## 9. Scope & Phasing

**Vertical slice (3 months)** — The Terrace + Low Market, ramen, cat, one STEEL GARDEN wave mode, DRIFT with 10 fauna. Proves the tonal shift between calm and combat works.

**Alpha (9 months)** — All 4 districts, apartment, full ambient activity set, STEEL GARDEN Garden mode, DRIFT at 40 fauna.

**Launch (18 months)** — Full content, social layer, async duels, accessibility pass, 90fps optimization pass.

**Post-launch** — New districts as free updates; new games-in-game as the primary content vector (a racing game on the rail line, a photography game, a music/rhythm game in the record shop).

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Tonal whiplash between calm city and sword combat | Combat is spatially quarantined behind a door and framed as a hologram; The Terrace is a guaranteed-calm zone |
| "Nothing to do" bounces new players in the first 10 minutes | The cat, the ramen, and the first DRIFT buzz all fire within 4 minutes of spawn, without a tutorial |
| Sword combat devolves into flailing | Inertia + parry-reading design; wild swinging is mechanically punished |
| Empty-server feel | Instances pool players; a well-tuned NPC density means the city feels alive at 0 players |
| Scope — two full games plus a city | Ambient activities are cheap and high-value; cut DRIFT content count before cutting quality |

---

## 11. Open Questions

- Does STEEL GARDEN want a light narrative, or is pure mechanics stronger for the tone?
- Is the AR device diegetically *yours*, or something you find in the city (better discovery moment)?
- Should the apartment be customizable, or curated-only to preserve the art direction?
- Monetization: premium one-time purchase (fits the no-obligation pillar) vs. cosmetic-only. Strong lean toward premium.
