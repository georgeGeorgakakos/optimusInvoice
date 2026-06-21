#!/usr/bin/env python3
"""
geometric_columns.py
====================

Geometric line-item extraction for Optimus (enhancement #1).

Reconstructs invoice tables from the *positions* of words on a born-digital PDF
page, instead of relying on pdfplumber's grid detection. Works on borderless and
partially-ruled Greek invoices where `page.extract_tables()` returns garbage.

Why this exists
---------------
The previous `ocr_helper._extract_bbox_table()` had three structural flaws:

  1. It bucketed every word by its LEFT edge (`x0`). Numeric columns on Greek
     invoices (ΤΙΜΗ, ΑΞΙΑ, ΦΠΑ) are RIGHT-aligned, so a price of "1.234,56" and
     a price of "9,90" start at very different x0 values and land in different
     buckets — shredding the column.
  2. It pooled x-gaps across ALL rows at once, so one wide header token could
     erase a real column boundary.
  3. It never used the per-supplier `column_x` prior that the profile store is
     already maintaining (write-only until now).

This module fixes all three:

  * Tokens are assigned to columns by their CENTRE x, then anchors are refined
    with a few Lloyd (k-means) iterations so numeric anchors migrate to where the
    numbers actually sit — alignment-agnostic.
  * Columns are ANCHORED to the detected header row (or to a learned prior),
    not to a global gap histogram.
  * A trusted supplier prior (>=3 invoices seen) overrides header guessing
    entirely, making repeat suppliers near-deterministic.

Output is *semantically labelled* (code / description / quantity / unit_price /
net_amount / vat_percent / unit), in the same item dict shape used by
`invoice_extractor_advanced._extract_item_by_columns`, plus the detected
`column_x_positions` so the caller can feed them back to
`SupplierLayoutProfiles.record_extraction(column_x_positions=...)`.

Dependencies: pdfplumber (already a project dep) + stdlib only.
"""

from __future__ import annotations

import re
import sys
import difflib
import statistics
from typing import Any, Dict, List, Optional, Tuple

# ── Canonical column lexicon (Greek + English) ───────────────────────────────
# label -> list of header tokens that map to it. Matching is fuzzy (difflib),
# so OCR corruption like "EIAOE" for "ΕΙΔΟΣ" still resolves.
COLUMN_LEXICON: Dict[str, List[str]] = {
    "aa":          ["α/α", "a/a", "αα", "no", "#"],
    "code":        ["κωδικος", "κωδ", "code", "sku", "barcode", "item code", "item no"],
    "description": ["περιγραφη", "αιτιολογια", "description", "product", "service",
                    "ονομασια", "προϊον", "προιον", "ειδος", "ειδη", "item"],
    "quantity":    ["ποσοτητα", "ποσοτ", "ποσ", "qty", "quantity", "τεμαχια", "τεμ"],
    "unit":        ["μοναδα", "μον", "μ.μ", "mm", "unit", "uom", "μετρησης"],
    "unit_price":  ["τιμη μοναδας", "τιμη", "unit price", "price", "τ.μ", "rate"],
    "discount":    ["εκπτωση", "εκπτ", "discount", "εκπ"],
    "net_amount":  ["αξια", "καθαρη αξια", "καθαρο", "μερικο συνολο", "net", "amount",
                    "value", "total", "συνολο"],
    "vat_percent": ["φπα %", "φπα%", "% φπα", "vat %", "vat%", "συντελεστης φπα"],
    "vat_amount":  ["ποσο φπα", "αξια φπα", "vat amount"],
}

# Header tokens that, if present, mark the END of the line-item table.
STOP_TOKENS = [
    "συνολα", "συνολο", "πληρωτ", "παρακρατ", "κρατησ", "χαρτοσημ",
    "ολικο συνολο", "τελικο συνολο", "γενικο συνολο", "αναλυση",
    "method", "paid with", "purchased on", "have an invoice",
]

NUMERIC_LABELS = {"quantity", "unit_price", "discount", "net_amount",
                  "vat_percent", "vat_amount"}


