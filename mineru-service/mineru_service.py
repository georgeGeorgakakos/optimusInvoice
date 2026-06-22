"""
mineru_service.py
─────────────────────────────────────────────────────────────────────────────
FastAPI HTTP service that exposes the MinerU document reader (pipeline backend).

Endpoints:
  GET  /health         - readiness probe ({status, ready, model, backend})
  POST /extract-pdf    - multipart PDF upload -> { markdown, pages, elapsed }

This service runs in its OWN container (mineru-service, port 8700) with its own
modern dependency stack (torch 2.7 + transformers 4.57 + mineru[core]), isolated
from vlm-service's pinned Surya 0.6.13 / transformers 4.46.3 stack. This mirrors
the isolation pattern already used for qwen-vl-service and gemma-vl-service:
those conflicting dependency stacks each live in a separate container and are
reached over HTTP.

IMPORTANT — what this service does and does NOT do:
  - It is a READER. It converts a PDF to Markdown (tables as HTML), nothing more.
  - It does NOT produce the invoice schema. After this returns Markdown, the
    caller (vlm_service.py in the vlm-service container) runs the SAME local
    Qwen2.5-3B semantic_extractor it uses for the pdfplumber/Surya paths to map
    the Markdown to invoice fields. The "two jobs" split (read vs understand) is
    preserved: this container reads, vlm-service understands.

Backend: MinerU `pipeline` backend, pinned to CPU (MINERU_DEVICE_MODE=cpu). The
pipeline backend is the only one that runs without a GPU.

Concurrency: MinerU's pipeline runs several models; we serialise extraction
requests via asyncio.Semaphore so concurrent uploads queue instead of thrashing
the CPU / running out of RAM.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import mineru_reader

# --------------------------- logging ----------------------------------------
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("mineru_service")

# Single-flight semaphore — MinerU pipeline is CPU/RAM heavy; serialise.
_extraction_sem = asyncio.Semaphore(1)

# Set True once a warm-up extraction has succeeded (or the module imports clean).
_READY = {"value": False}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm the import path at startup so the first real request isn't the one
    # that pays the (potentially slow) lazy model init. We do NOT hard-fail if
    # MinerU isn't importable — /health will simply report not-ready and the
    # caller falls back to Surya.
    try:
        if mineru_reader.is_available():
            _READY["value"] = True
            log.info("MinerU reader is available (pipeline backend, CPU).")
        else:
            log.warning("MinerU package not importable — service will report not-ready.")
    except Exception as exc:  # noqa: BLE001
        log.error(f"MinerU init check failed: {exc}", exc_info=True)
    yield
    log.info("mineru-service shutting down.")


app = FastAPI(title="OptimusInvoice MinerU Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> Dict[str, Any]:
    available = False
    try:
        available = bool(mineru_reader.is_available())
    except Exception:  # noqa: BLE001
        available = False
    return {
        "status":  "ok",
        "ready":   available and _READY["value"],
        "model":   "mineru-pipeline",
        "backend": os.getenv("MINERU_BACKEND", "pipeline"),
        "device":  os.getenv("MINERU_DEVICE_MODE", "cpu"),
        "lang":    os.getenv("MINERU_LANG", "el"),
    }


@app.post("/extract-pdf")
async def extract_pdf(
        file: UploadFile = File(...),
        # Accept the same form fields the other sidecars accept so the dispatcher
        # can call every container with one contract — we just ignore the ones that
        # don't apply to a reader (a reader has no invoice-extraction prompt).
        engine: str = Form("mineru"),
        language: str = Form("el"),
        extract_invoice: str = Form("true"),
        use_native_text: str = Form("false"),
) -> Dict[str, Any]:
    """
    Read a PDF and return Markdown. Returns 503 while MinerU is not ready so the
    caller's retry loop (same as gemma/qwen) can wait for first-time model init.
    """
    if not mineru_reader.is_available():
        # 503 → caller retries / falls back to Surya. Not a hard error.
        raise HTTPException(status_code=503, detail="MinerU not ready")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="empty file")

    async with _extraction_sem:
        t0 = time.perf_counter()
        try:
            # Run the (blocking) MinerU pipeline off the event loop.
            loop = asyncio.get_event_loop()
            markdown = await loop.run_in_executor(
                None, mineru_reader.extract_markdown_from_pdf_bytes, pdf_bytes
            )
        except Exception as exc:  # noqa: BLE001
            log.error(f"[mineru-service] extraction failed: {exc}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"mineru extraction failed: {exc}")

    elapsed = round(time.perf_counter() - t0, 2)
    markdown = markdown or ""
    _READY["value"] = True
    log.info(
        f"[mineru-service] {file.filename or 'invoice.pdf'} → "
        f"{len(markdown)} chars Markdown in {elapsed}s"
    )
    return {
        # Primary field for a reader: the Markdown. We also alias it as `text`
        # so any generic reader-consumer can pick it up.
        "markdown":          markdown,
        "text":              markdown,
        "extraction_method": "markdown",
        "engine":            "mineru",
        "elapsed":           elapsed,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8700"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level=os.getenv("LOG_LEVEL", "info").lower())