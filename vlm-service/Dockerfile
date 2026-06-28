# =============================================================================
#  OptimusInvoice — VLM Service Container
#  Image: vlm-service   Port: 8100 (mapped to host 8300)
# =============================================================================
#
#  PROCESSING PIPELINE (what happens when an invoice PDF arrives):
#
#  1. Node.js server (host:3000) receives uploaded PDF
#  2. python-integration.ts POSTs the PDF to http://localhost:8300/extract-pdf
#  3. This container handles the request through app.py:
#
#     a. pdfplumber pre-flight  [~0.1s]
#        → If PDF has selectable text (digital invoice): extract directly, skip OCR
#        → If PDF is scanned/image-only: fall through to Surya
#
#     b. Surya OCR  [~90s on CPU, ~10-30s on GPU]
#        → Converts each PDF page to image
#        → Detection model (vikp/surya_det3): finds text regions
#        → Recognition model (vikp/surya_rec2): reads text from regions
#        → Supports Greek + English (SURYA_LANGS="el,en")
#
#     c. Qwen2.5-3B semantic extraction  [~30-90s on CPU]
#        → Takes raw OCR text → produces structured JSON
#        → Fields: supplier, invoiceNumber, date, lineItems[], totals, VAT
#        → Falls back to regex parser if Qwen not loaded or times out
#
#  4. Structured JSON returned to Node.js → saved to MySQL → shown in UI
#
#  CONCURRENCY: Qwen is single-threaded CPU inference.
#  A semaphore in app.py serialises requests so parallel uploads queue
#  instead of failing with connection errors.
#
#  OFFLINE BUILD: All Python packages are pre-downloaded into vlm-service/wheels/
#  by Download-VlmWheels.ps1. The docker build never needs internet access.
#  Only the Qwen2.5 model (~2GB GGUF) downloads at first container start
#  into a persistent Docker volume (llama-models).
# =============================================================================

# ── Base image ────────────────────────────────────────────────────────────────
# python:3.11-slim chosen for:
#   - CPython 3.11 matches the wheel tags (cp311) pre-downloaded by Download-VlmWheels.ps1
#   - slim variant: no GUI toolkits, smaller attack surface (~170MB vs ~900MB full)
#   - Debian Bookworm base (glibc 2.36) satisfies manylinux_2_17 ABI requirement
#     used by torch, onnxruntime, tiktoken, and other native wheels
FROM python:3.11-slim

# ── System dependencies ───────────────────────────────────────────────────────
# poppler-utils   → pdf2image uses pdftoppm/pdfinfo to rasterise PDF pages
#                   before passing them to Surya OCR
# libgl1          → OpenCV (used by Surya) requires libGL.so.1 at runtime
#                   without it: "ImportError: libGL.so.1: cannot open shared object"
# libglib2.0-0    → OpenCV also needs libglib; both are headless OpenCV deps
# wget            → not used at runtime; kept for debugging/model downloading
# git             → scikit-build-core may need it to detect package version
# cmake           → required to compile llama-cpp-python from source tarball
#                   (no pre-built Linux wheel available on PyPI for this arch)
# build-essential → gcc, g++, make — C/C++ toolchain for llama.cpp compilation
# pkg-config      → cmake uses pkg-config to locate system libraries during build
#
# --no-install-recommends: skip suggested packages (saves ~100MB)
# rm -rf /var/lib/apt/lists/*: remove apt cache to keep image layer small
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
# wheels/ is populated by Download-VlmWheels.ps1 before docker build runs.
# Folder structure:
#   wheels/torch/         torch 2.5.1+cpu + torchvision 0.20.1+cpu (~180MB)
#   wheels/transformers/  transformers 4.46.3 + tokenizers + safetensors (~50MB)
#   wheels/surya/         surya-ocr 0.6.13 + opencv + onnxruntime + pdftext (~120MB)
#   wheels/requirements/  fastapi + uvicorn + pdfplumber + tiktoken + httpx (~60MB)
#   wheels/llama/         llama-cpp-python source tarball + scikit-build-core (~55MB)
#
# COPY happens before pip installs so Docker can cache the wheel layer.
# If no wheels change, all subsequent RUN layers are served from Docker cache.
COPY wheels/ /wheels/

