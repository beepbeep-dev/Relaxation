#!/usr/bin/env python3
"""One-shot timing/memory probe for stabilityai/sdxl-turbo on CPU.

Not part of the shipped pipeline. Run once to decide whether SDXL-Turbo is
actually usable in this environment before switching make_textures.py over
to it -- sd-turbo (SD2.1-distilled, ~530M UNet) is known-fast here; SDXL-Turbo
(~2.6B UNet + dual text encoders) may or may not fit the time/memory budget
for a background generation job.
"""
import resource
import time

import torch
from diffusers import AutoPipelineForText2Image

MODEL = "stabilityai/sdxl-turbo"

print(f"loading {MODEL} on CPU (float32)...", flush=True)
t0 = time.time()
pipe = AutoPipelineForText2Image.from_pretrained(
    MODEL, torch_dtype=torch.float32, safety_checker=None
).to("cpu")
pipe.set_progress_bar_config(disable=True)
print(f"loaded in {time.time() - t0:.1f}s", flush=True)

t0 = time.time()
img = pipe(
    prompt="flat overhead photograph of worn wet asphalt road surface, fine gravel aggregate, evenly lit, no shadows, seamless texture, macro detail",
    num_inference_steps=1,
    guidance_scale=0.0,
    height=512,
    width=512,
).images[0]
dt = time.time() - t0
peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
print(f"1-step 512px generation: {dt:.1f}s, peak RSS {peak_mb:.0f}MB", flush=True)
img.save("/tmp/sdxl_bench.jpg", quality=85)

t0 = time.time()
img2 = pipe(
    prompt="flat overhead photograph of raw poured concrete slab, subtle pitting, evenly lit, seamless texture, macro detail",
    num_inference_steps=2,
    guidance_scale=0.0,
    height=512,
    width=512,
).images[0]
dt2 = time.time() - t0
print(f"2-step 512px generation: {dt2:.1f}s", flush=True)
print("DONE", flush=True)
