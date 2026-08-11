using UnityEngine;

namespace Kaisei
{
    /// <summary>
    /// Kaisei's colour script: green, blue, purple. Nothing warm.
    ///
    /// Ported from src/world/palette.js. Centralising it is not tidiness for
    /// its own sake — a limited palette only reads as *deliberate* if it is
    /// actually enforced, and the fastest way for one to rot is a stray colour
    /// literal in a material six files away.
    ///
    /// The roles are fixed:
    ///   PURPLE sits at the top of the sky and in every shadow, so nothing
    ///          unlit is ever neutral grey.
    ///   BLUE   is the mid-tone and the key light. Most surfaces read blue.
    ///   GREEN  is the horizon and every affordance — the race pad, the boost
    ///          gates, the lit edge of a walkable ramp. It is the rarest of the
    ///          three, which is precisely why it is the colour the eye follows.
    ///
    /// Colours are authored as sRGB hex, matching the WebGL build's literals,
    /// but `Hex()` below does *not* convert them to linear — Unity's `Color`
    /// stores whatever component values it is given, and `ColorUtility`
    /// performs no colour-space conversion either. With the project's colour
    /// space set to Linear (required — Gamma will wash the whole script out
    /// for other reasons), these values are read by the GPU as if they were
    /// already linear, which is not what an sRGB hex string means. Consumers
    /// must call `.linear` on the way in (`Palette.KeyLight.linear` set as a
    /// light's `color`, etc.) or bake the same conversion into the shader.
    /// Getting this wrong reads as "the palette is right but everything looks
    /// washed out or oversaturated" rather than as an error, so it is worth
    /// checking explicitly the first time this script is wired into a scene.
    /// </summary>
    public static class Palette
    {
        static Color Hex(string hex)
        {
            ColorUtility.TryParseHtmlString(hex, out var c);
            return c;
        }

        // --- sky
        public static readonly Color SkyZenith  = Hex("#1b0f3a");
        public static readonly Color SkyMid     = Hex("#28508f");
        public static readonly Color SkyHorizon = Hex("#54dcc2");
        public static readonly Color SkyGround  = Hex("#08060f");
        public static readonly Color SunColor   = Hex("#a8f0e0");

        // --- lighting
        public static readonly Color KeyLight   = Hex("#9fd4ff");
        public static readonly Color FillSky    = Hex("#49b6c4");
        public static readonly Color FillGround = Hex("#2a1a45");
        public static readonly Color Fog        = Hex("#141a3a");

        // --- accents, by role rather than by hue
        public static readonly Color AccentGreen  = Hex("#3dffa8");
        public static readonly Color AccentBlue   = Hex("#48d6ff");
        public static readonly Color AccentPurple = Hex("#b98cff");

        public static readonly Color[] Neon =
        {
            Hex("#3dffa8"), Hex("#48d6ff"), Hex("#b98cff"),
            Hex("#5cf2d6"), Hex("#7c5cff"), Hex("#2ee89b"),
        };

        // --- surfaces
        public static readonly Color Concrete  = Hex("#333a56");
        public static readonly Color DarkMetal = Hex("#151a2c");
        public static readonly Color WetGround = Hex("#161c33");
        public static readonly Color DeckWood  = Hex("#2c2440");
        public static readonly Color Cushion   = Hex("#3a2a63");

        /// <summary>Deterministic pick from the neon set, given a 0..1 value.</summary>
        public static Color NeonAt(float t) => Neon[Mathf.Abs(Mathf.FloorToInt(t * Neon.Length)) % Neon.Length];

        /// <summary>
        /// The key light's elevation matters more than it looks. Below about
        /// 0.25 the sun grazes the ground so shallowly that N·L is near zero
        /// and the street ends up lit entirely by the reflection probe, which
        /// paints the whole road one flat colour. This was a real bug in the
        /// WebGL build; do not lower it without checking the road.
        /// </summary>
        public static readonly Vector3 SunDirection = new Vector3(-0.55f, 0.30f, -0.78f).normalized;
    }
}