# ── Step 1: PyTorch CPU-only ──────────────────────────────────────────────────
# torch==2.5.1+cpu: CPU-only variant (~750MB installed) — no CUDA, no MPS.
#   "+cpu" suffix is PyTorch's custom index tag (not on PyPI standard index).
#   Wheels were downloaded with: pip download torch==2.5.1+cpu
#     --index-url https://download.pytorch.org/whl/cpu
# torchvision==0.20.1+cpu: vision ops used by Surya for image transforms.
#
# Why installed first: subsequent steps (transformers, surya) depend on torch
# and pip resolves the already-installed version rather than trying to fetch.
# Installing torch last would cause pip to re-resolve all deps from scratch.
#
# --no-index: NEVER contact PyPI — all packages must come from --find-links
# --find-links: local wheel directory (treated like a simple package index)
RUN pip install --no-cache-dir --no-index \
    --find-links=/wheels/torch \
    "torch==2.5.1+cpu" "torchvision==0.20.1+cpu"

# ── Step 2: transformers + huggingface-hub ────────────────────────────────────
# transformers==4.46.3: Surya 0.6.x uses the classic HuggingFace API
#   (AutoProcessor, AutoModelForVision2Seq). Newer transformers break the
#   surya 0.6.x DetectionPredictor/RecognitionPredictor API.
#
# huggingface-hub==0.29.3: PINNED — critical version constraint.
#   Versions ≥0.30.0 added hf-xet as a platform-conditional dependency
#   (platform_machine == "x86_64"). On Linux x86_64 (inside this container)
#   pip requires hf-xet, but hf-xet has no pre-built wheel in our offline
#   folder, causing the build to fail. 0.29.3 is the last clean version.
#
# --find-links uses both folders because:
#   transformers/ has: tokenizers, safetensors, pyyaml, regex
#   requirements/ has: packaging, tqdm, requests, filelock, fsspec
RUN pip install --no-cache-dir --no-index \
    --find-links=/wheels/transformers \
    --find-links=/wheels/requirements \
    "transformers==4.46.3" "huggingface-hub==0.29.3"

# ── Step 3: surya-ocr 0.6.13 ─────────────────────────────────────────────────
# surya-ocr==0.6.13: the last stable 0.6.x release using the legacy
#   DetectionPredictor + RecognitionPredictor API. Surya 0.7+ switched to
#   FoundationPredictor which requires a different model loading path and
#   broke our inference code.
#
# pillow>=10.2.0,<11.0.0: PINNED RANGE — surya 0.6.x hard-requires pillow<11.
#   The requirements/ folder contains pillow 12.x (downloaded for pdf2image).
#   If pillow 12 installs first, surya cannot import and the container fails.
#   Strategy: install surya BEFORE requirements (Step 4) so pillow 10.4.0
#   installs here, and Step 4's pdf2image reuses it (no upgrade).
#
# Three --find-links dirs needed because surya's deps span multiple folders:
#   surya/        has: surya wheel, opencv, onnxruntime, pdftext, pypdfium2,
#                      pydantic, pillow 10.x, filetype, ftfy, tabulate
#   transformers/ has: tokenizers (surya uses HF tokenizers)
#   requirements/ has: pyyaml, packaging (shared deps)
RUN pip install --no-cache-dir --no-index \
    --find-links=/wheels/surya \
    --find-links=/wheels/transformers \
    --find-links=/wheels/requirements \
    "surya-ocr==0.6.13" "pillow>=10.2.0,<11.0.0" "huggingface-hub==0.29.3"

