"""
vlm_service.py
Unified VLM/OCR FastAPI service for Optimus invoice processing.

Engines:
  - surya          : Fast layout-aware OCR  (10-30s)  - default for scanned docs
  - got_ocr2       : Deep document analysis (3-7 min) - fallback / high-accuracy
  - olmocr         : allenai/olmOCR-2-7B via vLLM     - structured extraction
  - marker         : PDF -> Markdown via Marker         - mixed PDF (text + scan)
  - qwen_vl        : Qwen2.5-VL-7B/3B via vLLM        - VQA / line-item chat
  - qwen_vl_local  : Qwen2.5-VL-3B local (CPU, transformers) - direct image→JSON
  - gemma_vl_local : Gemma 3 4B-it    local (CPU, transformers) - direct image→JSON
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from enum import Enum
from typing import Any, Dict, List, Optional

import httpx
import torch
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Invoice field parsers
from vlm_invoice_parser import parse_invoice_fields   # regex-based (fallback)
from semantic_extractor import get_extractor           # LLM-based (primary when Ollama available)
from vision_validator import validate_vision_extraction  # internal-consistency checks for qwen/gemma
# qwen_vl_engine  runs in qwen-vl-service  container (port 8400) — proxied via HTTP
# gemma_vl_engine runs in gemma-vl-service container (port 8500) — proxied via HTTP

# --------------------------- logging ----------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("vlm_service")

# --------------------------- config -----------------------------------------
VLLM_BASE_URL         = os.getenv("VLLM_BASE_URL",   "http://localhost:8200")
OLMOCR_MODEL          = os.getenv("OLMOCR_MODEL",     "allenai/olmOCR-2-7B-1025")
QWEN_VL_MODEL         = os.getenv("QWEN_VL_MODEL",    "Qwen/Qwen2.5-VL-7B-Instruct")   # or -3B
DEVICE                = "cuda" if torch.cuda.is_available() else "cpu"
MAX_PAGES             = int(os.getenv("MAX_PAGES", "10"))
SEMANTIC_ENABLED      = os.getenv("SEMANTIC_ENABLED", "1") == "1"
SEMANTIC_MODEL        = os.getenv("SEMANTIC_MODEL", "qwen2.5:3b")  # set to "0" to disable LLM extraction
SURYA_LANGS           = os.getenv("SURYA_LANGS", "el,en").split(",")   # Greek + English
QWEN_VL_LOCAL_MODEL   = os.getenv("QWEN_VL_LOCAL_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
QWEN_VL_SERVICE_URL   = os.getenv("QWEN_VL_SERVICE_URL",  "http://qwen-vl-service:8400")  # separate container
GEMMA_VL_LOCAL_MODEL  = os.getenv("GEMMA_VL_LOCAL_MODEL", "google/gemma-3-4b-it")
GEMMA_VL_SERVICE_URL  = os.getenv("GEMMA_VL_SERVICE_URL", "http://gemma-vl-service:8500")  # separate container
QWEN3VL_SERVICE_URL   = os.getenv("QWEN3VL_SERVICE_URL",  "http://qwen3vl:8600")            # llama-server sidecar
QWEN35_SERVICE_URL    = os.getenv("QWEN35_SERVICE_URL",   "http://qwen35:8800")             # Qwen3.5-4B llama-server sidecar (newer llama.cpp)
MINERU_SERVICE_URL    = os.getenv("MINERU_SERVICE_URL",   "http://mineru-service:8700")     # MinerU reader sidecar

# ── HTML tag stripper (Surya sometimes emits <b>text</b>) ────────────────────
_HTML_TAG_RE = re.compile(r'<[^>]+>')

# --------------------------- lazy model registry ----------------------------
_models: Dict[str, Any] = {}
# Guards Surya model loading so the background pre-warm task and a concurrent
# first OCR request can't both build the models at once (double load = wasted
# CPU + transient double memory). Double-checked locking around `_models`.
_surya_load_lock = threading.Lock()


def _extract_native_text(pdf_bytes: bytes, max_pages: int = 3) -> str:
    """
    Extract native (digital) text from a PDF via pdfplumber, NUL-stripped.
    Returns "" for scanned PDFs (no embedded text). Used as the reference text
    for vision post-processing (currency/VAT/invoice-number validation).
    """
    try:
        import pdfplumber as _pp, io as _io
        with _pp.open(_io.BytesIO(pdf_bytes)) as _pdf:
            pages = [p.extract_text() or "" for p in _pdf.pages[:max_pages]]
        text = "\n\n".join(t for t in pages if t.strip())
        if text:
            text = text.replace("\x00", "")
            text = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f]", "", text)
        return text
    except Exception as _e:
        log.warning(f"_extract_native_text failed: {_e}")
        return ""


def _load_surya():
    """Load Surya OCR models (lazy, once).
    surya 0.6.x API: load_model/load_processor from detection + recognition modules.
    surya 0.8.x API: FoundationPredictor fallback.
    This container uses transformers==4.46.3 (pinned in vlm-service/Dockerfile)
    so both APIs work correctly.
    """
    if "surya" in _models:
        return _models["surya"]
    # Double-checked locking: only one thread builds the models; others wait and
    # then see the cached result. Protects against the background pre-warm task
    # racing a concurrent first OCR request.
    with _surya_load_lock:
        if "surya" in _models:
            return _models["surya"]
        log.info("Loading Surya OCR models ...")
        try:
            from surya.model.detection.model import load_model as load_det_model, load_processor as load_det_processor
            from surya.model.recognition.model import load_model as load_rec_model
            from surya.model.recognition.processor import load_processor as load_rec_processor
            det_model      = load_det_model()
            det_processor  = load_det_processor()
            rec_model      = load_rec_model()
            rec_processor  = load_rec_processor()
            _models["surya"] = {
                "api":           "0.6",
                "det_model":     det_model,
                "det_processor": det_processor,
                "rec_model":     rec_model,
                "rec_processor": rec_processor,
            }
            log.info("Surya ready (0.6.x API)")
            return _models["surya"]
        except ImportError:
            pass

        try:
            from surya.detection import DetectionPredictor
            from surya.recognition import RecognitionPredictor
            from surya.foundation import FoundationPredictor
            foundation = FoundationPredictor()
            rec = RecognitionPredictor(foundation)
            det = DetectionPredictor()
            _models["surya"] = {
                "api":         "0.8",
                "detection":   det,
                "recognition": rec,
                "foundation":  foundation,
            }
            log.info("Surya ready (0.8.x API)")
            return _models["surya"]
        except Exception as exc:
            raise RuntimeError(f"Surya failed to load: {exc}")


def _load_got_ocr2():
    """Load GOT-OCR2 model (lazy, heavy - ~3 GB).
    NOTE: Requires transformers>=4.52. The default image pins transformers<4.52
    for Surya compatibility. GOT-OCR2 will fail with a clear error and fall back
    to Surya automatically. To use GOT-OCR2, rebuild with a dedicated Dockerfile.
    """
    if "got_ocr2" in _models:
        return _models["got_ocr2"]

    # Fast pre-check: fail immediately with a clear message if transformers is too old
    import transformers as _tf
    from packaging.version import Version
    if Version(_tf.__version__) < Version("4.52.0"):
        raise RuntimeError(
            f"GOT-OCR2 requires transformers>=4.52.0 but found {_tf.__version__}. "
            "The default image pins transformers<4.52 for Surya compatibility. "
            "Set VLM_ENGINE=surya in .env to use Surya instead."
        )

    log.info("Loading GOT-OCR2 ... (this may take a minute)")
    from transformers import AutoTokenizer, AutoModelForCausalLM
    tok = AutoTokenizer.from_pretrained("stepfun-ai/GOT-OCR2_0", trust_remote_code=True)
    mdl = AutoModelForCausalLM.from_pretrained(
        "stepfun-ai/GOT-OCR2_0",
        trust_remote_code=True,
        low_cpu_mem_usage=True,
        device_map="auto",
        use_safetensors=True,
        pad_token_id=tok.eos_token_id,
    )
    _models["got_ocr2"] = {"tokenizer": tok, "model": mdl}
    log.info("GOT-OCR2 ready")
    return _models["got_ocr2"]


# --------------------------- lifespan ----------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("=== VLM Service starting up ===")
    log.info(f"Device: {DEVICE}")

    # 1. Pre-warm Surya OCR — IN THE BACKGROUND (non-blocking).
    #    Previously this ran synchronously here, which BLOCKED the lifespan from
    #    yielding: the server couldn't accept connections (and /health couldn't
    #    answer) until Surya's two PyTorch models finished building on CPU
    #    (~several minutes). On a slow cold start the whole startup exceeded the
    #    healthcheck window (observed ~774s) and compose aborted `app`.
    #    Surya build is pure CPU compute (local files; not a download), so caching
    #    can't help — the only fix is to not block on it. We warm it in a thread
    #    executor instead; /health already returns "ok" as soon as the server is
    #    up (it just advertises which models are loaded), and the queue worker
    #    defers any OCR request that arrives before Surya is ready. First scanned
    #    invoice may wait for the one-time load; digital PDFs (pdfplumber/auto)
    #    never need Surya at all.
    async def _preload_surya():
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _load_surya)
            log.info("Surya pre-warmed successfully (background)")
        except Exception as exc:
            log.error(f"Surya warm-up failed: {exc}", exc_info=True)
            log.warning("Service is up without Surya pre-loaded — first OCR request will trigger a one-time load")
    asyncio.create_task(_preload_surya())

    # 2. Pre-warm Qwen2.5-VL-3B local if configured as default engine
    if os.getenv("VLM_ENGINE", "auto") == "qwen_vl_local":
        async def _preload_qwen_vl_local():
            try:
                # The qwen_vl_engine module isn't imported in this container
                # (transformers version conflict); preload happens automatically
                # in the qwen-vl-service container.
                log.info("[QwenVL-Local] Preload deferred to qwen-vl-service container")
            except Exception as _e:
                log.warning(f"[QwenVL-Local] Pre-warm error (non-fatal): {_e}")
        asyncio.create_task(_preload_qwen_vl_local())

    # 3. Pre-load semantic LLM in the background so it's ready for the first invoice
    if SEMANTIC_ENABLED:
        async def _preload_llm():
            try:
                _ext = get_extractor()
                if _ext.is_available():
                    log.info(f"[Semantic] Loading {SEMANTIC_MODEL} into memory ...")
                    loop = asyncio.get_event_loop()
                    ok = await loop.run_in_executor(None, _ext.load)
                    if ok:
                        log.info(f"[Semantic] {SEMANTIC_MODEL} ready — semantic extraction active")
                    else:
                        log.warning("[Semantic] Model load failed — regex fallback will be used")
                else:
                    log.warning(f"[Semantic] Model {SEMANTIC_MODEL!r} not found — "
                                "run: docker exec <container> python semantic_extractor.py --download")
            except Exception as _e:
                log.warning(f"[Semantic] Pre-load error (non-fatal): {_e}")
        asyncio.create_task(_preload_llm())

    yield
    log.info("VLM service shutting down")


# --------------------------- app --------------------------------------------
app = FastAPI(title="Optimus VLM Service", version="2.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Semaphore: Qwen is single-threaded CPU inference — serialise extraction requests
# so concurrent uploads queue up instead of failing with connection errors.
# (Gemma is also single-threaded; we share the same semaphore.)
_extraction_sem = asyncio.Semaphore(1)


# --------------------------- schemas ----------------------------------------
class Engine(str, Enum):
    surya          = "surya"
    got_ocr2       = "got_ocr2"
    olmocr         = "olmocr"
    marker         = "marker"
    qwen_vl        = "qwen_vl"
    qwen_vl_local  = "qwen_vl_local"    # local CPU — no vLLM required
    gemma_vl_local = "gemma_vl_local"   # local CPU — Gemma 3 4B-it
    qwen3vl_local  = "qwen3vl_local"    # local CPU — Qwen3-VL-8B Q5_K_M GGUF via llama-server sidecar
    qwen35_local   = "qwen35_local"     # local CPU — Qwen3.5-4B Q4_K_M GGUF via llama-server sidecar (newer llama.cpp)
    mineru         = "mineru"           # local CPU — MinerU pipeline backend → Markdown → semantic_extractor
    auto           = "auto"


class OcrRequest(BaseModel):
    image_b64: str = Field(..., description="Base-64 encoded image or first PDF page PNG")
    engine: Engine = Engine.auto
    language: str = "el"
    prompt: Optional[str] = None


class OcrResult(BaseModel):
    engine: str
    text: str
    lines: List[Dict[str, Any]] = []
    latency_ms: float
    confidence: Optional[float] = None
    structured: Optional[Dict[str, Any]] = None


class MarkerRequest(BaseModel):
    pdf_b64: str = Field(..., description="Base-64 encoded PDF")
    extract_images: bool = False
    force_ocr: bool = False


class MarkerResult(BaseModel):
    markdown: str
    metadata: Dict[str, Any]
    latency_ms: float


class VllmChatRequest(BaseModel):
    model: Engine
    image_b64: str
    system_prompt: Optional[str] = None
    user_prompt: str = "Extract all text from this invoice including line items, amounts and totals."
    max_tokens: int = 2048
    temperature: float = 0.0


# --------------------------- helpers ----------------------------------------

def _b64_to_pil(b64: str):
    from PIL import Image
    data = base64.b64decode(b64)
    return Image.open(io.BytesIO(data)).convert("RGB")


def _pil_to_b64(img) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _choose_engine(image_b64: str, language: str) -> Engine:
    """Heuristic: default to surya; fall back to got_ocr2 for complex pages."""
    return Engine.surya


async def _proxy_vision_container(
        container_url: str,
        container_label: str,
        engine_name: str,
        file: UploadFile,
        pdf_bytes: bytes,
        extract_invoice: str,
        use_native_text: str,
) -> Dict[str, Any]:
    """
    Shared helper for proxying to a remote vision container (qwen-vl or gemma-vl).
    Handles the "model still loading" retry loop and shapes the response back
    into the dispatcher format.

    Both qwen-vl-service and gemma-vl-service expose the same HTTP contract:
      - POST /extract-pdf accepting multipart file + form data
      - Returns 503 while model is still loading
      - Returns 200 with { text, structured, ... } on success
    """
    url = f"{container_url}/extract-pdf"
    log.info(f"[{container_label}] Forwarding {len(pdf_bytes)} bytes to {url}")

    async with httpx.AsyncClient(timeout=1800.0) as _client:
        for _attempt in range(30):
            _resp = await _client.post(
                url,
                files={"file": (file.filename or "invoice.pdf", pdf_bytes, "application/pdf")},
                data={
                    "engine":          engine_name,
                    "language":        "el",
                    "extract_invoice": extract_invoice,
                    "use_native_text": use_native_text,
                },
            )
            if _resp.status_code == 503:
                log.info(f"[{container_label}] Model still loading (attempt {_attempt+1}/30) — retrying in 10s ...")
                await asyncio.sleep(10)
                continue
            _resp.raise_for_status()
            return _resp.json()
    raise RuntimeError(f"{container_label} model did not become ready within 5 minutes")


async def _proxy_mineru_reader(pdf_bytes: bytes, filename: str) -> str:
    """
    Proxy to the mineru-service sidecar (port 8700) and return Markdown.

    Unlike the vision containers, MinerU is a READER: it returns Markdown, not an
    invoice schema. The caller feeds that Markdown to the LOCAL semantic_extractor
    (same as the pdfplumber/Surya paths). Returns "" on any failure so the caller
    can fall back to Surya. Handles 503 (model still loading) with a retry loop.
    """
    url = f"{MINERU_SERVICE_URL}/extract-pdf"
    log.info(f"[MinerU-Proxy] Forwarding {len(pdf_bytes)} bytes to {url}")
    try:
        async with httpx.AsyncClient(timeout=1800.0) as _client:
            for _attempt in range(30):
                _resp = await _client.post(
                    url,
                    files={"file": (filename or "invoice.pdf", pdf_bytes, "application/pdf")},
                    data={"engine": "mineru", "language": "el"},
                )
                if _resp.status_code == 503:
                    log.info(f"[MinerU-Proxy] Model still loading (attempt {_attempt+1}/30) — retrying in 10s ...")
                    await asyncio.sleep(10)
                    continue
                _resp.raise_for_status()
                _data = _resp.json()
                return _data.get("markdown") or _data.get("text") or ""
        log.warning("[MinerU-Proxy] sidecar did not become ready within 5 minutes")
        return ""
    except Exception as exc:  # noqa: BLE001
        log.error(f"[MinerU-Proxy] failed: {exc}", exc_info=True)
        return ""


async def _mineru_available() -> bool:
    """Quick /health probe of the mineru-service sidecar (used by auto-routing)."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as _client:
            _resp = await _client.get(f"{MINERU_SERVICE_URL}/health")
            if _resp.status_code == 200:
                return bool(_resp.json().get("ready"))
    except Exception:  # noqa: BLE001
        pass
    return False


