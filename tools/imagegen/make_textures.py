#!/usr/bin/env python3
"""
Generate the game's surface textures with sd-turbo, then make them usable.

A diffusion model does not produce a tiling texture. Dropped straight onto a
500m road, raw output shows a hard seam every tile and the whole thing reads as
wallpaper. So each image goes through three steps that matter more than the
prompt:

  1. **Seamless wrap.** The image is blended with its three half-offset copies
     under cosine weights that share the tile's period. Each copy is weighted
     to zero exactly where its own seam falls, and periodic weights make the
     result continuous across the tile boundary by construction.

  2. **Flatten the lighting.** Diffusion bakes light and shadow into the image.
     Baked light on a surface that the engine is also lighting reads as dirt
     that moves wrongly, so a heavy blur of the image is divided out, leaving
     the grain and discarding the illumination.

  3. **Desaturate towards the palette.** The city runs a strict green/blue/
     purple script. A texture that arrives with its own colour opinion fights
     that, so albedo is pulled most of the way to greyscale and tinted in the
     engine instead.

Output is 512px JPEG at quality 80 — roughly 60-90KB each. That is a real cost
against a bundle that was previously 100% procedural, and the reason the count
is kept to three.
"""
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
from diffusers import AutoPipelineForText2Image

MODEL = "stabilityai/sd-turbo"
OUT = Path("public/textures")

# Prompts are written for *flat, evenly lit, top-down* surfaces. Anything that
# invites composition — "a road", "a wall in a city" — produces a picture with
# perspective and a light source, which is useless as a tiling material.
TEXTURES = {
    "asphalt": (
        "flat overhead photograph of worn wet asphalt road surface, fine gravel "
        "aggregate, evenly lit, no shadows, no markings, no perspective, "
        "seamless texture, macro detail"
    ),
    "concrete": (
        "flat overhead photograph of raw poured concrete slab, subtle pitting "
        "and fine cracks, evenly lit, no shadows, no perspective, seamless "
        "texture, macro detail"
    ),
    "panel": (
        "flat overhead photograph of brushed dark metal panel, fine horizontal "
        "brush grain, subtle scratches, evenly lit, no shadows, no perspective, "
        "seamless texture, macro detail"
    ),
}


def make_seamless(img: Image.Image) -> Image.Image:
    """
    Blend the image with its three half-offset copies under periodic weights.

    Each copy carries its discontinuity somewhere different: the original's is
    at the edges, the x-rolled copy's is down the middle vertically, and so on.
    The weights are cosine ramps with exactly the tile's period, so each copy
    is weighted to *zero* precisely where its own seam lies, and because the
    weights are periodic the result is continuous across the tile boundary by
    construction.

    An earlier version rolled the image and then faded back to the original
    towards the edges. That is inverted: it restores the original's mismatched
    edge exactly where the seam has to disappear, which is why a faint line ran
    down the middle of every tile.
    """
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = a.shape

    rx = np.roll(a, w // 2, axis=1)
    ry = np.roll(a, h // 2, axis=0)
    rxy = np.roll(rx, h // 2, axis=0)

    # 0 at the tile edge, 1 at the centre, and periodic with the tile.
    wx = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(w) / w))[None, :, None]
    wy = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(h) / h))[:, None, None]

    out = (a * wx * wy
           + rx * (1 - wx) * wy
           + ry * wx * (1 - wy)
           + rxy * (1 - wx) * (1 - wy))

    # Averaging four copies flattens contrast; restore the original spread so
    # the grain does not turn to mush.
    out = (out - out.mean()) * (a.std() / max(out.std(), 1e-3)) + a.mean()
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def flatten_lighting(img: Image.Image, strength: float = 0.85) -> Image.Image:
    """Divide out a heavy blur, removing baked illumination but keeping grain."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    low = np.asarray(img.convert("RGB").filter(ImageFilter.GaussianBlur(28)),
                     dtype=np.float32)
    flat = a / np.maximum(low, 1.0) * low.mean()
    out = a * (1 - strength) + flat * strength
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def toward_grey(img: Image.Image, amount: float = 0.78) -> Image.Image:
    """Pull most of the way to greyscale so the engine's palette decides hue."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    lum = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    out = a * (1 - amount) + lum[..., None] * amount
    # Re-centre so every texture arrives at a predictable mid grey; the material
    # colour supplies the actual value.
    out *= 128.0 / max(out.mean(), 1.0)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"loading {MODEL} on CPU...", flush=True)
    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL, torch_dtype=torch.float32, safety_checker=None
    ).to("cpu")
    pipe.set_progress_bar_config(disable=True)

    for name, prompt in TEXTURES.items():
        if only and only != name:
            continue
        print(f"  {name}...", flush=True)
        image = pipe(
            prompt=prompt,
            num_inference_steps=4,
            guidance_scale=0.0,
            height=512,
            width=512,
        ).images[0]

        image = flatten_lighting(image)
        image = make_seamless(image)
        image = toward_grey(image)

        path = OUT / f"{name}.jpg"
        image.save(path, quality=80, optimize=True)
        print(f"  -> {path} ({path.stat().st_size // 1024}KB)", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
