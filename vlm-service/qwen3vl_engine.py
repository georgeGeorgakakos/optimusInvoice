"""
qwen3vl_engine.py
─────────────────────────────────────────────────────────────────────────────
Qwen3-VL-8B-Instruct vision engine — talks to a llama.cpp `llama-server` sidecar
over its OpenAI-compatible /v1/chat/completions API.

WHY A SIDECAR (vs the transformers qwen-vl container):
  The existing qwen-vl runs Qwen2.5-VL-3B via transformers + torch in fp32 — slow
  on CPU (~0.37 tok/s). Qwen3-VL-8B in GGUF Q4_K_M runs 4-bit on llama.cpp, the
  same fast runtime class as gemma, on a newer + more capable model. The stock
  llama-cpp-python (0.3.16) in this stack does NOT support Qwen3-VL multimodal, so
  instead of a Python binding we run the official `llama-server` (ghcr.io/ggml-org/
  llama.cpp:server) as its own container and call it over HTTP. This avoids any
  binding-version problem and uses upstream, maintained llama.cpp.

PIPELINE:  PDF bytes → pdf2image → base64 PNG → POST /v1/chat/completions
           → parse JSON → vision_postprocess (SHARED) → structured invoice

⚠️ KNOWN llama.cpp BUG (issue #17200): on some builds, two consecutive multimodal
   requests can corrupt the KV cache and make the 2nd response gibberish. We guard
   against it three ways:
     1. The compose service runs with --parallel 1 (one slot, serialized).
     2. This engine serializes requests with a module lock.
     3. On a detected-bad response (empty / non-JSON / control-char garbage) we
        retry ONCE after asking the server to clear state (/slots + cache reset),
        falling back to a fresh request. Pin a recent server build where the fix
        is present to avoid needing the retry.

ENV (read here):
  QWEN3VL_SERVICE_URL   default http://qwen3vl:8600   (the llama-server sidecar)
  QWEN3VL_TIMEOUT       default 600  (seconds; CPU inference is slow)
  QWEN3VL_MAX_TOKENS    default 768  (output cap)
  QWEN3VL_DPI           default 110  (pdf2image rasterization DPI)
  QWEN3VL_TEMP          default 0.1  (low — deterministic extraction)
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional

import httpx

log = logging.getLogger("qwen3vl_engine")

# ── Config ────────────────────────────────────────────────────────────────────
QWEN3VL_SERVICE_URL = os.getenv("QWEN3VL_SERVICE_URL", "http://qwen3vl:8600").rstrip("/")
QWEN3VL_TIMEOUT     = float(os.getenv("QWEN3VL_TIMEOUT", "600"))
QWEN3VL_MAX_TOKENS  = int(os.getenv("QWEN3VL_MAX_TOKENS", "768"))
QWEN3VL_DPI         = int(os.getenv("QWEN3VL_DPI", "110"))
QWEN3VL_TEMP        = float(os.getenv("QWEN3VL_TEMP", "0.1"))

# Serialize requests — protects against the KV-cache concurrency bug (#17200)
# and keeps a single-slot CPU server from being hit in parallel.
_REQUEST_LOCK = threading.Lock()


# ── Extraction prompt (mirrors the qwen2.5-vl / gemma prompt for a consistent
#    output schema so vision_postprocess + the Node mapping layer work unchanged) ──
_INVOICE_SYSTEM_PROMPT = (
    "You are an expert invoice data extraction engine for Greek and European "
    "invoices. You receive an image of a business invoice (which may be in Greek "
    "or English) and extract all fields into a structured JSON object. "
    "Always return valid JSON only — no markdown, no explanation, no extra text."
)

_INVOICE_USER_PROMPT = """Extract all invoice fields from this image and return a SINGLE JSON object with exactly the keys below.
If a field is missing from the invoice, set it to null (do NOT invent values).