# --------------------------- engine implementations -------------------------

def _run_surya(image_b64: str, language: str = "el") -> Dict[str, Any]:
    t0    = time.perf_counter()
    preds = _load_surya()
    img   = _b64_to_pil(image_b64)

    lines          = []
    full_text_parts = []

    if preds.get("api") == "0.6":
        # surya 0.6.x: batch_text_detection + run_recognition
        from surya.detection import batch_text_detection
        from surya.ocr import run_recognition
        det_result = batch_text_detection(
            [img], preds["det_model"], preds["det_processor"]
        )
        bboxes = [[b.bbox for b in det_result[0].bboxes]] if det_result else [[]]
        rec_result = run_recognition(
            [img], [[language]], preds["rec_model"], preds["rec_processor"],
            bboxes=bboxes
        )
        for line in rec_result[0].text_lines:
            text = _HTML_TAG_RE.sub('', line.text).strip()
            if text:
                lines.append({"text": text, "bbox": line.bbox,
                              "confidence": round(float(line.confidence), 4) if line.confidence is not None else 0.0})
                full_text_parts.append(text)
    else:
        # surya 0.8.x: recognition predictor
        rec_preds = preds["recognition"]([img], det_predictor=preds["detection"])
        for page_rec in rec_preds:
            for line in page_rec.text_lines:
                text = _HTML_TAG_RE.sub('', line.text).strip()
                if text:
                    lines.append({"text": text, "bbox": line.bbox,
                                  "confidence": round(float(line.confidence), 4) if line.confidence is not None else 0.0})
                    full_text_parts.append(text)

    return {
        "text":       "\n".join(full_text_parts),
        "lines":      lines,
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
        "confidence": round(
            sum(l["confidence"] for l in lines) / max(len(lines), 1), 4
        ) if lines else None,
    }