# ── Step 4: FastAPI service dependencies ──────────────────────────────────────
# The service layer that wraps OCR and exposes HTTP endpoints.
#
# fastapi==0.115.6       → HTTP framework, handles /extract-pdf and /health
# uvicorn[standard]==0.34.0 → ASGI server; [standard] adds:
#                            uvloop (faster event loop, Linux-only)
#                            httptools (fast HTTP parsing)
#                            watchfiles (hot-reload, useful for dev)
#                            websockets (not used but part of standard)
# python-multipart==0.0.20 → required for FastAPI File/Form uploads;
#                            without it file uploads return 422 Unprocessable Entity
# pdf2image>=1.17.0      → wraps pdftoppm (poppler) to convert PDF pages to PIL Images
#                         for Surya. Does not pull pillow 12 because pillow<11 is
#                         already installed and pip reuses it (no upgrade attempted)
# pdfminer.six==20251230 → text extraction backend used by pdfplumber
# pdfplumber>=0.11.0     → high-level PDF text extractor for the native-text pre-flight.
#                         Digital PDFs skip Surya entirely via pdfplumber (0.1s vs 90s)
# tiktoken>=0.7.0        → BPE tokenizer used by the semantic extractor to count tokens
#                         before sending to Qwen (avoids context overflow)
# httpx>=0.23.0          → async HTTP client used in app.py for vLLM-compatible
#                         engine endpoints (olmOCR, Qwen-VL via external server)
# huggingface-hub==0.29.3 → re-specified to prevent pip upgrading it to a version
#                           that requires hf-xet (see Step 2 note)
#
# NOTE: requirements.txt is intentionally NOT used here.
# The requirements.txt file lists surya-ocr>=0.6.0 and chandra-ocr, which
# would cause pip to re-resolve all their dependencies from scratch — leading
# to platform tag conflicts and pillow version conflicts in offline mode.
RUN pip install --no-cache-dir --no-index \
    --find-links=/wheels/requirements \
    "fastapi==0.115.6" \
    "uvicorn[standard]==0.34.0" \
    "python-multipart==0.0.20" \
    "pdf2image>=1.17.0" \
    "pdfminer.six==20251230" \
    "pdfplumber>=0.11.0" \
    "tiktoken>=0.7.0" \
    "httpx>=0.23.0" \
    "huggingface-hub==0.29.3"

# ── Step 5: llama-cpp-python (compiled from source) ──────────────────────────
# llama-cpp-python>=0.3.2: Python bindings for llama.cpp, the C++ inference
#   engine that runs Qwen2.5-3B-Instruct-Q4_K_M.gguf for semantic extraction.
#
# WHY SOURCE (not a pre-built wheel):
#   No pre-built manylinux wheel exists for llama-cpp-python on PyPI that
#   matches cp311 + CPU-only + x86_64 without CUDA/Metal. The source tarball
#   (~51MB) is compiled here inside the container using the gcc toolchain
#   installed in Step 0 (build-essential, cmake).
#
# CMAKE_ARGS flags:
#   -DGGML_CUDA=OFF   → do not link against CUDA libraries (no GPU in this setup)
#   -DGGML_METAL=OFF  → macOS Metal GPU acceleration (irrelevant on Linux)
#   -DGGML_BLAS=OFF   → disable OpenBLAS/MKL; pure CPU with AVX2 SIMD instead
#                        (BLAS would require libopenblas-dev which is not installed)
#
# BUILD DEPENDENCIES (in /wheels/llama/):
#   scikit-build-core>=0.9.2: modern CMake build backend (replaces setuptools)
#   pyproject-metadata:       PEP 517 metadata reader used by scikit-build-core
#   ninja:                    fast parallel build system (replaces make)
#                             speeds up llama.cpp compilation from ~4min to ~2min
#
# RUNTIME DEPENDENCIES (resolved from /wheels/requirements/ and /wheels/surya/):
#   diskcache>=5.6.1: key-value cache for llama-cpp-python's chat history
#   jinja2>=2.11.3:   template engine for formatting chat prompts (already in surya folder)
#   numpy>=1.20.0:    array ops (already installed by torch step)
#   typing-extensions>=4.5.0: already installed
#
# COMPILE TIME: ~2 minutes on first build. Subsequent builds use Docker cache
# as long as the source tarball and Dockerfile haven't changed.
RUN CMAKE_ARGS="-DGGML_CUDA=OFF -DGGML_METAL=OFF -DGGML_BLAS=OFF" \
    pip install --no-cache-dir --no-index \
    --find-links=/wheels/llama \
    --find-links=/wheels/requirements \
    --find-links=/wheels/surya \
    "llama-cpp-python>=0.3.2"

