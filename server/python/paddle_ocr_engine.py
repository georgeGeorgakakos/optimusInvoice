"""
paddle_ocr_engine.py
─────────────────────────────────────────────────────────────────────────────
PaddleOCR PP-StructureV3 document-parsing engine (CPU).

This is the *vision half* of the paddle-ocr sidecar. It rasterises a PDF (or
takes an image), runs PP-StructureV3 — PaddleOCR 3.x's layout-analysis pipeline
(layout detection + PP-OCRv5 text recognition + table-structure recognition) —
and returns clean, layout-aware **Markdown** plus the raw structured JSON blocks.

Why PP-StructureV3 rather than plain PaddleOCR text recognition:
  Your line-item extraction is the hard part of a Greek invoice. PP-StructureV3
  reconstructs *real* table structure (cells, rows, columns) instead of the
  whitespace-soup that tesseract.js / the pdfplumber bbox hack produce. That
  table-aware Markdown is exactly what the KIE LLM needs to get quantities,
  unit prices, discounts and net values into the right columns.

Design decisions (match the rest of the stack):
  • CPU only         — device="cpu". PP-StructureV3's OCR + layout heads are
                       light; expect a few seconds/page on CPU (far faster than
                       the VLM engines).
  • Greek            — the recognition model is pinned to el_PP-OCRv5_mobile_rec
                       (the confirmed Greek PP-OCRv5 model). Set via env so you
                       can switch to a server-grade or latin model if needed.
  • Offline / air-gapped — PaddleOCR does NOT use the HuggingFace cache. It has
                       its own model store. Point PADDLE_PDX_CACHE_HOME at your
                       bind-mounted /models/paddlex and pre-bake the models with
                       Download-PaddleModels.ps1 so first run never hits the net.
  • Speed toggles    — doc-orientation, doc-unwarping and textline-orientation
                       are OFF by default (they add latency and rarely help on
                       clean digital invoices). Turn them on via env for skewed
                       scans.

The pipeline is loaded lazily and cached; loading is guarded by a lock because
the FastAPI service serialises requests but startup may still race a health probe.

ENV (read here):
  PADDLE_DEVICE                 default "cpu"
  PADDLE_LANG                   default "el"          (Greek)
  PADDLE_REC_MODEL_NAME         default "el_PP-OCRv5_mobile_rec"
  PADDLE_REC_MODEL_DIR          optional explicit path to the rec model dir
  PADDLE_LAYOUT_MODEL_DIR       optional explicit path to the layout model dir
  PADDLE_USE_DOC_ORIENTATION    default "0"
  PADDLE_USE_DOC_UNWARPING      default "0"
  PADDLE_USE_TEXTLINE_ORIENT    default "0"
  PADDLE_USE_TABLE              default "1"
  PADDLE_USE_FORMULA            default "0"
  PADDLE_USE_CHART              default "0"
  PADDLE_DPI                    default "150"         (pdf rasterisation DPI)
  PADDLE_MAX_PAGES              default "10"
  PADDLE_PDX_CACHE_HOME         default "/models/paddlex"  (offline model store)
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

log = logging.getLogger("paddle_ocr_engine")

# ── Config ──────────────────────────────────────────────────────────────────
PADDLE_DEVICE              = os.getenv("PADDLE_DEVICE", "cpu")
PADDLE_LANG               = os.getenv("PADDLE_LANG", "el")
PADDLE_REC_MODEL_NAME     = os.getenv("PADDLE_REC_MODEL_NAME", "el_PP-OCRv5_mobile_rec")
PADDLE_REC_MODEL_DIR      = os.getenv("PADDLE_REC_MODEL_DIR", "").strip() or None
PADDLE_LAYOUT_MODEL_DIR   = os.getenv("PADDLE_LAYOUT_MODEL_DIR", "").strip() or None
# ── Speed: pin the MOBILE/lightweight models instead of PP-StructureV3's heavy
#    server-grade defaults (PP-DocLayout_plus-L + PP-OCRv5_server_det), which are
#    slow on CPU. Empty string ("") lets PaddleOCR pick its default for that model.
PADDLE_LAYOUT_MODEL_NAME  = os.getenv("PADDLE_LAYOUT_MODEL_NAME", "PP-DocLayout-S").strip() or None
PADDLE_DET_MODEL_NAME     = os.getenv("PADDLE_DET_MODEL_NAME", "PP-OCRv5_mobile_det").strip() or None
PADDLE_USE_DOC_ORIENT     = os.getenv("PADDLE_USE_DOC_ORIENTATION", "0") == "1"
PADDLE_USE_DOC_UNWARP     = os.getenv("PADDLE_USE_DOC_UNWARPING", "0") == "1"
PADDLE_USE_TEXTLINE_ORIENT= os.getenv("PADDLE_USE_TEXTLINE_ORIENT", "0") == "1"
PADDLE_USE_TABLE          = os.getenv("PADDLE_USE_TABLE", "1") == "1"
PADDLE_USE_FORMULA        = os.getenv("PADDLE_USE_FORMULA", "0") == "1"
PADDLE_USE_CHART          = os.getenv("PADDLE_USE_CHART", "0") == "1"
PADDLE_DPI                = int(os.getenv("PADDLE_DPI", "150"))
PADDLE_MAX_PAGES          = int(os.getenv("PADDLE_MAX_PAGES", "10"))

# PaddleOCR/PaddleX keep their own model cache (NOT the HF cache). Force it onto
# the bind-mounted /models volume so pre-baked models are found offline.
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", os.getenv("PADDLE_PDX_CACHE_HOME", "/models/paddlex"))

_pipeline = None
_load_lock = threading.Lock()


def _build_kwargs() -> Dict[str, Any]:
    """
    Constructor kwargs for PPStructureV3.

    We pass the submodule enable/disable flags (these names are stable across
    PaddleOCR 3.x) plus explicit model names/dirs so the Greek recogniser is
    used and everything resolves from the local cache offline.
    """
    kwargs: Dict[str, Any] = {
        "device": PADDLE_DEVICE,
        "use_doc_orientation_classify": PADDLE_USE_DOC_ORIENT,
        "use_doc_unwarping": PADDLE_USE_DOC_UNWARP,
        "use_textline_orientation": PADDLE_USE_TEXTLINE_ORIENT,
        "use_table_recognition": PADDLE_USE_TABLE,
        "use_formula_recognition": PADDLE_USE_FORMULA,
        "use_chart_recognition": PADDLE_USE_CHART,
        # Pin the Greek PP-OCRv5 recogniser (confirmed: el_PP-OCRv5_mobile_rec).
        "text_recognition_model_name": PADDLE_REC_MODEL_NAME,
    }
    # Mobile layout + detection models (huge CPU speedup vs server defaults).
    if PADDLE_LAYOUT_MODEL_NAME:
        kwargs["layout_detection_model_name"] = PADDLE_LAYOUT_MODEL_NAME
    if PADDLE_DET_MODEL_NAME:
        kwargs["text_detection_model_name"] = PADDLE_DET_MODEL_NAME
    if PADDLE_REC_MODEL_DIR:
        kwargs["text_recognition_model_dir"] = PADDLE_REC_MODEL_DIR
    if PADDLE_LAYOUT_MODEL_DIR:
        kwargs["layout_detection_model_dir"] = PADDLE_LAYOUT_MODEL_DIR
    return kwargs


def _predict_kwargs() -> Dict[str, Any]:
    """
    Per-call overrides for pipeline.predict(). CRITICAL: PP-StructureV3.predict()
    re-applies its OWN defaults for these toggles (which are ON), so setting them
    only on the constructor is not enough — orientation/unwarp sub-models still
    load and run at predict time. Pass them here too to actually disable them.
    """
    return {
        "use_doc_orientation_classify": PADDLE_USE_DOC_ORIENT,
        "use_doc_unwarping": PADDLE_USE_DOC_UNWARP,
        "use_textline_orientation": PADDLE_USE_TEXTLINE_ORIENT,
    }


_PREDICT_OK = True  # flips to False if a build rejects the predict-time overrides


def _predict(pipeline, arr):
    """Run predict() with orientation/unwarp disabled; fall back if unsupported."""
    global _PREDICT_OK
    if _PREDICT_OK:
        try:
            return pipeline.predict(input=arr, **_predict_kwargs())
        except TypeError as e:
            log.warning(f"[PaddleOCR] predict() rejected override kwargs ({e}); "
                        f"falling back to plain predict()")
            _PREDICT_OK = False
    return pipeline.predict(input=arr)


def _load_pipeline():
    """Lazily construct and cache the PP-StructureV3 pipeline (thread-safe)."""
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    with _load_lock:
        if _pipeline is not None:
            return _pipeline
        from paddleocr import PPStructureV3  # imported lazily — heavy

        kwargs = _build_kwargs()
        t0 = time.perf_counter()
        log.info(f"[PaddleOCR] Loading PP-StructureV3 (device={PADDLE_DEVICE}, "
                 f"rec={PADDLE_REC_MODEL_NAME}, table={PADDLE_USE_TABLE}) ...")
        try:
            _pipeline = PPStructureV3(**kwargs)
        except TypeError as e:
            # Older/newer 3.x builds may not accept every kwarg (e.g.
            # use_chart_recognition). Drop unknown kwargs and retry once so a
            # minor version bump doesn't hard-fail the container.
            log.warning(f"[PaddleOCR] Constructor rejected a kwarg ({e}); "
                        f"retrying with a reduced set")
            for k in ("use_chart_recognition", "use_formula_recognition",
                      "text_recognition_model_name", "layout_detection_model_name",
                      "text_detection_model_name"):
                kwargs.pop(k, None)
            _pipeline = PPStructureV3(**kwargs)
        log.info(f"[PaddleOCR] PP-StructureV3 ready in "
                 f"{time.perf_counter() - t0:.1f}s")
    return _pipeline


def warmup() -> None:
    """Force model load (called at service startup so /health can report ready)."""
    _load_pipeline()


def is_ready() -> bool:
    return _pipeline is not None


def _pdf_to_images(pdf_bytes: bytes, dpi: int, max_pages: int):
    """Rasterise a PDF to a list of PIL images (poppler via pdf2image)."""
    from pdf2image import convert_from_bytes
    return convert_from_bytes(pdf_bytes, dpi=dpi)[:max_pages]


def _result_to_markdown(res, tmpdir: str, index: int) -> str:
    """
    Turn one PP-StructureV3 result into a Markdown string.

    We use save_to_markdown() into a temp dir and read the file back — this is
    the most version-robust way to get Markdown across PaddleOCR 3.x point
    releases (the in-memory `res.markdown` shape has changed between versions).
    Falls back to res.markdown / res.json text if the file isn't produced.
    """
    out_dir = Path(tmpdir) / f"page_{index}"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        res.save_to_markdown(save_path=str(out_dir))
        md_files = sorted(out_dir.rglob("*.md"))
        if md_files:
            return "\n\n".join(f.read_text(encoding="utf-8", errors="ignore")
                               for f in md_files).strip()
    except Exception as e:  # noqa: BLE001
        log.warning(f"[PaddleOCR] save_to_markdown failed on page {index}: {e}")

    # Fallback 1: in-memory markdown attribute (str or dict shape).
    md = getattr(res, "markdown", None)
    if isinstance(md, str) and md.strip():
        return md.strip()
    if isinstance(md, dict):
        txt = md.get("markdown_texts") or md.get("text") or ""
        if isinstance(txt, str) and txt.strip():
            return txt.strip()

    # Fallback 2: pull recognised text lines out of the JSON blocks.
    try:
        j = res.json if hasattr(res, "json") else {}
        return _text_from_json_blocks(j).strip()
    except Exception:  # noqa: BLE001
        return ""


def _text_from_json_blocks(j: Any) -> str:
    """Best-effort: harvest any 'text'/'rec_text' strings from the result JSON."""
    out: List[str] = []

    def _walk(node: Any):
        if isinstance(node, dict):
            for key in ("text", "rec_text", "content"):
                v = node.get(key)
                if isinstance(v, str) and v.strip():
                    out.append(v.strip())
            for v in node.values():
                _walk(v)
        elif isinstance(node, list):
            for v in node:
                _walk(v)

    _walk(j)
    return "\n".join(out)


def parse_pdf_bytes(pdf_bytes: bytes,
                    max_pages: Optional[int] = None) -> Dict[str, Any]:
    """
    Run PP-StructureV3 over every page of a PDF and return concatenated Markdown.

    Returns:
        {
          "markdown": "<# page 1 ...\n\n# page 2 ...>",
          "text":     "<same content, plain>",
          "pages":    <int>,
          "engine":   "paddle_ocr",
          "elapsed":  <seconds>,
        }
    """
    max_pages = max_pages or PADDLE_MAX_PAGES
    pipeline = _load_pipeline()
    t0 = time.perf_counter()

    images = _pdf_to_images(pdf_bytes, dpi=PADDLE_DPI, max_pages=max_pages)
    if not images:
        raise RuntimeError("PaddleOCR: PDF produced no pages")

    log.info(f"[PaddleOCR] Parsing {len(images)} page(s) at dpi={PADDLE_DPI}")

    import numpy as np

    md_parts: List[str] = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, pil_img in enumerate(images):
            arr = np.array(pil_img.convert("RGB"))
            # PP-StructureV3.predict returns an iterable of result objects.
            page_md_parts: List[str] = []
            for res in _predict(pipeline, arr):
                page_md_parts.append(_result_to_markdown(res, tmpdir, i))
            page_md = "\n\n".join(p for p in page_md_parts if p).strip()
            if page_md:
                md_parts.append(f"\n\n--- PAGE {i + 1} ---\n\n{page_md}")
            log.info(f"[PaddleOCR] page {i + 1}: {len(page_md)} md chars")

    markdown = "".join(md_parts).strip()
    elapsed = round(time.perf_counter() - t0, 2)
    log.info(f"[PaddleOCR] Done: {len(markdown)} md chars from "
             f"{len(images)} page(s) in {elapsed}s")

    return {
        "markdown": markdown,
        "text": markdown,          # same content; callers accept either key
        "pages": len(images),
        "engine": "paddle_ocr",
        "elapsed": elapsed,
    }


def parse_image_bytes(image_bytes: bytes) -> Dict[str, Any]:
    """Run PP-StructureV3 on a single image (PNG/JPG)."""
    from PIL import Image
    import numpy as np

    pipeline = _load_pipeline()
    t0 = time.perf_counter()
    pil_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    arr = np.array(pil_img)

    md_parts: List[str] = []
    with tempfile.TemporaryDirectory() as tmpdir:
        for res in _predict(pipeline, arr):
            md_parts.append(_result_to_markdown(res, tmpdir, 0))

    markdown = "\n\n".join(p for p in md_parts if p).strip()
    elapsed = round(time.perf_counter() - t0, 2)
    return {
        "markdown": markdown,
        "text": markdown,
        "pages": 1,
        "engine": "paddle_ocr",
        "elapsed": elapsed,
    }


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) < 2:
        print("Usage: paddle_ocr_engine.py <pdf_or_image_path>")
        sys.exit(1)
    p = Path(sys.argv[1])
    data = p.read_bytes()
    if p.suffix.lower() == ".pdf":
        out = parse_pdf_bytes(data)
    else:
        out = parse_image_bytes(data)
    print(f"pages={out['pages']} elapsed={out['elapsed']}s "
          f"chars={len(out['markdown'])}")
    print("--- Markdown preview ---")
    print(out["markdown"][:1500])