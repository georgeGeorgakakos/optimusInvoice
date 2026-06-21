"""
gemma_vl_engine.py
─────────────────────────────────────────────────────────────────────────────
Gemma 3 4B-it vision engine for Optimus Invoice — GGUF/llama.cpp backend.

Architecture (switched from transformers bf16 to llama.cpp Q4_K_M):
  - Model: ggml-org/gemma-3-4b-it-GGUF (Q4_K_M, ~2.5 GB) + mmproj (~800 MB)
  - Backend: llama-cpp-python with embedded Gemma3ChatHandler
  - Inference: ~5-10 tok/s on CPU (12 cores) vs ~0.4 tok/s for bf16 transformers
  - Total per invoice: 2-3 min vs 30 min (10-15x speedup)

The "engine" module is intentionally separated from the FastAPI "service"
module so the heavy model state lives in one place and can be tested
standalone:

    >>> from gemma_vl_engine import load_gemma_vl_local, extract_invoice_from_image
    >>> load_gemma_vl_local()
    True
    >>> result = extract_invoice_from_image(pil_image)
    >>> result["structured"]["invoiceNumber"]
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
from typing import Any, Dict, Optional

log = logging.getLogger("gemma_vl_engine")

# ── Module-level state ──────────────────────────────────────────────────────
# Singleton Llama instance + chat handler. Inference is single-threaded (CPU
# bottleneck) — the FastAPI service serializes requests with an asyncio.Semaphore.
_MODEL = None
_HANDLER = None
_LOAD_LOCK = threading.Lock()
_LOADING = False
_LOAD_ERROR: Optional[str] = None

# Config from environment — resolved at load time
_MODEL_PATH    = os.environ.get("GEMMA_VL_MODEL_PATH",    "")   # auto-resolved if empty
_MMPROJ_PATH   = os.environ.get("GEMMA_VL_MMPROJ_PATH",   "")   # auto-resolved if empty
_REPO_ID       = os.environ.get("GEMMA_VL_REPO_ID",       "ggml-org/gemma-3-4b-it-GGUF")
_MODEL_FILE    = os.environ.get("GEMMA_VL_MODEL_FILE",    "gemma-3-4b-it-Q4_K_M.gguf")
_MMPROJ_FILE   = os.environ.get("GEMMA_VL_MMPROJ_FILE",   "mmproj-model-f16.gguf")

# Inference tuning
# DEFAULTS sized for real Fiverr-style PDFs with multi-line addresses + line
# items. Tried tighter values (2048/512) but they truncated JSON output —
# see https://github.com/.../issues/XX for the Fiverr 115M case.
_N_CTX         = int(os.environ.get("LLAMA_N_CTX",         "4096"))  # context window
_N_THREADS     = int(os.environ.get("LLAMA_N_THREADS",     "10"))    # 10 of 12 cores
_N_BATCH       = int(os.environ.get("LLAMA_N_BATCH",       "512"))
_MAX_NEW_TOKENS = int(os.environ.get("GEMMA_MAX_NEW_TOKENS", "1024"))


# ── Gemma 3 chat handler (embedded from llama-cpp-python PR #1989) ──────────
# Defined inline so this code works whether the user's installed
# llama-cpp-python version includes Gemma3ChatHandler natively or not.
# Reference: https://github.com/abetlen/llama-cpp-python/pull/1989

def _get_gemma3_chat_handler_class():
    """Return Gemma3ChatHandler class — either the native one or our embedded version."""
    # noinspection PyUnresolvedReferences
    from llama_cpp.llama_chat_format import Llava15ChatHandler

    # Try to use the native version first if it exists in this llama-cpp-python build
    try:
        # noinspection PyUnresolvedReferences
        from llama_cpp.llama_chat_format import Gemma3ChatHandler as _NativeGemma3
        log.info("[GemmaVL] Using native Gemma3ChatHandler from llama-cpp-python")
        return _NativeGemma3
    except ImportError:
        pass

    # Fallback: embedded class (mirrors PR #1989)
    log.info("[GemmaVL] Using embedded Gemma3ChatHandler (PR #1989 backport)")

    class Gemma3ChatHandler(Llava15ChatHandler):
        """Gemma 3 multimodal chat handler.

        Inherits image-loading logic from Llava15ChatHandler but uses Gemma 3's
        chat template (<start_of_turn>...<end_of_turn>) for prompt formatting.

        System messages are translated to a "Understood." turn pair because
        Gemma 3 doesn't have a dedicated system role.
        """
        DEFAULT_SYSTEM_MESSAGE = None
        CHAT_FORMAT = (
            "{{ bos_token }}"
            "{% for message in messages %}"
            "{% if message.role == 'system' %}"
            "<start_of_turn>user\n{{ message.content }}<end_of_turn>\n"
            "<start_of_turn>model\nUnderstood.<end_of_turn>\n"
            "{% endif %}{% endfor %}"
            "{% for message in messages %}{% if message.role != 'system' %}"
            "<start_of_turn>{{ message.role }}\n"
            "{% if message.content is string %}{{ message.content }}"
            "{% else %}{% for c in message.content %}"
            "{% if c.type == 'text' and c.text %}{{ c.text }}{% endif %}"
            "{% if c.type == 'image_url' %}{{ c.image_url.url }}{% endif %}"
            "{% endfor %}{% endif %}"
            "<end_of_turn>\n"
            "{% endif %}{% endfor %}"
            "{% if add_generation_prompt %}<start_of_turn>model\n{% endif %}"
        )

    return Gemma3ChatHandler


# ── Path resolution (find GGUF files in HF cache) ───────────────────────────

def _resolve_gguf_paths():
    """
    Resolve absolute paths for the main GGUF and mmproj files.

    Priority:
      1. Explicit env vars GEMMA_VL_MODEL_PATH / GEMMA_VL_MMPROJ_PATH
      2. huggingface_hub.hf_hub_download (looks up cached files by repo+filename)

    Returns (model_path, mmproj_path) or raises RuntimeError with diagnostics.
    """
    global _MODEL_PATH, _MMPROJ_PATH

    if _MODEL_PATH and _MMPROJ_PATH:
        if os.path.exists(_MODEL_PATH) and os.path.exists(_MMPROJ_PATH):
            return _MODEL_PATH, _MMPROJ_PATH
        log.warning(
            f"[GemmaVL] Env paths set but files missing: "
            f"model={_MODEL_PATH} exists={os.path.exists(_MODEL_PATH)}, "
            f"mmproj={_MMPROJ_PATH} exists={os.path.exists(_MMPROJ_PATH)}"
        )

    # Fall back to HF cache lookup
    try:
        from huggingface_hub import hf_hub_download
        # local_files_only=True ensures no network call — cache must be primed
        # by Download-VlmWheels.ps1 Step 8
        offline = os.environ.get("HF_HUB_OFFLINE", "1") == "1"
        kwargs = {"local_files_only": True} if offline else {}

        model_path = hf_hub_download(
            repo_id=_REPO_ID, filename=_MODEL_FILE, **kwargs
        )
        mmproj_path = hf_hub_download(
            repo_id=_REPO_ID, filename=_MMPROJ_FILE, **kwargs
        )
        log.info(f"[GemmaVL] Resolved model:  {model_path}")
        log.info(f"[GemmaVL] Resolved mmproj: {mmproj_path}")
        return model_path, mmproj_path

    except Exception as e:
        raise RuntimeError(
            f"Cannot find Gemma 3 GGUF files for {_REPO_ID}. "
            f"Files expected: {_MODEL_FILE}, {_MMPROJ_FILE}. "
            f"Make sure Download-VlmWheels.ps1 Step 8 was run successfully. "
            f"Original error: {e}"
        )


# ── Loading ─────────────────────────────────────────────────────────────────

def is_loaded() -> bool:
    return _MODEL is not None


def is_loading() -> bool:
    return _LOADING


def get_load_error() -> Optional[str]:
    return _LOAD_ERROR


def load_gemma_vl_local() -> bool:
    """
    Load Gemma 3 GGUF + mmproj into memory via llama-cpp-python.

    Idempotent — calling twice returns True without reloading.
    Thread-safe via _LOAD_LOCK.

    Returns True on success, False on failure (sets _LOAD_ERROR).
    """
    global _MODEL, _HANDLER, _LOADING, _LOAD_ERROR

    if is_loaded():
        return True

    with _LOAD_LOCK:
        if is_loaded():
            return True
        _LOADING = True
        _LOAD_ERROR = None

        try:
            t0 = time.perf_counter()

            # Lazy imports — module can be imported without llama_cpp installed
            # noinspection PyUnresolvedReferences
            from llama_cpp import Llama

            model_path, mmproj_path = _resolve_gguf_paths()
            log.info(f"[GemmaVL] Loading Q4_K_M GGUF on CPU (n_threads={_N_THREADS}, n_ctx={_N_CTX}) ...")

            # Create chat handler with mmproj (vision encoder)
            HandlerClass = _get_gemma3_chat_handler_class()
            handler = HandlerClass(clip_model_path=mmproj_path, verbose=False)

            # Create Llama instance
            llm = Llama(
                model_path=model_path,
                chat_handler=handler,
                n_ctx=_N_CTX,
                n_threads=_N_THREADS,
                n_batch=_N_BATCH,
                n_gpu_layers=0,    # CPU only
                verbose=False,
            )

            _HANDLER = handler
            _MODEL = llm
            elapsed = round(time.perf_counter() - t0, 1)
            log.info(f"[GemmaVL] Loaded in {elapsed}s — ready for inference")
            return True

        except Exception as e:
            _LOAD_ERROR = f"{type(e).__name__}: {e}"
            log.exception(f"[GemmaVL] Load failed: {_LOAD_ERROR}")
            return False

        finally:
            _LOADING = False


# ── Prompt ──────────────────────────────────────────────────────────────────

_INVOICE_PROMPT = """You are an expert invoice extraction system for Greek and European invoices.
Examine the invoice image carefully and return a SINGLE JSON object with exactly the keys below.
If a field is missing from the invoice, set it to null (do NOT invent values).

