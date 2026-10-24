# Dockerfile — paddle-ocr-service
# ─────────────────────────────────────────────────────────────────────────────
# PaddleOCR PP-StructureV3 (CPU) + KIE sidecar for Optimus invoice extraction.
#
# Contract: exposes POST /extract-pdf and GET /health on PORT (default 8900),
# mirroring mineru-service / gemma-vl-service so vlm-service can proxy to it.
#
# The .py files are STAGED into this folder by deployDockerFull.ps1 STEP 4e from
# server\python\ (single source of truth, same as every other service). This
# Dockerfile + requirements.txt are the only files that live here permanently.
#
# ── Two build modes ──────────────────────────────────────────────────────────
#  A) ONLINE (default below): pip pulls paddlepaddle/paddleocr from PyPI at
#     build time. The build host needs internet (it already does — you pull
#     llama.cpp images and download models the same way).
#  B) OFFLINE / air-gapped: pre-download wheels into ./wheels/paddle and install
#     with --no-index --find-links (see the commented block). Models are a
#     SEPARATE concern — PaddleOCR fetches them at RUNTIME into
#     /models/paddlex; pre-bake them with Download-PaddleModels.ps1.
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim

# ── System deps ──────────────────────────────────────────────────────────────
#  poppler-utils  → pdf2image rasterisation
#  libgl1 / libglib2.0-0 / libgomp1 → OpenCV + Paddle runtime shared libs
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── (A) ONLINE install ───────────────────────────────────────────────────────
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# ── (B) OFFLINE install — uncomment and comment out (A) above ─────────────────
# COPY wheels/paddle/ /wheels/paddle/
# RUN pip install --no-cache-dir --no-index --find-links=/wheels/paddle \
#     paddlepaddle==3.0.0 paddleocr==3.1.1 \
#     fastapi==0.115.6 "uvicorn[standard]==0.34.0" python-multipart==0.0.20 \
#     pdf2image pillow numpy httpx

# ── Sanity check the pipeline imports (does NOT download models) ──────────────
RUN python -c "from paddleocr import PPStructureV3; print('PPStructureV3 import OK')"

# ── Application code (staged from server\python\ by deployDockerFull.ps1 4e) ───
COPY paddle_ocr_engine.py   /app/paddle_ocr_engine.py
COPY paddle_kie.py          /app/paddle_kie.py
COPY paddle_ocr_service.py  /app/paddle_ocr_service.py
COPY paddle_ppchatocr.py    /app/paddle_ppchatocr.py
COPY vision_postprocess.py  /app/vision_postprocess.py

# ── Model cache: PaddleOCR/PaddleX store models here (bind-mounted /models) ────
ENV PADDLE_PDX_CACHE_HOME=/models/paddlex
ENV PORT=8900
ENV PADDLE_DEVICE=cpu
ENV PADDLE_LANG=el
ENV LOG_LEVEL=INFO

EXPOSE 8900

HEALTHCHECK --interval=30s --timeout=10s --retries=8 --start-period=300s \
    CMD curl -fsS http://localhost:8900/health || exit 1

CMD ["python", "paddle_ocr_service.py"]
