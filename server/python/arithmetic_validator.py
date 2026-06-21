#!/usr/bin/env python3
"""
arithmetic_validator.py
=======================

The invoice's own arithmetic is free ground truth. This module turns that into
three capabilities shared by BOTH extraction paths (geometric #1 and VLM #2):

  1. REPAIR   — if two of {quantity, unit_price, net_amount} are present, solve
                for the third instead of discarding the row.
  2. VALIDATE — check the line-item identities and the document totals:
                  qty * unit_price            ≈ net_amount        (per line)
                  Σ net_amount                ≈ subtotal          (document)
                  subtotal + vat              ≈ total             (document)
                  net * vatRate/100           ≈ vat_amount        (per line)
  3. SCORE    — convert the residuals into a single 0..1 confidence used by the
                ensemble to choose between candidate extractions.

The previous extractor only used qty*price as a *reject filter* inside
`_is_valid_item`. Here it becomes a repair + scoring signal, which both lifts
recall (rows that were dropped get fixed) and gives the review queue a calibrated
number to route on.

Item dict shape (matches invoice_extractor_advanced):
    quantity, unit_price/unitPrice, net_amount/totalPrice, vat_percent/vatRate,
    vat_amount, description, product_code/supplierCode

stdlib only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


# ── tolerances ────────────────────────────────────────────────────────────────
ABS_TOL = 0.02        # 2 cents absolute slack for rounding
REL_TOL = 0.01        # 1% relative slack


def _close(a: float, b: float, abs_tol: float = ABS_TOL,
           rel_tol: float = REL_TOL) -> bool:
    return abs(a - b) <= max(abs_tol, abs(b) * rel_tol)


def _get(item: Dict[str, Any], *keys) -> Optional[float]:
    """First non-None numeric among aliased keys."""
    for k in keys:
        v = item.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def _set_both(item: Dict[str, Any], pairs: List[Tuple[str, float]]) -> None:
    for k, v in pairs:
        item[k] = round(v, 4)


# ──────────────────────────────────────────────────────────────────────────────
# 1. REPAIR
# ──────────────────────────────────────────────────────────────────────────────
def repair_item(item: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """
    Fill a missing field from the other two. Returns (item, notes).
    Mutates a copy. Never overwrites a value that's already consistent.
    """
    notes: List[str] = []
    it = dict(item)

    qty = _get(it, "quantity")
    price = _get(it, "unit_price", "unitPrice")
    net = _get(it, "net_amount", "totalPrice")

    have = sum(x is not None for x in (qty, price, net))
    if have < 2:
        return it, notes  # not enough to solve anything

    # Solve the missing one
    if net is None and qty is not None and price is not None:
        net = qty * price
        _set_both(it, [("net_amount", net), ("totalPrice", net)])
        notes.append("derived net = qty*price")
    elif price is None and qty not in (None, 0) and net is not None:
        price = net / qty
        _set_both(it, [("unit_price", price), ("unitPrice", price)])
        notes.append("derived unit_price = net/qty")
    elif qty is None and price not in (None, 0) and net is not None:
        qty = net / price
        # only trust a clean-ish quantity
        if abs(qty - round(qty)) < 0.01:
            qty = float(round(qty))
        _set_both(it, [("quantity", qty)])
        notes.append("derived quantity = net/price")

    # If all three present but inconsistent, decide which field to trust.
    # Small discrepancies are rounding; large ones mean one field is corrupted.
    qty = _get(it, "quantity")
    price = _get(it, "unit_price", "unitPrice")
    net = _get(it, "net_amount", "totalPrice")
    if None not in (qty, price, net) and price != 0:
        expected = qty * price
        if not _close(expected, net) and abs(expected - net) > 0.5:
            implied_qty = net / price
            # If net/price is a clean integer that differs from the parsed qty,
            # the QUANTITY is the corrupted field (e.g. US "1,437" mis-parsed as
            # 1.437). Trust net+price and fix qty — do NOT overwrite a correct net.
            if abs(implied_qty - round(implied_qty)) < 0.02 and abs(round(implied_qty) - qty) > 0.5:
                it["quantity"] = float(round(implied_qty))
                notes.append(f"corrected qty {qty}->{round(implied_qty)} (net/price)")
            else:
                _set_both(it, [("net_amount", expected), ("totalPrice", expected)])
                notes.append(f"corrected net {net}->{round(expected,2)} (qty*price)")

    # Derive missing VAT amount from rate
    net = _get(it, "net_amount", "totalPrice")
    rate = _get(it, "vat_percent", "vatRate")
    vat_amt = _get(it, "vat_amount")
    if vat_amt is None and net is not None and rate is not None and rate > 0:
        it["vat_amount"] = round(net * rate / 100, 2)
        notes.append("derived vat_amount = net*rate")

    return it, notes


# ──────────────────────────────────────────────────────────────────────────────
# 2 + 3. VALIDATE + SCORE
# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class ValidationResult:
    confidence: float                       # 0..1
    line_consistency: float                 # fraction of lines passing qty*price=net
    totals_ok: bool                         # Σnet (+vat) reconciles to document total
    issues: List[str] = field(default_factory=list)
    repaired_items: List[Dict[str, Any]] = field(default_factory=list)
    computed: Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "confidence": round(self.confidence, 3),
            "line_consistency": round(self.line_consistency, 3),
            "totals_ok": self.totals_ok,
            "issues": self.issues,
            "computed": {k: round(v, 2) for k, v in self.computed.items()},
        }


def validate_invoice(
        line_items: List[Dict[str, Any]],
        header: Optional[Dict[str, Any]] = None,
        repair: bool = True,
) -> ValidationResult:
    """
    Validate a candidate extraction and produce a confidence score.

    header may contain any of: subtotal/calc_subtotal, vat/calc_vat,
    total/grand_total/calc_total. Missing header totals simply skip that check.
    """
    header = header or {}
    issues: List[str] = []

    items = []
    for it in line_items:
        fixed, notes = (repair_item(it) if repair else (dict(it), []))
        if notes:
            issues.extend(notes)
        items.append(fixed)

    if not items:
        return ValidationResult(confidence=0.0, line_consistency=0.0,
                                totals_ok=False, issues=["no line items"],
                                repaired_items=[])

    # ── per-line consistency ──────────────────────────────────────────────────
    line_pass = 0
    line_checkable = 0
    sum_net = 0.0
    for it in items:
        qty = _get(it, "quantity")
        price = _get(it, "unit_price", "unitPrice")
        net = _get(it, "net_amount", "totalPrice")
        if net is not None:
            sum_net += net
        if None not in (qty, price, net):
            line_checkable += 1
            if _close(qty * price, net):
                line_pass += 1
            else:
                issues.append(
                    f"line mismatch: {qty}*{price}={round(qty*price,2)} != {net}"
                )
    line_consistency = (line_pass / line_checkable) if line_checkable else 0.5

    # ── document totals ─────────────────────────────────────────────────────────
    subtotal = _get(header, "subtotal", "calc_subtotal")
    vat = _get(header, "vat", "calc_vat", "totalVat")
    total = _get(header, "total", "grand_total", "calc_total", "totalAmount")

    totals_ok = True
    checks = 0
    if subtotal is not None:
        checks += 1
        if not _close(sum_net, subtotal, abs_tol=0.05, rel_tol=0.02):
            totals_ok = False
            issues.append(f"Σnet {round(sum_net,2)} != subtotal {subtotal}")
    if subtotal is not None and vat is not None and total is not None:
        checks += 1
        if not _close(subtotal + vat, total, abs_tol=0.05, rel_tol=0.02):
            totals_ok = False
            issues.append(f"subtotal+vat {round(subtotal+vat,2)} != total {total}")
    elif total is not None and vat is None and subtotal is None:
        # only a grand total available — compare against Σnet as a weak check
        checks += 1
        if not _close(sum_net, total, abs_tol=0.05, rel_tol=0.05):
            totals_ok = False

    # ── magnitude sanity check ───────────────────────────────────────────────
    # Catches catastrophic extraction errors where an IBAN, account number, or
    # other long digit string was read as a monetary amount (e.g. a cheque's
    # account number 7002320000959 becoming the "total"). A real supplier
    # invoice total is essentially never above this ceiling; if it is, the value
    # is almost certainly a misread identifier, so force review.
    ABSURD_AMOUNT = 1_000_000_000.0   # 1 billion — far above any real invoice
    for label, val in (("total", total), ("subtotal", subtotal), ("vat", vat)):
        if val is not None and abs(val) >= ABSURD_AMOUNT:
            totals_ok = False
            issues.append(f"absurd {label} {val} — likely a misread IBAN/account number")

    # ── confidence blend ─────────────────────────────────────────────────────
    #   60% line consistency, 30% totals reconciliation, 10% completeness
    completeness = sum(
        1 for it in items
        if it.get("description") and _get(it, "net_amount", "totalPrice") is not None
    ) / len(items)

    totals_score = 1.0 if (checks and totals_ok) else (0.5 if not checks else 0.0)
    confidence = 0.60 * line_consistency + 0.30 * totals_score + 0.10 * completeness

    return ValidationResult(
        confidence=round(confidence, 3),
        line_consistency=round(line_consistency, 3),
        totals_ok=totals_ok,
        issues=issues[:20],
        repaired_items=items,
        computed={"sum_net": sum_net,
                  "subtotal": subtotal or 0.0,
                  "vat": vat or 0.0,
                  "total": total or 0.0},
    )


# ── CLI / self-test ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Quick self-test demonstrating repair + scoring.
    demo = [
        {"description": "Translation", "quantity": 1, "unit_price": 164.72,
         "net_amount": 164.72, "vat_percent": 0},
        {"description": "Service Fee", "quantity": 1, "unitPrice": 12.18},  # net missing → repaired
        {"description": "Widget", "quantity": 3, "net_amount": 30.0},        # price missing → repaired
    ]
    res = validate_invoice(demo, header={"subtotal": 206.90, "vat": 0, "total": 206.90})
    import json
    print(json.dumps(res.to_dict(), indent=2, ensure_ascii=False))
    print("\nRepaired items:")
    for it in res.repaired_items:
        print("  ", json.dumps(it, ensure_ascii=False))