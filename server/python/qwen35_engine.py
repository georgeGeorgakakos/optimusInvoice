"""
qwen35_engine.py
─────────────────────────────────────────────────────────────────────────────
Qwen3.5-4B-Instruct vision engine — talks to a llama.cpp `llama-server` sidecar
over its OpenAI-compatible /v1/chat/completions API.

This is a SIBLING of qwen3vl_engine.py (same sidecar pattern, same output
schema, same SHARED vision_postprocess wiring) for the NEWER Qwen3.5 family.
It runs in its OWN container on a NEWER llama.cpp image because the qwen3vl
image (server-b6907) predates Qwen3.5 and cannot load its GGUF+mmproj.
Reasoning is left DISABLED (Qwen3.5 small-series default) for deterministic JSON.

WHY A SIDECAR (vs the transformers qwen-vl container):
  Qwen3.5-4B in GGUF Q4_K_M runs 4-bit on llama.cpp — the same fast runtime class
  as gemma/qwen3vl — instead of fp32 transformers (~0.37 tok/s on CPU). The stock
  llama-cpp-python binding in this stack does NOT support Qwen3.5 multimodal, so we
  run the official `llama-server` (ghcr.io/ggml-org/llama.cpp:server, a NEWER tag
  than qwen3vl's b6907) as its own container and call it over HTTP. Upstream,
  maintained llama.cpp, no binding-version problem.

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
  QWEN35_SERVICE_URL   default http://qwen35:8800   (the llama-server sidecar)
  QWEN35_TIMEOUT       default 600  (seconds; CPU inference is slow)
  QWEN35_MAX_TOKENS    default 1536 (output cap)
  QWEN35_DPI           default 110  (pdf2image rasterization DPI)
  QWEN35_TEMP          default 0.1  (low — deterministic extraction)
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

log = logging.getLogger("qwen35_engine")

# ── Config ────────────────────────────────────────────────────────────────────
QWEN35_SERVICE_URL = os.getenv("QWEN35_SERVICE_URL", "http://qwen35:8800").rstrip("/")
QWEN35_TIMEOUT     = float(os.getenv("QWEN35_TIMEOUT", "600"))
QWEN35_MAX_TOKENS  = int(os.getenv("QWEN35_MAX_TOKENS", "1536"))  # was 768 — multi-line-item invoices truncate below ~1500
QWEN35_DPI         = int(os.getenv("QWEN35_DPI", "110"))
QWEN35_TEMP        = float(os.getenv("QWEN35_TEMP", "0.1"))
# Readiness wait: the GGUF takes minutes to load on CPU. While loading, the
# sidecar answers /health and /v1/chat with 503. Instead of failing instantly,
# wait up to QWEN35_READY_WAIT seconds (polling every QWEN35_READY_POLL) for
# the model to finish loading before the first request and on a 503.
QWEN35_READY_WAIT  = float(os.getenv("QWEN35_READY_WAIT", "600"))   # 10 min
QWEN35_READY_POLL  = float(os.getenv("QWEN35_READY_POLL", "5"))     # 5 s

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

  "mark": "the actual MARK digit string read from the document (a long number under the 'MARK' or 'ΜΑΡΚ' label, e.g. 400013377908872), or null if absent. Do NOT output the words 'myDATA MARK' — output the digits.",
  "uid": "the actual myDATA UID value read from the document, or null. Do NOT output the word 'UID' — output the value.",
  "authenticationCode": "the actual myDATA authentication code read from the document, or null. Do NOT output a label — output the value.",
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
  1.234,56 → 1234.56.
- LINE-ITEM AMOUNTS (read the table columns carefully — this is the #1 error):
  * `totalPrice` MUST be the line's NET value AS PRINTED in the net-amount column
    (Greek header: ΚΑΘΑΡΗ ΑΞΙΑ; English: NET / AMOUNT / LINE TOTAL). COPY that
    printed number directly. Do NOT compute quantity × unitPrice yourself.
  * Many Greek invoices have a DISCOUNT column (ΕΚΠΤ% / ΕΚΠΤΩΣΗ / DISCOUNT). When a
    discount applies, quantity × unitPrice will NOT equal the net value — the
    printed ΚΑΘΑΡΗ ΑΞΙΑ already has the discount applied. Always trust the printed
    net-value column over any multiplication; put the discount % in `discount1`.
  * `unitPrice` is the per-unit price column (ΤΙΜΗ / ΤΙΜΗ ΜΟΝΑΔΟΣ / UNIT PRICE) —
    copy it as printed. It is NOT necessarily totalPrice ÷ quantity when a discount
    exists.
- SELF-CHECK BEFORE OUTPUT: the sum of all line `totalPrice` values should be close
  to `totals.subtotal` (the printed ΚΑΘΑΡΗ ΑΞΙΑ total). If your line totals sum to
  far more than the printed subtotal, you read the wrong column (likely unit price
  or a pre-discount value) — re-read the ΚΑΘΑΡΗ ΑΞΙΑ column for each line and fix
  them so they reconcile with the printed subtotal before returning."""


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


