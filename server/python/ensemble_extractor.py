#!/usr/bin/env python3
"""
ensemble_extractor.py
=====================

Replaces the silent waterfall ("run table parser; if 0 items, try text") with a
candidate-and-reconcile design.

Old flow:
    table -> (if empty) text -> (separately) VLM regex cascade
    Whoever ran first and returned anything won, even a partial 3-of-5 parse.

New flow:
    Run every available extractor as a CANDIDATE in parallel:
        • geometric   (enhancement #1, prior-aware)
        • vlm         (enhancement #2, constrained schema)   [optional]
        • legacy      (existing table/text extractor)         [optional]
    Score each candidate with the invoice's own ARITHMETIC (arithmetic_validator).
    Pick the highest-confidence candidate. If the best is still weak, or the two
    strongest disagree on item count, flag the invoice for human review.
    Feed the geometric column positions back into the supplier profile so the
    same supplier is faster/deterministic next time.

This module is dependency-injected: extractors are passed in as callables, so it
runs and tests without the VLM model or a database present.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import arithmetic_validator as av


# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class Candidate:
    name: str
    line_items: List[Dict[str, Any]]
    header: Dict[str, Any] = field(default_factory=dict)
    extra: Dict[str, Any] = field(default_factory=dict)   # e.g. column_x_positions
    confidence: float = 0.0                                # filled by scoring
    validation: Optional[av.ValidationResult] = None


@dataclass
class EnsembleResult:
    line_items: List[Dict[str, Any]]
    header: Dict[str, Any]
    confidence: float
    chosen: str                       # winning candidate name
    review_recommended: bool
    reasons: List[str]
    candidates: List[Dict[str, Any]]  # per-candidate summary (for the UI/audit)


# review thresholds
REVIEW_BELOW = 0.75          # accept-without-review confidence floor
DISAGREEMENT_FRACTION = 0.25  # item-count divergence that triggers review


# ──────────────────────────────────────────────────────────────────────────────
def score_candidate(c: Candidate) -> Candidate:
    """Attach an arithmetic-based confidence (and repaired items) to a candidate."""
    res = av.validate_invoice(c.line_items, header=c.header, repair=True)
    c.validation = res
    c.line_items = res.repaired_items or c.line_items
    # Blend the candidate's own structural confidence (if any) with arithmetic.
    structural = float(c.extra.get("structural_confidence", 0.0))
    c.confidence = round(0.75 * res.confidence + 0.25 * structural, 3)
    return c


def reconcile(candidates: List[Candidate]) -> EnsembleResult:
    scored = [score_candidate(c) for c in candidates if c.line_items is not None]
    scored = [c for c in scored if c.line_items]  # drop empties
    reasons: List[str] = []

    if not scored:
        return EnsembleResult([], {}, 0.0, "none", True,
                              ["no candidate produced line items"], [])

    scored.sort(key=lambda c: c.confidence, reverse=True)
    best = scored[0]
    reasons.append(f"chose '{best.name}' (conf={best.confidence})")

    review = best.confidence < REVIEW_BELOW
    if review:
        reasons.append(f"confidence {best.confidence} below {REVIEW_BELOW}")

    # Cross-candidate disagreement on item count → review even if conf is high.
    if len(scored) >= 2:
        runner = scored[1]
        n1, n2 = len(best.line_items), len(runner.line_items)
        if max(n1, n2) and abs(n1 - n2) / max(n1, n2) > DISAGREEMENT_FRACTION:
            review = True
            reasons.append(
                f"'{best.name}' found {n1} items, '{runner.name}' found {n2} — disagree"
            )

    if best.validation and best.validation.issues:
        reasons.extend(best.validation.issues[:3])

    summary = [{
        "name": c.name,
        "items": len(c.line_items),
        "confidence": c.confidence,
        "line_consistency": c.validation.line_consistency if c.validation else None,
        "totals_ok": c.validation.totals_ok if c.validation else None,
    } for c in scored]

    return EnsembleResult(
        line_items=best.line_items,
        header=best.header,
        confidence=best.confidence,
        chosen=best.name,
        review_recommended=review,
        reasons=reasons,
        candidates=summary,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Candidate builders
# ──────────────────────────────────────────────────────────────────────────────
def geometric_candidate(pdf_path: str,
                        column_prior: Optional[Dict[str, float]] = None,
                        header: Optional[Dict[str, Any]] = None) -> Optional[Candidate]:
    """Build a candidate from the geometric extractor across the first pages."""
    try:
        import pdfplumber
        import geometric_columns as gc
    except Exception as exc:
        sys.stderr.write(f"[ensemble] geometric unavailable: {exc}\n")
        return None

    all_items: List[Dict[str, Any]] = []
    col_positions: Dict[str, float] = {}
    best_conf = 0.0
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages[:5]:
                r = gc.extract_line_items_geometric(page, column_prior=column_prior)
                if r["line_items"]:
                    all_items.extend(r["line_items"])
                    if r["confidence"] > best_conf:
                        best_conf = r["confidence"]
                        col_positions = r["column_x_positions"]
    except Exception as exc:
        sys.stderr.write(f"[ensemble] geometric failed: {exc}\n")
        return None

    if not all_items:
        return None
    return Candidate(
        name="geometric",
        line_items=all_items,
        header=header or {},
        extra={"structural_confidence": best_conf,
               "column_x_positions": col_positions},
    )


def vlm_candidate(pdf_bytes: bytes,
                  header: Optional[Dict[str, Any]] = None,
                  engine=None) -> Optional[Candidate]:
    """Build a candidate from the constrained VLM extractor."""
    try:
        import vlm_constrained as vc
        from pdf2image import convert_from_bytes
    except Exception as exc:
        sys.stderr.write(f"[ensemble] vlm unavailable: {exc}\n")
        return None
    try:
        images = convert_from_bytes(pdf_bytes, dpi=100)[:3]
        best = None
        for img in images:
            out = vc.extract_constrained(img, engine=engine)
            items = out["structured"].get("lineItems", [])
            if best is None or len(items) > len(best["structured"].get("lineItems", [])):
                best = out
        if not best:
            return None
        s = best["structured"]
        hdr = header or {}
        hdr.setdefault("subtotal", s.get("subtotal"))
        hdr.setdefault("vat", s.get("vat"))
        hdr.setdefault("total", s.get("total"))
        return Candidate(name="vlm", line_items=s.get("lineItems", []), header=hdr)
    except Exception as exc:
        sys.stderr.write(f"[ensemble] vlm failed: {exc}\n")
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Top-level
# ──────────────────────────────────────────────────────────────────────────────
def extract(pdf_path: str,
            *,
            supplier_vat: str = "",
            supplier_name: str = "",
            profiles=None,
            use_vlm: bool = False,
            vlm_engine=None,
            header: Optional[Dict[str, Any]] = None,
            extra_candidates: Optional[List[Candidate]] = None) -> EnsembleResult:
    """
    Full ensemble extraction.

    profiles : an optional SupplierLayoutProfiles instance. When given, its
               learned column_x prior is fed to the geometric extractor, and the
               freshly-detected positions are recorded back after success.
    """
    column_prior = None
    if profiles is not None:
        try:
            column_prior = profiles.get_column_x(vat_id=supplier_vat, name=supplier_name)
        except Exception:
            column_prior = None

    candidates: List[Candidate] = []

    geo = geometric_candidate(pdf_path, column_prior=column_prior, header=header)
    if geo:
        candidates.append(geo)

    if use_vlm:
        try:
            with open(pdf_path, "rb") as f:
                pdf_bytes = f.read()
            v = vlm_candidate(pdf_bytes, header=header, engine=vlm_engine)
            if v:
                candidates.append(v)
        except Exception as exc:
            sys.stderr.write(f"[ensemble] vlm path skipped: {exc}\n")

    if extra_candidates:
        candidates.extend(extra_candidates)

    result = reconcile(candidates)

    # Feed the profile store so this supplier is deterministic next time.
    if profiles is not None and result.chosen == "geometric" and not result.review_recommended:
        try:
            geo_extra = next(c.extra for c in candidates if c.name == "geometric")
            profiles.record_extraction(
                vat_id=supplier_vat,
                invoice_number=(header or {}).get("invoice_number", ""),
                item_count=len(result.line_items),
                success=True,
                name=supplier_name,
                column_x_positions=geo_extra.get("column_x_positions"),
            )
        except Exception as exc:
            sys.stderr.write(f"[ensemble] profile record skipped: {exc}\n")

    return result


# ── end-to-end self-test on a real PDF (geometric + mock VLM) ───────────────────
if __name__ == "__main__":
    import json

    pdf = sys.argv[1] if len(sys.argv) > 1 else \
        "/home/claude/oi/data/invoices/FI69383660620.pdf"

    # A mock VLM candidate that disagrees, to exercise reconciliation/review.
    mock_vlm = Candidate(
        name="vlm",
        line_items=[{"description": "Translation", "quantity": 1, "unitPrice": 164.72,
                     "totalPrice": 164.72}],   # only 1 item — disagrees with geom's 2
        header={"subtotal": 176.90, "vat": 0, "total": 176.90},
    )

    res = extract(pdf, header={"subtotal": 176.90, "vat": 0, "total": 176.90},
                  extra_candidates=[mock_vlm])
    print(json.dumps({
        "chosen": res.chosen,
        "confidence": res.confidence,
        "review_recommended": res.review_recommended,
        "reasons": res.reasons,
        "candidates": res.candidates,
        "items": res.line_items,
    }, indent=2, ensure_ascii=False))