Required JSON structure:
{
  "invoiceNumber":   "string or null",
  "invoiceDate":     "YYYY-MM-DD or null",
  "documentType":    "invoice | credit_note | receipt | dispatch_note",
  "orderNumber":     "string or null",
  "currency":        "EUR | USD | GBP | ...",
  "paymentMethod":   "string or null",

  "issuer": {
    "name":       "company legal name as printed",
    "vatNumber":  "EU VAT EXACTLY as printed (EL/BG/DE/IT...) — null if none. NEVER fabricate.",
    "taxId":      "non-EU tax/company id or null",
    "address":    "street and number",
    "city":       "city",
    "postCode":   "postal code",
    "country":    "country name",
    "registrationNumber": "GEMI/registry number or null",
    "doy":        "tax office name or null"
  },

  "recipient": {
    "name":          "LEGAL ENTITY NAME — the line containing a corporate suffix",
    "contactPerson": "person name if shown SEPARATELY — otherwise null",
    "vatNumber":     "EU VAT EXACTLY as printed or null. NEVER invent.",
    "taxId":         "non-EU tax/company id or null",
    "address":       "street and number",
    "city":          "city",
    "postCode":      "postal code",
    "country":       "country name"
  },

  "lineItems": [
    {
      "description":  "item or service description",
      "supplierCode": "internal product code or null",
      "quantity":     1.0,
      "unit":         "pcs | hours | kg | null",
      "unitPrice":    0.00,
      "totalPrice":   0.00,
      "vatRate":      "number (0, 6, 13, 24, 19...) or null. NEVER guess 24.",
      "discount1":    null
    }
  ],

  "totals": { "subtotal": 0.00, "vat": 0.00, "total": 0.00, "payable": 0.00 },
  "withholdingTax": null,

  "mark": "myDATA MARK or null",
  "uid": "myDATA UID or null",
  "authenticationCode": "myDATA auth code or null",
  "provider": "e-invoicing provider or null",
  "dispatchDate": "YYYY-MM-DD or null",
  "vehicleNumber": "plate or null",
  "purpose": "purpose of dispatch or null"
}

Rules:
- Output ONLY valid JSON. No markdown fences, no commentary.
- NEVER copy literal example values from this prompt. Missing field → null.
- TOTALS: read subtotal / VAT amount / grand total from the summary box (usually
  bottom-right; Greek labels: ΚΑΘΑΡΗ ΑΞΙΑ, Φ.Π.Α., ΣΥΝΟΛΟ / ΠΛΗΡΩΤΕΟ).
- VAT RATE: use the EXACT printed rate per line. If no rate is printed anywhere,
  set vatRate to null — do NOT default to 24.
- VAT NUMBERS: copy EXACTLY as printed; non-EU id → taxId, vatNumber=null. Never
  invent a country prefix.
- CURRENCY: detect from symbols/text ($→USD, €→EUR, £→GBP, лв/BGN→BGN). Do NOT
  default to EUR. If "$"/"USD" appears, currency is USD.
- RECIPIENT NAME: when the bill-to block has a person line then a company line with
  a corporate suffix (EOOD/LTD/GMBH/AE/ΑΕ/PC/IKE/...), set recipient.name to the
  company line and put the person in contactPerson.
- Amounts use a period decimal separator in the JSON (1234.56). Convert Greek
  1.234,56 → 1234.56."""


def _pdf_to_png_b64(pdf_bytes: bytes, dpi: int, max_pages: int = 1) -> List[str]:
    """Rasterize PDF pages to base64-encoded PNG strings (no data: prefix)."""
    from pdf2image import convert_from_bytes
    images = convert_from_bytes(pdf_bytes, dpi=dpi)[:max_pages]
    out: List[str] = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out.append(base64.b64encode(buf.getvalue()).decode("ascii"))
    return out


def _looks_like_garbage(text: str) -> bool:
    """Detect the KV-cache-corruption symptom: empty, all '?', or no JSON brace."""
    if not text or not text.strip():
        return True
    stripped = text.strip()
    if set(stripped) <= {"?", " ", "\n", "\t"}:
        return True
    if "{" not in stripped:
        return True
    return False


def _parse_json_output(text: str) -> Optional[Dict[str, Any]]:
    """Extract JSON from the model's text (handles fences + leading prose)."""
    if not text:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned.strip())
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            return None
    return None


