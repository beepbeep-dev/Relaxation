/**
 * Kaisei's colour script: green, blue, purple. Nothing warm.
 *
 * Every colour in the game comes from here. Centralising it is not tidiness
 * for its own sake — a limited palette only reads as *deliberate* if it is
 * actually enforced, and the fastest way for one to rot is a stray hex code
 * in a mesh constructor six files away.
 *
 * The script:
 *
 *   PURPLE  sits at the top of the sky and in the shadows. It is the colour
 *           of everything unlit, so shadow is never neutral grey.
 *   BLUE    is the mid-tone and the key light. Most surfaces read blue.
 *   GREEN   is the horizon, the accent, and every affordance. Because it is
 *           the rarest of the three, it is what the eye goes to — so it is
 *           reserved for things that matter: the race pad, boost gates, the
 *           lit edge of a walkable ramp.
 *
 * The warm/cool split that usually carries a scene is replaced here by a
 * green/purple split across the blue mid-tone, which is a wider hue spread
 * than the original amber/navy and holds up better in a headset.
 */

export const PALETTE = {
  // --- sky
  skyZenith: '#1b0f3a',      // deep violet overhead
  skyMid: '#28508f',         // the blue the city sits in
  skyHorizon: '#54dcc2',     // jade band at the skyline
  skyGround: '#08060f',
  sunColor: '#a8f0e0',       // cool, almost mint — never a warm sun

  // --- lighting
  keyLight: '#9fd4ff',       // pale blue key
  fillSky: '#49b6c4',        // blue-green bounce from the horizon
  fillGround: '#2a1a45',     // purple bounce from the wet street
  fog: '#141a3a',

  // --- neon, in rough order of how often they appear
  neon: ['#3dffa8', '#48d6ff', '#b98cff', '#5cf2d6', '#7c5cff', '#2ee89b'],

  // --- accents by role
  accentGreen: '#3dffa8',
  accentBlue: '#48d6ff',
  accentPurple: '#b98cff',

  // --- surfaces
  concrete: '#4d5680',
  darkMetal: '#2a3150',
  wetGround: '#2b3350',
  glass: '#0e1830',
  deckWood: '#463a63',       // stained violet rather than brown
  cushion: '#54408c',

  // --- window lights in tower facades
  windows: ['#c9f7e6', '#9fd4ff', '#c4b5fd', '#e8f4ff', '#7ce8c4', '#a5b4fc'],

  // --- lounge
  lantern: '#8ef0d4',
  lanternDrift: '#a78bfa',

  // --- racing
  railLeft: '#48d6ff',
  railRight: '#b98cff',
  gate: '#3dffa8',
  thruster: '#5cf2d6',
  ghost: '#8b9cff',
};

/** Deterministic pick from the neon set, given a 0..1 value. */
export function neonAt(t) {
  return PALETTE.neon[Math.floor(t * PALETTE.neon.length) % PALETTE.neon.length];
}
