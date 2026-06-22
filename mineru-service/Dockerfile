# =============================================================================
#  OptimusInvoice — MinerU Service Container (sidecar)
#  Image: mineru-service   Port: 8700
# =============================================================================
#
#  WHY A SEPARATE CONTAINER:
#    MinerU's pipeline backend requires a MODERN dependency stack:
#       torch >= 2.6, transformers >= 4.57.3, pillow (recent)
#    The vlm-service container is pinned to the OLD Surya 0.6.13 stack:
#       torch 2.5.1, transformers 4.46.3, pillow < 11
#    These CANNOT coexist in one Python environment (the exact transformers
#    version conflict that already forced qwen-vl and gemma-vl into their own
#    containers). So MinerU gets its own isolated container and is reached over
#    HTTP — identical to how vlm-service calls qwen-vl-service / gemma-vl-service.
#
#  WHAT IT DOES:
#    POST /extract-pdf  → runs MinerU pipeline backend (CPU) → returns Markdown.
#    It is a READER only. vlm-service feeds the returned Markdown to its local
#    Qwen2.5-3B semantic_extractor to produce the invoice schema.
#
#  OFFLINE BUILD:
#    All wheels are pre-downloaded into mineru-service/wheels/ by the deploy
#    script's one-time download step. The docker build never needs internet
#    (--no-index). This matches every other OptimusInvoice container.
# =============================================================================

# ── Base image ────────────────────────────────────────────────────────────────
# python:3.11-slim — matches the cp311 wheel tags downloaded for the other
# containers, Debian Bookworm glibc satisfies manylinux_2_17 for torch/onnxruntime.
FROM python:3.11-slim

# ── System dependencies ───────────────────────────────────────────────────────
# poppler-utils → MinerU/pdf rasterisation (pdftoppm/pdfinfo)
# libgl1 + libglib2.0-0 → OpenCV (MinerU pipeline uses cv2) runtime libs
# build-essential + cmake + pkg-config + git → in case any MinerU dep needs a
#   source build (albumentations/onnxruntime deps occasionally do)
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    wget \
    git \
    cmake \
    build-essential \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Copy pre-downloaded wheels ────────────────────────────────────────────────
# mineru-service/wheels/ is populated by the deploy script's one-time download:
#   wheels/torch/         torch 2.7.x (CPU) + torchvision
#   wheels/mineru/        mineru[core] + transformers 4.57 + its full dep tree
#   wheels/requirements/  fastapi + uvicorn + python-multipart
#
# COPY before pip installs so Docker caches the wheel layer.
COPY wheels/ /wheels/

# ── Step 1: PyTorch CPU-only (torch 2.6.x) ────────────────────────────────────
# MinerU pipeline requires torch>=2.6,<3. We use the CPU build — no GPU.
# Installed FIRST so transformers/mineru resolve against the already-present
# torch rather than trying to fetch a CUDA build.
# --find-links spans ALL wheel folders because torch's pure-Python deps
# (filelock, sympy, networkx, jinja2, fsspec, typing-extensions) may have been
# downloaded into any of them by Download-MineruWheels.ps1.
RUN pip install --no-cache-dir --no-index \
    --find-links=/wheels/torch \
    --find-links=/wheels/requirements \
    --find-links=/wheels/mineru \
    "torch>=2.6.0,<3" "torchvision"

# ── Step 2: FastAPI service layer ─────────────────────────────────────────────
RUN pip install --no-cache-dir --no-index \
    --find-links=/wheels/requirements \
    --find-links=/wheels/mineru \
    "fastapi" "uvicorn[standard]" "python-multipart" "pdfplumber"

# ── Step 3: MinerU pipeline backend (offline) ─────────────────────────────────
# Pulls transformers>=4.57.3, accelerate, onnxruntime, albumentations, shapely,
# pyclipper, omegaconf, ftfy, etc. All must be present in /wheels/mineru/.
# This is the heavy layer. Because torch is already installed (Step 1), pip
# reuses it instead of re-resolving.
RUN pip install --no-cache-dir --no-index \
    --find-links=/wheels/mineru \
    --find-links=/wheels/torch \
    --find-links=/wheels/requirements \
    "mineru[pipeline]==3.4.0"

# ── Verification (build-time smoke tests) ────────────────────────────────────
# Fail the build immediately if MinerU or transformers can't import, rather
# than at container startup when an invoice arrives.
RUN python -c "import transformers; print('transformers=' + transformers.__version__)"
RUN python -c "import torch; print('torch=' + torch.__version__)"
RUN python -c "import mineru; print('mineru OK')"

# ── Application files ─────────────────────────────────────────────────────────
# Copied last so code changes don't bust the pip cache layers above.
#   mineru_reader.py  → wraps MinerU pipeline backend → Markdown (shared with
#                       vlm-service, but here it's the in-process worker)
#   mineru_service.py → the FastAPI app (POST /extract-pdf, GET /health)
COPY mineru_reader.py  .
COPY mineru_service.py .

# ── Runtime environment variables ─────────────────────────────────────────────
ENV PORT=8700
ENV LOG_LEVEL=INFO
# MinerU config (read by mineru_reader.py)
ENV MINERU_BACKEND=pipeline
ENV MINERU_DEVICE_MODE=cpu
ENV MINERU_LANG=el
# Keep HF fully offline at runtime — MinerU model weights are baked / cached in
# the model_cache volume; never reach out to the hub.
ENV HF_HOME=/models
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
# CPU thread budget — leave headroom so this sidecar doesn't starve vlm-service.
ENV OMP_NUM_THREADS=8

EXPOSE 8700

# ── Health check ──────────────────────────────────────────────────────────────
# start-period is generous: MinerU pipeline lazy-loads several models on the
# first request, which can take a while on CPU.
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8700/health')" || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────────
CMD ["python", "mineru_service.py"]