def _post_chat(b64_png: str, max_tokens: int) -> str:
    """Single OpenAI-compatible multimodal chat request to the llama-server sidecar."""
    payload = {
        "messages": [
            {"role": "system", "content": _INVOICE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _INVOICE_USER_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64_png}"},
                    },
                ],
            },
        ],
        "temperature": QWEN3VL_TEMP,
        "max_tokens": max_tokens,
        "stream": False,
    }
    url = f"{QWEN3VL_SERVICE_URL}/v1/chat/completions"
    with httpx.Client(timeout=QWEN3VL_TIMEOUT) as client:
        r = client.post(url, json=payload)
        r.raise_for_status()
        data = r.json()
    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


def _try_reset_server() -> None:
    """Best-effort KV-cache clear between requests (guards bug #17200)."""
    for path in ("/slots/0?action=erase", "/slots/reset"):
        try:
            with httpx.Client(timeout=15) as client:
                client.post(f"{QWEN3VL_SERVICE_URL}{path}")
        except Exception:
            continue


def health() -> bool:
    """Is the llama-server sidecar up?"""
    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(f"{QWEN3VL_SERVICE_URL}/health")
            return r.status_code == 200
    except Exception:
        return False


def extract_invoice_from_pdf_bytes(
        pdf_bytes: bytes,
        reference_text: Optional[str] = None,
        max_pages: int = 1,
) -> Dict[str, Any]:
    """
    Run Qwen3-VL-8B (via the llama-server sidecar) on the first page of a PDF.

    `reference_text` (optional): the PDF's native pdfplumber text, passed to the
    shared post-processor so the full cross-reference validation runs (currency,
    hallucinated VAT numbers, street-as-name). Resolved by the caller/service.

    Returns: { text, structured, engine, elapsed }
    """
    t0 = time.perf_counter()

    pages = _pdf_to_png_b64(pdf_bytes, dpi=QWEN3VL_DPI, max_pages=max_pages)
    if not pages:
        raise RuntimeError("Qwen3-VL: PDF produced no pages")
    b64 = pages[0]
    log.info(f"[Qwen3VL] Page rasterized at dpi={QWEN3VL_DPI} → {len(b64)} b64 chars; "
             f"POST {QWEN3VL_SERVICE_URL}")

    # Serialize: single-slot CPU server + KV-cache bug guard.
    with _REQUEST_LOCK:
        raw_text = _post_chat(b64, QWEN3VL_MAX_TOKENS)
        if _looks_like_garbage(raw_text):
            log.warning("[Qwen3VL] First response looked corrupt (possible KV bug) — "
                        "resetting server state and retrying once")
            _try_reset_server()
            raw_text = _post_chat(b64, QWEN3VL_MAX_TOKENS)

    elapsed = round(time.perf_counter() - t0, 2)
    log.info(f"[Qwen3VL] Response in {elapsed}s — {len(raw_text)} chars")
    if raw_text:
        log.info(f"[Qwen3VL] Output preview: {raw_text[:200]}")

    structured = _parse_json_output(raw_text)

    # Shared vision post-processing (number normalization + VAT guard + full
    # validation when reference_text is supplied). Wrapped so it never breaks.
    try:
        from vision_postprocess import postprocess_vision_invoice
        structured = postprocess_vision_invoice(structured, reference_text=reference_text)
    except Exception as _pp_e:
        log.warning(f"[Qwen3VL] postprocess skipped: {_pp_e}")

    if structured:
        items = len(structured.get("lineItems") or [])
        log.info(f"[Qwen3VL] ✓ parsed — invoice={structured.get('invoiceNumber')} "
                 f"items={items} currency={structured.get('currency')}")
    else:
        log.warning(f"[Qwen3VL] ✗ JSON parse failed; raw[:300]={raw_text[:300]}")

    return {
        "text":       raw_text,
        "structured": structured,
        "engine":     "qwen3vl_local",
        "elapsed":    elapsed,
    }