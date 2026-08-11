#!/usr/bin/env python3
"""
Local, CPU-only key art generation.

There is no GPU on this machine, so the choices here are all about making
diffusion viable on four CPU cores:

  - sd-turbo, an adversarially distilled model that produces an image in 1-4
    denoising steps rather than the 30-50 a standard checkpoint needs. That is
    roughly a 10x saving and it is the only reason this finishes at all.
  - guidance_scale=0.0, which turbo models are trained for. Any other value
    both degrades quality and doubles the work, because classifier-free
    guidance runs the U-Net twice per step.
  - float32. CPU has no fast float16 path; half precision is *slower* here.

Usage:  python3 tools/imagegen/generate.py "a prompt" out.png [steps] [size]
"""
import sys
import time

import torch
from diffusers import AutoPipelineForText2Image

MODEL = "stabilityai/sd-turbo"


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else "a city at night"
    out = sys.argv[2] if len(sys.argv) > 2 else "out.png"
    steps = int(sys.argv[3]) if len(sys.argv) > 3 else 2
    size = int(sys.argv[4]) if len(sys.argv) > 4 else 512

    torch.set_num_threads(torch.get_num_threads())
    print(f"loading {MODEL} (first run downloads ~2.5GB)...", flush=True)
    t0 = time.time()
    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL, torch_dtype=torch.float32, safety_checker=None
    )
    pipe = pipe.to("cpu")
    pipe.set_progress_bar_config(disable=False)
    print(f"loaded in {time.time() - t0:.0f}s", flush=True)

    t1 = time.time()
    image = pipe(
        prompt=prompt,
        num_inference_steps=steps,
        guidance_scale=0.0,
        height=size,
        width=size,
    ).images[0]
    image.save(out)
    print(f"generated in {time.time() - t1:.0f}s -> {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
