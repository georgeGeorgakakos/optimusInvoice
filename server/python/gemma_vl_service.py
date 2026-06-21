"""
gemma_vl_service.py
─────────────────────────────────────────────────────────────────────────────
FastAPI HTTP service that exposes the Gemma 3 vision engine (GGUF/llama.cpp).

Endpoints:
  GET  /health         - readiness probe ({status, ready, loading, model})
  POST /extract-pdf    - multipart PDF upload -> { text, structured, ... }

This service is called by vlm_service.py (port 8300) via HTTP. The HTTP API
shape MIRRORS qwen_vl_service so the dispatcher in vlm_service.py can route
to either container with the same contract.

Backend: llama-cpp-python with Q4_K_M GGUF + mmproj (vision projector).
~5-10 tok/s on CPU (12 cores). Single invoice extraction: 2-3 min typical.

Concurrency: llama.cpp inference is single-threaded. We serialise extraction
requests via asyncio.Semaphore so concurrent uploads queue up instead of
failing with OOM or connection errors.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import gemma_vl_engine

# --------------------------- logging ----------------------------------------
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("gemma_vl_service")

# Single-flight semaphore — Gemma 3 inference is single-threaded
_extraction_sem = asyncio.Semaphore(1)


def _extract_native_text(pdf_bytes: bytes) -> str:
    """
    Extract the PDF's embedded text layer via pdfplumber (fast, <1s for digital
    PDFs, empty for true scans). Used as the trustworthy reference for the shared
    vision post-processor: currency detection ($ / USD vs the model's guess) and
    full cross-reference validation (hallucinated VAT numbers, street-as-name).
    Never raises — returns "" on any failure or for image-only PDFs.
    """
    try:
        import pdfplumber
        out = []
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                try:
                    out.append(page.extract_text() or "")
                except Exception:
                    continue
        return "\n".join(out).strip()
    except Exception as exc:
        log.warning(f"[GemmaVL] native text extraction failed: {exc}")
        return ""


# --------------------------- lifespan ---------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("=== Gemma VL Service starting ===")
    log.info(f"Model: {os.environ.get('GEMMA_VL_LOCAL_MODEL', 'google/gemma-3-4b-it')}")

    # Pre-load in the background so the service can respond to /health right
    # away while the model loads. /extract-pdf returns HTTP 503 until ready.
    async def _bg_load():
        try:
            loop = asyncio.get_event_loop()
            ok = await loop.run_in_executor(None, gemma_vl_engine.load_gemma_vl_local)
            if ok:
                log.info("[GemmaVL] Model pre-loaded successfully")
            else:
                log.error(f"[GemmaVL] Pre-load failed: {gemma_vl_engine.get_load_error()}")
        except Exception as e:
            log.exception(f"[GemmaVL] Pre-load crashed: {e}")

    asyncio.create_task(_bg_load())
    yield
    log.info("=== Gemma VL Service shutting down ===")


# --------------------------- app --------------------------------------------
app = FastAPI(
    title="Optimus Gemma 3 Vision Service",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------- routes -----------------------------------------

@app.get("/health")
async def health():
    """
    Readiness probe used by:
      - Docker HEALTHCHECK (passes if 200 returned)
      - vlm-service dispatcher (checks `ready=True` before forwarding requests)
      - the Configuration UI (engine status grid)
    """
    return {
        "status":  "ok",
        "ready":   gemma_vl_engine.is_loaded(),
        "loading": gemma_vl_engine.is_loading(),
        "error":   gemma_vl_engine.get_load_error(),
        "model":   os.environ.get("GEMMA_VL_LOCAL_MODEL", "google/gemma-3-4b-it"),
        "engine":  "gemma_vl_local",
    }


@app.post("/extract-pdf")
async def extract_pdf(
        file:             UploadFile = File(...),
        engine:           str        = Form("gemma_vl_local"),
        language:         str        = Form("el"),
        extract_invoice:  str        = Form("1"),
        use_native_text:  str        = Form("0"),
):
    """
    Accepts a PDF, rasterises the first page, runs Gemma 3 inference, returns
    the model's JSON output as structured fields plus the raw text for
    debugging.

    Mirrors the contract of qwen_vl_service.extract-pdf so vlm_service.py can
    route to either container with identical request shapes.

    The form fields `engine`, `language`, `extract_invoice`, `use_native_text`
    are accepted for compatibility with the dispatcher but only the PDF bytes
    are actually used (Gemma 3 is a pure vision model — no OCR pre-step).
    """
    # Return 503 if model isn't loaded yet — vlm-service retries with backoff
    if not gemma_vl_engine.is_loaded():
        if gemma_vl_engine.is_loading():
            raise HTTPException(503, "Model still loading — retry in a moment")
        # Not loading and not loaded — load failed earlier
        err = gemma_vl_engine.get_load_error() or "Unknown load error"
        raise HTTPException(503, f"Model not available: {err}")

    async with _extraction_sem:
        return await _do_extract(file, language)


async def _do_extract(file: UploadFile, language: str) -> Dict[str, Any]:
    t0 = time.perf_counter()
    pdf_bytes = await file.read()
    log.info(f"[GemmaVL] Received {len(pdf_bytes)} bytes ({file.filename})")

    # Rasterise first page (Gemma 3 needs an image, not a PDF)
    try:
        from pdf2image import convert_from_bytes
        # DPI is env-configurable via GEMMA_VL_DPI (mirrors QWEN_VL_DPI on the
        # qwen engine). Unified default 150 across all deploy paths — balanced:
        # sharper than 100 for small digits (VAT/ΑΦΜ), faster than 200 on CPU.
        # Higher DPI increases image tokens + inference time; keep aligned with
        # QWEN_VL_DPI for consistent reads between the two vision engines.
        gemma_dpi = int(os.getenv("GEMMA_VL_DPI", "150"))
        log.info(f"[GemmaVL] Rasterising PDF at dpi={gemma_dpi}")
        images = convert_from_bytes(pdf_bytes, dpi=gemma_dpi, first_page=1, last_page=1)
    except Exception as e:
        log.exception("[GemmaVL] pdf2image conversion failed")
        raise HTTPException(500, f"PDF rasterisation failed: {e}")

    if not images:
        raise HTTPException(400, "PDF contains no pages")

    image = images[0]

    # Extract the PDF's native text once (fast). Threaded into the engine so the
    # shared post-processor validates against the REAL invoice text, and returned
    # as "text" below so the Node resolveCurrency() sees real $/USD signals instead
    # of the model's JSON (fixes the EUR-default bug on USD invoices).
    native_text = _extract_native_text(pdf_bytes)
    if native_text:
        log.info(f"[GemmaVL] Native text: {len(native_text)} chars (used as validation/currency reference)")
    else:
        log.info("[GemmaVL] No native text (scanned PDF) — model currency used as-is")

    # Inference happens in a thread executor so we don't block the event loop
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, gemma_vl_engine.extract_invoice_from_image, image, language, native_text or None
        )
    except Exception as e:
        log.exception("[GemmaVL] Inference failed")
        raise HTTPException(500, f"Inference failed: {e}")

    elapsed = round(time.perf_counter() - t0, 2)

    raw_model_text = result.get("text", "")
    response = {
        # Return native PDF text as "text" when available so downstream currency
        # detection reads the real invoice; fall back to model output for scans.
        # Raw model output preserved under "model_text" for debugging.
        "text":         native_text or raw_model_text,
        "model_text":   raw_model_text,
        # Parsed JSON the dispatcher can merge into the invoice extracted_data
        "structured":   result.get("structured", {}),
        # Metadata for client display / DB persistence
        "engine":       "gemma_vl_local",
        "engines_used": ["gemma_vl_local"],
        "elapsed":      elapsed,
        "inference_seconds": result.get("elapsed"),
    }

    structured = result.get("structured", {}) or {}
    invoice_num = structured.get("invoiceNumber") if isinstance(structured, dict) else None
    line_count = len(structured.get("lineItems", [])) if isinstance(structured, dict) else 0
    log.info(
        f"[GemmaVL] Done in {elapsed}s — invoice={invoice_num!r}, "
        f"line_items={line_count}, chars={len(response['text'])}"
    )

    return response


# --------------------------- main -------------------------------------------
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8500"))
    uvicorn.run(app, host="0.0.0.0", port=port)