def _repair_truncated_json(s: str) -> Optional[Dict[str, Any]]:
    """
    Best-effort recovery of JSON that was cut off mid-output (e.g. the model hit
    max_tokens). Strategy: trim back to the last complete key/value, drop any
    dangling partial line-item, then close open brackets/braces. Returns a dict
    or None. This salvages a usable invoice instead of discarding everything.
    """
    if not s:
        return None
    s = s.strip()
    # Take from the first brace.
    start = s.find("{")
    if start == -1:
        return None
    s = s[start:]
    # Walk and track structure; remember the last position where the document
    # was syntactically "safe" to close (just after a complete value).
    depth = 0
    in_str = False
    esc = False
    last_safe = None
    for i, ch in enumerate(s):
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        # A safe cut point is right after a closed value/element at depth>=1.
        if ch in "}]\"," and not in_str:
            last_safe = i
    if last_safe is None:
        return None
    candidate = s[: last_safe + 1]
    # Strip a trailing comma if we cut right after one.
    candidate = re.sub(r",\s*$", "", candidate.strip())
    # Close any still-open arrays/objects by counting unmatched openers.
    opens = []
    in_str = False
    esc = False
    for ch in candidate:
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch in "{[":
            opens.append(ch)
        elif ch in "}]":
            if opens:
                opens.pop()
    closers = "".join("}" if c == "{" else "]" for c in reversed(opens))
    for attempt in (candidate + closers, candidate + closers + "}"):
        try:
            return json.loads(attempt)
        except json.JSONDecodeError:
            continue
    return None


def _parse_json_output(text: str) -> Optional[Dict[str, Any]]:
    """Extract JSON from the model's text (handles fences + leading prose +
    truncation when the model hit the token cap)."""
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
            pass
    # Last resort: the output was cut off mid-JSON — repair and salvage.
    repaired = _repair_truncated_json(cleaned)
    if repaired:
        log.warning("[Qwen35] recovered truncated JSON via repair")
    return repaired


