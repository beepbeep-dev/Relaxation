#!/usr/bin/env bash
# CPU-only image generation. No GPU on this machine, so everything here is
# picked for CPU viability: the CPU torch wheel (a fraction of the CUDA one)
# and a turbo model that produces an image in 1-4 denoising steps instead of
# the 30-50 a standard Stable Diffusion checkpoint needs.
set -euo pipefail
pip3 install --break-system-packages --quiet \
  --index-url https://download.pytorch.org/whl/cpu torch
pip3 install --break-system-packages --quiet diffusers transformers accelerate safetensors pillow
python3 -c "import torch, diffusers; print('torch', torch.__version__, 'diffusers', diffusers.__version__)"