# ── Verification (build-time smoke tests) ────────────────────────────────────
# These RUN commands execute during docker build and fail the build immediately
# if any package is broken or has a missing dependency — better to catch it
# here than at container startup when an invoice arrives.
RUN python -c "import transformers; print('transformers=' + transformers.__version__)"
RUN printf 'import sys\ntry:\n    from surya.model.detection.model import load_model as det\n    from surya.model.recognition.model import load_model as rec\n    print("surya 0.6.x API OK")\nexcept ImportError:\n    from surya.detection import DetectionPredictor\n    from surya.recognition import RecognitionPredictor\n    print("surya 0.8.x API OK")\n' > /tmp/check_surya.py && python /tmp/check_surya.py
RUN python -c "from llama_cpp import Llama; print('llama-cpp-python OK')"

# ── Application files ─────────────────────────────────────────────────────────
# Copied last so that code changes don't bust the pip install cache layers above.
# Only these three files change during development — all the heavy pip steps
# remain cached across redeploys.
#
# app.py               → FastAPI application. Endpoints:
#                          GET  /health        → liveness + readiness status
#                          POST /extract-pdf   → main OCR + extraction endpoint
#                        Includes asyncio.Semaphore(1) to serialise Qwen calls.
#
# vlm_invoice_parser.py → Pure-Python invoice field parser.
#                         Used as regex fallback when Qwen is not available.
#                         Also runs as post-processing validation after Qwen output.
#
# semantic_extractor.py → Wraps llama-cpp-python.
#                         Loads Qwen2.5-3B-Instruct Q4_K_M from GGUF cache.
#                         Formats the OCR text into a structured prompt,
#                         calls Llama(), parses the JSON response.
COPY app.py .
COPY vlm_invoice_parser.py .
COPY semantic_extractor.py .
COPY mydata_fields.py    .
COPY client_profile.py   .
COPY dispatch_fields.py  .
COPY vision_validator.py .
#                       ^ REQUIRED: vlm_service.py imports validate_vision_extraction
#                         from this module. Without this COPY the container crashes
#                         at startup with ModuleNotFoundError: No module named
#                         'vision_validator'.
COPY qwen3vl_engine.py   .
#                       ^ REQUIRED: vlm_service.py imports qwen3vl_engine for the
#                         Qwen3-VL-8B sidecar dispatch + 503/truncation handling.
COPY qwen35_engine.py    .
#                       ^ REQUIRED: vlm_service.py imports qwen35_engine for the
#                         Qwen3.5-4B sidecar dispatch (port 8800, newer llama.cpp).
# NOTE: mineru is NOT installed here. MinerU lives in its own mineru-service
#       sidecar container (modern torch/transformers, incompatible with Surya
#       0.6.13's pins). vlm_service.py reaches it over HTTP (MINERU_SERVICE_URL),
#       exactly like qwen3vl and gemma. Nothing MinerU-related is needed in this
#       image.
# ── Runtime environment variables ─────────────────────────────────────────────
ENV PORT=8100
                            # uvicorn listens on this port inside the container
                            # mapped to host port 8300 by docker run -p 8300:8100
