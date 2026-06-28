"""
semantic_extractor.py
Semantic invoice field extraction via a local GGUF model running inside the
container using llama-cpp-python (CPU inference, no GPU, no Ollama needed).

The model is downloaded once to the Docker volume (/root/.cache/llama) on
first use and reused on every subsequent container start.

Recommended models (auto-downloaded from HuggingFace):
  SEMANTIC_MODEL=qwen2.5:3b   → Qwen/Qwen2.5-3B-Instruct-GGUF  Q4_K_M  (~2 GB)
  SEMANTIC_MODEL=qwen2.5:7b   → Qwen/Qwen2.5-7B-Instruct-GGUF  Q4_K_M  (~4.5 GB)
  SEMANTIC_MODEL=phi3.5:mini  → microsoft/Phi-3.5-mini-instruct-gguf Q4  (~2.5 GB)

Environment variables:
  SEMANTIC_MODEL    = qwen2.5:3b   (model shortname, see MODEL_REGISTRY below)
  SEMANTIC_ENABLED  = 1            (set to 0 to disable, use regex fallback)
  SEMANTIC_TIMEOUT  = 120          (seconds, CPU inference can be slow)
  LLAMA_CACHE_DIR   = /root/.cache/llama
  LLAMA_N_CTX       = 4096         (context window)
  LLAMA_N_THREADS   = 4            (CPU threads for inference)
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional

log = logging.getLogger("semantic_extractor")


# ══════════════════════════════════════════════════════════════════════════════
# ── MinerU HTML-table flattener ──────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════
#
# MinerU's pipeline backend emits tabular data (line items, totals) as HTML
# tables, e.g.:
#     <table><tr><td rowspan=1 colspan=4>ΕΙΔΟΣ</td>...</tr>
#            <tr><td>ΕΙΔ0000003</td><td>ΕΠΑΓΓΕΛΜΑΤΙΚΕΣ ΚΑΡΤΕΣ</td><td>TEM</td>
#                <td>300</td><td>0,100</td>...</tr></table>
#
# The rowspan/colspan markup is enormous token bloat: a 5-value row becomes
# ~200 chars of HTML. On a small CPU LLM this (a) wastes the limited context
# window so the TOTALS rows at the bottom get cut by the char cap, and (b)
# buries the actual values under attribute noise so the model extracts nothing
# (observed: 0 line items, €0 totals on a valid Greek τιμολόγιο).
#
# This flattener converts each <table> into clean pipe-delimited rows the
# semantic extractor already reads well (same shape as columnar pdfplumber
# output):
#     ΕΙΔ0000003 | ΕΠΑΓΓΕΛΜΑΤΙΚΕΣ ΚΑΡΤΕΣ | TEM | 300 | 0,100 | ...
#
# Surya/pdfplumber output contains NO <table> tags, so flatten_html_tables()
# is a no-op for those engines — the MinerU path is the only one affected.

def _flatten_one_table(table_html: str) -> str:
    """Convert a single <table>...</table> block to pipe-delimited text rows."""
    rows_out = []
    # Each <tr>...</tr> is one row
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL | re.IGNORECASE):
        cells = []
        # Each <td ...>value</td> (or <th>) is one cell; ignore the attributes
        for cell in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', tr, re.DOTALL | re.IGNORECASE):
            # Strip any nested tags (e.g. <br>, <b>) and collapse whitespace
            txt = re.sub(r'<[^>]+>', ' ', cell)
            txt = re.sub(r'\s+', ' ', txt).strip()
            cells.append(txt)
        # Drop fully-empty rows; join non-empty cells with " | "
        if any(c for c in cells):
            rows_out.append(" | ".join(cells))
    return "\n".join(rows_out)


def flatten_html_tables(text: str) -> str:
    """
    Replace every <table>...</table> block in `text` with a flattened,
    pipe-delimited plain-text version. Non-table text is left untouched.
    No-op when the text contains no <table> tags (Surya/pdfplumber paths).

    MinerU emits line items / totals as HTML tables whose rowspan/colspan markup
    (a) wastes the small CPU LLM's context window so the TOTALS rows get cut by
    the char cap, and (b) buries the actual values under attribute noise
    (observed: 0 line items + €0 totals on a valid τιμολόγιο). Flattening to
    "val | val | val" rows gives the extractor the columnar format it already
    reads well.
    """
    if not text or "<table" not in text.lower():
        return text
    try:
        def _repl(m):
            # Surround with newlines so it reads as its own block
            return "\n" + _flatten_one_table(m.group(0)) + "\n"
        out = re.sub(r'<table[^>]*>.*?</table>', _repl, text,
                     flags=re.DOTALL | re.IGNORECASE)
        # Also strip any stray markdown image embeds MinerU adds (![](....jpg))
        # — they carry no invoice data and waste context budget.
        out = re.sub(r'!\[\]\([^)]*\)', '', out)
        # Collapse the blank lines the removals leave behind
        out = re.sub(r'\n{3,}', '\n\n', out)
        log.info(f"[Semantic] Flattened HTML table(s): {len(text)} → {len(out)} chars")
        return out
    except Exception as e:  # noqa: BLE001
        log.warning(f"[Semantic] HTML table flatten failed (using raw text): {e}")
        return text


# ── Configuration ─────────────────────────────────────────────────────────────
SEMANTIC_ENABLED  = os.getenv("SEMANTIC_ENABLED", "1") == "1"
SEMANTIC_MODEL    = os.getenv("SEMANTIC_MODEL", "qwen2.5:3b")
SEMANTIC_TIMEOUT  = int(os.getenv("SEMANTIC_TIMEOUT", "120"))
LLAMA_CACHE_DIR   = os.getenv("LLAMA_CACHE_DIR", "/root/.cache/llama")
LLAMA_N_CTX       = int(os.getenv("LLAMA_N_CTX", "4096"))
LLAMA_N_THREADS   = int(os.getenv("LLAMA_N_THREADS", "4"))


# ── Mixed-format numeric parsing ───────────────────────────────────────────────
# Invoices arrive in BOTH European ("1.234,56") and US/UK ("1,234.56") number
# formats, and integer quantities frequently carry a thousands separator
# ("1.437" or "1,437" meaning 1437). The previous code used
# `float(str(v).replace(",", "."))`, which blindly treats every comma as a
# decimal point — so "1,437" became 1.437 (the multi-unit quantity bug) and EU
# prices like "1.234,56" were corrupted too.
#
# `_normalize_number()` infers thousands-vs-decimal per value from the
# separators present, so no global locale assumption is needed. `integer_hint`
# biases the ambiguous single-separator + 3-trailing-digit case toward THOUSANDS,
# which is correct for quantities (whole counts).

def _normalize_number(v, *, default: Optional[float] = 0.0, integer_hint: bool = False) -> Optional[float]:
    """Locale-agnostic numeric parser for mixed EU/US invoice formats.

    Handles both '1.234,56' (EU) and '1,234.56' (US), plain integers with a
    thousands separator ('1.437' or '1,437' -> 1437), decimals ('1,5' -> 1.5),
    space/NBSP thousands ('1 234,56'), currency symbols, and negatives
    (leading '-' or accounting parentheses — important for credit notes).

    Returns `default` when the value is missing or unparseable. `default=None`
    preserves "not specified" semantics (used for vatRate).

    `integer_hint=True` biases the ambiguous single-separator + 3-trailing-digit
    case toward THOUSANDS (correct for quantities, which are whole counts).
    """
    if v is None:
        return default
    s = str(v).strip()
    if not s:
        return default

    # Negative via accounting parentheses: (123,45) -> -123,45
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1].strip()

    # Keep only digits and separators; drop currency symbols, letters, spaces,
    # NBSP (which act as thousands). Capture a leading minus sign.
    cleaned = []
    for i, ch in enumerate(s):
        if ch.isdigit() or ch in ".,":
            cleaned.append(ch)
        elif ch == "-" and i == 0:
            neg = True
    s = "".join(cleaned)
    if not s or s in (".", ","):
        return default

    has_dot = "." in s
    has_comma = "," in s

    try:
        if has_dot and has_comma:
            # The LAST-occurring separator is the decimal; the other is thousands.
            if s.rfind(",") > s.rfind("."):
                s = s.replace(".", "").replace(",", ".")   # EU: comma decimal
            else:
                s = s.replace(",", "")                       # US: dot decimal
            num = float(s)
        elif has_comma:
            num = _resolve_single_sep(s, ",", integer_hint)
        elif has_dot:
            num = _resolve_single_sep(s, ".", integer_hint)
        else:
            num = float(s)
    except (ValueError, TypeError):
        return default

    return -num if neg else num


def _resolve_single_sep(s: str, sep: str, integer_hint: bool) -> float:
    """One separator type present — decide thousands vs decimal."""
    parts = s.split(sep)
    if len(parts) > 2:
        # Multiple occurrences -> thousands grouping: "1,234,567" -> 1234567
        return float("".join(parts))
    # Exactly one separator: parts = [intpart, fracpart]
    intpart, frac = parts[0], parts[1]
    # A leading-zero integer part ("0.645", "0,750", ".645") is NEVER a thousands
    # group — you never write 645 as "0,645". Treating it as thousands corrupted
    # genuine sub-unit prices (0.645 -> 645). Thousands grouping requires a
    # non-zero 1-3 digit lead ("1,437", "12,500").
    leading_zero = (intpart == "" or intpart == "0")
    if len(frac) == 3 and not leading_zero and (integer_hint or len(intpart) <= 3):
        # 3 trailing digits, single separator -> thousands group: "1,437" -> 1437
        return float(intpart + frac)
    # 1, 2, or >3 trailing digits (or leading-zero) -> decimal
    return float(intpart + "." + frac)


# ── Model registry ─────────────────────────────────────────────────────────────
# shortname → (hf_repo, gguf_filename)
# All are Q4_K_M quantized — good balance of quality and RAM usage
MODEL_REGISTRY: Dict[str, tuple] = {
    "qwen2.5:3b":   ("Qwen/Qwen2.5-3B-Instruct-GGUF",
                     "qwen2.5-3b-instruct-q4_k_m.gguf"),
    "qwen2.5:7b":   ("Qwen/Qwen2.5-7B-Instruct-GGUF",
                     "qwen2.5-7b-instruct-q4_k_m.gguf"),
    "phi3.5:mini":  ("bartowski/Phi-3.5-mini-instruct-GGUF",
                     "Phi-3.5-mini-instruct-Q4_K_M.gguf"),
    "llama3.2:3b":  ("bartowski/Llama-3.2-3B-Instruct-GGUF",
                     "Llama-3.2-3B-Instruct-Q4_K_M.gguf"),
    "mistral:7b":   ("TheBloke/Mistral-7B-Instruct-v0.2-GGUF",
                     "mistral-7b-instruct-v0.2.Q4_K_M.gguf"),
}

# ── Extraction prompt ──────────────────────────────────────────────────────────
SYSTEM_PROMPT = (
    "You are a precise invoice data extraction engine. "
    "Extract structured data from invoice text and return ONLY valid JSON. "
    "No explanation, no markdown, ONLY the JSON object. "
    "For missing fields use null. For amounts use numbers, not strings."
)

EXTRACTION_PROMPT = """Extract all invoice fields from the text below.