Required JSON structure:
{
  "invoiceNumber":   "string or null",
  "invoiceDate":     "YYYY-MM-DD or null",
  "documentType":    "invoice | credit_note | receipt | dispatch_note",
  "orderNumber":     "string or null — see CRITICAL ORDER NUMBER RULE below",
  "currency":        "EUR | USD | GBP | ...",
  "paymentMethod":   "string or null (e.g. 'Card', 'Bank transfer', 'Cash')",

  "issuer": {
    "name":       "company legal name as printed",
    "vatNumber":  "EU VAT number EXACTLY as printed on the invoice (e.g. starts with EL/BG/DE/IT/...) — null if the invoice does NOT show an EU VAT. NEVER fabricate.",
    "taxId":      "non-EU tax/company identifier (e.g. Israeli 'Company no.', US EIN, UK CRN) — null if not shown",
    "address":    "street and number",
    "city":       "city",
    "postCode":   "postal code",
    "country":    "country name",
    "registrationNumber": "GEMI/registry number or null",
    "doy":        "tax office name or null"
  },

  "recipient": {
    "name":          "LEGAL ENTITY NAME — see CRITICAL RULE below",
    "contactPerson": "person name (e.g. an individual who signed the order, listed separately from the legal entity) if shown SEPARATELY from the company line — otherwise null. Do NOT copy this example label; extract the actual person name from THIS invoice.",
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
      "vatRate":      "number (0, 6, 13, 24, 19, etc.) — or null if the invoice does NOT show a VAT rate for this line. NEVER guess 24.",
      "discount1":    null
    }
  ],

  "totals": {
    "subtotal":      0.00,
    "vat":           0.00,
    "total":         0.00,
    "payable":       0.00
  },
  "withholdingTax": null,

  "mark":                "myDATA MARK (15 digits) or null",
  "uid":                 "myDATA UID (40 hex chars) or null",
  "authenticationCode":  "myDATA auth code or null",
  "provider":            "e-invoicing provider name or null",

  "dispatchDate":   "YYYY-MM-DD or null (for combined dispatch documents)",
  "vehicleNumber":  "vehicle plate or null",
  "purpose":        "purpose of dispatch (sale / return / ...) or null"
}