def _run_got_ocr2(image_b64: str) -> Dict[str, Any]:
    t0  = time.perf_counter()
    ctx = _load_got_ocr2()
    img = _b64_to_pil(image_b64)

    import tempfile, os
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        img.save(tmp.name)
        tmp_path = tmp.name

    try:
        result = ctx["model"].chat(
            ctx["tokenizer"], tmp_path, ocr_type="format"
        )
    finally:
        os.unlink(tmp_path)

    return {
        "text":       result,
        "lines":      [],
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
        "confidence": None,
    }


async def _run_olmocr(image_b64: str, prompt: Optional[str], max_tokens: int = 2048) -> Dict[str, Any]:
    """Call olmOCR-2-7B via vLLM OpenAI-compatible endpoint."""
    t0 = time.perf_counter()
    system = (
        "You are an OCR engine for Greek business invoices. "
        "Extract all text preserving structure. "
        "Return a JSON object with keys: header, line_items, totals, raw_text."
    )
    user_prompt = prompt or (
        "Extract all invoice fields: supplier, date, invoice number, "
        "line items (description, qty, unit price, total), subtotal, VAT, grand total."
    )
    payload = {
        "model": OLMOCR_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
                    {"type": "text", "text": user_prompt},
                ],
            },
        ],
        "max_tokens":  max_tokens,
        "temperature": 0.0,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{VLLM_BASE_URL}/v1/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()

    raw = data["choices"][0]["message"]["content"]
    structured = None
    try:
        import json as _json
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            structured = _json.loads(m.group())
    except Exception:
        pass

    return {
        "text":       raw,
        "lines":      [],
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
        "confidence": None,
        "structured": structured,
    }


