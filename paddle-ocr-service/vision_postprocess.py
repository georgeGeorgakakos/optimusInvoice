"""
vision_postprocess.py
─────────────────────────────────────────────────────────────────────────────
Shared post-processing for the VISION engines (qwen_vl_engine, gemma_vl_engine).

WHY THIS EXISTS
  The Surya/text path runs every extraction through semantic_extractor.py's
  _normalize_number() + _validate_extraction() — which strip hallucinated VAT,
  fix mixed EU/US numbers, null fabricated VAT numbers, and reconcile totals.

  The VISION engines parse their OWN JSON (_parse_json_output / _safe_parse_json)
  and return it DIRECTLY, bypassing all of that. As a result, on a digital invoice
  like New Relic the vision models produced:
    • qwen  : invented vatRate=13 on a $0.00-tax invoice
    • gemma : invented vatRate=24, currency EUR (invoice is USD), hallucinated a
              Greek VAT number, lost line totals ($646.65 → 0.645)
    • both  : misread "1,437" (thousands) as 1.437 (decimal)

  This module gives the vision output the SAME safety net, in one shared place so
  both engines stay in sync. It deliberately reuses semantic_extractor's helpers
  (_normalize_number, _validate_extraction) rather than duplicating them.

WHAT IT DOES (in order)
  1. Flatten the vision schema (totals{} object) into the flat shape the Node
     layer expects (subtotal / vatAmount / total) while keeping totals{} too.
  2. Normalize every numeric field via _normalize_number():
       - quantity uses integer_hint  → "1,437"/"1.437" become 1437 (a count)
       - unitPrice/totalPrice/subtotal/vat/total parse mixed EU/US correctly
  3. VAT HALLUCINATION GUARD (the deterministic core):
       If subtotal == total (within tolerance) the invoice has NO VAT, so any
       positive line vatRate is a hallucination → null it, and force vat=0.
       This single rule kills qwen's 13% and gemma's 24% with no source text.
  4. Optional full validation: if reference_text is provided (the REAL invoice
     text, e.g. from pdfplumber), run semantic_extractor._validate_extraction()
     to also catch hallucinated VAT numbers, currency defaults, street-as-name,
     etc. — exactly what the Surya path gets.

USAGE (from each engine, right after parsing the model JSON):
    from vision_postprocess import postprocess_vision_invoice
    structured = postprocess_vision_invoice(structured, reference_text=None)
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

log = logging.getLogger("vision_postprocess")

# Reuse the battle-tested helpers from the text path — never duplicate them.
try:
    from semantic_extractor import _normalize_number, _validate_extraction
except Exception as _e:  # pragma: no cover - import-time safety
    _normalize_number = None
    _validate_extraction = None
    log.warning(f"[vision_postprocess] could not import semantic_extractor helpers: {_e}")


# Tolerance for "subtotal == total" comparison (currency rounding).
_TOTALS_EQ_TOL = 0.05


def _num(v, *, default=None, integer_hint: bool = False):
    """Safe wrapper around _normalize_number (no-op if helper unavailable)."""
    if _normalize_number is None:
        return v
    return _normalize_number(v, default=default, integer_hint=integer_hint)


def _flatten_totals(data: Dict[str, Any]) -> None:
    """
    Vision engines emit totals under a nested `totals` object:
        {"totals": {"subtotal", "vat", "total", "payable"}}
    The Node mapping layer (python-integration.ts) also reads flat
    subtotal/vatAmount/total. Populate the flat keys from totals{} when the flat
    ones are absent, so downstream code finds them either way. Keeps totals{}.
    """
    totals = data.get("totals")
    if not isinstance(totals, dict):
        return
    if data.get("subtotal") is None and totals.get("subtotal") is not None:
        data["subtotal"] = totals.get("subtotal")
    if data.get("vatAmount") is None and totals.get("vat") is not None:
        data["vatAmount"] = totals.get("vat")
    if data.get("total") is None and totals.get("total") is not None:
        data["total"] = totals.get("total")
    if data.get("payableAmount") is None and totals.get("payable") is not None:
        data["payableAmount"] = totals.get("payable")


def _normalize_numbers(data: Dict[str, Any]) -> None:
    """Normalize all monetary + quantity fields in place via _normalize_number."""
    # Document-level monetary fields: present-but-unparseable → None (not 0).
    for field in ("subtotal", "vatAmount", "total", "payableAmount", "withholdingTax"):
        if data.get(field) is not None:
            data[field] = _num(data[field], default=None)

    # totals{} mirror, if present
    totals = data.get("totals")
    if isinstance(totals, dict):
        for k in ("subtotal", "vat", "total", "payable"):
            if totals.get(k) is not None:
                totals[k] = _num(totals[k], default=None)

    # Line items
    for li in (data.get("lineItems") or []):
        if not isinstance(li, dict):
            continue
        # quantity: integer_hint so "1,437"/"1.437" → 1437 (a count, not 1.437)
        if li.get("quantity") is not None:
            li["quantity"] = _num(li["quantity"], default=0.0, integer_hint=True)
        for f in ("unitPrice", "totalPrice"):
            if li.get(f) is not None:
                li[f] = _num(li[f], default=0.0)
        # vatRate: extract-only — preserve None, never synthesize 0/24.
        if li.get("vatRate") is not None:
            li["vatRate"] = _num(li["vatRate"], default=None)


def _vat_hallucination_guard(data: Dict[str, Any]) -> list:
    """
    DETERMINISTIC, source-text-free guard against invented VAT.

    If subtotal and total are both present and equal (within tolerance), the
    invoice carries NO VAT. Any positive line vatRate is therefore a
    hallucination — null it. Also force document vatAmount/totals.vat to 0.

    This is what catches qwen's 13% and gemma's 24% on the New Relic invoice
    (subtotal 745.65 == total 745.65) regardless of engine or source text.

    Returns a list of human-readable issue strings (for debugging/audit).
    """
    issues: list = []
    subtotal = data.get("subtotal")
    total = data.get("total")
    if subtotal is None or total is None:
        return issues
    try:
        if abs(float(subtotal) - float(total)) > _TOTALS_EQ_TOL:
            return issues  # there IS a tax delta — leave rates alone
    except (ValueError, TypeError):
        return issues

    # subtotal == total → no VAT on this invoice.
    for li in (data.get("lineItems") or []):
        if not isinstance(li, dict):
            continue
        rate = li.get("vatRate")
        try:
            if rate is not None and float(rate) > 0:
                issues.append(
                    f"line vatRate={rate} stripped: subtotal==total "
                    f"({subtotal}) ⇒ invoice has no VAT (hallucinated rate)"
                )
                li["vatRate"] = 0
        except (ValueError, TypeError):
            continue

    # Force document VAT amount to 0 (it must be, if subtotal==total).
    if data.get("vatAmount") not in (0, 0.0, None):
        issues.append(f"vatAmount={data.get('vatAmount')} forced to 0 (subtotal==total)")
    data["vatAmount"] = 0
    totals = data.get("totals")
    if isinstance(totals, dict):
        totals["vat"] = 0

    return issues


def _line_items_reconcile_guard(data: Dict[str, Any]) -> list:
    """
    Check that the sum of line-item totalPrice values reconciles with the printed
    subtotal. A large mismatch usually means the vision model read the wrong table
    column on a discount invoice (unit price or pre-discount value). Sets a flag so
    the document is routed to review; does NOT silently alter the amounts.
    """
    issues: list = []
    items = data.get("lineItems") or []
    subtotal = data.get("subtotal")
    if not items or subtotal is None:
        return issues
    try:
        sub = float(subtotal)
    except (TypeError, ValueError):
        return issues
    if sub <= 0:
        return issues
    line_sum = 0.0
    counted = 0
    for it in items:
        tp = it.get("totalPrice")
        if tp is None:
            continue
        try:
            line_sum += float(tp)
            counted += 1
        except (TypeError, ValueError):
            continue
    if counted == 0:
        return issues
    # Tolerance: 2% or 1.00, whichever larger.
    tol = max(1.0, abs(sub) * 0.02)
    if abs(line_sum - sub) > tol:
        data["_line_items_reconciled"] = False
        data["needs_review"] = True
        issues.append(
            f"line totals Σ={round(line_sum, 2)} do not match subtotal {round(sub, 2)} "
            f"(possible discount-column misread)"
        )
    else:
        data["_line_items_reconciled"] = True
    return issues


def postprocess_vision_invoice(
        structured: Optional[Dict[str, Any]],
        reference_text: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Run the shared vision post-processing pipeline on a parsed vision-model JSON.

    Args:
      structured     : the dict parsed from the vision model output (may be None)
      reference_text : the REAL invoice text (e.g. pdfplumber native text). When
                       provided, the full _validate_extraction() pass also runs,
                       catching hallucinated VAT numbers, currency defaults,
                       street-as-name, etc. When None, only the source-text-free
                       guards run (number normalization + the subtotal==total VAT
                       guard), which still fix the worst hallucinations.

    Returns the mutated dict (or the original value if not a dict).
    """
    if not isinstance(structured, dict):
        return structured

    issues: list = list(structured.get("_validation_issues") or [])

    # 1. flatten totals{} → flat keys
    _flatten_totals(structured)

    # 2. normalize numbers (fixes 1,437 → 1437, mixed EU/US prices)
    _normalize_numbers(structured)

    # 3. deterministic VAT-hallucination guard (no source text needed)
    issues.extend(_vat_hallucination_guard(structured))

    # 3.5 line-item reconciliation: Σ(line totalPrice) vs subtotal. On discount
    # invoices the model often reads the pre-discount or unit-price column, so the
    # line totals can be far larger than the printed subtotal. Flag it so the
    # invoice is reviewed rather than trusted.
    issues.extend(_line_items_reconcile_guard(structured))

    # 4. full cross-reference validation when we have the real invoice text
    if reference_text and _validate_extraction is not None:
        try:
            structured = _validate_extraction(structured, reference_text)
            issues.extend(structured.get("_validation_issues") or [])
        except Exception as e:  # never let validation crash extraction
            log.warning(f"[vision_postprocess] validation pass failed: {e}")

    if issues:
        structured["_validation_issues"] = issues
        log.info(f"[vision_postprocess] {len(issues)} issue(s): " + "; ".join(issues[:4]))

    return structured