Rules:
- Output ONLY valid JSON. No markdown fences, no commentary, no preamble.
- NEVER copy literal example values from this prompt (the schema text is INSTRUCTIONS, not data). If a field is not visible on the invoice, set it to null.

- CRITICAL — TOTALS BOX: The authoritative subtotal, VAT amount, and final total are in the summary/calculation box, usually at the BOTTOM-RIGHT of the invoice. On Greek invoices this box is labelled with terms like "ΑΝΑΛΥΣΗ ΥΠΟΛΟΓΙΣΜΟΥ ΦΠΑ", "ΚΑΘΑΡΗ ΑΞΙΑ" (net/subtotal), "Φ.Π.Α." (VAT amount), "ΣΥΝΟΛΟ" / "ΤΕΛΙΚΗ ΑΞΙΑ" / "ΠΛΗΡΩΤΕΟ" (grand total / payable). Read totals.subtotal, totals.vat and totals.total/totals.payable from THIS box — NOT from the line-items area. The grand total (ΠΛΗΡΩΤΕΟ / ΤΕΛΙΚΗ ΑΞΙΑ) is the VAT-inclusive amount and is usually the largest number in the box.

- TOTALS CONSISTENCY: subtotal + vat should equal total. If your extracted numbers do not reconcile, re-read the totals box before answering.