def _load_marker():
    """Load Marker 1.x models (lazy, once)."""
    if "marker" not in _models:
        log.info("Loading Marker models (1.x API) ...")
        try:
            from marker.models import create_model_dict
            _models["marker"] = create_model_dict()
            log.info("Marker ready")
        except Exception as e:
            log.error(f"Marker load failed: {e}", exc_info=True)
            raise
    return _models["marker"]


def _run_marker(pdf_b64: str, force_ocr: bool = False, extract_images: bool = False) -> Dict[str, Any]:
    """Convert PDF to Markdown using Marker 1.x API."""
    import tempfile, os
    t0 = time.perf_counter()

    artifact_dict = _load_marker()
    pdf_bytes = base64.b64decode(pdf_b64)

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        from marker.converters.pdf import PdfConverter
        from marker.output import text_from_rendered
        converter = PdfConverter(artifact_dict=artifact_dict)
        rendered  = converter(tmp_path)
        full_text, _, images = text_from_rendered(rendered)
        out_meta  = getattr(rendered, "metadata", {})
    finally:
        os.unlink(tmp_path)

    return {
        "markdown":   full_text,
        "metadata":   out_meta if isinstance(out_meta, dict) else {},
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
    }


async def _run_qwen_vl(image_b64: str, prompt: str, system_prompt: Optional[str], max_tokens: int) -> Dict[str, Any]:
    """Call Qwen2.5-VL via vLLM OpenAI-compatible endpoint."""
    t0 = time.perf_counter()
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_b64}"}},
            {"type": "text", "text": prompt},
        ],
    })
    payload = {
        "model":       QWEN_VL_MODEL,
        "messages":    messages,
        "max_tokens":  max_tokens,
        "temperature": 0.0,
    }
    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(f"{VLLM_BASE_URL}/v1/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()

    raw = data["choices"][0]["message"]["content"]
    structured = None
    try:
        import json as _json
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            structured = _json.loads(m.group())
    except Exception:
        pass

    return {
        "text":       raw,
        "lines":      [],
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
        "confidence": None,
        "structured": structured,
    }


# --------------------------- routes -----------------------------------------

@app.get("/health")
async def health():
    # Semantic LLM status
    semantic_status = "disabled"
    if SEMANTIC_ENABLED:
        ext = get_extractor()
        if not ext.is_available():
            semantic_status = f"unavailable — model {SEMANTIC_MODEL!r} not found"
        elif ext.is_loaded():
            semantic_status = f"loaded ({SEMANTIC_MODEL})"
        else:
            semantic_status = f"available — loading {SEMANTIC_MODEL} ..."

    # Local-engine availability: surya is loaded in-process; qwen_vl_local and
    # gemma_vl_local live in separate containers — always advertise them as
    # available here so the dispatcher routes get tried (the remote service
    # will return 503 while its own model loads).
    # Local-engine availability: surya is loaded in-process; qwen_vl_local,
    # gemma_vl_local, qwen3vl_local, and mineru all live in separate containers.
    # We always advertise mineru (like the other sidecars) — the mineru-service
    # container returns 503 while loading and the dispatcher falls back to Surya
    # if it's unreachable. The real availability shows in the UI once /health on
    # the sidecar is wired, but advertising here lets the route be attempted.
    return {
        "status":        "ok",
        "device":        DEVICE,
        "loaded_models": list(_models.keys()) + ["qwen_vl_local", "gemma_vl_local", "qwen3vl_local", "qwen35_local", "mineru"],
        "vllm_url":      VLLM_BASE_URL,
        "semantic_llm":  semantic_status,
        "semantic_model": SEMANTIC_MODEL if SEMANTIC_ENABLED else None,
    }


@app.post("/ocr", response_model=OcrResult)
async def ocr(req: OcrRequest):
    engine = req.engine
    if engine == Engine.auto:
        engine = _choose_engine(req.image_b64, req.language)

    try:
        if engine == Engine.surya:
            res = _run_surya(req.image_b64, req.language)
        elif engine == Engine.got_ocr2:
            res = _run_got_ocr2(req.image_b64)
        elif engine == Engine.olmocr:
            res = await _run_olmocr(req.image_b64, req.prompt)
        elif engine == Engine.qwen_vl:
            res = await _run_qwen_vl(
                req.image_b64,
                req.prompt or "Extract all text from this invoice.",
                None,
                2048,
                )
        else:
            raise HTTPException(400, f"Unknown engine: {engine}")
    except Exception as exc:
        log.exception(f"OCR engine {engine} failed")
        raise HTTPException(500, str(exc))

    return OcrResult(engine=engine.value, **res)


@app.post("/convert/pdf", response_model=MarkerResult)
async def convert_pdf(req: MarkerRequest):
    """Convert a full PDF using Marker (best for mixed text+scan PDFs)."""
    try:
        res = _run_marker(req.pdf_b64, req.force_ocr, req.extract_images)
    except Exception as exc:
        log.exception("Marker conversion failed")
        raise HTTPException(500, str(exc))
    return MarkerResult(**res)


@app.post("/convert/pdf/upload", response_model=MarkerResult)
async def convert_pdf_upload(
        file: UploadFile = File(...),
        force_ocr: bool = Form(False),
        extract_images: bool = Form(False),
):
    """Multipart PDF upload -> Marker conversion."""
    pdf_bytes = await file.read()
    b64 = base64.b64encode(pdf_bytes).decode()
    try:
        res = _run_marker(b64, force_ocr, extract_images)
    except Exception as exc:
        log.exception("Marker upload conversion failed")
        raise HTTPException(500, str(exc))
    return MarkerResult(**res)


@app.post("/extract-pdf")
async def extract_pdf(
        file:             UploadFile = File(...),
        engine:           str        = Form("auto"),
        doc_type:         str        = Form("auto"),
        extract_invoice:  str        = Form("0"),
        use_native_text:  str        = Form("0"),  # "1" = try pdfplumber first for digital PDFs
):
    """
    Primary endpoint called by python-integration.ts.
    Accepts a full PDF, returns OCR text across all pages.
    When extract_invoice=True, also runs vlm_invoice_parser and returns
    a structured invoice dict under the 'invoice' key.
    """
    # Queue concurrent requests — Qwen is single-threaded CPU inference
    # Callers wait here instead of getting "fetch failed" connection errors
    async with _extraction_sem:
        return await _do_extract_pdf(file, engine, doc_type, extract_invoice, use_native_text)


async def _do_extract_pdf(file, engine, doc_type, extract_invoice, use_native_text):
    import tempfile, os
    t0        = time.perf_counter()
    pdf_bytes = await file.read()
    b64       = base64.b64encode(pdf_bytes).decode()

    used_engine = engine if engine != "auto" else "surya"
    ocr_text    = ""
    error_msg   = None
    elapsed     = 0.0  # initialized here; updated per-engine branch

    # --- Surya path (default) ---
    if used_engine in ("surya", "auto"):

        # ── pdfplumber pre-flight (always runs first for digital PDFs) ─────────
        # Automatically detects digitally-generated PDFs (Avise, Adobe, Fiverr, etc.)
        # and extracts text directly — instant and perfectly accurate.
        # Falls through to Surya OCR only if pdfplumber finds fewer than 50 chars
        # (scanned/image-only PDFs have no selectable text).
        try:
            import pdfplumber as _pdfplumber, io as _io
            with _pdfplumber.open(_io.BytesIO(pdf_bytes)) as _pdf:
                _pages_text = [p.extract_text() or "" for p in _pdf.pages[:MAX_PAGES]]
            _plumber_text = "\n\n".join(t for t in _pages_text if t.strip())
            # pdfplumber can emit NUL bytes (\x00) inside extracted text for some PDF
            # encodings (e.g. date ranges "Apr 30\x00May 31"). NUL bytes carry no
            # meaning, corrupt the stored JSON, and crash Node's spawn() when the text
            # is passed as a subprocess arg (ERR_INVALID_ARG_VALUE in product matching).
            # Strip NUL + other C0 control chars (keep tab/newline/CR) at the source so
            # clean text flows to the parser, matcher, and saved extraction alike.
            if _plumber_text:
                _plumber_text = _plumber_text.replace("\x00", "")
                _plumber_text = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f]", "", _plumber_text)
            if len(_plumber_text.strip()) > 50:
                log.info(f"extract-pdf: pdfplumber auto-detected digital PDF — {len(_plumber_text)} chars (skipping Surya OCR)")
                ocr_text    = _plumber_text
                used_engine = "pdfplumber"
            else:
                log.info("extract-pdf: pdfplumber found no text — PDF is scanned")
                # Prefer MinerU (better tables, hallucination-free) for scanned
                # docs when the mineru-service sidecar is up; otherwise fall back
                # to Surya. Digital PDFs never reach here (handled by pdfplumber).
                if await _mineru_available():
                    log.info("extract-pdf: routing scanned PDF to MinerU sidecar")
                    used_engine = "mineru"
                else:
                    log.info("extract-pdf: MinerU sidecar not ready — using Surya OCR")
        except Exception as _plumber_exc:
            log.warning(f"pdfplumber pre-flight failed: {_plumber_exc}")

        # ── MinerU reader via sidecar (auto-selected for scanned docs) ────────
        if used_engine == "mineru" and not ocr_text:
            _md = await _proxy_mineru_reader(pdf_bytes, file.filename or "invoice.pdf")
            if _md and len(_md.strip()) > 20:
                ocr_text = _md
                log.info(f"[MinerU] {len(_md)} chars of Markdown from sidecar")
            else:
                log.warning("[MinerU] empty/failed sidecar output — falling back to Surya")
                used_engine = "surya"

        # ── Surya (runs when pdfplumber disabled or found no text) ────────────
        if not ocr_text:
            try:
                from pdf2image import convert_from_bytes
                images = convert_from_bytes(pdf_bytes, dpi=200)
                parts  = []
                for img in images[:MAX_PAGES]:
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    img_b64 = base64.b64encode(buf.getvalue()).decode()
                    res = _run_surya(img_b64, "el")
                    parts.append(res.get("text", ""))
                ocr_text    = "\n\n".join(p for p in parts if p)
                used_engine = "surya"
            except Exception as exc:
                log.error(f"Surya extraction failed: {exc}", exc_info=True)
                error_msg = str(exc)
                # Surface the real error so Node can log it meaningfully
                log.error(f"PDF details: {len(pdf_bytes)} bytes, first 4 bytes: {pdf_bytes[:4]}")

    # --- MinerU pipeline reader (pure-CPU) → Markdown → semantic_extractor ---
    # MinerU is a *reader*: it converts the PDF to Markdown (tables as HTML,
    # reading-order text). The Markdown flows into ocr_text exactly like Surya's
    # output, and the existing semantic_extractor below maps it to the invoice
    # schema. Falls back to Surya if MinerU isn't installed or produces nothing.
    elif used_engine == "mineru":
        # Explicit MinerU selection → call the mineru-service sidecar (port 8700).
        # MinerU is a reader; the returned Markdown is fed to the local
        # semantic_extractor below (same as Surya/pdfplumber paths).
        _md = await _proxy_mineru_reader(pdf_bytes, file.filename or "invoice.pdf")
        if _md and len(_md.strip()) > 20:
            ocr_text    = _md
            used_engine = "mineru"
            log.info(f"[MinerU] {len(_md)} chars of Markdown from sidecar")
        else:
            log.warning("[MinerU] empty/failed sidecar output — falling back to Surya")
            used_engine = "surya"

        # Surya fallback when MinerU was unavailable/empty/failed.
        if used_engine == "surya" and not ocr_text:
            try:
                from pdf2image import convert_from_bytes
                images = convert_from_bytes(pdf_bytes, dpi=200)
                parts  = []
                for img in images[:MAX_PAGES]:
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    img_b64 = base64.b64encode(buf.getvalue()).decode()
                    res = _run_surya(img_b64, "el")
                    parts.append(res.get("text", ""))
                ocr_text = "\n\n".join(p for p in parts if p)
            except Exception as exc:
                log.error(f"Surya fallback failed: {exc}", exc_info=True)
                error_msg = str(exc)

    # --- GOT-OCR2 path ---
    elif used_engine == "got_ocr2":
        try:
            from pdf2image import convert_from_bytes
            images = convert_from_bytes(pdf_bytes, dpi=200)
            parts  = []
            for img in images[:MAX_PAGES]:
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                img_b64 = base64.b64encode(buf.getvalue()).decode()
                res = _run_got_ocr2(img_b64)
                parts.append(res.get("text", ""))
            ocr_text    = "\n\n".join(p for p in parts if p)
            used_engine = "got_ocr2"
        except Exception as exc:
            log.error(f"GOT-OCR2 extraction failed: {exc}", exc_info=True)
            error_msg = str(exc)
            # Graceful fallback to Surya
            log.warning("Falling back to Surya after GOT-OCR2 failure")
            try:
                from pdf2image import convert_from_bytes
                images = convert_from_bytes(pdf_bytes, dpi=200)
                parts  = []
                for img in images[:MAX_PAGES]:
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    img_b64 = base64.b64encode(buf.getvalue()).decode()
                    res = _run_surya(img_b64, "el")
                    parts.append(res.get("text", ""))
                ocr_text    = "\n\n".join(p for p in parts if p)
                used_engine = "surya"
                error_msg   = None
                log.info(f"Surya fallback produced {len(ocr_text)} chars")
            except Exception as fallback_exc:
                log.error(f"Surya fallback also failed: {fallback_exc}")

    # --- Qwen2.5-VL-3B local path (direct image→JSON, no OCR→LLM chain) ---
    elif used_engine == "qwen_vl_local":
        try:
            # ── Proxy to qwen-vl-service container (port 8400) ──────────
            # That container runs transformers>=4.52 for Qwen2.5-VL-3B.
            # This container keeps transformers==4.46.3 for Surya.
            _qvl_result = await _proxy_vision_container(
                QWEN_VL_SERVICE_URL, "QwenVL-Proxy", "qwen_vl_local",
                file, pdf_bytes, extract_invoice, use_native_text,
            )
            ocr_text    = _qvl_result.get("text", "")
            structured  = _qvl_result.get("structured", {})
            # Internal-consistency validation (no OCR text on the vision path —
            # checks reconcile totals/VAT/line-items, flags needs_review).
            if isinstance(structured, dict) and structured:
                structured = validate_vision_extraction(structured)
            elapsed     = round(time.perf_counter() - t0, 2)
            log.info(f"extract-pdf: engine=qwen_vl_local, chars={len(ocr_text)}, elapsed={elapsed}s")
            return {
                "ocr_text":     ocr_text,
                "text":         ocr_text,   # alias for compatibility
                "structured":   structured,
                "engines_used": ["qwen_vl_local"],
                # Path-B vision engines bypass the OCR→semantic chain, so the
                # generic extraction_method ladder below (which only runs for the
                # OCR/reader branches) never tags them — leaving the UI to show
                # "unknown". Tag it here as "vlm" so InvoiceDetail's badge and the
                # debug panel label this run as a vision extraction.
                "extraction_method": "vlm",
                "reasoning":    "engine=qwen_vl_local → Path B (vision model returns structured JSON directly; semantic step skipped)",
                "elapsed":      elapsed,
                "engine":       "qwen_vl_local",
            }
        except Exception as exc:
            log.error(f"[QwenVL-Proxy] Failed: {exc}", exc_info=True)
            error_msg = f"qwen-vl-service unavailable: {exc}"
            ocr_text  = ""

    # --- Qwen3-VL-8B path (NEW — GGUF via llama-server sidecar, port 8600) ---
    # Newer/larger vision model than qwen_vl_local, run as Q5_K_M GGUF on the
    # official llama.cpp server (OpenAI-compatible API). Far faster than the
    # fp32 qwen_vl_local on CPU. The engine module talks to the sidecar over
    # HTTP and reuses vision_postprocess for number/VAT/currency correction.
    elif used_engine == "qwen3vl_local":
        try:
            import qwen3vl_engine
            # native pdfplumber text (if any) → reference for postprocess validation
            _ref_text = None
            try:
                _ref_text = _extract_native_text(pdf_bytes)
            except Exception:
                _ref_text = None
            _q3_result = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: qwen3vl_engine.extract_invoice_from_pdf_bytes(
                    pdf_bytes, reference_text=_ref_text or None
                ),
            )
            ocr_text   = _ref_text or _q3_result.get("text", "")
            structured = _q3_result.get("structured", {})
            if isinstance(structured, dict) and structured:
                structured = validate_vision_extraction(structured)
            elapsed = round(time.perf_counter() - t0, 2)
            log.info(f"extract-pdf: engine=qwen3vl_local, chars={len(ocr_text)}, elapsed={elapsed}s")
            return {
                "ocr_text":     ocr_text,
                "text":         ocr_text,
                "structured":   structured,
                "engines_used": ["qwen3vl_local"],
                # Path-B vision engines bypass the OCR→semantic chain, so the
                # extraction_method ladder further below never tags them, leaving
                # the UI to show "unknown". Tag as "vlm" here so the badge + debug
                # panel correctly label this as a vision extraction.
                "extraction_method": "vlm",
                "reasoning":    "engine=qwen3vl_local → Path B (vision model returns structured JSON directly; semantic step skipped)",
                "elapsed":      elapsed,
                "engine":       "qwen3vl_local",
            }
        except Exception as exc:
            log.error(f"[Qwen3VL] Failed: {exc}", exc_info=True)
            error_msg = f"qwen3vl sidecar unavailable: {exc}"
            ocr_text  = ""

    # --- Qwen3.5-4B path (NEW — GGUF via llama-server sidecar, port 8800) ---
    # Sibling of qwen3vl_local but on the NEWER Qwen3.5 model + a NEWER llama.cpp
    # image (b6907 predates Qwen3.5 and can't load it). ~half the active params of
    # the 8B → ~half the CPU latency, with better Greek/document accuracy. Same
    # Path-B contract: talks to the sidecar over HTTP, reuses vision_postprocess.
    elif used_engine == "qwen35_local":
        try:
            import qwen35_engine
            # native pdfplumber text (if any) → reference for postprocess validation
            _ref_text = None
            try:
                _ref_text = _extract_native_text(pdf_bytes)
            except Exception:
                _ref_text = None
            _q35_result = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: qwen35_engine.extract_invoice_from_pdf_bytes(
                    pdf_bytes, reference_text=_ref_text or None
                ),
            )
            ocr_text   = _ref_text or _q35_result.get("text", "")
            structured = _q35_result.get("structured", {})
            if isinstance(structured, dict) and structured:
                structured = validate_vision_extraction(structured)
            elapsed = round(time.perf_counter() - t0, 2)
            log.info(f"extract-pdf: engine=qwen35_local, chars={len(ocr_text)}, elapsed={elapsed}s")
            return {
                "ocr_text":     ocr_text,
                "text":         ocr_text,
                "structured":   structured,
                "engines_used": ["qwen35_local"],
                # Path-B vision engine: tag as "vlm" so the UI badge + debug panel
                # label this a vision extraction instead of falling back to "unknown".
                "extraction_method": "vlm",
                "reasoning":    "engine=qwen35_local → Path B (vision model returns structured JSON directly; semantic step skipped)",
                "elapsed":      elapsed,
                "engine":       "qwen35_local",
            }
        except Exception as exc:
            log.error(f"[Qwen35] Failed: {exc}", exc_info=True)
            error_msg = f"qwen35 sidecar unavailable: {exc}"
            ocr_text  = ""

    # --- Gemma 3 4B-it local path (NEW — direct image→JSON via Gemma container) ---
    elif used_engine == "gemma_vl_local":
        try:
            # ── Proxy to gemma-vl-service container (port 8500) ─────────
            # Same contract as qwen-vl-service: POST /extract-pdf with multipart,
            # returns 503 while loading, returns JSON {text, structured} on success.
            _gvl_result = await _proxy_vision_container(
                GEMMA_VL_SERVICE_URL, "GemmaVL-Proxy", "gemma_vl_local",
                file, pdf_bytes, extract_invoice, use_native_text,
            )
            ocr_text    = _gvl_result.get("text", "")
            structured  = _gvl_result.get("structured", {})
            # Internal-consistency validation (same pass as the qwen branch).
            if isinstance(structured, dict) and structured:
                structured = validate_vision_extraction(structured)
            elapsed     = round(time.perf_counter() - t0, 2)
            log.info(f"extract-pdf: engine=gemma_vl_local, chars={len(ocr_text)}, elapsed={elapsed}s")
            return {
                "ocr_text":     ocr_text,
                "text":         ocr_text,   # alias for compatibility
                "structured":   structured,
                "engines_used": ["gemma_vl_local"],
                # Path-B vision engines bypass the OCR→semantic chain, so the
                # extraction_method ladder further below never tags them, leaving
                # the UI to show "unknown". Tag as "vlm" here so the badge + debug
                # panel correctly label this as a vision extraction.
                "extraction_method": "vlm",
                "reasoning":    "engine=gemma_vl_local → Path B (vision model returns structured JSON directly; semantic step skipped)",
                "elapsed":      elapsed,
                "engine":       "gemma_vl_local",
            }
        except Exception as exc:
            log.error(f"[GemmaVL-Proxy] Failed: {exc}", exc_info=True)
            error_msg = f"gemma-vl-service unavailable: {exc}"
            ocr_text  = ""

    log.info(f"extract-pdf: engine={used_engine}, chars={len(ocr_text)}, elapsed={elapsed}s")

    result: Dict[str, Any] = {
        "ocr_text":        ocr_text,
        "engines_used":    [used_engine],
        "extraction_method": (
            "native_text"  if used_engine == "pdfplumber" else
            "ocr_image"    if used_engine in ("surya", "got_ocr2") else
            "markdown"     if used_engine == "mineru" else
            "vlm"          if used_engine in ("qwen_vl", "olmocr", "qwen_vl_local", "gemma_vl_local") else
            "converted"    if used_engine == "marker" else
            "unknown"
        ),
        "elapsed_seconds": elapsed,
        "total_pages":     None,
        "error":           error_msg,
    }

    # --- Structured invoice extraction ---
    if extract_invoice.lower() in ("1", "true", "yes") and ocr_text and len(ocr_text.strip()) > 20:
        try:
            # ── Semantic LLM extraction (Ollama) if available, regex fallback ──
            if SEMANTIC_ENABLED:
                extractor = get_extractor()
                # If model is still loading (first boot, download in progress),
                # wait up to 30s for it to become ready before falling back to regex
                if not extractor.is_loaded() and extractor.is_available():
                    # The semantic GGUF (~2GB, n_ctx=4096) takes 2-4 min to load on
                    # CPU. The OLD 30s wait was too short: the first invoice after a
                    # deploy beat the background load and fell back to the regex
                    # parser, which produces actively WRONG output (e.g. reading a
                    # P.O. Box number as a €104,477 line item). Wait up to 180s so the
                    # LLM — which understands invoice structure — does the extraction.
                    _wait_secs = int(os.getenv("SEMANTIC_LOAD_WAIT", "180"))
                    log.info(f"[Semantic] Model not yet loaded — waiting up to {_wait_secs}s ...")
                    for _ in range(_wait_secs):
                        await asyncio.sleep(1)
                        if extractor.is_loaded():
                            log.info("[Semantic] Model ready — proceeding with LLM extraction")
                            break
                    else:
                        log.warning(f"[Semantic] Model still not ready after {_wait_secs}s — using regex fallback")
                loop = asyncio.get_event_loop()
                result["invoice"] = await loop.run_in_executor(
                    None, extractor.extract, ocr_text
                )
                method = result["invoice"].get("_extraction_method", "unknown")
                log.info(f"extract-pdf: semantic extraction method={method}")
            else:
                result["invoice"] = parse_invoice_fields(ocr_text)

            items_found  = len(result["invoice"].get("lineItems", []))
            confidence   = result["invoice"].get("confidence", 0) or 0
            log.info(
                f"extract-pdf: invoice parsed - "
                f"number={result['invoice'].get('invoiceNumber')} "
                f"items={items_found} "
                f"confidence={confidence}%"
            )

            # ── VLM escalation: if no items extracted or confidence < 60%,
            #    retry via Qwen-VL with a targeted line-items prompt ──
            # GATED behind VLM_ESCALATION (default OFF). On a CPU-only box the
            # qwen-vl vision pass can take 30+ MINUTES for a single invoice, which
            # is almost never worth it versus simply sending the invoice to manual
            # review. Enable with VLM_ESCALATION=1 only if you have GPU/throughput
            # headroom and genuinely need vision to recover line items.
            escalation_enabled = os.getenv("VLM_ESCALATION", "0") == "1"
            need_escalation = escalation_enabled and (
                    (items_found == 0) or (confidence < 60 and items_found < 3)
            )
            if need_escalation and "qwen_vl" in _models:
                log.info("extract-pdf: low confidence/items → escalating to Qwen-VL for line items")
                try:
                    # Use the first page image for VLM (already rasterised above)
                    from pdf2image import convert_from_bytes
                    vlm_images = convert_from_bytes(pdf_bytes, dpi=200, first_page=1, last_page=1)
                    if vlm_images:
                        buf = io.BytesIO()
                        vlm_images[0].save(buf, format="PNG")
                        vlm_b64 = base64.b64encode(buf.getvalue()).decode()

                        vlm_prompt = (
                            "Extract ONLY the line items table from this invoice as JSON. "
                            "Return a JSON array where each element has these keys: "
                            "description (string), supplierCode (string or empty), "
                            "quantity (number), unit (string), unitPrice (number), "
                            "totalPrice (number), vatRate (number). "
                            "Do NOT include header rows, subtotals, or totals. "
                            "Return ONLY the JSON array, no other text."
                        )
                        vlm_result = await _run_qwen_vl(vlm_b64, vlm_prompt, None, 1500)

                        if vlm_result.get("text"):
                            import json as _json
                            raw_json = vlm_result["text"].strip()
                            # Strip markdown fences if present
                            raw_json = re.sub(r'^```(?:json)?\s*', '', raw_json, flags=re.IGNORECASE)
                            raw_json = re.sub(r'\s*```$', '', raw_json)
                            try:
                                vlm_items = _json.loads(raw_json)
                                if isinstance(vlm_items, list) and len(vlm_items) > items_found:
                                    log.info(
                                        f"extract-pdf: VLM escalation succeeded — "
                                        f"{len(vlm_items)} items (was {items_found})"
                                    )
                                    result["invoice"]["lineItems"]     = vlm_items
                                    result["invoice"]["vlm_escalated"] = True
                                else:
                                    log.info(
                                        f"extract-pdf: VLM escalation returned {len(vlm_items) if isinstance(vlm_items, list) else 0} items, "
                                        f"keeping original {items_found}"
                                    )
                            except _json.JSONDecodeError as je:
                                log.warning(f"VLM escalation JSON parse failed: {je}")
                except Exception as vlm_exc:
                    log.warning(f"VLM escalation failed (non-fatal): {vlm_exc}")
            elif need_escalation:
                log.info("extract-pdf: low confidence but Qwen-VL not loaded — skipping VLM escalation")

        except Exception as exc:
            log.warning(f"Invoice field parsing failed (non-fatal): {exc}")
            result["invoice"] = None

    return result


