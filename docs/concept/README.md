# Concept art

Generated locally on this machine's CPU — no GPU, no external image service.

`tools/imagegen/` holds the setup: the CPU-only torch wheel plus **sd-turbo**, an
adversarially distilled model that produces an image in 1–4 denoising steps
instead of the 30–50 a standard Stable Diffusion checkpoint needs. That is
roughly a 10× saving and it is the only reason this finishes on four cores —
about **15 seconds per 512px image** after a one-off ~2.5GB model download.

```bash
bash tools/imagegen/install.sh
python3 tools/imagegen/generate.py "your prompt" out.png 4 512
```

Two choices worth keeping if you tune it: `guidance_scale=0.0`, which turbo
models are trained for and which halves the work because classifier-free
guidance otherwise runs the U-Net twice per step; and float32, because CPU has
no fast float16 path and half precision is actually *slower* here.

## These are reference, not assets

Nothing here ships in the build. Every texture in the game is generated
procedurally at runtime, which is what keeps the bundle small enough to load
quickly in the Quest browser — dropping a 500KB PNG into the boot screen would
undo that for decoration. These exist to check the palette reads the way it is
supposed to, and as a target to aim the real-time renderer at.

| | |
|---|---|
| `keyart.png` | Street level, wet road, purple sky over green shopfronts — closest to what the game actually looks like |
| `keyart-skyline.png` | Skyline variant. On-palette but has artifacts in the sky |