# ──────────────────────────────────────────────────────────────────────────────
# Number parsing (Greek 1.234,56  /  EU 1,234.56  /  plain)
# ──────────────────────────────────────────────────────────────────────────────
def parse_number(text: Optional[str]) -> Optional[float]:
    """
    Locale-robust number parser. Resolves the comma/dot ambiguity:
      - both separators present → the LAST one is the decimal sep
        (1.234,56 → 1234.56 ; 1,234.56 → 1234.56)
      - only a comma → 3 digits after = thousands (US 1,437 → 1437),
        otherwise decimal (164,72 → 164.72)
      - only a dot   → 3 digits after = thousands (1.437 → 1437),
        otherwise decimal (646.65 → 646.65)
    Strips currency symbols ($ € £ ¥) so US "$646.65" parses cleanly.
    """
    if text is None:
        return None
    s = str(text).strip()
    s = re.sub(r"[€$£¥\s]", "", s).replace("%", "")
    if not s or not re.search(r"\d", s):
        return None
    neg = s.startswith("-")
    s = s.lstrip("+-")
    last_comma, last_dot = s.rfind(","), s.rfind(".")
    try:
        if last_comma >= 0 and last_dot >= 0:
            if last_comma > last_dot:                 # EU: comma decimal
                s = s.replace(".", "").replace(",", ".")
            else:                                     # US: dot decimal
                s = s.replace(",", "")
        elif last_comma >= 0:
            after = len(s) - last_comma - 1
            if after == 3 and len(s.replace(",", "")) > 3:
                s = s.replace(",", "")                # 1,437 → 1437 (thousands)
            else:
                s = s.replace(",", ".")               # 164,72 → 164.72 (decimal)
        elif last_dot >= 0:
            after = len(s) - last_dot - 1
            if after == 3 and len(s.replace(".", "")) > 3:
                s = s.replace(".", "")                # 1.437 → 1437 (thousands)
            # else dot is the decimal separator — leave as-is
        val = float(s)
        return -val if neg else val
    except ValueError:
        return None


