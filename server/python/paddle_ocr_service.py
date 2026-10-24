"""
paddle_ocr_service.py
─────────────────────────────────────────────────────────────────────────────
FastAPI sidecar for PaddleOCR PP-StructureV3 + KIE  →  invoice JSON  (CPU).

HTTP contract mirrors the other Optimus sidecars (mineru-service / qwen-vl /
gemma-vl) so vlm-service can proxy to it with the same helper:

  GET  /health
       → 200 {"status":"ok","ready":true|false,"engine":"paddle_ocr"}
         (200 with ready=false while PP-StructureV3 is still loading; the
          vlm-service proxy treats not-ready like the others and retries)

  POST /extract-pdf   (multipart form)
       fields:
         file            : the PDF (or image) bytes            [required]
         engine          : "paddle_ocr" (ignored, for symmetry)
         language        : "el" (ignored — set via PADDLE_LANG env)
         extract_invoice : "1"/"0"  — run KIE to invoice JSON  [default "1"]
       → 200 {
           "text":       "<markdown>",
           "markdown":   "<markdown>",
           "structured": {<invoice json>} | null,
           "engine":     "paddle_ocr",
           "elapsed":    <seconds>
         }

When structured is null (extract_invoice=0, or PADDLE_KIE_BACKEND=none, or the
KIE LLM failed), vlm-service feeds `markdown` to its existing semantic_extractor
— exactly like the MinerU path. So this sidecar degrades gracefully into a
"reader" if you ever want to A/B the two KIE routes.

Model loading is done in a background thread at startup so the container can
answer /health immediately (returning ready=false until the pipeline is up).

ENV: see paddle_ocr_engine.py and paddle_kie.py. Plus:
  PORT   default 8900
"""

from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import paddle_ocr_engine as engine
import paddle_kie as kie

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("paddle_ocr_service")

PORT = int(os.getenv("PORT", "8900"))

_warmup_started = False
_warmup_error: str = ""


def _warmup_worker():
    global _warmup_error
    try:
        engine.warmup()
        log.info("[PaddleOCR-Service] warmup complete — pipeline ready")
    except Exception as e:  # noqa: BLE001
        _warmup_error = str(e)
        log.error(f"[PaddleOCR-Service] warmup FAILED: {e}", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _warmup_started
    if not _warmup_started:
        _warmup_started = True
        threading.Thread(target=_warmup_worker, daemon=True).start()
        log.info("[PaddleOCR-Service] warmup thread started")
    yield


app = FastAPI(title="Optimus PaddleOCR Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serialise extraction — CPU inference + a single downstream llama-server slot.
_sem = threading.Semaphore(1)


@app.get("/health")
def health():
    ready = engine.is_ready()
    body: Dict[str, Any] = {
        "status": "ok",
        "ready": ready,
        "engine": "paddle_ocr",
        "kie_backend": kie.PADDLE_KIE_BACKEND,
    }
    if _warmup_error:
        body["warmup_error"] = _warmup_error
    # 200 always (like the other sidecars); readiness is in the body. If you
    # prefer 503-while-loading semantics, return status_code=503 when not ready.
    return JSONResponse(body, status_code=200)


@app.post("/extract-pdf")
async def extract_pdf(
    file: UploadFile = File(...),
    engine_name: str = Form("paddle_ocr", alias="engine"),
    language: str = Form("el"),
    extract_invoice: str = Form("1"),
):
    t0 = time.perf_counter()
    raw = await file.read()
    filename = file.filename or "invoice.pdf"
    is_pdf = filename.lower().endswith(".pdf") or raw[:5] == b"%PDF-"

    if not engine.is_ready() and _warmup_error:
        return JSONResponse(
            {"error": f"pipeline failed to load: {_warmup_error}"},
            status_code=500,
        )
    if not engine.is_ready():
        # Still loading — mirror the sidecar convention so the proxy retries.
        return JSONResponse(
            {"error": "model still loading"}, status_code=503
        )

    with _sem:
        try:
            if is_pdf:
                parsed = engine.parse_pdf_bytes(raw)
            else:
                parsed = engine.parse_image_bytes(raw)
        except Exception as e:  # noqa: BLE001
            log.error(f"[PaddleOCR-Service] parse failed: {e}", exc_info=True)
            return JSONResponse({"error": f"parse failed: {e}"}, status_code=500)

        markdown = parsed.get("markdown") or parsed.get("text") or ""
        structured = None
        if extract_invoice not in ("0", "false", "False", ""):
            try:
                structured = kie.extract_invoice_json(
                    markdown, reference_text=markdown
                )
            except Exception as e:  # noqa: BLE001
                log.error(f"[PaddleOCR-Service] KIE failed: {e}", exc_info=True)
                structured = None

    elapsed = round(time.perf_counter() - t0, 2)
    log.info(f"[PaddleOCR-Service] extract-pdf done: engine=paddle_ocr "
             f"pages={parsed.get('pages')} md_chars={len(markdown)} "
             f"structured={'yes' if structured else 'no'} elapsed={elapsed}s")

    return JSONResponse(
        {
            "text": markdown,
            "markdown": markdown,
            "structured": structured,
            "engine": "paddle_ocr",
            "pages": parsed.get("pages"),
            "elapsed": elapsed,
        },
        status_code=200,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level=os.getenv("LOG_LEVEL", "info").lower())
