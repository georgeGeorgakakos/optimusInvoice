"""
qwen_vl_engine.py
Local Qwen2.5-VL-3B-Instruct vision engine for Optimus invoice extraction.

Runs entirely inside the vlm-service container via HuggingFace transformers.
No vLLM, no separate server, no GPU required — pure CPU inference.

Model: Qwen/Qwen2.5-VL-3B-Instruct
Size:  ~2.3 GB (bf16 weights, downloaded once to /models volume)
Speed: ~90-120s per invoice page on 12-core CPU

Pipeline:
  PDF page image (PIL) → Qwen2.5-VL-3B → structured JSON invoice fields

The model is lazy-loaded on first request and kept in memory for subsequent
requests. A semaphore in vlm_service.py serialises concurrent calls.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any, Dict, Optional

log = logging.getLogger("qwen_vl_engine")

# ── Config ────────────────────────────────────────────────────────────────────
QWEN_VL_LOCAL_MODEL = os.getenv(
    "QWEN_VL_LOCAL_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct"
)
QWEN_VL_LOCAL_MAX_TOKENS = int(os.getenv("QWEN_VL_LOCAL_MAX_TOKENS", "512"))
QWEN_VL_LOCAL_THREADS    = int(os.getenv("LLAMA_N_THREADS", "12"))  # reuse thread config

# ── Module-level model cache (loaded once, reused) ────────────────────────────
_qwen_vl_model     = None
_qwen_vl_processor = None


# ── Invoice extraction prompt ─────────────────────────────────────────────────
_INVOICE_SYSTEM_PROMPT = (
    "You are an expert invoice data extraction engine for Greek and European "
    "invoices. You receive an image of a business invoice (which may be in Greek "
    "or English) and extract all fields into a structured JSON object. "
    "Always return valid JSON only — no markdown, no explanation, no extra text."
)

# NOTE: This nested schema mirrors gemma_vl_engine.py so both vision engines
# emit the SAME shape (issuer/recipient/totals objects). The Node mapping layer
# (server/python-integration.ts) consumes issuer/recipient directly. Keep this
# in sync with the Gemma prompt when invoice-handling rules change.
_INVOICE_USER_PROMPT = """Extract all invoice fields from this image and return a SINGLE JSON object with exactly the keys below.
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
    "vatNumber":  "EU VAT number EXACTLY as printed (e.g. starts with EL/BG/DE/IT/...) — null if the invoice does NOT show an EU VAT. NEVER fabricate.",
    "taxId":      "non-EU tax/company identifier (Israeli 'Company no.', US EIN, UK CRN) — null if not shown",
    "address":    "street and number",
    "city":       "city",
    "postCode":   "postal code",
    "country":    "country name",
    "registrationNumber": "GEMI/registry number or null",
    "doy":        "tax office name or null"
  },

  "recipient": {
    "name":          "LEGAL ENTITY NAME — see CRITICAL RULE below",
    "contactPerson": "person name if shown SEPARATELY from the company line — otherwise null. Extract the actual person name from THIS invoice.",
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

- VAT RATE: For Greek invoices, valid rates are 0, 6, 13, 24. Non-Greek invoices may show 19, 20, 21, 23, 25, etc. Set vatRate to the EXACT number printed for each line. If no VAT rate is printed anywhere, set vatRate to null — do NOT default to 24.

- VAT NUMBERS: Issuer and recipient VAT numbers must be copied EXACTLY as printed. If the invoice shows only a non-EU tax identifier (e.g. Israeli "Company no. 514440874", US EIN), put that in taxId and leave vatNumber=null. Never invent a country prefix (do NOT prepend "EL" or any prefix that is not actually printed).

- CURRENCY: Detect from symbols and text on the invoice:
    "$"            → USD (also "Invoice Total (USD)", "USD 100")
    "€"            → EUR
    "£"            → GBP
    "лв" or "BGN"  → BGN
    "¥"            → JPY (or CNY for Chinese context)
    "₪"            → ILS
  Do NOT default to EUR. If the invoice shows "$" or "USD", the currency is USD. If no currency symbol or code is visible, return null. Greek invoices are almost always EUR — do not output ILS or other currencies unless a matching symbol is actually printed.

- CRITICAL — RECIPIENT NAME DISAMBIGUATION:
  When the "Bill To" / "To" / "Recipient" / "Πελάτης" / "ΣΤΟΙΧΕΙΑ ΣΥΜΒΑΛΛΟΜΕΝΟΥ" block contains MULTIPLE consecutive lines (a person name then a company name + corporate suffix then address lines), set recipient.name to the line that contains a corporate suffix, even if a person name appears first. Corporate suffixes include:
      EOOD, OOD, LTD, LIMITED, GMBH, AG, SA, S.A., AE, ΑΕ, AEBE, ΑΕΒΕ,
      EPE, ΕΠΕ, IKE, ΙΚΕ, OE, ΟΕ, BV, NV, INC, LLC, CORP, SRL, SARL, KG, PC,
      ΑΝΩΝΥΜΗ ΕΤΑΙΡΕΙΑ
  Put the person name in recipient.contactPerson (or null). If no corporate-suffix line exists, use the most company-like line as recipient.name.

- ISSUER vs RECIPIENT: The ISSUER is the entity SENDING the invoice (typically top-left header / letterhead / logo). The RECIPIENT is the entity RECEIVING it (a "Bill To" / "Πελάτης" / "ΣΤΟΙΧΕΙΑ ΣΥΜΒΑΛΛΟΜΕΝΟΥ" block). Never confuse them.

- CRITICAL — ORDER NUMBER vs STREET ADDRESS:
  Set orderNumber ONLY to the token that visually sits to the right of an "Order number" / "PO" / "Purchase Order" label. A short alphanumeric that starts with a digit and is followed by street keywords (Blvd., Street, St., Strasse, Avenue, οδός, λεωφ., ΚΗΦΙΣΙΑΣ, etc.) is a STREET NUMBER — leave orderNumber=null for it. If the invoice has NO order-number label, set orderNumber=null. NEVER fabricate.

- Amounts use period as decimal separator in the JSON output (1234.56, not 1.234,56). Greek invoices print 1.234,56 — convert to 1234.56."""


def load_qwen_vl_local() -> bool:
    """
    Load Qwen2.5-VL-3B-Instruct model and processor into memory.
    Returns True on success, False on failure.
    Downloads ~2.3 GB to HF_HOME on first call.
    """
    global _qwen_vl_model, _qwen_vl_processor

    if _qwen_vl_model is not None:
        return True

    log.info(f"[QwenVL-Local] Loading {QWEN_VL_LOCAL_MODEL} ...")
    t0 = time.perf_counter()

    try:
        import torch
        from transformers import AutoProcessor
        try:
            from transformers.models.qwen2_5_vl.modeling_qwen2_5_vl import Qwen2_5_VLForConditionalGeneration as QwenVLModel
        except ImportError:
            from transformers import Qwen2VLForConditionalGeneration as QwenVLModel

        # ── Force CPU thread count ────────────────────────────────────────
        # PyTorch does NOT reliably honor OMP_NUM_THREADS for inference — it
        # auto-detects physical cores (observed: 6 on a 12-core box, leaving
        # ~40% idle and decode crawling at ~0.37 tok/s). Set it explicitly here,
        # BEFORE any tensor op, so generate() uses all the cores we intend.
        # set_num_interop_threads must be called before the first parallel op or
        # it raises — load time is the safe place. QWEN_VL_THREADS overrides;
        # falls back to LLAMA_N_THREADS (compose already sets 10), then 10.
        _threads = int(os.getenv("QWEN_VL_THREADS", os.getenv("LLAMA_N_THREADS", "10")))
        try:
            torch.set_num_threads(_threads)
            try:
                torch.set_num_interop_threads(_threads)
            except Exception:
                pass  # interop can only be set once per process — ignore if already set
            log.info(f"[QwenVL-Local] torch threads set to {torch.get_num_threads()} "
                     f"(requested {_threads})")
        except Exception as _te:
            log.warning(f"[QwenVL-Local] could not set torch threads: {_te}")

        # Load processor (tokenizer + image processor)
        log.info("[QwenVL-Local] Loading processor ...")
        _cache_dir = os.getenv("HF_HOME", "/models")
        _model_local = os.path.isdir(f"{_cache_dir}/hub/models--Qwen--Qwen2.5-VL-3B-Instruct")
        # max_pixels caps the image resolution the vision encoder sees, which
        # DIRECTLY caps the number of vision tokens (the main driver of CPU
        # inference time). Qwen2.5-VL resizes any input down to this budget
        # before encoding. Default here ~602k px (~0.6 Mpx) -> ~850 vision
        # tokens, vs the ~2940 tokens a full 2.1 Mpx page produced (which
        # estimated ~80 min on CPU). Tune via QWEN_VL_MAX_PIXELS / QWEN_VL_MIN_PIXELS.
        #   28*28 = 784 px per token block; 768*784 ≈ 602k px ≈ 850 tokens.
        # Lower = faster but coarser text; raise if small fonts are missed.
        _max_pixels = int(os.getenv("QWEN_VL_MAX_PIXELS", str(768 * 784)))
        _min_pixels = int(os.getenv("QWEN_VL_MIN_PIXELS", str(256 * 784)))
        _qwen_vl_processor = AutoProcessor.from_pretrained(
            QWEN_VL_LOCAL_MODEL,
            trust_remote_code=True,
            cache_dir=_cache_dir,
            local_files_only=_model_local,
            max_pixels=_max_pixels,
            min_pixels=_min_pixels,
        )
        log.info(
            f"[QwenVL-Local] Processor image budget: max_pixels={_max_pixels} "
            f"(~{round(_max_pixels/784)} vision tokens), min_pixels={_min_pixels}"
        )

        # ── Model dtype — env-gated ───────────────────────────────────────
        # fp32 is the safe default (bf16/fp16 can emit NaN on some CPUs → garbage
        # output). But fp32 is ~2x the memory bandwidth of bf16, and CPU LLM decode
        # is bandwidth-bound — so fp32 is the dominant reason for slow generation.
        # Set QWEN_VL_DTYPE=bf16 (or fp16) to opt into the faster path, then TEST a
        # known invoice: if fields are clean, keep it; if output is NaN/garbage,
        # revert to fp32. Default unchanged (fp32) so this is safe out of the box.
        _dtype_name = os.getenv("QWEN_VL_DTYPE", "fp32").lower()
        if _dtype_name in ("bf16", "bfloat16"):
            _torch_dtype = torch.bfloat16
        elif _dtype_name in ("fp16", "float16", "half"):
            _torch_dtype = torch.float16
        else:
            _dtype_name = "fp32"
            _torch_dtype = torch.float32
        log.info(f"[QwenVL-Local] Model dtype: {_dtype_name} ({_torch_dtype}) "
                 f"— set QWEN_VL_DTYPE=bf16 for faster CPU decode (test output first)")

        # Load model — dtype from QWEN_VL_DTYPE (default fp32 for CPU stability)
        log.info("[QwenVL-Local] Loading model weights (this may take a minute) ...")
        _qwen_vl_model = QwenVLModel.from_pretrained(
            QWEN_VL_LOCAL_MODEL,
            torch_dtype=_torch_dtype,
            device_map="cpu",
            trust_remote_code=True,
            cache_dir=_cache_dir,
            local_files_only=_model_local,
        )
        _qwen_vl_model.eval()

        elapsed = round(time.perf_counter() - t0, 1)
        log.info(f"[QwenVL-Local] Model ready in {elapsed}s")
        return True

    except Exception as exc:
        log.error(f"[QwenVL-Local] Load failed: {exc}", exc_info=True)
        _qwen_vl_model     = None
        _qwen_vl_processor = None
        return False


def is_loaded() -> bool:
    """Check if model is already in memory."""
    return _qwen_vl_model is not None


def extract_invoice_from_image(pil_image, reference_text: Optional[str] = None) -> Dict[str, Any]:
    """
    Run Qwen2.5-VL-3B on a single PIL invoice page image.
    Returns a dict with keys: text, structured, latency_ms, engine.

    The 'structured' key contains parsed invoice JSON if extraction succeeded.
    The 'text' key contains the raw model output string.

    `reference_text` (optional): the PDF's native text (pdfplumber). When provided
    it is passed to the shared post-processor so the FULL cross-reference
    validation runs (nulls hallucinated VAT numbers, fixes currency defaults,
    street-as-name, etc.) against the real invoice text rather than the image.
    """
    global _qwen_vl_model, _qwen_vl_processor

    if _qwen_vl_model is None:
        ok = load_qwen_vl_local()
        if not ok:
            raise RuntimeError(
                "Qwen2.5-VL-3B failed to load. "
                "Check logs for details. "
                f"Model: {QWEN_VL_LOCAL_MODEL}"
            )

    t0 = time.perf_counter()

    try:
        import torch
        from qwen_vl_utils import process_vision_info

        # Build the chat message with image + extraction prompt
        messages = [
            {
                "role": "system",
                "content": _INVOICE_SYSTEM_PROMPT,
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "image": pil_image,
                    },
                    {
                        "type": "text",
                        "text": _INVOICE_USER_PROMPT,
                    },
                ],
            },
        ]

        # Apply chat template
        text_input = _qwen_vl_processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )

        # ── Process image + text inputs ──────────────────────────────────
        log.info("[QwenVL-Local] Processing image + text through vision encoder ...")
        t_proc = time.perf_counter()
        image_inputs, video_inputs = process_vision_info(messages)
        inputs = _qwen_vl_processor(
            text=[text_input],
            images=image_inputs,
            videos=video_inputs,
            padding=True,
            return_tensors="pt",
        )
        proc_elapsed = round(time.perf_counter() - t_proc, 2)
        log.info(f"[QwenVL-Local] Vision encoding complete in {proc_elapsed}s")

        # ── Log input token count ────────────────────────────────────────
        n_input_tokens = inputs.input_ids.shape[1]
        log.info(f"[QwenVL-Local] Input tokens: {n_input_tokens} — generating up to {QWEN_VL_LOCAL_MAX_TOKENS} output tokens ...")

        # ── Generate with streamed progress logging ───────────────────────
        # We use a callback-based approach to log progress every 50 tokens
        _gen_start = time.perf_counter()
        _last_log  = [0]  # mutable for closure

        from transformers import StoppingCriteria, StoppingCriteriaList

        class _ProgressLogger(StoppingCriteria):
            """Logs generation progress every 50 tokens — never actually stops."""
            def __call__(self, input_ids, scores, **kwargs):
                n_new = input_ids.shape[1] - n_input_tokens
                if n_new - _last_log[0] >= 50:
                    _last_log[0] = n_new
                    elapsed_gen  = round(time.perf_counter() - _gen_start, 1)
                    tok_per_s    = round(n_new / elapsed_gen, 2) if elapsed_gen > 0 else 0
                    pct          = round(n_new / QWEN_VL_LOCAL_MAX_TOKENS * 100)
                    log.info(
                        f"[QwenVL-Local] Generating ... {n_new}/{QWEN_VL_LOCAL_MAX_TOKENS} tokens "
                        f"({pct}%) — {tok_per_s} tok/s — {elapsed_gen}s elapsed"
                    )
                return False  # never stop early

        with torch.no_grad():
            output_ids = _qwen_vl_model.generate(
                **inputs,
                max_new_tokens=QWEN_VL_LOCAL_MAX_TOKENS,
                do_sample=False,
                temperature=None,
                top_p=None,
                repetition_penalty=1.05,
                num_beams=1,
                stopping_criteria=StoppingCriteriaList([_ProgressLogger()]),
            )

        n_generated = output_ids.shape[1] - n_input_tokens
        gen_elapsed = round(time.perf_counter() - _gen_start, 1)
        log.info(
            f"[QwenVL-Local] Generation complete — {n_generated} tokens in {gen_elapsed}s "
            f"({round(n_generated/gen_elapsed,2) if gen_elapsed>0 else 0} tok/s)"
        )

        # ── Decode only the newly generated tokens ────────────────────────
        generated_ids = [
            out[len(inp):]
            for inp, out in zip(inputs.input_ids, output_ids)
        ]
        raw_text = _qwen_vl_processor.batch_decode(
            generated_ids,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0].strip()
        log.info(f"[QwenVL-Local] Decoded output: {len(raw_text)} chars")
        if raw_text:
            log.info(f"[QwenVL-Local] Output preview (first 300 chars): {raw_text[:300]}")

    except Exception as exc:
        elapsed = round(time.perf_counter() - t0, 2)
        log.error(f"[QwenVL-Local] Inference failed after {elapsed}s: {exc}", exc_info=True)
        raise

    elapsed = round(time.perf_counter() - t0, 2)
    log.info(f"[QwenVL-Local] Inference complete in {elapsed}s — {len(raw_text)} chars generated")
    if not raw_text.strip():
        log.warning("[QwenVL-Local] Model returned empty string — possible OOM or token limit")

    # ── Parse JSON from model output ──────────────────────────────────────────
    log.info("[QwenVL-Local] Parsing JSON from model output ...")
    structured = _parse_json_output(raw_text)

    # ── Shared vision post-processing ─────────────────────────────────────────
    # The vision path bypasses semantic_extractor's _normalize_number /
    # _validate_extraction safety net (it parses its own JSON), so apply the
    # shared guards here: number normalization ("1,437" -> 1437) and the
    # deterministic VAT-hallucination guard (strip an invented vatRate when
    # subtotal == total). When reference_text (the PDF's native pdfplumber text)
    # is supplied by the service, the FULL cross-reference validation also runs
    # (nulls hallucinated VAT numbers, fixes currency, street-as-name). Wrapped so
    # post-processing can NEVER break extraction.
    try:
        from vision_postprocess import postprocess_vision_invoice
        structured = postprocess_vision_invoice(structured, reference_text=reference_text)
    except Exception as _pp_e:
        log.warning(f"[QwenVL-Local] postprocess skipped: {_pp_e}")

    if structured:
        items = len(structured.get("lineItems") or [])
        _issuer = structured.get("issuer") or {}
        _totals = structured.get("totals") or {}
        log.info(
            f"[QwenVL-Local] ✓ JSON parsed successfully — "
            f"invoice={structured.get('invoiceNumber')} "
            f"issuer={_issuer.get('name') if isinstance(_issuer, dict) else None} "
            f"items={items} "
            f"total={_totals.get('total') if isinstance(_totals, dict) else None} "
            f"currency={structured.get('currency')}"
        )
        # Log each line item for verification
        for li in (structured.get("lineItems") or []):
            log.info(
                f"[QwenVL-Local]   item: {li.get('description','?')[:40]} "
                f"qty={li.get('quantity')} "
                f"price={li.get('unitPrice')} "
                f"total={li.get('totalPrice')}"
            )
    else:
        log.warning(f"[QwenVL-Local] ✗ JSON parse failed")
        log.warning(f"[QwenVL-Local] Full raw output ({len(raw_text)} chars): {raw_text[:500]}")

    return {
        "text":       raw_text,
        "structured": structured,
        "latency_ms": round(elapsed * 1000, 1),
        "engine":     "qwen_vl_local",
    }


def extract_invoice_from_pdf_bytes(
        pdf_bytes: bytes,
        max_pages: int = 5,
        dpi: int = int(os.getenv("QWEN_VL_DPI", "96")),
        reference_text: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Convert PDF to images and run Qwen2.5-VL-3B on each page.
    Merges multi-page results: takes structured JSON from best page
    (most line items), concatenates raw text from all pages.

    `reference_text` (optional): the PDF's native pdfplumber text, threaded to the
    per-image extractor so the shared post-processor can validate against the real
    invoice text. Resolved once by the service from the same PDF bytes.

    Returns the same shape as extract_invoice_from_image plus:
      pages_processed: int
    """
    from pdf2image import convert_from_bytes

    log.info(f"[QwenVL-Local] Converting PDF ({len(pdf_bytes)} bytes) to images (dpi={dpi}) ...")
    t_conv = time.perf_counter()
    images = convert_from_bytes(pdf_bytes, dpi=dpi)
    pages  = images[:max_pages]
    conv_elapsed = round(time.perf_counter() - t_conv, 2)
    log.info(f"[QwenVL-Local] PDF→image: {len(images)} page(s) converted in {conv_elapsed}s — using {len(pages)} page(s)")
    for i, img in enumerate(pages):
        mpx = round(img.size[0]*img.size[1]/1e6, 1)
        est_tokens = int(mpx * 1400)  # ~1400 tokens per Mpx empirically
        est_min    = round(est_tokens / 0.6 / 60, 1)  # 0.6 tok/s on CPU
        log.info(
            f"[QwenVL-Local] Page {i+1}: {img.size[0]}x{img.size[1]}px "
            f"({mpx} Mpx) → est. ~{est_tokens} input tokens → ~{est_min} min inference"
        )

    all_text   = []
    best_result: Optional[Dict[str, Any]] = None
    best_items = -1

    for i, img in enumerate(pages):
        log.info(f"[QwenVL-Local] Processing page {i + 1}/{len(pages)} ...")
        try:
            result     = extract_invoice_from_image(img, reference_text=reference_text)
            all_text.append(result.get("text", ""))
            structured = result.get("structured") or {}
            n_items    = len(structured.get("lineItems") or [])

            # Keep the page with the most line items as primary result
            if n_items > best_items:
                best_items  = n_items
                best_result = result
        except Exception as exc:
            log.warning(f"[QwenVL-Local] Page {i + 1} failed: {exc}")
            continue

    if best_result is None:
        raise RuntimeError("Qwen2.5-VL-3B failed on all pages")

    best_result["text"]            = "\n\n".join(t for t in all_text if t)
    best_result["pages_processed"] = len(pages)
    return best_result


# ── JSON parsing helpers ──────────────────────────────────────────────────────

def _parse_json_output(text: str) -> Optional[Dict[str, Any]]:
    """
    Extract and parse JSON from model output.
    Handles: raw JSON, ```json fences, partial JSON with leading text.
    """
    if not text:
        return None

    # Strip markdown code fences
    cleaned = re.sub(r'^```(?:json)?\s*', '', text.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r'\s*```$', '', cleaned.strip())

    # Try direct parse first
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Find first { ... } block
    m = re.search(r'\{.*\}', cleaned, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass

    # ── Repair truncated JSON ────────────────────────────────────────────
    # CPU inference can hit the token cap mid-object, leaving the JSON
    # unterminated (e.g. ends at '"provider'). The output is otherwise valid,
    # so we attempt to close it: terminate any open string, then balance the
    # remaining brackets. This salvages a near-complete extraction instead of
    # discarding it (which would otherwise fall through to a regex parser that
    # mis-reads the raw JSON text).
    repaired = _repair_truncated_json(cleaned)
    if repaired is not None:
        log.warning("[QwenVL-Local] JSON was truncated — repaired and parsed")
        return repaired

    return None


def _repair_truncated_json(text: str) -> Optional[Dict[str, Any]]:
    """
    Best-effort repair of JSON cut off mid-generation. Closes an unterminated
    trailing string, strips a dangling key/comma, and appends the missing
    closing brackets in the right order. Returns a dict on success, else None.
    """
    start = text.find("{")
    if start == -1:
        return None
    s = text[start:]

    stack = []          # holds '{' and '[' in nesting order
    in_string = False
    escaped = False
    last_significant = -1   # index of last char that completed a value
    for i, ch in enumerate(s):
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            if not in_string:
                last_significant = i
            continue
        if in_string:
            continue
        if ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            last_significant = i
        elif ch.isdigit() or ch in "truefalsenul.-+":
            last_significant = i

    fixed = s
    if in_string:
        fixed = fixed + '"'
        last_significant = len(fixed) - 1
    else:
        fixed = fixed[: last_significant + 1] if last_significant >= 0 else fixed

    fixed = re.sub(r',\s*$', '', fixed.rstrip())
    fixed = re.sub(r',\s*"[^"]*"\s*:?\s*$', '', fixed.rstrip())

    for opener in reversed(stack):
        fixed += "}" if opener == "{" else "]"

    try:
        result = json.loads(fixed)
        return result if isinstance(result, dict) else None
    except json.JSONDecodeError:
        return None