- VAT RATE: For Greek invoices, valid rates are 0, 6, 13, 24. Non-Greek invoices may show 19, 20, 21, 23, 25, etc. Set vatRate to the EXACT number printed for each line. If no VAT rate is printed anywhere on the invoice (e.g. some export/service invoices that show no VAT at all), set vatRate to null — do NOT default to 24.

- VAT NUMBERS: Issuer and recipient VAT numbers must be copied EXACTLY as printed on the invoice. If the invoice shows only a non-EU tax identifier (e.g. Israeli "Company no. 514440874", US EIN), put that in taxId and leave vatNumber=null. Never invent a country prefix.

- CURRENCY: Detect from symbols and text on the invoice:
    "$"            → USD (also "Invoice Total (USD)", "USD 100", etc.)
    "€"            → EUR
    "£"            → GBP
    "лв" or "BGN"  → BGN
    "¥"            → JPY (or CNY for Chinese context)
    "₪"            → ILS
  Do NOT default to EUR. If the invoice shows "$" or "USD", the currency is USD — never EUR. If no currency symbol or code is visible, return null.

- CRITICAL — RECIPIENT NAME DISAMBIGUATION:
  When the "Bill To" / "To" / "Recipient" / "Customer" / "Πελάτης" block contains MULTIPLE consecutive lines, like:
      Bill to
      [individual person name]               ← person name (an individual)
      [company name + corporate suffix]      ← LEGAL ENTITY with corporate suffix
      [street address line]
      [city, postal code, country]
  you MUST set recipient.name to the line that contains a corporate suffix, even if a person name appears first. Corporate suffixes include:
      EOOD, OOD, LTD, LIMITED, GMBH, AG, SA, S.A., AE, ΑΕ, AEBE, ΑΕΒΕ,
      EPE, ΕΠΕ, IKE, ΙΚΕ, OE, ΟΕ, BV, NV, INC, LLC, CORP, SRL, SARL, KG, PC
  Put the person name in recipient.contactPerson (or null if no person is named).
  If no corporate-suffix line exists in the block, use the most company-like line as recipient.name.
  CRITICAL: The placeholders above are illustrative only. You MUST extract the actual values you see on THIS invoice. Never copy placeholder text into the output.

- ISSUER vs RECIPIENT: The ISSUER is the entity SENDING the invoice (typically top-left header — "From", logo, letterhead). The RECIPIENT is the entity RECEIVING the invoice (typically a "Bill To" / "To" / "Πελάτης" block). Never confuse them.

- CRITICAL — ORDER NUMBER vs STREET ADDRESS:
  In TWO-COLUMN invoice layouts, the "Order number" label is often in the right column while the address rows in the left column extend across multiple lines, like this:
      Bill to                                Order number
      [company name]                         [order number token]   ← THIS is the order number
      [person name]
      [street number + street name + type]   ← NOT the order number — this is a street!
      [city, postal code]
  The orderNumber field is ONLY the token that visually sits to the right of the "Order number" / "PO" / "Purchase Order" label. Tokens that match the pattern "digit(s) + letter(s)" (a short alphanumeric that starts with a digit) and are followed by street keywords (Blvd., Street, St., Strasse, Avenue, οδός, λεωφ., etc.) are STREET NUMBERS — leave orderNumber=null for them.
  Real order numbers typically have one of these shapes:
      - Letter prefix + alphanumeric tail: e.g. an "FO" followed by digits/letters, or "PO-" followed by year + digits
      - Pure long digit string (6+ digits)
  CRITICAL: If the invoice has NO "Order number" / "PO" / "Purchase Order" label at all, set orderNumber=null. NEVER fabricate. The placeholders above are illustrative only — do not copy them into the output.