Return a JSON object with EXACTLY this structure:
{
  "invoiceNumber": "string or null",
  "invoiceDate": "string or null",
  "orderNumber": "string or null",
  "currency": "3-letter ISO code detected from invoice symbols ($→USD, €→EUR, £→GBP, лв→BGN, ¥→JPY/CNY, ₪→ILS). NEVER default to EUR.",
  "paymentMethod": "string or null",
  "issuer": {
    "name": "string or null",
    "vatNumber": "string or null",
    "taxId": "string or null",
    "registrationNumber": "string or null",
    "address": "string or null",
    "city": "string or null",
    "postCode": "string or null",
    "country": "string or null",
    "doy": "string or null",
    "profession": "string or null",
    "manager": "string or null",
    "phone": "string or null",
    "email": "string or null",
    "iban": "string or null",
    "swift": "string or null",
    "bank": "string or null"
  },
  "recipient": {
    "name": "string or null",
    "contactPerson": "string or null",
    "vatNumber": "string or null",
    "taxId": "string or null",
    "registrationNumber": "string or null",
    "address": "string or null",
    "city": "string or null",
    "postCode": "string or null",
    "country": "string or null",
    "doy": "string or null",
    "manager": "string or null",
    "branch": "string or null",
    "phone": "string or null",
    "email": "string or null"
  },
  "lineItems": [
    {
      "description": "string",
      "supplierCode": "string or null",
      "quantity": 1,
      "unit": "string or null",
      "unitPrice": 0.0,
      "totalPrice": 0.0,
      "vatRate": null
    }
  ],
  "subtotal": "REQUIRED number — the Sub-Total / Net-Total amount from the invoice (e.g. 745.65). null only if no subtotal line exists on the invoice.",
  "vatAmount": "REQUIRED number — the VAT / Tax amount (e.g. 0.00 for tax-free, 178.96 for 24% VAT). null only if no VAT line exists.",
  "vatRate": null,
  "total": "REQUIRED number — the final Invoice Total / Grand Total amount (e.g. 745.65). MOST IMPORTANT field to extract. Never leave null if any total appears on the invoice.",
  "payableAmount": null,
  "withholdingTax": null,
  "mark": "string or null"
}

Rules:
- issuer = company ISSUING the invoice (seller/supplier at top of document)
- recipient = company RECEIVING the invoice (buyer/client — "To:" / "Bill To:" / "Πελάτης")
- ΑΦΜ = vatNumber, ΔΟΥ = doy, ΜΑΡΚ = mark (Greek fields)
- Include ALL product/service rows in lineItems — never omit items
- Do NOT include header, subtotal, or total rows in lineItems
- Do NOT use a COLUMN HEADER as a line-item description. Greek table headers like
  "Α/Α" or "ΑΙΑ" (row-number), "Κωδ." (code), "Περιγραφή" (description),
  "Ποσότητα"/"Μ.Μ." (qty/unit), "Τιμή"/"Αξία"/"ΦΠΑ" are HEADERS, never products.
  If the only candidate description is one of these header words, the row is the
  header row — skip it. A real line item has an actual product/service name.
- lineItems[].description must be ONLY the product/service name. Do NOT append the
  quantity, unit price, or amount to it. E.g. for a row "Max plan - 5x 1 €90.00
  €90.00", description="Max plan - 5x", quantity=1, unitPrice=90.00, totalPrice=90.00.
  A date sub-line under the description (e.g. "Apr 30–May 31, 2026") is a service
  period, not a separate line item — do not create a row for it.