def _post_chat(b64_png: str, max_tokens: int) -> str:
    """Single OpenAI-compatible multimodal chat request to the llama-server sidecar.

    The sidecar returns 503 while the GGUF model is still loading (minutes on
    CPU). Rather than failing the invoice, wait for readiness and retry once the
    model is up. A 503 is treated as "not ready yet", not a hard error.
    """
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
        "temperature": QWEN35_TEMP,
        "max_tokens": max_tokens,
        "stream": False,
    }
    url = f"{QWEN35_SERVICE_URL}/v1/chat/completions"

    # Make sure the model has finished loading before we send the image.
    wait_until_ready(QWEN35_READY_WAIT)

    deadline = time.monotonic() + QWEN35_READY_WAIT
    attempt = 0
    while True:
        attempt += 1
        with httpx.Client(timeout=QWEN35_TIMEOUT) as client:
            r = client.post(url, json=payload)
        # 503 = model still loading / no slot yet → wait and retry, don't fail.
        if r.status_code == 503 and time.monotonic() < deadline:
            log.info(f"[Qwen35] sidecar 503 (loading), waiting {QWEN35_READY_POLL}s "
                     f"(attempt {attempt})")
            time.sleep(QWEN35_READY_POLL)
            continue
        r.raise_for_status()
        data = r.json()
        return (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


def _try_reset_server() -> None:
    """Best-effort KV-cache clear between requests (guards bug #17200)."""
    for path in ("/slots/0?action=erase", "/slots/reset"):
        try:
            with httpx.Client(timeout=15) as client:
                client.post(f"{QWEN35_SERVICE_URL}{path}")
        except Exception:
            continue


def health() -> bool:
    """Is the llama-server sidecar up?"""
    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(f"{QWEN35_SERVICE_URL}/health")
            return r.status_code == 200
    except Exception:
        return False


def wait_until_ready(max_wait: float) -> bool:
    """
    Poll /health until the sidecar reports ready (200) or max_wait elapses.
    While the GGUF loads on CPU (minutes), /health returns 503. Returns True if
    ready, False on timeout. Never raises — callers can still attempt the request.
    """
    deadline = time.monotonic() + max_wait
    waited = False
    while time.monotonic() < deadline:
        if health():
            if waited:
                log.info("[Qwen35] sidecar ready")
            return True
        waited = True
        log.info(f"[Qwen35] waiting for sidecar to load model "
                 f"(poll {QWEN35_READY_POLL}s)...")
        time.sleep(QWEN35_READY_POLL)
    log.warning(f"[Qwen35] sidecar not ready after {max_wait}s — attempting anyway")
    return False


def extract_invoice_from_pdf_bytes(
        pdf_bytes: bytes,
        reference_text: Optional[str] = None,
        max_pages: int = 1,
) -> Dict[str, Any]:
    """
    Run Qwen3.5-4B (via the llama-server sidecar) on the first page of a PDF.

    `reference_text` (optional): the PDF's native pdfplumber text, passed to the
    shared post-processor so the full cross-reference validation runs (currency,
    hallucinated VAT numbers, street-as-name). Resolved by the caller/service.

    Returns: { text, structured, engine, elapsed }
    """
    t0 = time.perf_counter()

    pages = _pdf_to_png_b64(pdf_bytes, dpi=QWEN35_DPI, max_pages=max_pages)
    if not pages:
        raise RuntimeError("Qwen3.5: PDF produced no pages")
    b64 = pages[0]
    log.info(f"[Qwen35] Page rasterized at dpi={QWEN35_DPI} → {len(b64)} b64 chars; "
             f"POST {QWEN35_SERVICE_URL}")

    # Serialize: single-slot CPU server + KV-cache bug guard.
    with _REQUEST_LOCK:
        raw_text = _post_chat(b64, QWEN35_MAX_TOKENS)
        if _looks_like_garbage(raw_text):
            log.warning("[Qwen35] First response looked corrupt (possible KV bug) — "
                        "resetting server state and retrying once")
            _try_reset_server()
            raw_text = _post_chat(b64, QWEN35_MAX_TOKENS)

    elapsed = round(time.perf_counter() - t0, 2)
    log.info(f"[Qwen35] Response in {elapsed}s — {len(raw_text)} chars")
    if raw_text:
        log.info(f"[Qwen35] Output preview: {raw_text[:200]}")

    structured = _parse_json_output(raw_text)

    # Shared vision post-processing (number normalization + VAT guard + full
    # validation when reference_text is supplied). Wrapped so it never breaks.
    try:
        from vision_postprocess import postprocess_vision_invoice
        structured = postprocess_vision_invoice(structured, reference_text=reference_text)
    except Exception as _pp_e:
        log.warning(f"[Qwen35] postprocess skipped: {_pp_e}")

    if structured:
        items = len(structured.get("lineItems") or [])
        log.info(f"[Qwen35] ✓ parsed — invoice={structured.get('invoiceNumber')} "
                 f"items={items} currency={structured.get('currency')}")
    else:
        log.warning(f"[Qwen35] ✗ JSON parse failed; raw[:300]={raw_text[:300]}")

    return {
        "text":       raw_text,
        "structured": structured,
        "engine":     "qwen35_local",
        "elapsed":    elapsed,
    }