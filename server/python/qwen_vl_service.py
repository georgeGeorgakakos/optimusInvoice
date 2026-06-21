"""
qwen_vl_service.py
Minimal FastAPI wrapper around qwen_vl_engine.py.
Runs in its own container (port 8400) with transformers>=4.52.
vlm_service.py (port 8300) proxies qwen_vl_local requests here.
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import qwen_vl_engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("qwen_vl_service")

PORT = int(os.getenv("PORT", "8400"))

# Global flag: True once model is fully loaded and ready
_model_ready = False
_model_loading = False

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model_ready, _model_loading
    log.info("=== Qwen2.5-VL Service starting up ===")
    loop = asyncio.get_event_loop()

    async def _preload():
        global _model_ready, _model_loading
        _model_loading = True
        try:
            log.info("Pre-loading Qwen2.5-VL-3B model (this takes ~120s)...")
            ok = await loop.run_in_executor(None, qwen_vl_engine.load_qwen_vl_local)
            if ok:
                _model_ready = True
                log.info("Qwen2.5-VL-3B pre-loaded successfully — ready for requests")
            else:
                log.warning("Qwen2.5-VL-3B pre-load failed")
        except Exception as exc:
            log.warning(f"Qwen2.5-VL-3B pre-load error: {exc}")
        finally:
            _model_loading = False

    asyncio.create_task(_preload())
    yield
    log.info("Qwen2.5-VL Service shutting down")


app = FastAPI(title="Qwen2.5-VL Service", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_semaphore = asyncio.Semaphore(1)  # serialise CPU inference — only one request at a time


def _extract_native_text(pdf_bytes: bytes) -> str:
    """
    Extract the PDF's embedded text layer via pdfplumber (fast, <1s for digital
    PDFs, empty for true scans). Used as the trustworthy reference for the shared
    vision post-processor: currency detection ($ / USD vs the model's guess) and
    full cross-reference validation (hallucinated VAT numbers, street-as-name).
    Never raises — returns "" on any failure or for image-only PDFs.
    """
    try:
        import io
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
        log.warning(f"[QwenVL-Service] native text extraction failed: {exc}")
        return ""


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "qwen_vl_service",
        "model": os.getenv("QWEN_VL_LOCAL_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct"),
        "loaded": qwen_vl_engine.is_loaded(),
        "ready": _model_ready,
        "loading": _model_loading,
    }


@app.post("/extract-pdf")
async def extract_pdf(
        file: UploadFile = File(...),
        engine: str = Form("qwen_vl_local"),
        language: str = Form("el"),
        extract_invoice: str = Form("1"),
        use_native_text: str = Form("0"),
):
    t0 = time.perf_counter()

    # ── Block until model is ready ────────────────────────────────────────────
    # If a request arrives while the model is still loading (e.g. container
    # just started), wait up to 300s for it to finish rather than crashing.
    wait_start = time.perf_counter()
    while not _model_ready:
        if time.perf_counter() - wait_start > 300:
            raise HTTPException(
                status_code=503,
                detail="Qwen2.5-VL-3B model is still loading. Please retry in a moment."
            )
        log.info(f"[QwenVL-Service] Model still loading — waiting... ({int(time.perf_counter()-wait_start)}s)")
        await asyncio.sleep(5)

    pdf_bytes = await file.read()
    log.info(f"[QwenVL-Service] Received PDF: {len(pdf_bytes)} bytes")

    # Extract the PDF's native text once (fast). Threaded into the engine so the
    # shared post-processor validates against the REAL invoice text, and returned
    # as "text" below so the Node resolveCurrency() sees real $/USD signals instead
    # of the model's JSON (fixes the EUR-default bug on USD invoices).
    native_text = _extract_native_text(pdf_bytes)
    if native_text:
        log.info(f"[QwenVL-Service] Native text: {len(native_text)} chars (used as validation/currency reference)")
    else:
        log.info("[QwenVL-Service] No native text (scanned PDF) — model currency used as-is")

    async with _semaphore:
        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(
                None,
                lambda: qwen_vl_engine.extract_invoice_from_pdf_bytes(
                    pdf_bytes, reference_text=native_text or None
                )
            )
        except Exception as exc:
            log.error(f"[QwenVL-Service] Extraction failed: {exc}", exc_info=True)
            return {
                "text":      "",
                "structured": {},
                "error":     str(exc),
                "engine":    "qwen_vl_local",
                "elapsed":   round(time.perf_counter() - t0, 2),
            }

    elapsed = round(time.perf_counter() - t0, 2)
    raw_model_text = result.get("text", "")
    log.info(f"[QwenVL-Service] Done: {len(raw_model_text)} chars in {elapsed}s")
    if not raw_model_text.strip():
        log.error("[QwenVL-Service] Model returned empty text — dumping result keys: " + str(list(result.keys())))
    else:
        log.info(f"[QwenVL-Service] Raw output preview: {raw_model_text[:200]}")

    # Return the native PDF text as "text" when available so downstream currency
    # detection reads the real invoice; fall back to the model output for scans.
    # The raw model output is preserved under "model_text" for debugging.
    return {
        "text":       native_text or raw_model_text,
        "model_text": raw_model_text,
        "structured": result.get("structured", {}),
        "engine":     "qwen_vl_local",
        "elapsed":    elapsed,
    }


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
        timeout_keep_alive=1800,   # 30 min — Qwen CPU inference takes 2-5 min
        h11_max_incomplete_event_size=10 * 1024 * 1024,
    )