- CRITICAL — TWO-COLUMN LAYOUTS (issuer left, recipient right on the SAME line):
  Many invoices print the issuer (seller) and recipient (buyer) side by side, so
  the extracted TEXT merges both columns onto one line. For example:
      "Anthropic, PBC                 Bill to"
      "548 Market Street              GEORGIOS GEORGAKAKOS"
      "PMB 90375                      TIRINTHOS 30 ANO GLYFADA"
      "San Francisco, CA 94104        16561 Athens"
      "United States                  Greece"
  Here the LEFT side ("548 Market Street", "PMB 90375", "San Francisco, CA 94104",
  "United States") all belongs to the ISSUER, and the RIGHT side ("GEORGIOS
  GEORGAKAKOS", "TIRINTHOS 30 ANO GLYFADA", "16561 Athens", "Greece") all belongs
  to the RECIPIENT. Split each merged line at the large gap and assign the left
  part to issuer and the right part to recipient. NEVER mix a street/city/postcode
  from one party into the other:
    • issuer.address must be the issuer's OWN street (e.g. "548 Market Street"),
      NOT a "Payment address" / "P.O. Box" block lower on the page.
    • recipient.address must contain ONLY the recipient's street, NOT the issuer's.
    • Do NOT merge two postcodes (e.g. "94104 16561"); keep each party's own.

- CRITICAL — PAYMENT ADDRESS IS NOT THE ISSUER ADDRESS:
  A "PAYMENT ADDRESS" / "P.O. Box" block (often near "send checks to ...") is a
  remittance address, NOT the issuer's registered address. Use the issuer's
  letterhead address (top of the invoice) for issuer.address. Never put the P.O.
  Box / payment block into issuer.address, issuer.city, or issuer.doy.

- CRITICAL — VAT NUMBER OWNERSHIP:
  A VAT line like "GR VAT EL121194734" printed inside or directly under the
  recipient (buyer) block belongs to the RECIPIENT, not the issuer — assign it to
  recipient.vatNumber. Strip any label words ("GR VAT", "VAT", "ΑΦΜ", "Tax ID")
  and keep ONLY the identifier itself (e.g. "EL121194734"). Do NOT copy the label
  into the value. If a party has no VAT number printed, set it to null — never
  borrow the other party's VAT number.

- doy / tax office is a NAME (e.g. a Greek ΔΟΥ office), never a date. If you cannot
  find a tax-office name, set doy to null. NEVER put an invoice date in doy.

- CRITICAL — TOTALS EXTRACTION (subtotal, vatAmount, total):
  These three fields are REQUIRED and you MUST extract them whenever they appear on the invoice. Look for these patterns (in any language):
      "Sub-Total:" / "Subtotal" / "Net Total" / "Καθαρό Σύνολο" / "Net Amount"  → subtotal
      "Tax:" / "VAT:" / "ΦΠΑ:" / "Tax Amount" / "VAT Amount"                  → vatAmount
      "Invoice Total" / "Grand Total" / "Total Due" / "Σύνολο" / "Total (USD)" → total
  Strip currency symbols ($, €, £, лв, ¥, ₪) and parse as a NUMBER (e.g. "$745.65" → 745.65).
  Example — invoice text contains:
      Sub-Total: $745.65
      Tax: $0.00
      Invoice Total (USD): $745.65
  → subtotal=745.65, vatAmount=0.00, total=745.65
  If a value is $0.00 or 0.00 it is STILL a valid number — set the field to 0, never null. Only use null when the invoice does NOT show that line at all.

  CRITICAL — GREEK COLUMNAR TOTALS ROW (no label-colon!): Many Greek τιμολόγια do
  NOT print "ΦΠΑ:" followed by a value. Instead the totals appear as a single ROW
  of numbers sitting UNDER column headers. The header row reads (left→right):
      Τιμή (€)  Έκπτωση (€)  Αξία (€)   ...   ΦΠΑ %   ΦΠΑ (€)   Τελ. Αξία (€)
  and the values row is usually labelled "Σύνολα" (totals), e.g.:
      Σύνολα   0,00   173,89   ...   24   41,73   215,62
  Map each value to the field DIRECTLY BELOW ITS COLUMN HEADER:
      • "Αξία (€)" / "Καθαρή Αξία" column          → subtotal   (here 173,89)
      • "ΦΠΑ (€)" / "Φ.Π.Α." column (the EURO one) → vatAmount  (here 41,73)
      • "ΦΠΑ %" column                              → vatRate    (here 24 — a percent, NOT euros)
      • "Τελ. Αξία (€)" / "ΠΛΗΡΩΤΕΟ" / "Σύνολο"     → total      (here 215,62)
  DO NOT confuse the two ΦΠΑ columns: "ΦΠΑ %" is the rate (24), "ΦΠΑ (€)" is the
  euro amount (41,73). The vatAmount is the EURO column, never the percent.
  DO NOT put the grand total (215,62) into both subtotal AND total — the subtotal is
  the smaller "Αξία" figure (173,89). If you only see one big number, the net (Αξία)
  is total minus the ΦΠΑ (€) value: subtotal = total − vatAmount.
  A standalone "Πληρωτέο (€): 215,62" line confirms the grand total.
  SANITY CHECK before answering: subtotal + vatAmount must equal total
  (173,89 + 41,73 = 215,62). If your numbers don't reconcile, re-read the Σύνολα row.

- CRITICAL — CURRENCY DETECTION:
  Detect the invoice currency from these signals in the text:
      "$"            → USD  (e.g. "Invoice Total (USD): $745.65", "$0.45 Per Unit")
      "€"            → EUR  (e.g. "€87.51")
      "£"            → GBP
      "лв" or "BGN"  → BGN  (Bulgarian lev)
      "¥"            → JPY (or CNY for Chinese context)
      "₪"            → ILS  (Israeli shekel)
  Look at all amounts on the invoice. If they all use "$" → currency=USD. If they all use "€" → currency=EUR. NEVER default to EUR — only use EUR if you see "€" symbols or "EUR" text in the invoice.

- VAT NUMBERS: Copy issuer.vatNumber and recipient.vatNumber EXACTLY as printed on the invoice (including country prefix like EL/BG/DE/IT if printed). If the invoice does NOT show an EU-format VAT number, set vatNumber to null. NEVER invent or guess a VAT number, country prefix, or digits. If the invoice only shows a non-EU identifier (e.g. Israeli "Company no. 514440874", US EIN), put that value in taxId and leave vatNumber as null.

- VAT RATE: vatRate is a percentage NUMBER as printed on the invoice (typical values: 0, 6, 13, 24 for Greece; 19, 20, 21, 23, 25 for other EU countries — NOT 0.24). If the invoice does NOT print a VAT rate for a line (e.g. export/service invoices that show no VAT at all), set vatRate to null. NEVER default to 24 — leave it null when missing.

- CRITICAL — RECIPIENT NAME DISAMBIGUATION:
  When the recipient block ("To" / "Bill To" / "Πελάτης" / "Customer") contains MULTIPLE lines like:
      Bill to
      [individual person name]         ← person name (an individual)
      [company name + corporate suffix] ← LEGAL ENTITY with corporate suffix
      [street address]
  you MUST set recipient.name to the line that contains a corporate suffix, even if a person name appears first. Corporate suffixes include:
      EOOD, OOD, LTD, LIMITED, GMBH, AG, SA, S.A., AE, ΑΕ, AEBE, ΑΕΒΕ,
      EPE, ΕΠΕ, IKE, ΙΚΕ, OE, ΟΕ, BV, NV, INC, LLC, CORP, SRL, SARL, KG, PC
  Put the person name in recipient.contactPerson (or null if no person is named).
  If no corporate-suffix line exists in the block, use the most company-like line as recipient.name.
  CRITICAL: The placeholders above are illustrative only — never copy them into the output. Extract the actual values from THIS invoice text.

Invoice text:
---
{TEXT}
---

JSON:"""


# ── Model downloader ───────────────────────────────────────────────────────────

def _get_model_path(model_key: str) -> Optional[Path]:
    """
    Return the local path to the GGUF model file.
    Downloads from HuggingFace if not already cached.
    """
    if model_key not in MODEL_REGISTRY:
        log.error(f"[Semantic] Unknown model key: {model_key}. "
                  f"Available: {list(MODEL_REGISTRY.keys())}")
        return None

    repo, filename = MODEL_REGISTRY[model_key]
    cache_dir = Path(LLAMA_CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    model_path = cache_dir / filename

    if model_path.exists():
        log.info(f"[Semantic] Model cached: {model_path} ({model_path.stat().st_size // 1_000_000} MB)")
        return model_path

    # Download from HuggingFace
    log.info(f"[Semantic] Downloading {filename} from {repo} ...")
    log.info(f"[Semantic] This happens once. File will be saved to {model_path}")
    try:
        from huggingface_hub import hf_hub_download
        downloaded = hf_hub_download(
            repo_id=repo,
            filename=filename,
            cache_dir=str(cache_dir),
            local_dir=str(cache_dir),
        )
        log.info(f"[Semantic] Download complete: {downloaded}")
        return Path(downloaded)
    except Exception as e:
        log.error(f"[Semantic] Download failed: {e}")
        return None


# ── SemanticExtractor ─────────────────────────────────────────────────────────

class SemanticExtractor:
    """
    Runs a GGUF quantized LLM inside the container via llama-cpp-python
    for semantic invoice field extraction.

    Falls back to the regex-based vlm_invoice_parser.py if:
    - llama-cpp-python is not installed
    - The model file is not available
    - Inference fails for any reason
    """

    def __init__(self, model_key: str = SEMANTIC_MODEL):
        self.model_key = model_key
        self._llm: Any = None          # llama_cpp.Llama instance (lazy-loaded)
        self._load_attempts = 0        # bounded retries (was a permanent one-shot latch)
        self._available: Optional[bool] = None

    # ── Public API ────────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        """Check if the LLM is ready (model loaded or loadable)."""
        if self._available is not None:
            return self._available
        if not SEMANTIC_ENABLED:
            self._available = False
            return False
        try:
            import llama_cpp  # noqa: F401
            model_path = _get_model_path(self.model_key)
            self._available = model_path is not None and model_path.exists()
        except ImportError:
            log.warning("[Semantic] llama-cpp-python not installed — regex fallback active")
            self._available = False
        return self._available

    def is_loaded(self) -> bool:
        """Check if model is currently loaded in memory."""
        return self._llm is not None

    def load(self) -> bool:
        """
        Load the GGUF model into memory (lazy — called on first extract()).
        Returns True on success, False on failure.

        A failed load is NOT permanent: we allow a bounded number of retries on
        subsequent invoices, because the first failure is often transient (model
        file still being written after deploy, or a momentary memory spike while
        another container loads). Previously a single failure latched regex
        fallback forever, which is why a bad first attempt poisoned every later
        invoice.
        """
        if self._llm is not None:
            return True
        _max_attempts = int(os.getenv("SEMANTIC_LOAD_MAX_ATTEMPTS", "5"))
        if self._load_attempts >= _max_attempts:
            return False
        self._load_attempts += 1

        if not self.is_available():
            return False

        model_path = _get_model_path(self.model_key)
        if not model_path:
            return False

        try:
            from llama_cpp import Llama
            log.info(f"[Semantic] Loading {self.model_key} from {model_path} "
                     f"(attempt {self._load_attempts}/{_max_attempts}) ...")
            t0 = time.perf_counter()
            self._llm = Llama(
                model_path    = str(model_path),
                n_ctx         = LLAMA_N_CTX,
                n_threads     = LLAMA_N_THREADS,
                n_gpu_layers  = 0,          # CPU only
                verbose       = False,
                # use_mlock locks the full model into RAM. On a memory-tight box
                # (e.g. ~22/30GB with qwen fp32 + gemma also resident) the lock can
                # fail or hang the load, after which extract() falls to regex
                # forever. Default OFF; opt in with SEMANTIC_USE_MLOCK=1 only when
                # there's comfortable headroom.
                use_mlock     = os.getenv("SEMANTIC_USE_MLOCK", "0") == "1",
            )
            elapsed = round(time.perf_counter() - t0, 1)
            log.info(f"[Semantic] Model loaded in {elapsed}s "
                     f"(ctx={LLAMA_N_CTX}, threads={LLAMA_N_THREADS})")
            return True
        except Exception as e:
            log.error(f"[Semantic] Failed to load model: {e}")
            self._llm = None
            return False

    def extract(self, ocr_text: str) -> Dict[str, Any]:
        """
        Extract structured invoice fields from raw OCR text.
        Returns a dict compatible with vlm_invoice_parser.parse_invoice_fields().
        Falls back to regex parser if LLM is unavailable.
        """
        if not SEMANTIC_ENABLED or not self.is_available():
            return self._regex_fallback(ocr_text)

        if self._llm is None and not self.load():
            return self._regex_fallback(ocr_text)

        t0 = time.perf_counter()
        try:
            raw_json = self._run_inference(ocr_text)
            result   = self._parse_response(raw_json)

            # ── Validation pass — cross-reference LLM output against raw OCR text
            # Catches hallucinations (fabricated VAT numbers, fake totals),
            # corrects recipient name swaps (person ↔ company), and flags
            # internally-inconsistent totals.
            validation_t0 = time.perf_counter()
            result = _validate_extraction(result, ocr_text)
            result["_validation_elapsed"] = round(time.perf_counter() - validation_t0, 3)

            elapsed  = round(time.perf_counter() - t0, 1)
            log.info(
                f"[Semantic] Extracted in {elapsed}s — "
                f"issuer={result.get('issuer', {}).get('name')} "
                f"items={len(result.get('lineItems', []))} "
                f"total={result.get('total')} "
                f"validation_issues={len(result.get('_validation_issues', []))}"
            )
            result["_semantic_elapsed"] = elapsed
            result["_semantic_model"]   = self.model_key
            return result
        except Exception as e:
            log.error(f"[Semantic] Inference failed: {e} — falling back to regex")
            return self._regex_fallback(ocr_text)

    # ── Inference ─────────────────────────────────────────────────────────────

    def _run_inference(self, text: str) -> str:
        """Run the GGUF model and return the raw JSON string."""
        # MinerU emits line items/totals as HTML tables — flatten them to clean
        # pipe-delimited rows first. This both (a) removes rowspan/colspan bloat
        # so the totals rows fit under the cap, and (b) gives the LLM the
        # columnar format it extracts reliably. No-op for Surya/pdfplumber text
        # (which contains no <table> tags), so the existing paths are unaffected.
        text = flatten_html_tables(text)
        # Cap text to stay within the context window. Raised 5000 → 8000 because
        # n_ctx is 4096 tokens (~12-16k chars of mixed Greek/Latin) and the old
        # 5000-char cap was truncating multi-section invoices BEFORE the totals
        # block at the bottom — the single most important data to extract. The
        # flatten step above frees enough budget that the totals now survive.
        capped = text[:8000]
        prompt = EXTRACTION_PROMPT.replace("{TEXT}", capped)

        # Use chat completion format (works for all instruct models)
        response = self._llm.create_chat_completion(
            messages=[
                {"role": "system",  "content": SYSTEM_PROMPT},
                {"role": "user",    "content": prompt},
            ],
            max_tokens  = 1500,
            temperature = 0.0,    # deterministic
            stop        = ["```", "\n\n\n"],
        )
        return response["choices"][0]["message"]["content"]

    # ── Response parsing ──────────────────────────────────────────────────────

    def _parse_response(self, raw: str) -> Dict[str, Any]:
        """Parse and validate the LLM JSON response."""
        text = raw.strip()

        # Strip markdown fences
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```\s*$",      "", text)

        # Extract outermost JSON object
        start = text.find("{")
        end   = text.rfind("}")
        if start == -1 or end <= start:
            raise ValueError(f"No JSON in response: {text[:200]}")
        data = json.loads(text[start:end + 1])

        # Normalise numeric fields (mixed EU/US formats via _normalize_number).
        # default=None: a present-but-unparseable monetary field becomes null
        # (unchanged behaviour), never 0.
        for field in ("subtotal", "vatAmount", "total", "payableAmount",
                      "withholdingTax", "vatRate"):
            v = data.get(field)
            if v is not None:
                data[field] = _normalize_number(v, default=None)

        # Normalise line items
        clean_items = []
        for li in (data.get("lineItems") or []):
            if not isinstance(li, dict):
                continue
            # Numeric coercion — fields that should default to 0 if missing/invalid.
            # quantity uses integer_hint so "1,437"/"1.437" -> 1437 (a count),
            # not 1.437. Prices parse mixed EU/US formats correctly too.
            for f in ("quantity", "unitPrice", "totalPrice"):
                v = li.get(f)
                if v is not None:
                    li[f] = _normalize_number(v, default=0.0, integer_hint=(f == "quantity"))
            # vatRate: extract-only policy. Coerce to float if a value is present,
            # but if the LLM returned null OR conversion fails, preserve null —
            # NEVER synthesize 0 (or 24). This lets the Node layer skip VAT
            # calculation entirely for invoices that don't print a VAT rate.
            # default=None keeps that null-preservation semantics.
            v = li.get("vatRate")
            if v is not None:
                li["vatRate"] = _normalize_number(v, default=None)
            li.setdefault("description",  "")
            li.setdefault("supplierCode", "")
            li.setdefault("quantity",     1.0)
            li.setdefault("unit",         "EA")
            li.setdefault("unitPrice",    0.0)
            li.setdefault("totalPrice",   0.0)
            li.setdefault("vatRate",      None)   # null = "not specified on invoice"
            # Currency inheritance — never default to EUR. If the document-level
            # currency is null/missing, the line item also has no currency yet
            # (the TypeScript resolveCurrency() resolver will fill it from OCR).
            li.setdefault("currency",     data.get("currency"))
            if li["description"] or li["totalPrice"]:
                clean_items.append(li)
        data["lineItems"] = clean_items

        # Populate legacy keys for backward compat
        issuer    = data.get("issuer")    or {}
        recipient = data.get("recipient") or {}
        data["supplier"]        = issuer.get("name")
        data["supplierAddress"] = issuer.get("address")
        data["supplierVat"]     = issuer.get("vatNumber")
        data["client"]          = recipient.get("name")
        data["clientVat"]       = recipient.get("vatNumber")

        # Confidence score
        score = 80
        if clean_items:           score += 10
        if data.get("total"):     score += 5
        if issuer.get("name"):    score += 3
        if recipient.get("name"): score += 2
        data["confidence"]          = min(score, 100)
        data["_extraction_method"]  = "semantic_llm"

        return data

    # ── Regex fallback ────────────────────────────────────────────────────────

    def _regex_fallback(self, text: str) -> Dict[str, Any]:
        """Use the regex parser when LLM is unavailable."""
        try:
            from vlm_invoice_parser import parse_invoice_fields
            result = parse_invoice_fields(text)
            result["_extraction_method"] = "regex_fallback"
            return result
        except Exception as e:
            log.error(f"[Semantic] Regex fallback failed: {e}")
            return {
                "lineItems":          [],
                "issuer":             {},
                "recipient":          {},
                "confidence":         0,
                "_extraction_method": "failed",
            }


# ══════════════════════════════════════════════════════════════════════════════
# ── Validation pass ──────────────────────────────────────────────────────────
# ══════════════════════════════════════════════════════════════════════════════
#
# Post-processing layer that runs after the LLM produces its JSON. Cross-
# references each extracted field against the raw OCR text to catch the most
# common failure modes:
#
#   1. Hallucinated VAT numbers (LLM copies prompt example values verbatim)
#   2. Recipient name = contact person instead of the legal entity
#   3. Internally inconsistent totals (subtotal + VAT ≠ grand total)
#   4. Line-item sum doesn't reconcile with subtotal
#   5. VAT rates not present in the source text
#   6. Currency mismatch (EUR claimed but only BGN/USD signs visible)
#   7. Issuer.vatNumber == Recipient.vatNumber (clearly wrong)
#   8. Suspiciously-formatted email/phone strings
#
# Each issue is recorded under `result["_validation_issues"]` for debugging,
# and the offending field is either corrected in-place (if a safe replacement
# is available) or nulled (if not). Never invents data — only removes or
# rearranges.

# Corporate suffix regex (also used in the LLM prompt) — captures any of the
# 27 common legal forms we expect to see in EU invoices.
_CORP_SUFFIX_RE = re.compile(
    r'\b(EOOD|OOD|LTD|LIMITED|GMBH|AG|SA|S\.A\.|AE|ΑΕ|AEBE|ΑΕΒΕ|'
    r'EPE|ΕΠΕ|IKE|ΙΚΕ|OE|ΟΕ|BV|NV|INC|LLC|CORP|SRL|SARL|KG|PC)\b',
    re.IGNORECASE
)

# Strip a couple of common LLM hallucination patterns that are template-derived
# (these literal strings appear in prompt examples and the LLM sometimes copies
# them verbatim into structured output, instead of writing null).
_TEMPLATE_HALLUCINATIONS = {
    "EL123456789", "EL000000000",
    "514440874",   # Israeli example we used in the prompt
    "FERRYSCANNER.COM EOOD", "PHILIPP BRINKMANN",
}


def _norm_text(s: str) -> str:
    """Lowercase + collapse whitespace + strip punctuation for fuzzy matching."""
    if not s:
        return ""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s.lower())).strip()


def _value_in_text(value: Any, text: str) -> bool:
    """Check whether `value` (or a close variant) appears in the OCR text."""
    if value is None or value == "":
        return False
    sval = str(value).strip()
    if not sval:
        return False
    # 1. Exact substring match
    if sval in text:
        return True
    # 2. Normalised fuzzy match — handles whitespace/punctuation differences
    if _norm_text(sval) and _norm_text(sval) in _norm_text(text):
        return True
    # 3. For VAT numbers: try without the country prefix
    m = re.match(r"^[A-Z]{2}(\d{6,})$", sval, re.IGNORECASE)
    if m and m.group(1) in text:
        return True
    return False


def _strip_nonalnum(s: str) -> str:
    """Lowercase and strip all non-alphanumeric chars for loose comparison."""
    return re.sub(r"[^A-Za-z0-9]", "", s or "").lower()


# Characters vision OCR commonly confuses with each other. Each frozenset is a
# mutual-confusion group; two strings are "confusable-equal" if they match
# position-by-position where every mismatch is within one of these groups.
_CONFUSABLE_GROUPS = [
    frozenset({"0", "o", "O", "d", "D", "q", "Q"}),
    frozenset({"1", "l", "I", "i", "|"}),
    frozenset({"9", "g", "q"}),
    frozenset({"5", "s", "S"}),
    frozenset({"8", "b", "B"}),
    frozenset({"2", "z", "Z"}),
    frozenset({"6", "G"}),
    frozenset({"7", "T"}),
]


def _confusable_equal(a: str, b: str) -> bool:
    """
    True if a and b are the same length and every differing character pair is a
    known OCR confusion (e.g. "UP6BUX01-0008" vs "UP6BUX9I-0008": 0↔9? no — but
    1↔I yes). Used to decide whether a model's invoiceNumber is a misread of the
    authoritative one from the reference text.
    """
    if not a or not b or len(a) != len(b):
        return False
    diffs = 0
    for ca, cb in zip(a, b):
        if ca == cb:
            continue
        diffs += 1
        if diffs > 3:                     # too many differences → not the same token
            return False
        if not any(ca in g and cb in g for g in _CONFUSABLE_GROUPS):
            return False
    return True


_INVOICE_NO_LABEL_RE = re.compile(
    r'(?:invoice\s*(?:number|no\.?|#)|αρ\.?\s*τιμολογίου|τιμολόγιο\s*αρ\.?'
    r'|rechnung(?:s)?\s*nr|facture\s*n)',
    re.IGNORECASE,
)


def _find_invoice_number_in_text(text: str) -> Optional[str]:
    """
    Find the authoritative invoice number in the native invoice text by locating
    an 'Invoice number' (or localized) label and taking the token after it.
    Returns None if no labelled invoice number is found.
    """
    if not text:
        return None
    for m in _INVOICE_NO_LABEL_RE.finditer(text):
        tail = text[m.end():m.end() + 60]
        # First token that looks like an invoice number: alphanumeric, may
        # contain - / . and is at least 4 chars.
        tok = re.search(r'[:\s]*([A-Za-z0-9][A-Za-z0-9\-\/.]{3,})', tail)
        if tok:
            candidate = tok.group(1).strip().rstrip(".")
            # Avoid grabbing a date or a pure word like "Date"
            if re.search(r'\d', candidate) and candidate.lower() not in ("date", "number"):
                return candidate
    return None


def _validate_extraction(data: Dict[str, Any], ocr_text: str) -> Dict[str, Any]:
    """
    Run cross-reference validation between the LLM-extracted `data` and the
    raw `ocr_text`. Returns the (possibly mutated) data with a new field
    `_validation_issues: list[str]` describing what was caught/fixed.
    """
    issues: list = []

    if not isinstance(data, dict):
        return {"_validation_issues": ["non-dict response from LLM"]}

    issuer    = data.get("issuer")    or {}
    recipient = data.get("recipient") or {}

    # ────────────────────────────────────────────────────────────────────
    # 0. INVOICE NUMBER OCR-MISREAD CORRECTION (vision engines)
    # ────────────────────────────────────────────────────────────────────
    # Vision models misread visually-similar characters (e.g. "9I"→"01",
    # "O"→"0", "5"→"S", "B"→"8"). When the real invoice text is available as
    # reference, prefer the EXACT invoice number from that text. We look for a
    # token near an "Invoice number / Invoice no / Αρ. Τιμολογίου" label and,
    # if it differs from the model's value only by common-confusion characters,
    # replace the model value with the authoritative one.
    inv_no = data.get("invoiceNumber")
    if ocr_text:
        true_no = _find_invoice_number_in_text(ocr_text)
        if true_no:
            if not inv_no:
                data["invoiceNumber"] = true_no
                issues.append(f"invoiceNumber set to {true_no!r} from reference text")
            elif true_no != inv_no:
                # The native invoice text is authoritative for the invoice number
                # (vision OCR misreads visually-similar chars like 9I→01, O→0).
                # Prefer the text value, but record the discrepancy so a reviewer
                # can see the model disagreed.
                issues.append(
                    f"invoiceNumber={inv_no!r} replaced with {true_no!r} from reference "
                    f"text (authoritative; vision likely misread)"
                )
                data["invoiceNumber"] = true_no

    # ────────────────────────────────────────────────────────────────────
    # 1. VAT NUMBER HALLUCINATION CHECK
    # ────────────────────────────────────────────────────────────────────
    # If the LLM produced a VAT number that doesn't actually appear in the
    # OCR text, it's a hallucination. Null it out.
    for entity_key, entity in (("issuer", issuer), ("recipient", recipient)):
        vat = entity.get("vatNumber")
        if vat and isinstance(vat, str):
            # Catch known template hallucinations
            if vat.strip().upper() in _TEMPLATE_HALLUCINATIONS:
                issues.append(f"{entity_key}.vatNumber={vat!r} is a template hallucination → nulled")
                entity["vatNumber"] = None
            elif not _value_in_text(vat, ocr_text):
                issues.append(f"{entity_key}.vatNumber={vat!r} not found in OCR text → nulled (hallucinated)")
                entity["vatNumber"] = None

        # Same check for taxId (non-EU identifiers)
        tid = entity.get("taxId")
        if tid and isinstance(tid, str):
            if tid.strip().upper() in _TEMPLATE_HALLUCINATIONS:
                issues.append(f"{entity_key}.taxId={tid!r} is a template hallucination → nulled")
                entity["taxId"] = None
            elif not _value_in_text(tid, ocr_text):
                issues.append(f"{entity_key}.taxId={tid!r} not found in OCR text → nulled")
                entity["taxId"] = None

    # ────────────────────────────────────────────────────────────────────
    # 2. ISSUER/RECIPIENT VAT COLLISION
    # ────────────────────────────────────────────────────────────────────
    # The issuer and recipient cannot have the same VAT number on a real
    # invoice — that would mean a company is invoicing itself. If we see
    # this, both are suspect; null the recipient (more commonly the LLM
    # gets confused about who's who).
    if (issuer.get("vatNumber") and recipient.get("vatNumber")
            and issuer["vatNumber"] == recipient["vatNumber"]):
        issues.append(
            f"issuer.vatNumber == recipient.vatNumber ({issuer['vatNumber']!r}) — "
            f"nulled recipient (likely LLM confusion)"
        )
        recipient["vatNumber"] = None

    # ────────────────────────────────────────────────────────────────────
    # 3. RECIPIENT NAME = CONTACT PERSON (corporate suffix preference)
    # ────────────────────────────────────────────────────────────────────
    # If recipient.name is set but has no corporate suffix, scan the OCR
    # text for a nearby line WITH a corporate suffix and swap them.
    rec_name = recipient.get("name")
    if rec_name and not _CORP_SUFFIX_RE.search(rec_name):
        # Locate a "Bill To" / "Recipient" / "Πελάτης" block in the text
        # and scan the next 5 lines for one with a corporate suffix.
        block_match = re.search(
            r'(?:Bill\s+To|Billed\s+To|Recipient|Client|To|Πελάτη?ς?|ΠΕΛΑΤΗΣ)'
            r'[^\n]*\n((?:[^\n]+\n){1,6})',
            ocr_text, re.IGNORECASE
        )
        if block_match:
            for raw_line in block_match.group(1).split("\n"):
                line = raw_line.strip()
                if not line or len(line) < 3:
                    continue
                # Skip lines that look like dates/addresses/numbers
                if re.match(r'^[\d\s,\.\-/]+$', line):
                    continue
                if _CORP_SUFFIX_RE.search(line) and line != rec_name:
                    issues.append(
                        f"recipient.name {rec_name!r} has no corporate suffix; "
                        f"swapped with {line!r} (contactPerson updated)"
                    )
                    # Move existing name to contactPerson (if empty)
                    if not recipient.get("contactPerson"):
                        recipient["contactPerson"] = rec_name
                    recipient["name"] = line
                    break

    # ────────────────────────────────────────────────────────────────────
    # 4. LINE-ITEM VAT RATE SANITY
    # ────────────────────────────────────────────────────────────────────
    # If a vatRate like 24 was extracted but the digits "24" (or "24%" or
    # "0,24" etc.) never appear in the OCR text, this is a hallucinated
    # default — null it. We're conservative: only flag exact-number absence.
    for li in (data.get("lineItems") or []):
        if not isinstance(li, dict):
            continue
        rate = li.get("vatRate")
        if rate is None:
            continue
        try:
            rate_num = float(rate)
        except (ValueError, TypeError):
            continue
        # Format the rate as int when possible (24 not 24.0)
        rate_int = int(rate_num) if rate_num == int(rate_num) else rate_num
        rate_str = str(rate_int)
        # The text must contain the rate as a standalone token OR followed
        # by % OR followed by a comma+decimal (Greek format like "24,00").
        patterns = [
            rf'\b{re.escape(rate_str)}\b',
            rf'\b{re.escape(rate_str)}\s*%',
            rf'\b{re.escape(rate_str)},\d',
            rf'\b{re.escape(rate_str)}\.\d',
        ]
        if not any(re.search(p, ocr_text) for p in patterns):
            issues.append(
                f"lineItem vatRate={rate_str} never appears in OCR text → nulled"
            )
            li["vatRate"] = None

    # ────────────────────────────────────────────────────────────────────
    # 4.5 VAT AMOUNT RECOVERY (Greek columnar-totals dropped-VAT fix)
    # ────────────────────────────────────────────────────────────────────
    # Observed on the Surya/auto run for the watermarked Greek invoice: the OCR
    # text cleanly contained the totals row "Σύνολα 0,00 173,89 ... 41,73 215,62"
    # (net 173,89 / ΦΠΑ 41,73 / total 215,62), yet the small semantic model stored
    # vatAmount=0 (and sometimes subtotal==total). The number 41,73 WAS present in
    # the source — the model just failed to map the ΦΠΑ(€) column. Rather than lose
    # it, recover deterministically: when vatAmount is missing/zero but subtotal and
    # total disagree, the implied VAT is (total − subtotal); if that exact figure
    # also appears verbatim in the OCR text, it's the real ΦΠΑ amount, so adopt it.
    # Conservative: only fires when the recovered number is actually present in the
    # text AND makes the totals reconcile — never invents a value.
    try:
        _sub = data.get("subtotal")
        _vat = data.get("vatAmount")
        _tot = data.get("total")
        _sub_f = float(_sub) if _sub is not None else None
        _vat_f = float(_vat) if _vat is not None else None
        _tot_f = float(_tot) if _tot is not None else None

        # Case A: have subtotal + total, VAT missing or zero, and they differ.
        if (_sub_f is not None and _tot_f is not None
                and (_vat_f is None or abs(_vat_f) < 0.005)
                and abs(_tot_f - _sub_f) > 0.05):
            implied = round(_tot_f - _sub_f, 2)
            # Does this implied VAT appear in the OCR text? Accept both EU "41,73"
            # and US "41.73" renderings of the same number.
            cand_eu = f"{implied:.2f}".replace(".", ",")
            cand_us = f"{implied:.2f}"
            if implied > 0 and (cand_eu in ocr_text or cand_us in ocr_text):
                data["vatAmount"] = implied
                issues.append(
                    f"vatAmount recovered as {implied} from (total {_tot_f} − "
                    f"subtotal {_sub_f}); value present in OCR text "
                    f"(model had dropped the ΦΠΑ column to 0/null)"
                )

        # Case B: subtotal missing/zero but total + a VAT amount are present — the
        # net is total − vat (the "Αξία" column). Recover subtotal if that figure
        # is in the text. Handles the inverse mis-map (model put gross into both).
        elif (_tot_f is not None and _vat_f is not None and abs(_vat_f) > 0.005
              and (_sub_f is None or abs(_sub_f) < 0.005
                   or abs(_sub_f - _tot_f) < 0.005)):
            implied_net = round(_tot_f - _vat_f, 2)
            cand_eu = f"{implied_net:.2f}".replace(".", ",")
            cand_us = f"{implied_net:.2f}"
            if implied_net > 0 and (cand_eu in ocr_text or cand_us in ocr_text):
                data["subtotal"] = implied_net
                issues.append(
                    f"subtotal recovered as {implied_net} from (total {_tot_f} − "
                    f"vat {_vat_f}); value present in OCR text"
                )
    except (ValueError, TypeError):
        pass

    # ────────────────────────────────────────────────────────────────────
    # 5. TOTAL RECONCILIATION
    # ────────────────────────────────────────────────────────────────────
    # subtotal + vat ≈ total (within ±0.05 to allow rounding).
    # If not, flag — don't auto-correct (we don't know which value is wrong).
    subtotal = data.get("subtotal")
    vat_amt  = data.get("vatAmount")
    total    = data.get("total")
    if subtotal is not None and vat_amt is not None and total is not None:
        try:
            diff = abs(float(subtotal) + float(vat_amt) - float(total))
            if diff > 0.05:
                issues.append(
                    f"totals do not reconcile: subtotal({subtotal}) + vat({vat_amt}) "
                    f"≠ total({total}) — diff={diff:.2f}"
                )
        except (ValueError, TypeError):
            pass

    # ────────────────────────────────────────────────────────────────────
    # 6. LINE-ITEM SUM vs SUBTOTAL
    # ────────────────────────────────────────────────────────────────────
    # Σ(lineItems.totalPrice) should ≈ subtotal (±0.10). If wildly off,
    # the LLM probably missed line items or hallucinated some.
    items = data.get("lineItems") or []
    if items and subtotal is not None:
        try:
            items_sum = sum(float(li.get("totalPrice") or 0) for li in items if isinstance(li, dict))
            diff = abs(items_sum - float(subtotal))
            if diff > max(0.10, float(subtotal) * 0.02):  # >2% deviation
                issues.append(
                    f"sum(lineItems.totalPrice)={items_sum:.2f} differs from "
                    f"subtotal={subtotal} by {diff:.2f} — possible missing/extra items"
                )
        except (ValueError, TypeError):
            pass

    # ────────────────────────────────────────────────────────────────────
    # 7. CURRENCY CONSISTENCY
    # ────────────────────────────────────────────────────────────────────
    # If currency=EUR but € symbol absent AND BGN/USD symbols present in
    # the text, flag — the LLM may have defaulted to EUR incorrectly.
    currency = (data.get("currency") or "").upper()
    if currency == "EUR":
        has_eur = "€" in ocr_text or re.search(r'\bEUR\b', ocr_text)
        has_bgn = "лв" in ocr_text or re.search(r'\bBGN\b', ocr_text)
        has_usd = "$"  in ocr_text or re.search(r'\bUSD\b', ocr_text)
        if not has_eur and (has_bgn or has_usd):
            other = "BGN" if has_bgn else "USD"
            issues.append(
                f"currency=EUR but no EUR sign found in text; {other} signs present "
                f"(LLM may have defaulted to EUR)"
            )

    # ────────────────────────────────────────────────────────────────────
    # 8. EMAIL/PHONE FORMAT SANITY
    # ────────────────────────────────────────────────────────────────────
    _EMAIL_RE = re.compile(r"^[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}$")
    for entity_key, entity in (("issuer", issuer), ("recipient", recipient)):
        email = entity.get("email")
        if email and isinstance(email, str) and not _EMAIL_RE.match(email.strip()):
            issues.append(f"{entity_key}.email={email!r} fails email regex → nulled")
            entity["email"] = None

    # ────────────────────────────────────────────────────────────────────
    # 9. INVOICE NUMBER TEXT-PRESENCE
    # ────────────────────────────────────────────────────────────────────
    # If invoiceNumber doesn't appear in the OCR text, it's hallucinated.
    inv_num = data.get("invoiceNumber")
    if inv_num and isinstance(inv_num, str):
        if inv_num.strip().upper() in _TEMPLATE_HALLUCINATIONS:
            issues.append(f"invoiceNumber={inv_num!r} is a template hallucination → nulled")
            data["invoiceNumber"] = None
        elif not _value_in_text(inv_num, ocr_text):
            issues.append(f"invoiceNumber={inv_num!r} not found in OCR text → nulled")
            data["invoiceNumber"] = None

    # ────────────────────────────────────────────────────────────────────
    # 10. ORDER NUMBER SANITY (rejects street addresses misread as orders)
    # ────────────────────────────────────────────────────────────────────
    # Real-world bug observed with the Fiverr invoice:
    #   PDF layout:
    #     Bill to                          Order number
    #     Ferryscanner.com EOOD            FO1149476C5C5
    #     115M Tsarigradsko Shose Blvd.    ← LLM picked "115M" here
    #     Sofia, 1784
    #
    # The LLM (and a less-careful regex) sees the line under "Order number" and
    # grabs whatever short alphanumeric token starts the next address row. We
    # reject any orderNumber that:
    #   (a) appears IN an address line in the OCR text (followed by street keywords)
    #   (b) is shorter than 5 chars AND starts with a digit (typical street nos.)
    #   (c) does not appear in the OCR text at all (pure hallucination)
    #
    # Real order numbers from real invoices we've seen:
    #   "FO1149476C5C5", "PO-2025-0042", "ORD-9988", "100043217" (all-digit ≥6)
    # — all of these pass the heuristics below.
    order_num = data.get("orderNumber")
    if order_num and isinstance(order_num, str):
        on_clean = order_num.strip()

        # (c) text-presence
        if not _value_in_text(on_clean, ocr_text):
            issues.append(f"orderNumber={on_clean!r} not found in OCR text → nulled (hallucinated)")
            data["orderNumber"] = None
        else:
            # (a) street-address detection: scan the OCR text for the token
            # followed within ~60 chars by a street keyword. Greek/English/German
            # common street markers covered.
            STREET_KEYWORDS_RE = re.compile(
                r'\b(blvd\.?|boulevard|street|st\.?|str\.?|strasse|straße|avenue|ave\.?|'
                r'road|rd\.?|lane|ln\.?|drive|dr\.?|highway|hwy\.?|'
                r'οδ(ός|ου|ό)|λεωφ\.?|λεωφόρος|αγ\.|πλατεία|πλ\.)',
                re.IGNORECASE
            )
            # Find token in text and check what follows
            try:
                escaped = re.escape(on_clean)
                # Look at up to 60 chars after the token
                follow_re = re.compile(rf'\b{escaped}\b([^\n]{{0,60}})', re.IGNORECASE)
                follow_match = follow_re.search(ocr_text)
                if follow_match and STREET_KEYWORDS_RE.search(follow_match.group(1)):
                    issues.append(
                        f"orderNumber={on_clean!r} appears inside a street address "
                        f"(followed by {follow_match.group(1).strip()[:30]!r}) → nulled"
                    )
                    data["orderNumber"] = None
            except re.error:
                pass

            # (b) short-digit-prefixed tokens — likely street numbers.
            # Real order numbers are either longer or start with letters/prefix.
            if data.get("orderNumber") is not None:
                if len(on_clean) <= 4 and re.match(r'^\d', on_clean):
                    issues.append(
                        f"orderNumber={on_clean!r} is suspiciously short and starts with "
                        f"a digit (likely street number) → nulled"
                    )
                    data["orderNumber"] = None

    # ────────────────────────────────────────────────────────────────────
    # 11. ADDRESS / CONTACT-PERSON TEXT-PRESENCE (anti-contamination)
    # ────────────────────────────────────────────────────────────────────
    # Real-world Gemma bug observed with the New Relic invoice: even though
    # the PDF text contains "MILTIADOU 7 / ATHENS, 105 60 / Greece", the LLM
    # output had:
    #     recipient.address    = "115M Tsarigradsko Shose Blvd."  ← from prompt example
    #     recipient.city       = "Sofia"                          ← from prompt example
    #     recipient.postCode   = "1784"                           ← from prompt example
    #     recipient.contactPerson = "Philipp Brinkmann"           ← from prompt example
    #
    # These values literally came from worked examples in the LLM prompt that
    # the small (4B param) model treated as templates to copy when it couldn't
    # confidently read the actual recipient block from the image.
    #
    # The fix is twofold: (a) cleaned the prompt to remove concrete examples
    # (done in gemma_vl_engine.py + semantic_extractor.py prompts), and
    # (b) this defensive presence-check below — if any address/city/postCode/
    # contactPerson value isn't found verbatim in the OCR text, it's nulled.
    #
    # Caveat: this can produce false positives if the OCR garbled the address
    # (e.g. "MILTIADOU" → "Mlitiadou" due to bad OCR). To avoid over-nulling,
    # we use a more permissive fuzzy match for these fields — exact substring
    # check first, then a token-overlap check (≥50% of words must appear).
    def _address_in_text(value: str, text: str) -> bool:
        """Permissive presence check for multi-word address fields."""
        if not value or not isinstance(value, str):
            return True  # nothing to check
        v = value.strip()
        if len(v) < 3:
            return True  # too short to meaningfully check
        # Exact substring match (case-insensitive)
        if v.lower() in text.lower():
            return True
        # Token overlap: split into words 3+ chars, count how many appear
        tokens = [t for t in re.findall(r'\w+', v) if len(t) >= 3]
        if not tokens:
            return True
        found = sum(1 for t in tokens if t.lower() in text.lower())
        return (found / len(tokens)) >= 0.5

    # Check fields on both issuer and recipient
    for entity_name, entity in (("issuer", issuer), ("recipient", recipient)):
        if not isinstance(entity, dict):
            continue
        for field in ("address", "city", "postCode", "contactPerson"):
            val = entity.get(field)
            if val and isinstance(val, str) and val.strip():
                if not _address_in_text(val.strip(), ocr_text):
                    issues.append(
                        f"{entity_name}.{field}={val.strip()!r} not found in OCR text "
                        f"→ nulled (likely prompt-example contamination)"
                    )
                    entity[field] = None

    # ────────────────────────────────────────────────────────────────────
    # 12. CONCATENATED RECIPIENT NAME (2-column layout fix)
    # ────────────────────────────────────────────────────────────────────
    # Real-world New Relic bug: pdfplumber reads 2-column "Bill To: / Sold To:"
    # blocks as a single line per row, so the LLM sees:
    #     Ferryscanner Single Mermber PC MILTIADOU 7
    # and produces:
    #     recipient.name          = "Ferryscanner Single Mermber PC MILTIADOU 7"
    #     recipient.contactPerson = "MILTIADOU 7"
    #     recipient.address       = "ATHENS, 105 60"  ← city, not address
    #
    # Detection: recipient.name ends with a "street-like" token pattern
    # (uppercase word + space + small number, e.g. "MILTIADOU 7", "VENIZELOY 22").
    # If matched AND the trailing token also appears as a separate row in OCR text,
    # we split: keep the corporate prefix as name, push the street to address,
    # and shift fields appropriately.
    rec_name = recipient.get("name") or ""
    if rec_name and isinstance(rec_name, str):
        # Pattern: "<Company words> <STREET-NAME> <NUMBER>"
        # We want the rightmost match — split at the last UPPERCASE word + number
        # The street name may be all-caps (Greek) or mixed-case (English).
        street_split_re = re.compile(
            r'^(.+?[A-Za-zΑ-Ωα-ω])\s+([A-ZΑ-Ω][A-ZΑ-Ω\.\-]+\s+\d{1,4}[A-Za-z]?)\s*$'
        )
        match = street_split_re.match(rec_name.strip())
        if match:
            company_part = match.group(1).strip()
            street_part  = match.group(2).strip()
            # Verify the street part appears separately in the OCR text — this
            # means the LLM did concatenate two separate fields, not a single
            # company name that happens to include a street.
            if (street_part in ocr_text and
                    len(company_part) >= 5 and
                    _CORP_SUFFIX_RE.search(company_part)):
                issues.append(
                    f"recipient.name={rec_name!r} contains concatenated street "
                    f"{street_part!r} → split into name + address"
                )
                recipient["name"] = company_part
                # Repair address fields:
                #   If contactPerson is the street, clear it (it's not a person)
                #   If address is currently the city, shift it to street
                if recipient.get("contactPerson") == street_part:
                    recipient["contactPerson"] = None
                # Set street as address (overriding any wrong value)
                if not recipient.get("address") or \
                        re.match(r'^[A-ZΑ-Ω\s,]+\d', recipient.get("address") or ""):
                    # Address looks empty or is city-like ("ATHENS, 105 60")
                    recipient["address"] = street_part

    # ── Persist results ──
    data["issuer"]    = issuer
    data["recipient"] = recipient
    if issues:
        data["_validation_issues"] = issues
        log.warning(f"[Validation] {len(issues)} issue(s) caught: " + "; ".join(issues[:3]))

    return data


# ── Singleton ──────────────────────────────────────────────────────────────────
_extractor: Optional[SemanticExtractor] = None

def get_extractor() -> SemanticExtractor:
    global _extractor
    if _extractor is None:
        _extractor = SemanticExtractor()
    return _extractor


# ── CLI ────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import argparse, sys
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    parser = argparse.ArgumentParser(description="Semantic invoice extraction")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--model",     default=SEMANTIC_MODEL)
    args = parser.parse_args()

    ext = SemanticExtractor(model_key=args.model)
    if not ext.is_available():
        print(f"ERROR: Model {args.model} not available.", file=sys.stderr)
        print("Run: pip install llama-cpp-python huggingface-hub", file=sys.stderr)
        sys.exit(1)

    text   = open(args.text_file, encoding="utf-8").read()
    result = ext.extract(text)
    print(json.dumps(result, indent=2, ensure_ascii=False))