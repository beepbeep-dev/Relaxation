extends Node

## Kaisei's colour script: green, blue, purple. Nothing warm.
##
## Ported from src/world/palette.js. Autoloaded, so any scene can reach it as
## `Palette.ACCENT_GREEN` without an import. Centralising it is not tidiness
## for its own sake — a limited palette only reads as *deliberate* if it is
## actually enforced, and the fastest way for one to rot is a stray hex code
## in a mesh constructor six files away.
##
## The script:
##   PURPLE sits at the top of the sky and in every shadow, so nothing unlit
##          is ever neutral grey.
##   BLUE   is the mid-tone and the key light. Most surfaces read blue.
##   GREEN  is the horizon and every affordance — the race pad, boost gates,
##          the lit edge of a walkable ramp. It is the rarest of the three,
##          which is precisely why it is the colour the eye follows.
##
## Colour space note, and it is the one that bites: `Color("#3dffa8")` in
## Godot parses the hex straight into the Color's float components with no
## sRGB→linear conversion. Godot 4 renders in linear space and converts on
## output, so a hex authored for sRGB (which is what every value below is,
## since they came from CSS) is *already* the right thing to hand to a
## material's albedo — Godot treats albedo_color as sRGB and converts it
## internally. Do NOT call `.srgb_to_linear()` on these when assigning to
## albedo; that double-converts and washes the whole script out. It IS
## needed when feeding a shader uniform that skips the automatic conversion.

# --- sky
const SKY_ZENITH := Color("#1b0f3a")   # deep violet overhead
const SKY_MID := Color("#28508f")      # the blue the city sits in
const SKY_HORIZON := Color("#54dcc2")  # jade band at the skyline
const SKY_GROUND := Color("#08060f")
const SUN_COLOR := Color("#a8f0e0")    # cool, almost mint — never a warm sun

# --- lighting
const KEY_LIGHT := Color("#9fd4ff")    # pale blue key
const FILL_SKY := Color("#49b6c4")     # blue-green bounce from the horizon
const FILL_GROUND := Color("#2a1a45")  # purple bounce from the wet street
const FOG := Color("#141a3a")

# --- accents by role rather than by hue
const ACCENT_GREEN := Color("#3dffa8")
const ACCENT_BLUE := Color("#48d6ff")
const ACCENT_PURPLE := Color("#b98cff")

const NEON: Array[Color] = [
	Color("#3dffa8"), Color("#48d6ff"), Color("#b98cff"),
	Color("#5cf2d6"), Color("#7c5cff"), Color("#2ee89b"),
]

# --- surfaces
const CONCRETE := Color("#333a56")
const DARK_METAL := Color("#151a2c")
const WET_GROUND := Color("#161c33")
const GLASS := Color("#0e1830")
const DECK_WOOD := Color("#2c2440")    # stained violet rather than brown
const CUSHION := Color("#3a2a63")

# --- window lights in tower facades
const WINDOWS: Array[Color] = [
	Color("#c9f7e6"), Color("#9fd4ff"), Color("#c4b5fd"),
	Color("#e8f4ff"), Color("#7ce8c4"), Color("#a5b4fc"),
]

## The key light's elevation matters more than it looks. Below about 0.25 the
## sun grazes the ground so shallowly that N·L is near zero and the street
## ends up lit entirely by ambient, which paints the whole road one flat
## colour. This was a real bug in the WebGL build; do not lower it without
## looking at the road afterwards.
const SUN_DIRECTION := Vector3(-0.55, 0.30, -0.78)


## Deterministic pick from the neon set, given a 0..1 value.
func neon_at(t: float) -> Color:
	return NEON[int(t * NEON.size()) % NEON.size()]
