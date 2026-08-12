#!/usr/bin/env python3
"""
Generate the panoramic sky for the Godot build with sdxl-turbo.

The WebXR build's sky is a gradient shader — three palette colours blended
by height, which is cheap, exactly on-palette, and completely free of
detail. That is the right call when a custom shader is already in the
budget. Godot's PanoramaSkyMaterial instead wants an equirectangular
texture, and a texture can carry something a three-stop gradient cannot:
actual cloud structure and a city glow on the horizon.

Two things make this harder than a flat texture:

  1. **It has to wrap horizontally.** An equirect panorama's left and right
     edges are the same meridian. A seam there is a vertical scar hanging in
     the sky exactly where the player turns to look at it. Only the X axis
     wraps — the poles do not, so the four-way blend used for tiling ground
     textures is wrong here and would smear the horizon into the zenith.

  2. **The horizon has to sit at the horizon.** In an equirect projection
     the vertical middle row *is* eye level. A diffusion model given "sky"
     composes a picture with the horizon wherever it likes, so the prompt
     asks for an overhead-to-horizon gradient and the result is then forced
     onto the palette rather than trusted.

Output is 2048x1024 JPEG — the standard 2:1 equirect aspect. Larger would be
wasted: it is a background, seen out of focus, and sky texture memory
competes with everything else on a standalone headset.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path("godot/assets")

GEN_W, GEN_H = 1024, 512     # generated size, before upscale
OUT_W, OUT_H = 2048, 1024    # shipped equirect
STEPS = 4

PROMPT = (
    "wide panoramic night sky, deep violet at the top fading to teal at the "
    "horizon, thin wispy cloud bands, distant city glow along the horizon "
    "line, no ground, no buildings, no sun, no moon, smooth gradient, "
    "cinematic, high detail"
)

# The palette the whole game is scripted to. The generated sky is pulled
# most of the way onto this rather than trusted to land on it — a diffusion
# model has its own colour opinion and a sky that fights the city's script
# is worse than one with less detail.
ZENITH = np.array([0x1b, 0x0f, 0x3a], dtype=np.float32)
MID = np.array([0x28, 0x50, 0x8f], dtype=np.float32)
HORIZON = np.array([0x54, 0xdc, 0xc2], dtype=np.float32)
GROUND = np.array([0x08, 0x06, 0x0f], dtype=np.float32)


def wrap_seam(img: Image.Image, blend: int = 96) -> Image.Image:
    """
    Make the left and right edges join, and only those.

    Cross-fades a band from the far right edge onto the left edge under a
    linear ramp, so the two meridians converge on the same pixels. Unlike
    the ground textures' four-way half-offset blend, nothing is done
    vertically: in an equirect projection the top and bottom rows are the
    zenith and nadir singularities, not tiling edges, and blending them
    would drag the horizon up into the sky.
    """
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = a.shape
    b = min(blend, w // 4)

    left = a[:, :b, :]
    right_tail = a[:, w - b:, :]
    ramp = (np.arange(b, dtype=np.float32) / max(b - 1, 1))[None, :, None]

    a[:, :b, :] = right_tail * (1.0 - ramp) + left * ramp
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def force_palette(img: Image.Image, amount: float = 0.62) -> Image.Image:
    """
    Blend the generated sky towards the game's vertical colour script.

    Builds the same zenith->mid->horizon->ground ramp the WebXR sky shader
    uses, then mixes the generated image towards it. What survives is the
    cloud structure and the glow; what is discarded is whatever hue the
    model felt like producing.
    """
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = a.shape

    # v: 0 at the top row (zenith), 1 at the bottom (nadir). The horizon is
    # the middle row by definition of the projection.
    v = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None]
    ramp = np.empty((h, 3), dtype=np.float32)

    upper = v[:, 0] < 0.35
    t = (v[upper, 0] / 0.35)[:, None]
    ramp[upper] = ZENITH * (1 - t) + MID * t

    band = (v[:, 0] >= 0.35) & (v[:, 0] < 0.5)
    t = ((v[band, 0] - 0.35) / 0.15)[:, None]
    ramp[band] = MID * (1 - t) + HORIZON * t

    lower = v[:, 0] >= 0.5
    t = np.clip((v[lower, 0] - 0.5) / 0.25, 0, 1)[:, None]
    ramp[lower] = HORIZON * (1 - t) + GROUND * t

    target = np.repeat(ramp[:, None, :], w, axis=1)

    # Multiply-style mix keeps the generated luminance variation (clouds)
    # while taking hue from the ramp: the structure is in the deviation from
    # each row's mean, not in the absolute colour.
    row_mean = a.mean(axis=1, keepdims=True)
    detail = a - row_mean
    out = target + detail * (1.0 - amount) * 1.6
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def main() -> int:
    import torch
    from diffusers import AutoPipelineForText2Image

    OUT.mkdir(parents=True, exist_ok=True)

    print("loading stabilityai/sdxl-turbo on CPU...", flush=True)
    pipe = AutoPipelineForText2Image.from_pretrained(
        "stabilityai/sdxl-turbo", torch_dtype=torch.float32
    ).to("cpu")
    pipe.set_progress_bar_config(disable=True)

    print("  sky...", flush=True)
    image = pipe(
        prompt=PROMPT,
        num_inference_steps=STEPS,
        guidance_scale=0.0,
        height=GEN_H,
        width=GEN_W,
    ).images[0]

    image = force_palette(image)
    image = image.resize((OUT_W, OUT_H), Image.LANCZOS)
    # Seam last, at final resolution, so the blend band is not resampled
    # afterwards — resampling across the join is what reintroduces a faint
    # line in the exact place the whole step exists to remove one.
    image = wrap_seam(image)

    path = OUT / "sky_panorama.jpg"
    image.save(path, quality=88, optimize=True)
    print(f"  -> {path} ({path.stat().st_size // 1024}KB)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
