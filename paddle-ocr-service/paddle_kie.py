"""
paddle_kie.py
─────────────────────────────────────────────────────────────────────────────
Key-Information-Extraction (KIE) step for the paddle-ocr sidecar.

This is the *language half* of the "document → invoice JSON" pipeline. It takes
the layout-aware Markdown produced by PP-StructureV3 (paddle_ocr_engine.py) and
turns it into your canonical invoice JSON by prompting a **local, already-running
llama-server** — the same OpenAI-compatible `qwen35` sidecar the rest of the
stack uses. No new LLM, no API key, fully offline on CPU.

Why reuse qwen35 instead of PP-ChatOCRv4's built-in chat():
  PP-ChatOCRv4's native KIE defaults to Baidu ERNIE (online, API key) and its
  generic prompt does not know your Greek/myDATA schema (discountN, doy, mark,
  uid, two-column issuer/recipient split, "trust the printed net column" rule,
  etc.). Your qwen35 prompt is already tuned for exactly that. So we keep the
  proven prompt and just feed it PaddleOCR's superior table Markdown.

  The pure PP-ChatOCRv4 path is documented in PADDLEOCR_INTEGRATION.md if you
  prefer PaddleOCR to own the whole pipeline — set PADDLE_KIE_BACKEND=ppchatocr.

Backends (PADDLE_KIE_BACKEND):
  • "llama_server" (default) — POST the Markdown to QWEN35_SERVICE_URL as a
                               text-only chat; parse JSON out.
  • "none"                   — skip KIE, return structured=None. The vlm-service
                               dispatcher then feeds the Markdown to its existing
                               semantic_extractor (same as the MinerU path).

ENV (read here):
  PADDLE_KIE_BACKEND     default "llama_server"
  KIE_LLM_URL            default = QWEN35_SERVICE_URL or http://qwen35:8800
  KIE_LLM_TIMEOUT        default 600   (CPU inference is slow)
  KIE_LLM_MAX_TOKENS     default 1536
  KIE_LLM_TEMP           default 0.1
  KIE_LLM_READY_WAIT     default 600   (wait for the GGUF to load, in seconds)
  KIE_LLM_READY_POLL     default 5
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, Optional

import httpx

log = logging.getLogger("paddle_kie")

PADDLE_KIE_BACKEND = os.getenv("PADDLE_KIE_BACKEND", "llama_server").strip().lower()
KIE_LLM_URL   = (os.getenv("KIE_LLM_URL")
                 or os.getenv("QWEN35_SERVICE_URL")
                 or "http://qwen35:8800").rstrip("/")
KIE_LLM_TIMEOUT    = float(os.getenv("KIE_LLM_TIMEOUT", "600"))
KIE_LLM_MAX_TOKENS = int(os.getenv("KIE_LLM_MAX_TOKENS", "1536"))
KIE_LLM_TEMP       = float(os.getenv("KIE_LLM_TEMP", "0.1"))
KIE_LLM_READY_WAIT = float(os.getenv("KIE_LLM_READY_WAIT", "600"))
KIE_LLM_READY_POLL = float(os.getenv("KIE_LLM_READY_POLL", "5"))
KIE_MAX_INPUT_CHARS = int(os.getenv("KIE_MAX_INPUT_CHARS", "12000"))

# ── Prompt ────────────────────────────────────────────────────────────────────
# Mirrors your qwen35 / semantic_extractor schema so the output drops straight
# into your existing Node mapping + vision_postprocess. Text-in (Markdown from
# PP-StructureV3), JSON-out.
_SYSTEM_PROMPT = (
    "You are an expert invoice data extraction engine for Greek and European "
    "invoices. You receive the Markdown text of a business invoice (which may be "
    "in Greek or English), including reconstructed tables, and extract all fields "
    "into a structured JSON object. Always return valid JSON only — no markdown, "
    "no explanation, no extra text."
)

_USER_PROMPT_TEMPLATE = """Extract all invoice fields from the invoice Markdown below and return a SINGLE JSON object with exactly the keys shown.
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

  "mark": "the actual MARK digit string read from the document (a long number under 'MARK'/'ΜΑΡΚ'), or null. Output digits, not the label.",
  "uid": "the actual myDATA UID value, or null. Output the value, not the label.",
  "authenticationCode": "the actual myDATA authentication code, or null. Output the value, not a label.",
  "provider": "e-invoicing provider or null"
}

Rules:
- Output ONLY valid JSON. No markdown fences, no commentary.
- NEVER copy literal example values from this prompt. Missing field -> null.
- issuer = company ISSUING the invoice (seller/supplier, top of the document).
  recipient = company RECEIVING it (buyer/client — "To:"/"Bill To:"/"Πελάτης").
- Greek field mapping: ΑΦΜ = vatNumber, ΔΟΥ = doy, ΜΑΡΚ = mark.
- TOTALS: read subtotal / VAT amount / grand total from the summary box (Greek
  labels: ΚΑΘΑΡΗ ΑΞΙΑ, Φ.Π.Α., ΣΥΝΟΛΟ / ΠΛΗΡΩΤΕΟ).
- CURRENCY: detect from symbols/text ($->USD, €->EUR, £->GBP, лв/BGN->BGN). Never
  default to EUR. If "$"/"USD" appears, currency is USD.
- Amounts use a period decimal separator in the JSON (1234.56). Convert Greek
  1.234,56 -> 1234.56.
- Include ALL product/service rows in lineItems — never omit items. Do NOT put
  header rows (Α/Α, Κωδ., Περιγραφή, Ποσότητα, Τιμή, Αξία, ΦΠΑ) or subtotal/total
  rows into lineItems.
