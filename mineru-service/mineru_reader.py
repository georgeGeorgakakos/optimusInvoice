"""
mineru_reader.py — MinerU pipeline-backend reader for OptimusInvoice.

ROLE IN THE PIPELINE
--------------------
This is a *reader* (Architecture A), not a vision-to-JSON extractor. It turns a
scanned/complex PDF into clean Markdown (tables as HTML, reading-order text) and
hands that Markdown to the EXISTING semantic_extractor, which maps it to the
invoice schema. MinerU does the *seeing*; semantic_extractor does the
*understanding* (Greek ΚΑΘΑΡΗ ΑΞΙΑ, VAT-on-recipient, discount reconciliation).

    PDF ──> mineru_reader (Markdown) ──> semantic_extractor (invoice JSON)
            ^ this file                  ^ unchanged, already in your stack

WHY THE pipeline BACKEND
------------------------
Per MinerU v3.3.1, only the `pipeline` backend runs in a pure-CPU environment
(OmniDocBench 85.75, hallucination-free, min 16GB RAM — you have 64GB). The
high-accuracy `vlm-engine` needs an 8GB-VRAM GPU and is therefore NOT used here.
We pin backend="pipeline" and device="cpu" so this can never silently try to
grab a GPU that isn't there.

DEPENDENCY NOTE
---------------
MinerU is a torch-based pip package (`mineru[core]`), heavier than the GGUF
sidecars. It is imported lazily inside the function so that importing this module
(or running the rest of vlm_service) never fails just because MinerU isn't
installed. If MinerU is absent, is_available() returns False and the caller
falls back to Surya — exactly like every other optional engine here.
"""

from __future__ import annotations

import io
import os
import logging
import tempfile
from typing import Optional

log = logging.getLogger("mineru_reader")

# ── Config (env-overridable, sensible CPU defaults) ──────────────────────────
MINERU_BACKEND   = os.getenv("MINERU_BACKEND", "pipeline")     # pure-CPU backend
MINERU_DEVICE    = os.getenv("MINERU_DEVICE_MODE", "cpu")      # never grab a GPU
MINERU_LANG      = os.getenv("MINERU_LANG", "el")              # Greek default
MINERU_MAX_PAGES = int(os.getenv("MINERU_MAX_PAGES", "10"))


def is_available() -> bool:
    """True iff the MinerU package can be imported. Cheap, no model load."""
    try:
        import mineru  # noqa: F401
        return True
    except Exception:
        return False


def extract_markdown_from_pdf_bytes(
        pdf_bytes: bytes,
        *,
        lang: str = MINERU_LANG,
        max_pages: int = MINERU_MAX_PAGES,
) -> str:
    """
    Run MinerU's pure-CPU `pipeline` backend on a PDF and return Markdown.

    Returns "" on any failure so the caller can fall back to Surya. Never raises.

    The exact MinerU Python API differs slightly across 3.x point releases, so we
    use the stable CLI-equivalent path: write the PDF to a temp dir, invoke the
    pipeline analysis, and read back the produced .md. This is the most
    version-robust integration surface MinerU exposes.
    """
    if not pdf_bytes:
        return ""

    # Force CPU + pipeline before importing, so MinerU's device auto-detect
    # (CUDA→MPS→NPU→CPU) cannot pick something we don't have.
    os.environ.setdefault("MINERU_DEVICE_MODE", MINERU_DEVICE)

    try:
        # Lazy import: keep module import cheap and failure-tolerant.
        from mineru.cli.common import do_parse  # type: ignore
    except Exception as exc:
        log.warning(f"[MinerU] package not importable ({exc}); reader unavailable")
        return ""

    with tempfile.TemporaryDirectory(prefix="mineru_") as tmp:
        in_path  = os.path.join(tmp, "invoice.pdf")
        out_dir  = os.path.join(tmp, "out")
        os.makedirs(out_dir, exist_ok=True)
        with open(in_path, "wb") as fh:
            fh.write(pdf_bytes)

        try:
            # do_parse signature (v3.x): parse one or more files with a chosen
            # backend. We pin pipeline + Greek + page cap. Output lands as
            # Markdown in out_dir/<name>/<name>.md (auto/ocr subdir per version).
            do_parse(
                output_dir=out_dir,
                pdf_file_names=["invoice"],
                pdf_bytes_list=[pdf_bytes],
                p_lang_list=[lang],
                backend=MINERU_BACKEND,
                parse_method="auto",
                end_page_id=max_pages - 1,
            )
        except TypeError:
            # Older/newer point release with a different signature — try the
            # minimal positional form, still pinned to pipeline.
            try:
                do_parse(out_dir, ["invoice"], [pdf_bytes], [lang], backend=MINERU_BACKEND)
            except Exception as exc:
                log.error(f"[MinerU] do_parse failed: {exc}", exc_info=True)
                return ""
        except Exception as exc:
            log.error(f"[MinerU] parsing failed: {exc}", exc_info=True)
            return ""

        # Collect any .md MinerU produced (path layout varies by version).
        md = _read_first_markdown(out_dir)
        if md:
            log.info(f"[MinerU] pipeline backend produced {len(md)} chars of Markdown")
        else:
            log.warning("[MinerU] no Markdown output found")
        return md


def _read_first_markdown(root: str) -> str:
    """Walk the MinerU output dir and return the first .md file's contents."""
    best = ""
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if fn.lower().endswith(".md"):
                try:
                    with open(os.path.join(dirpath, fn), "r", encoding="utf-8") as fh:
                        txt = fh.read()
                    # Prefer the longest .md (the full-document one, not a fragment).
                    if len(txt) > len(best):
                        best = txt
                except Exception:
                    continue
    return best