def _norm(text: str) -> str:
    """Lowercase, strip accents/punctuation for fuzzy header matching."""
    t = text.lower().strip()
    # crude Greek accent fold
    accents = str.maketrans("άέήίόύώϊϋΐΰ", "αεηιουωιυιυ")
    t = t.translate(accents)
    t = re.sub(r"[^a-zα-ω0-9% ]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _best_label(header_text: str, threshold: float = 0.72) -> Optional[str]:
    """Fuzzy-match a header cell to a canonical column label."""
    h = _norm(header_text)
    if not h:
        return None
    best_label, best_score = None, 0.0
    for label, variants in COLUMN_LEXICON.items():
        for v in variants:
            # token containment is a strong signal
            if v in h or h in v:
                score = 0.92
            else:
                score = difflib.SequenceMatcher(None, h, v).ratio()
            if score > best_score:
                best_label, best_score = label, score
    return best_label if best_score >= threshold else None


# ──────────────────────────────────────────────────────────────────────────────
# Row clustering
# ──────────────────────────────────────────────────────────────────────────────
def _cluster_rows(words: List[dict], y_tolerance: float) -> List[List[dict]]:
    """Group words into horizontal bands by vertical midpoint proximity."""
    bands: List[Tuple[float, List[dict]]] = []
    for w in sorted(words, key=lambda x: (x["top"] + x["bottom"]) / 2):
        y_mid = (w["top"] + w["bottom"]) / 2
        for i, (key, members) in enumerate(bands):
            if abs(key - y_mid) <= y_tolerance:
                members.append(w)
                # update running key (mean) for stability
                bands[i] = ((key * (len(members) - 1) + y_mid) / len(members), members)
                break
        else:
            bands.append((y_mid, [w]))
    return [members for _, members in bands]


def _word_center(w: dict) -> float:
    return (w["x0"] + w["x1"]) / 2


# ──────────────────────────────────────────────────────────────────────────────
# Header detection + column anchoring
# ──────────────────────────────────────────────────────────────────────────────
def _find_header(rows: List[List[dict]]) -> Tuple[int, Dict[str, float]]:
    """
    Find the row that best looks like a column header.
    Returns (row_index, {label: x_center}). row_index = -1 if none found.
    """
    best_idx, best_anchors, best_hits = -1, {}, 0
    # Scan the whole page: on many invoices the line-item header sits well below
    # the address/meta block (row 17-20). The has_text + has_num guard below stops
    # footer rows ("NET AMOUNT (EUR) 212.08") being mistaken for a header.
    for idx, row in enumerate(rows):
        anchors: Dict[str, float] = {}
        for w in sorted(row, key=lambda x: x["x0"]):
            label = _best_label(w["text"])
            if label and label not in anchors:
                anchors[label] = _word_center(w)
        hits = len(anchors)
        has_text = "description" in anchors or "code" in anchors
        has_num = any(l in anchors for l in ("quantity", "unit_price", "net_amount"))
        if hits > best_hits and has_text and has_num:
            best_idx, best_anchors, best_hits = idx, anchors, hits
    return best_idx, best_anchors


def _refine_anchors(body_rows: List[List[dict]],
                    anchors: Dict[str, float],
                    iterations: int = 3) -> Dict[str, float]:
    """
    Lloyd / k-means refinement: assign every body token to its nearest anchor,
    then move each anchor to the mean centre of its assigned tokens. This pulls
    right-aligned numeric anchors to where the digits actually sit, regardless of
    where the header label was printed.
    """
    labels = list(anchors.keys())
    # Only refine on rows that look like genuine grid rows (tokens spread across
    # most columns). Continuation lines, currency-conversion lines and stray
    # footer text would otherwise drag the anchors sideways.
    min_distinct = max(2, len(labels) - 2)
    grid_rows = []
    for row in body_rows:
        hit = {min(labels, key=lambda l: abs(anchors[l] - _word_center(w))) for w in row}
        if len(hit) >= min_distinct:
            grid_rows.append(row)
    if not grid_rows:
        grid_rows = body_rows  # fall back rather than refine on nothing

    for _ in range(iterations):
        buckets: Dict[str, List[float]] = {l: [] for l in labels}
        for row in grid_rows:
            for w in row:
                cx = _word_center(w)
                nearest = min(labels, key=lambda l: abs(anchors[l] - cx))
                buckets[nearest].append(cx)
        for l in labels:
            if buckets[l]:
                anchors[l] = statistics.median(buckets[l])
    return anchors


# ──────────────────────────────────────────────────────────────────────────────
# Main entry point
# ──────────────────────────────────────────────────────────────────────────────
def extract_line_items_geometric(
        page,
        column_prior: Optional[Dict[str, float]] = None,
        y_tolerance: float = 4.0,
) -> Dict[str, Any]:
    """
    Extract semantically-labelled line items from a pdfplumber page using
    word geometry.

    Args:
        page:          a pdfplumber Page object.
        column_prior:  optional {label: x_center} from the supplier profile
                       (SupplierLayoutProfiles.get_column_x()). When supplied and
                       trusted, it ANCHORS the columns directly — no header guess.
        y_tolerance:   vertical band tolerance in points.

    Returns dict:
        {
          "line_items":         [ {item dict}, ... ],   # extractor-compatible shape
          "column_x_positions": {label: x_center},      # feed to record_extraction()
          "source":             "prior" | "header",     # how columns were anchored
          "confidence":         0.0-1.0,                 # structural confidence
          "header_row_index":   int,
        }
    """
    try:
        words = page.extract_words(x_tolerance=2, y_tolerance=3,
                                   keep_blank_chars=False)
    except Exception as exc:
        sys.stderr.write(f"[geom] extract_words failed: {exc}\n")
        return _empty()

    if not words:
        return _empty()

    rows = _cluster_rows(words, y_tolerance)
    if len(rows) < 2:
        return _empty()

    # ── Anchor the columns ────────────────────────────────────────────────────
    if column_prior:
        anchors = dict(column_prior)
        header_idx = -1
        source = "prior"
    else:
        header_idx, anchors = _find_header(rows)
        source = "header"
        if header_idx < 0 or not anchors:
            return _empty()

    # Body rows = everything after the header (or all rows when using a prior,
    # minus any row that fuzzy-matches header tokens).
    if source == "prior":
        body_rows = [r for r in rows if not _is_header_like(r)]
    else:
        body_rows = rows[header_idx + 1:]

    # Stop at the totals / footer band.
    body_rows = _truncate_at_footer(body_rows)
    if not body_rows:
        return _empty()

    # Refine anchors against the body so numeric columns sit correctly.
    anchors = _refine_anchors(body_rows, anchors)

    labels = list(anchors.keys())
    items: List[dict] = []
    for row in body_rows:
        cells: Dict[str, List[str]] = {l: [] for l in labels}
        for w in sorted(row, key=lambda x: x["x0"]):
            cx = _word_center(w)
            nearest = min(labels, key=lambda l: abs(anchors[l] - cx))
            cells[nearest].append(w["text"])
        item = _build_item(cells)
        if item:
            items.append(item)

    confidence = _structural_confidence(items, anchors)

    # Record where each column actually landed (median centre) for the profile.
    detected_positions = {l: round(anchors[l], 1) for l in labels}

    sys.stderr.write(
        f"[geom] {len(items)} items via {source} anchoring "
        f"({len(labels)} cols, conf={confidence:.2f})\n"
    )

    return {
        "line_items": items,
        "column_x_positions": detected_positions,
        "source": source,
        "confidence": confidence,
        "header_row_index": header_idx,
    }


# ── helpers ───────────────────────────────────────────────────────────────────
def _empty() -> Dict[str, Any]:
    return {"line_items": [], "column_x_positions": {}, "source": None,
            "confidence": 0.0, "header_row_index": -1}


def _is_header_like(row: List[dict]) -> bool:
    text = _norm(" ".join(w["text"] for w in row))
    hits = sum(1 for label in COLUMN_LEXICON
               for v in COLUMN_LEXICON[label] if v in text)
    return hits >= 2


def _truncate_at_footer(body_rows: List[List[dict]]) -> List[List[dict]]:
    out = []
    for row in body_rows:
        text = _norm(" ".join(w["text"] for w in row))
        if any(stop in text for stop in STOP_TOKENS) and not _row_has_item_numbers(row):
            break
        out.append(row)
    return out


def _row_has_item_numbers(row: List[dict]) -> bool:
    nums = [parse_number(w["text"]) for w in row]
    return sum(1 for n in nums if n is not None and n > 0) >= 2


def _build_item(cells: Dict[str, List[str]]) -> Optional[dict]:
    """Map labelled cells to the extractor's item dict shape."""
    def joined(label: str) -> str:
        return re.sub(r"\s+", " ", " ".join(cells.get(label, []))).strip()

    item: dict = {}

    code = joined("code") or joined("aa")
    if code and re.search(r"\w", code):
        item["product_code"] = code
        item["supplierCode"] = code

    desc = joined("description")
    if desc and len(desc) > 1 and not re.fullmatch(r"[\d.,\s€%]+", desc):
        item["description"] = desc

    unit = joined("unit")
    if unit:
        item["unit"] = unit

    qty = parse_number(joined("quantity"))
    if qty is not None:
        item["quantity"] = qty

    price = parse_number(joined("unit_price"))
    if price is not None:
        item["unit_price"] = price
        item["unitPrice"] = price

    disc = parse_number(joined("discount"))
    if disc is not None:
        item["discount_1"] = disc

    net = parse_number(joined("net_amount"))
    if net is not None:
        item["net_amount"] = net
        item["totalPrice"] = net

    vat_pct = parse_number(joined("vat_percent"))
    if vat_pct is not None and vat_pct <= 100:
        item["vat_percent"] = vat_pct
        item["vatRate"] = vat_pct

    vat_amt = parse_number(joined("vat_amount"))
    if vat_amt is not None:
        item["vat_amount"] = vat_amt

    # Require an identity AND a MONETARY value (net or unit price). A row with
    # only a stray quantity and no amount is almost always a fragment of a
    # complex layout (e.g. a usage/tier table), not a real invoice line.
    has_identity = item.get("description") or item.get("product_code")
    has_money = item.get("net_amount") is not None or item.get("unit_price") is not None
    return item if (has_identity and has_money) else None


def _structural_confidence(items: List[dict], anchors: Dict[str, float]) -> float:
    """
    Cheap structural confidence (NOT arithmetic — that lives in
    arithmetic_validator). Rewards: having items, full column coverage,
    consistent field population across rows.
    """
    if not items:
        return 0.0
    score = 0.4
    if {"description", "net_amount"} <= set(anchors) or \
            {"description", "unit_price"} <= set(anchors):
        score += 0.2
    # Field-population consistency: do most rows have qty & price?
    with_qty = sum(1 for i in items if i.get("quantity") is not None)
    with_price = sum(1 for i in items if i.get("unit_price") is not None)
    score += 0.2 * (with_qty / len(items))
    score += 0.2 * (with_price / len(items))
    return round(min(score, 1.0), 3)


# ── CLI smoke test ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import json
    import pdfplumber

    if len(sys.argv) < 2:
        print("Usage: geometric_columns.py <pdf_path>")
        sys.exit(1)

    with pdfplumber.open(sys.argv[1]) as pdf:
        for pno, page in enumerate(pdf.pages[:3]):
            res = extract_line_items_geometric(page)
            print(f"\n=== Page {pno + 1} | source={res['source']} "
                  f"conf={res['confidence']} cols={list(res['column_x_positions'])} ===")
            for it in res["line_items"]:
                print("  ", json.dumps(it, ensure_ascii=False))