- LINE-ITEM AMOUNTS (the #1 error): `totalPrice` MUST be the line's NET value AS
  PRINTED in the net-amount column (ΚΑΘΑΡΗ ΑΞΙΑ / NET / AMOUNT). Copy it directly;
  do NOT compute quantity × unitPrice. If a discount column (ΕΚΠΤ% / DISCOUNT)
  applies, put the % in discount1 and still trust the printed net value.
- SELF-CHECK: the sum of line `totalPrice` should be close to totals.subtotal. If
  it is far larger, you read the wrong column — re-read ΚΑΘΑΡΗ ΑΞΙΑ per line.

Invoice Markdown:
--------------------
{TEXT}
--------------------"""


# ── JSON parsing / repair (ported from qwen35_engine for consistent behaviour) ──
def _repair_truncated_json(s: str) -> Optional[Dict[str, Any]]:
    if not s:
        return None
    s = s.strip()
    start = s.find("{")
    if start == -1:
        return None
    s = s[start:]
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
        if ch in "}]\"," and not in_str:
            last_safe = i
    if last_safe is None:
        return None
    candidate = re.sub(r",\s*$", "", s[: last_safe + 1].strip())
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
    repaired = _repair_truncated_json(cleaned)
    if repaired:
        log.warning("[PaddleKIE] recovered truncated JSON via repair")
    return repaired


# ── llama-server client ─────────────────────────────────────────────────────
def _llm_health() -> bool:
    try:
        with httpx.Client(timeout=10) as c:
            return c.get(f"{KIE_LLM_URL}/health").status_code == 200
    except Exception:
        return False


def _wait_until_ready(max_wait: float) -> bool:
    deadline = time.monotonic() + max_wait
    waited = False
    while time.monotonic() < deadline:
        if _llm_health():
            if waited:
                log.info("[PaddleKIE] llama-server ready")
            return True
        waited = True
        log.info(f"[PaddleKIE] waiting for KIE llama-server to load "
                 f"(poll {KIE_LLM_READY_POLL}s)...")
        time.sleep(KIE_LLM_READY_POLL)
    log.warning(f"[PaddleKIE] llama-server not ready after {max_wait}s — trying anyway")
    return False


def _post_chat(markdown: str) -> str:
    """Single text-only OpenAI-compatible chat request to the llama-server."""
    capped = markdown[:KIE_MAX_INPUT_CHARS]
    user = _USER_PROMPT_TEMPLATE.replace("{TEXT}", capped)
    payload = {
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
        "temperature": KIE_LLM_TEMP,
        "max_tokens": KIE_LLM_MAX_TOKENS,
        "stream": False,
    }
    url = f"{KIE_LLM_URL}/v1/chat/completions"
    _wait_until_ready(KIE_LLM_READY_WAIT)

    deadline = time.monotonic() + KIE_LLM_READY_WAIT
    while True:
        with httpx.Client(timeout=KIE_LLM_TIMEOUT) as c:
            r = c.post(url, json=payload)
        if r.status_code == 503 and time.monotonic() < deadline:
            log.info(f"[PaddleKIE] llama-server 503 (loading), waiting "
                     f"{KIE_LLM_READY_POLL}s")
            time.sleep(KIE_LLM_READY_POLL)
            continue
        r.raise_for_status()
        data = r.json()
        return (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


def extract_invoice_json(markdown: str,
                         reference_text: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Turn PP-StructureV3 Markdown into the canonical invoice JSON.

    Returns None when KIE is disabled (PADDLE_KIE_BACKEND=none) or the LLM
    produced nothing parseable — the caller then falls back to returning the
    Markdown for vlm-service's semantic_extractor.
    """
    if PADDLE_KIE_BACKEND == "none":
        log.info("[PaddleKIE] backend=none — skipping KIE, Markdown returned as-is")
        return None
    if PADDLE_KIE_BACKEND == "ppchatocr":
        # Native PP-ChatOCRv4 KIE lives in paddle_ppchatocr.py (optional).
        try:
            from paddle_ppchatocr import extract_invoice_json_native
            return extract_invoice_json_native(markdown, reference_text=reference_text)
        except Exception as e:  # noqa: BLE001
            log.error(f"[PaddleKIE] ppchatocr backend failed ({e}); returning None")
            return None

    if not markdown or not markdown.strip():
        return None

    t0 = time.perf_counter()
    raw = _post_chat(markdown)
    elapsed = round(time.perf_counter() - t0, 2)
    log.info(f"[PaddleKIE] LLM responded in {elapsed}s — {len(raw)} chars")

    structured = _parse_json_output(raw)

    # Reuse the SHARED post-processor from vlm-service (mounted alongside) so the
    # same number-normalisation + VAT-hallucination guards run as for the vision
    # engines. Optional — never let it break extraction.
    if structured is not None:
        try:
            from vision_postprocess import postprocess_vision_invoice
            structured = postprocess_vision_invoice(structured, reference_text=reference_text)
        except Exception as e:  # noqa: BLE001
            log.info(f"[PaddleKIE] vision_postprocess not applied: {e}")

    if structured:
        items = len(structured.get("lineItems") or [])
        log.info(f"[PaddleKIE] ✓ invoice={structured.get('invoiceNumber')} "
                 f"items={items} currency={structured.get('currency')}")
    else:
        log.warning(f"[PaddleKIE] ✗ no JSON parsed; raw[:300]={raw[:300]!r}")
    return structured


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    md = sys.stdin.read() if len(sys.argv) < 2 else open(sys.argv[1]).read()
    print(json.dumps(extract_invoice_json(md), indent=2, ensure_ascii=False))