@app.post("/chat/vision", response_model=OcrResult)
async def vision_chat(req: VllmChatRequest):
    """Direct vLLM chat with vision - olmocr or qwen_vl."""
    try:
        if req.model == Engine.olmocr:
            res = await _run_olmocr(req.image_b64, req.user_prompt, req.max_tokens)
        elif req.model == Engine.qwen_vl:
            res = await _run_qwen_vl(
                req.image_b64, req.user_prompt,
                req.system_prompt, req.max_tokens,
            )
        else:
            raise HTTPException(400, f"/chat/vision only supports olmocr and qwen_vl, got: {req.model}")
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Vision chat failed")
        raise HTTPException(500, str(exc))

    return OcrResult(engine=req.model.value, **res)


@app.post("/ocr/pipeline")
async def ocr_pipeline(req: OcrRequest):
    """Full pipeline: Surya -> escalate to olmOCR if confidence < 0.70."""
    surya_res  = _run_surya(req.image_b64, req.language)
    confidence = surya_res.get("confidence") or 0.0

    if confidence >= 0.70:
        return OcrResult(engine="surya", **surya_res)

    log.info(f"Surya confidence {confidence:.2f} < 0.70 - escalating to olmOCR")
    olmocr_res = await _run_olmocr(req.image_b64, req.prompt)
    return OcrResult(engine="surya+olmocr", **olmocr_res)