ENV LOG_LEVEL=INFO
                            # uvicorn log verbosity

ENV HF_HOME=/models
                             # HuggingFace model cache — mounted as Docker volume
                             # Qwen2.5-VL-3B weights (~7.3 GB) pre-downloaded by
                             # Download-VlmWheels.ps1 into model_cache/ on host,
                             # which is bind-mounted here at container start
                             # HuggingFace model cache (surya model weights).
                             # Mounted as Docker volume so models persist across
                             # container recreations (surya downloads ~300MB on first start)

ENV TORCH_DEVICE=cpu
                             # Force PyTorch to CPU. "cuda" would require NVIDIA drivers
                             # and a CUDA-enabled torch wheel (not installed here)

ENV SURYA_LANGS="el,en"
                             # Greek + English — tells Surya which language models
                             # to load for text recognition. Adding more languages
                             # increases model load time and memory usage.

ENV VLM_MAX_TOKENS=4096
                             # Maximum tokens passed to any vLLM-based engine
                             # (olmOCR, Qwen-VL). Not used by Surya or Qwen2.5-3B.

ENV SEMANTIC_ENABLED=1
                             # 1 = run Qwen2.5-3B after OCR to extract structured fields
                             # 0 = use regex fallback only (faster but less accurate)

ENV SEMANTIC_MODEL=qwen2.5:3b
                             # Model identifier. Resolved by semantic_extractor.py to:
                             # /root/.cache/llama/qwen2.5-3b-instruct-q4_k_m.gguf
                             # The GGUF file is downloaded on first container start
                             # (~2.1GB) into the llama-models Docker volume.

ENV SEMANTIC_TIMEOUT=600
                             # Seconds to wait for Qwen inference before giving up
                             # and returning regex results. CPU inference can take
                             # 30-90s depending on text length and thread count.

ENV LLAMA_CACHE_DIR=/root/.cache/llama
                             # Where semantic_extractor.py looks for / saves GGUF files.
                             # Backed by a Docker volume so model survives redeploys.

ENV LLAMA_N_CTX=4096
                             # Qwen context window in tokens.
                             # Full model supports 32768 but we cap at 4096 for:
                             #   - Lower RAM usage (context = ~512MB at 4096 vs 4GB at 32768)
                             #   - Faster inference (attention is O(n²) in context length)
                             # A typical invoice OCR text is 500-2000 tokens — well within 4096.

ENV LLAMA_N_THREADS=8
                             # CPU threads for llama.cpp matrix operations.
                             # Set to ~half your logical CPU count for best throughput.
                             # Using all cores causes thermal throttling and hurts other processes.
                             # Check your count: (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

# ── MinerU runs in its own sidecar (mineru-service:8700) — no MinerU config here.

# ── Network ───────────────────────────────────────────────────────────────────
EXPOSE 8100
                             # Documents the internal port. Actual mapping is set by
                             # docker run -p 8300:8100 in deploySolutionLocal.ps1

# ── Health check ──────────────────────────────────────────────────────────────
# Docker polls this every 30s. The container is "healthy" only after startup
# completes (Surya models loaded + Qwen pre-loaded = ~5-15s after launch).
#
# --interval=30s    → check every 30 seconds
# --timeout=10s     → fail if /health doesn't respond within 10s
# --start-period=180s → don't count failures during the first 3 minutes
#                       (first-ever start downloads Surya ~300MB + Qwen ~2GB)
# --retries=3       → mark unhealthy only after 3 consecutive failures
#                     (90 seconds of no response = container is stuck)
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/health')" || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────────
# Runs app.py directly with Python (not uvicorn CLI) because app.py calls
# uvicorn.run() internally, allowing it to configure host/port from ENV vars.
# PID 1 = Python process → receives SIGTERM from docker stop → graceful shutdown.
CMD ["python", "app.py"]