- Amounts use period as decimal separator in the JSON output (1234.56, not 1.234,56).
""".strip()


# ── Inference ───────────────────────────────────────────────────────────────

def extract_invoice_from_image(image, language: str = "el", reference_text: Optional[str] = None) -> Dict[str, Any]:
    """
    Run Gemma 3 GGUF inference on a PIL Image of an invoice.

    `reference_text` (optional): the PDF's native text (pdfplumber). When provided
    it is passed to the shared post-processor so the FULL cross-reference
    validation runs (nulls hallucinated VAT numbers, fixes currency defaults,
    street-as-name, etc.) against the real invoice text rather than the image.

    Returns:
        {
          "text":       str,   # raw model output (the JSON string)
          "structured": dict,  # parsed JSON, or {} if parsing failed
          "elapsed":    float, # inference seconds
        }
    """
    if not is_loaded():
        ok = load_gemma_vl_local()
        if not ok:
            return {
                "text": "",
                "structured": {},
                "elapsed": 0.0,
                "error": _LOAD_ERROR or "Model not loaded",
            }

    t0 = time.perf_counter()

    # Convert PIL image → base64 data URL (llama.cpp multimodal input format)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    image_bytes = buf.getvalue()
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:image/png;base64,{image_b64}"

    log.info(
        f"[GemmaVL] Inference start "
        f"(image={len(image_bytes)} bytes, max_new_tokens={_MAX_NEW_TOKENS})"
    )

    try:
        response = _MODEL.create_chat_completion(
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": _INVOICE_PROMPT},
                    ],
                }
            ],
            max_tokens=_MAX_NEW_TOKENS,
            temperature=0.0,
        )
    except Exception as e:
        log.exception("[GemmaVL] Inference failed")
        return {"text": "", "structured": {}, "elapsed": round(time.perf_counter() - t0, 2), "error": str(e)}

    raw_text = response["choices"][0]["message"]["content"]
    if raw_text is None:
        raw_text = ""
    raw_text = raw_text.strip()

    elapsed = round(time.perf_counter() - t0, 2)
    log.info(f"[GemmaVL] Inference done in {elapsed}s ({len(raw_text)} chars)")

    structured = _safe_parse_json(raw_text)

    # ── Shared vision post-processing ─────────────────────────────────────────
    # The vision path bypasses semantic_extractor's _normalize_number /
    # _validate_extraction safety net (it parses its own JSON), so apply the
    # shared guards here: number normalization ("1,437" -> 1437) and the
    # deterministic VAT-hallucination guard (strip an invented vatRate when
    # subtotal == total). reference_text=None because the engine only has the
    # image; the full text-based validation (currency / VAT-number / street
    # fixes) runs on the Node side where pdfplumber text is available. Wrapped so
    # post-processing can NEVER break extraction.
    try:
        from vision_postprocess import postprocess_vision_invoice
        structured = postprocess_vision_invoice(structured, reference_text=reference_text)
    except Exception as _pp_e:
        log.warning(f"[GemmaVL] postprocess skipped: {_pp_e}")

    return {
        "text":       raw_text,
        "structured": structured,
        "elapsed":    elapsed,
    }


# ── JSON parsing helper ─────────────────────────────────────────────────────

_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)

def _safe_parse_json(raw: str) -> Dict[str, Any]:
    """
    Try hard to extract a JSON object from the model output. Handles:
      - markdown fences (```json ... ```)
      - text before/after the JSON
      - trailing commentary
      - truncated JSON (try to close brackets)

    Returns empty dict if parsing fails.
    """
    if not raw:
        return {}

    cleaned = _FENCE_RE.sub("", raw).strip()

    # Direct parse
    try:
        result = json.loads(cleaned)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        pass

    # Locate first balanced { ... } block
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        try:
            result = json.loads(match.group(0))
            if isinstance(result, dict):
                return result
        except json.JSONDecodeError as e:
            log.warning(f"[GemmaVL] JSON parse failed even after locating braces: {e}")

    return {}