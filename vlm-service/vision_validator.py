"""
vision_validator.py
─────────────────────────────────────────────────────────────────────────────
Internal-consistency validator for the VISION engines (qwen_vl_local,
gemma_vl_local).

Unlike semantic_extractor._validate_extraction (which cross-references the
LLM output against raw OCR text), the vision engines produce NO OCR text —
the page image goes straight to JSON. So this validator works on the
structured data ALONE: it checks whether the extracted numbers and fields
are internally consistent.

Design principle — FLAG, NEVER FIX:
  When something doesn't reconcile we do NOT know which value is wrong, so we
  never overwrite the model's numbers. We attach a list of human-readable
  issues, lower the confidence, and tag the record needs_review. A human (or
  the review queue) decides.

Expected input shape (the nested schema both vision engines now emit):
  {
    "currency": "EUR",
    "issuer":    {"vatNumber": ...},
    "recipient": {"vatNumber": ...},
    "lineItems": [{"totalPrice": ..., "vatRate": ...}, ...],
    "totals":    {"subtotal": ..., "vat": ..., "total": ..., "payable": ...}
  }

Tolerant of the flat shape too (subtotal/vat/total at top level) so it works
even if an engine emits the older layout.

Returns the SAME dict, mutated in place with:
  data["_validation"] = {
     "status": "ok" | "needs_review",
     "issues": [ "human readable string", ... ],
  }
and, if issues were found, a lowered data["classificationConfidence"].
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

log = logging.getLogger("vision_validator")

# Money comparisons tolerate small rounding noise.
_MONEY_EPS = 0.05
# Line-item sum may deviate slightly more (per-line rounding accumulates).
_LINEITEM_REL_TOL = 0.02   # 2%
_LINEITEM_ABS_TOL = 0.10

# Currencies that are plausible on a Greek/European invoice without raising a
# flag. Anything else (e.g. ILS, JPY) on a EUR-context invoice is suspicious.
_EUROPEAN_CURRENCIES = {"EUR", "GBP", "BGN", "RON", "PLN", "CHF", "SEK", "DKK", "NOK", "CZK", "HUF"}


def _as_float(value: Any) -> Optional[float]:
    """Best-effort numeric coercion. Returns None if not a number."""
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _get_totals(data: Dict[str, Any]) -> Dict[str, Optional[float]]:
    """
    Read subtotal/vat/total/payable from the nested `totals` object, falling
    back to top-level flat keys. Returns a dict of floats-or-None.
    """
    totals = data.get("totals") if isinstance(data.get("totals"), dict) else {}

    def pick(*keys):
        for src in (totals, data):
            for k in keys:
                if k in src and src[k] is not None:
                    return _as_float(src[k])
        return None

    return {
        "subtotal": pick("subtotal"),
        "vat":      pick("vat", "vatAmount"),
        "total":    pick("total", "totalAmount"),
        "payable":  pick("payable", "payableAmount"),
    }


def validate_vision_extraction(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate the internal consistency of a vision-engine extraction.
    Mutates and returns `data` with a `_validation` block; lowers confidence
    if issues are found. Never overwrites extracted values.
    """
    if not isinstance(data, dict):
        return {"_validation": {"status": "needs_review",
                                "issues": ["non-dict extraction result"]}}

    issues: List[str] = []

    issuer    = data.get("issuer")    if isinstance(data.get("issuer"), dict)    else {}
    recipient = data.get("recipient") if isinstance(data.get("recipient"), dict) else {}
    line_items = data.get("lineItems") if isinstance(data.get("lineItems"), list) else []
    t = _get_totals(data)
    subtotal, vat_amt, total, payable = t["subtotal"], t["vat"], t["total"], t["payable"]

    # ──────────────────────────────────────────────────────────────────────
    # 1. TOTALS RECONCILIATION — subtotal + vat ≈ total
    # ──────────────────────────────────────────────────────────────────────
    if subtotal is not None and vat_amt is not None and total is not None:
        diff = abs(subtotal + vat_amt - total)
        if diff > _MONEY_EPS:
            issues.append(
                f"totals do not reconcile: subtotal({subtotal:.2f}) + "
                f"vat({vat_amt:.2f}) != total({total:.2f}) — diff={diff:.2f}"
            )

    # ──────────────────────────────────────────────────────────────────────
    # 2. PAYABLE vs TOTAL — when both present they should match (or payable
    #    is total minus withholding; we only flag a large unexplained gap).
    # ──────────────────────────────────────────────────────────────────────
    if total is not None and payable is not None:
        if abs(total - payable) > _MONEY_EPS:
            wht = _as_float(data.get("withholdingTax"))
            explained = wht is not None and abs((total - payable) - wht) <= _MONEY_EPS
            if not explained:
                issues.append(
                    f"payable({payable:.2f}) != total({total:.2f}) and the "
                    f"difference is not explained by withholdingTax"
                )

    # ──────────────────────────────────────────────────────────────────────
    # 3. VAT AMOUNT vs IMPLIED RATE — does the VAT match the line-item rate?
    #    Catches the "VAT 7.20 implies 24% but a line says 6%" kind of mismatch.
    #    NOTE: this can only catch INTERNAL disagreement (VAT amount vs the
    #    rate the model itself extracted). It cannot catch a self-consistent
    #    but wrong extraction (e.g. model reads both the rate AND the amount
    #    as 6% when the invoice is really 24%) — nothing in the structured
    #    data contradicts that. Only the totals-box prompt rule + a human
    #    reviewer catch that case.
    # ──────────────────────────────────────────────────────────────────────
    if subtotal is not None and vat_amt is not None and subtotal > 0:
        implied_rate = round(vat_amt / subtotal * 100, 1)
        stated_rates = set()
        for li in line_items:
            if isinstance(li, dict):
                r = _as_float(li.get("vatRate"))
                if r is not None:
                    stated_rates.add(round(r, 1))
        if stated_rates:
            if not any(abs(implied_rate - r) <= 1.0 for r in stated_rates):
                rates_str = ", ".join(f"{r:g}%" for r in sorted(stated_rates))
                expected = subtotal * (sorted(stated_rates)[0] / 100.0)
                issues.append(
                    f"VAT amount {vat_amt:.2f} implies {implied_rate:g}% but "
                    f"line item rate(s) are {rates_str} — expected VAT ~ {expected:.2f}"
                )

    # ──────────────────────────────────────────────────────────────────────
    # 4. LINE-ITEM SUM vs SUBTOTAL
    # ──────────────────────────────────────────────────────────────────────
    if line_items and subtotal is not None:
        items_sum = 0.0
        any_priced = False
        for li in line_items:
            if isinstance(li, dict):
                tp = _as_float(li.get("totalPrice"))
                if tp is not None:
                    items_sum += tp
                    any_priced = True
        if any_priced:
            tol = max(_LINEITEM_ABS_TOL, abs(subtotal) * _LINEITEM_REL_TOL)
            if abs(items_sum - subtotal) > tol:
                issues.append(
                    f"sum(lineItems.totalPrice)={items_sum:.2f} differs from "
                    f"subtotal={subtotal:.2f} by {abs(items_sum - subtotal):.2f} "
                    f"— possible missing/extra/misread items"
                )

    # ──────────────────────────────────────────────────────────────────────
    # 5. ISSUER / RECIPIENT VAT COLLISION — a company cannot invoice itself.
    # ──────────────────────────────────────────────────────────────────────
    iv = issuer.get("vatNumber")
    rv = recipient.get("vatNumber")
    if iv and rv and str(iv).strip() == str(rv).strip():
        issues.append(
            f"issuer.vatNumber == recipient.vatNumber ({iv!r}) — "
            f"likely confused issuer/recipient"
        )

    # ──────────────────────────────────────────────────────────────────────
    # 6. CURRENCY PLAUSIBILITY — non-European currency on a EUR-context doc.
    #    The vision engines have no OCR text to cross-check, so this is a soft
    #    plausibility flag, not a correction.
    # ──────────────────────────────────────────────────────────────────────
    currency = (data.get("currency") or "").strip().upper()
    if currency and currency not in _EUROPEAN_CURRENCIES and currency != "USD":
        issues.append(
            f"currency={currency!r} is unusual for a Greek/European invoice — verify "
            f"(vision model may have misread the currency symbol)"
        )

    # ──────────────────────────────────────────────────────────────────────
    # 7. MISSING CRITICAL FIELDS — surfaced as review hints, not hard errors.
    # ──────────────────────────────────────────────────────────────────────
    if not data.get("invoiceNumber"):
        issues.append("invoiceNumber is missing")
    if total is None and payable is None:
        issues.append("no grand total / payable amount extracted")

    # ──────────────────────────────────────────────────────────────────────
    # Attach result + lower confidence (never raise it).
    # ──────────────────────────────────────────────────────────────────────
    if issues:
        data["_validation"] = {"status": "needs_review", "issues": issues}
        # Lower confidence proportionally to how many checks tripped, floored.
        existing = data.get("classificationConfidence")
        existing = float(existing) if isinstance(existing, (int, float)) else 70.0
        penalty = min(len(issues) * 12, 40)   # each issue -12, capped at -40
        data["classificationConfidence"] = max(int(existing - penalty), 25)
        log.info(
            f"[VisionValidator] {len(issues)} issue(s) — "
            f"confidence {existing:.0f} -> {data['classificationConfidence']}; "
            f"first: {issues[0]}"
        )
    else:
        data["_validation"] = {"status": "ok", "issues": []}

    return data