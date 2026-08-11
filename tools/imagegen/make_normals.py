#!/usr/bin/env python3
"""
Derive normal maps for the albedo jpgs already sitting in public/textures/,
without touching sdxl-turbo. Normal-map generation is a deterministic Sobel
filter over existing pixels (see make_normal() in make_textures.py) — it has
nothing to do with the diffusion model, so re-running the ~50s CPU model
load and a multi-second generation per image to get here would be pure
waste. This script exists so "I changed the strength constant" or "I want
normals for an albedo I hand-authored" doesn't require a GPU-model round
trip.
"""
import sys
from pathlib import Path

from PIL import Image

from make_textures import TEXTURES, make_normal

OUT = Path("public/textures")


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for name in TEXTURES:
        if only and only != name:
            continue
        src = OUT / f"{name}.jpg"
        if not src.exists():
            print(f"  skip {name}: {src} not found (run make_textures.py first)", flush=True)
            continue
        normal = make_normal(Image.open(src))
        path = OUT / f"{name}_n.jpg"
        normal.save(path, quality=85, optimize=True)
        print(f"  -> {path} ({path.stat().st_size // 1024}KB)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