@app.get("/models")
async def list_models():
    """List available vLLM models from the running vLLM server."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{VLLM_BASE_URL}/v1/models")
            return resp.json()
    except Exception as exc:
        return {"error": str(exc), "vllm_url": VLLM_BASE_URL}


@app.post("/preload/{engine}")
async def preload_engine(engine: Engine, background_tasks: BackgroundTasks):
    """Trigger background preloading of a heavy model."""
    def _load():
        try:
            if engine == Engine.surya:
                _load_surya()
            elif engine == Engine.got_ocr2:
                _load_got_ocr2()
            elif engine == Engine.marker:
                _load_marker()
            elif engine == Engine.qwen_vl_local:
                # Preload is handled by qwen-vl-service container on its startup
                log.info("qwen_vl_local preload: handled by qwen-vl-service container")
            elif engine == Engine.gemma_vl_local:
                # Preload is handled by gemma-vl-service container on its startup
                log.info("gemma_vl_local preload: handled by gemma-vl-service container")
            else:
                log.info(f"Engine {engine} is remote (vLLM) - nothing to preload locally")
        except Exception as exc:
            log.warning(f"Preload failed for {engine}: {exc}")

    background_tasks.add_task(_load)
    return {"status": "preloading", "engine": engine.value}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8100"))
    uvicorn.run(app, host="0.0.0.0", port=port)