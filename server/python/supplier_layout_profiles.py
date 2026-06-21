#!/usr/bin/env python3
"""
supplier_layout_profiles.py
Per-supplier layout profile: stores column x-positions, unit types, VAT rates,
extraction statistics, and myDATA unit normalization.

Why this helps:
  - Suppliers reuse the same invoice layout every time.
  - Knowing column positions up-front lets us skip header detection and go straight
    to bbox-based extraction using the known column map.
  - Tracking extraction success rates surfaces which suppliers still fail, so you
    can add targeted fixes.
  - Greek unit normalization maps OCR variants → canonical myDATA unit codes
    (ΤΕΜΑΧΙΟ, ΚΙΛΟ, ΛΙΤΡΟ, etc.) before they reach SoftOne.

Usage:
    from supplier_layout_profiles import SupplierLayoutProfiles

    profiles = SupplierLayoutProfiles("supplier_profiles.json")

    # After a successful extraction, record the result
    profiles.record_extraction(vat_id="094123456", invoice_number="ΤΠΥ-2026-001",
                               column_x_positions={"code": 42, "description": 95,
                                                   "quantity": 310, "unit": 355,
                                                   "unit_price": 395, "net_amount": 465},
                               units_seen=["ΤΕΜ", "ΚΙΒ"],
                               vat_rates_seen=[24],
                               item_count=12, success=True)

    # Before processing a new invoice from the same supplier
    profile = profiles.get_profile(vat_id="094123456")
    if profile and profile.get("column_x_positions"):
        # Use known columns directly — skip header detection
        pass
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# myDATA / ΑΑΔΕ canonical unit codes and their OCR variant aliases
# Source: ΑΑΔΕ myDATA REST API Documentation v1.0.9 (March 2024)
# ---------------------------------------------------------------------------

MYDATA_UNITS: Dict[str, Dict[str, Any]] = {
    # code → {label_el, label_en, aliases}
    "1":  {"label_el": "ΤΕΜΑΧΙΟ",   "label_en": "Piece",           "aliases": ["ΤΕΜ", "ΤΕΜΑΧ", "ΤΕΜΑΧΙΑ", "TEMAX", "TEMA", "TEMI", "TMX", "ΤΜΧ", "PCS", "PC", "UNIT", "EA", "EACH"]},
    "2":  {"label_el": "ΚΙΛΟ",       "label_en": "Kilogram",        "aliases": ["ΚΙΛ", "ΚΓ", "KG", "KGR", "KGS", "ΚΙΛ."]},
    "3":  {"label_el": "ΛΙΤΡΟ",      "label_en": "Litre",           "aliases": ["ΛΙΤ", "Λ", "LT", "LTR", "LITRE", "LITER"]},
    "4":  {"label_el": "ΜΕΤΡΟ",      "label_en": "Metre",           "aliases": ["ΜΕΤ", "Μ", "ML", "MET", "METRE", "METER", "MTR"]},
    "5":  {"label_el": "ΤΕΤΡ.ΜΕΤΡΟ","label_en": "Square metre",    "aliases": ["ΤΜ", "SQM", "M2", "M²"]},
    "6":  {"label_el": "ΚΥΒ.ΜΕΤΡΟ", "label_en": "Cubic metre",     "aliases": ["ΚΜ", "CBM", "M3", "M³"]},
    "7":  {"label_el": "ΖΕΥΓΟΣ",     "label_en": "Pair",            "aliases": ["ΖΕΥ", "ΖΕΥ.", "PAIR", "PR"]},
    "8":  {"label_el": "ΣΕΤ",        "label_en": "Set",             "aliases": ["ΣΕΤ", "SET", "KIT"]},
    "9":  {"label_el": "ΚΙΒΩΤΙΟ",   "label_en": "Box/Crate",       "aliases": ["ΚΙΒ", "ΚΙΒΩΤ", "BOX", "CTN", "CRATE", "ΚΙΒ."]},
    "10": {"label_el": "ΔΕΜΑ",       "label_en": "Bundle/Package",  "aliases": ["ΔΕΜ", "ΔΕΜ.", "PKG", "PKT", "PAK", "NAK", "MAK", "FAK", "PACK", "PK", "ΠΑΚ"]},
    "11": {"label_el": "ΠΑΛΕΤΑ",     "label_en": "Pallet",          "aliases": ["ΠΑΛ", "PAL", "PLT", "PALET"]},
    "12": {"label_el": "ΤΟΝΝΟΣ",     "label_en": "Tonne",           "aliases": ["ΤΟΝ", "TON", "MT", "T"]},
    "13": {"label_el": "ΓΡΑΜΜΑΡΙΟ",  "label_en": "Gram",            "aliases": ["ΓΡ", "GR", "GRM", "GRAM"]},
    "14": {"label_el": "ΩΡΕΣ ΕΡΓΑΣ","label_en": "Man-hours",       "aliases": ["ΩΡ", "HR", "HRS", "HOUR", "HOURS", "ΩΡΑ", "ΩΡΑ."]},
    "15": {"label_el": "ΗΜΕΡΕΣ",     "label_en": "Days",            "aliases": ["ΗΜ", "DAY", "DAYS"]},
    "16": {"label_el": "ΜΗΝΕΣ",      "label_en": "Months",          "aliases": ["ΜΗΝ", "MONTH", "MONTHS", "MO"]},
    "17": {"label_el": "ΧΡΟΝΙΑ",     "label_en": "Years",           "aliases": ["ΕΤΗ", "YEAR", "YEARS", "YR", "YRS"]},
    "18": {"label_el": "ΕΚΤΥΠΩΣΗ",  "label_en": "Print/Page",      "aliases": ["ΣΕΛ", "PAGE", "PAGES", "PRINT", "PG"]},
    "98": {"label_el": "ΧΙΛΙΑΔΕΣ",  "label_en": "Thousands",       "aliases": ["ΧΙΛ", "ΧΙΛΙ", "K", "THOU"]},
    "99": {"label_el": "ΑΛΛΟ",       "label_en": "Other",           "aliases": ["ΑΛΛ", "OTHER", "OTH", "MISC", "—"]},
}

# Build a fast reverse-lookup: alias.upper() → myDATA code
_ALIAS_TO_CODE: Dict[str, str] = {}
for _code, _info in MYDATA_UNITS.items():
    for _alias in _info["aliases"]:
        _ALIAS_TO_CODE[_alias.upper()] = _code
    # Also register the canonical Greek label itself
    _ALIAS_TO_CODE[_info["label_el"].upper()] = _code


def normalize_unit(raw_unit: str) -> Dict[str, str]:
    """
    Normalize a raw unit string (OCR output, supplier abbreviation, etc.) to the
    canonical myDATA code + label.

    Returns:
        {
            "code":     "1",          # myDATA unit code
            "label_el": "ΤΕΜΑΧΙΟ",   # canonical Greek label
            "label_en": "Piece",      # canonical English label
            "raw":      "TEMAX",      # original input
            "matched":  True,         # False if we fell back to "99 ΑΛΛΟ"
        }
    """
    cleaned = re.sub(r'[.\s]', '', raw_unit or "").upper()
    code = _ALIAS_TO_CODE.get(cleaned)

    if not code:
        # Try partial match: OCR garbling often drops a character
        for alias, c in _ALIAS_TO_CODE.items():
            if len(alias) >= 3 and (alias in cleaned or cleaned in alias):
                code = c
                break

    if code:
        info = MYDATA_UNITS[code]
        return {
            "code":     code,
            "label_el": info["label_el"],
            "label_en": info["label_en"],
            "raw":      raw_unit,
            "matched":  True,
        }

    return {
        "code":     "99",
        "label_el": "ΑΛΛΟ",
        "label_en": "Other",
        "raw":      raw_unit,
        "matched":  False,
    }


# ---------------------------------------------------------------------------
# SupplierLayoutProfiles — persistent JSON store
# ---------------------------------------------------------------------------

class SupplierLayoutProfiles:
    """
    Stores and retrieves per-supplier invoice layout profiles.

    Profile structure (keyed by supplier VAT ID or name-hash):
    {
        "vat_id": "094123456",
        "name": "ΑΛΦΑ ΤΡΟΦΙΜΑ Α.Ε.",
        "invoice_count": 47,
        "last_seen": "2026-03-21T14:22:00",
        "first_seen": "2025-10-01T09:00:00",
        "success_rate": 0.94,         # fraction of invoices with items extracted
        "avg_item_count": 14.2,
        "column_x_positions": {       # median x0 per column, from bbox extraction
            "code": 42.0,
            "description": 95.0,
            "quantity": 310.0,
            "unit": 355.0,
            "unit_price": 395.0,
            "discount1": null,
            "net_amount": 465.0,
            "vat_pct": 510.0,
            "vat_amount": null
        },
        "y_tolerance": 4.0,           # row-band height from observed spacing
        "min_gap": 12.0,              # min col gap from observed layout
        "units_seen": {"1": 43, "9": 12},  # myDATA code → occurrence count
        "vat_rates_seen": [24],       # most common VAT rates
        "currency": "EUR",
        "doc_types_seen": {"invoice": 40, "credit_note": 7},
        "extraction_log": [           # last 10 extraction results (ring buffer)
            {"ts": "...", "invoice_number": "ΤΠΥ-...", "items": 14, "success": true},
            ...
        ]
    }
    """

    RING_BUFFER_SIZE = 10

    def __init__(self, profiles_path: str = "supplier_profiles.json"):
        self.profiles_path = profiles_path
        self._data: Dict[str, Any] = self._load()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_profile(self, vat_id: str = "", name: str = "") -> Optional[Dict[str, Any]]:
        """Return profile dict or None if not found."""
        key = self._key(vat_id, name)
        return self._data.get(key)

    def get_column_x(self, vat_id: str = "", name: str = "") -> Optional[Dict[str, Optional[float]]]:
        """Return column x-positions or None if unknown / insufficient history."""
        profile = self.get_profile(vat_id, name)
        if not profile:
            return None
        # Only trust positions if we have seen at least 3 successful invoices
        if profile.get("invoice_count", 0) < 3:
            return None
        cols = profile.get("column_x_positions")
        if not cols:
            return None
        # Require at least description + one numeric column
        has_desc    = cols.get("description") is not None
        has_numeric = any(cols.get(k) is not None for k in ("quantity", "unit_price", "net_amount"))
        return cols if (has_desc and has_numeric) else None

    def record_extraction(
        self,
        vat_id: str,
        invoice_number: str,
        item_count: int,
        success: bool,
        name: str = "",
        column_x_positions: Optional[Dict[str, Optional[float]]] = None,
        units_seen: Optional[List[str]] = None,
        vat_rates_seen: Optional[List[float]] = None,
        doc_type: str = "invoice",
        currency: str = "EUR",
        bbox_y_tolerance: float = 4.0,
        bbox_min_gap: float = 12.0,
    ) -> None:
        """Record one extraction result and update the profile."""
        key     = self._key(vat_id, name)
        profile = self._data.setdefault(key, {
            "vat_id":           vat_id,
            "name":             name,
            "invoice_count":    0,
            "success_count":    0,
            "first_seen":       datetime.now().isoformat(),
            "last_seen":        None,
            "avg_item_count":   0.0,
            "column_x_positions": {},
            "y_tolerance":      bbox_y_tolerance,
            "min_gap":          bbox_min_gap,
            "units_seen":       {},
            "vat_rates_seen":   [],
            "currency":         currency,
            "doc_types_seen":   {},
            "extraction_log":   [],
        })

        # Counts
        prev_count     = profile["invoice_count"]
        profile["invoice_count"] = prev_count + 1
        if success:
            profile["success_count"] = profile.get("success_count", 0) + 1
        profile["success_rate"] = (
            profile["success_count"] / profile["invoice_count"]
        )
        profile["last_seen"] = datetime.now().isoformat()

        # Rolling average item count
        if item_count > 0:
            prev_avg = profile["avg_item_count"]
            profile["avg_item_count"] = (
                (prev_avg * prev_count + item_count) / profile["invoice_count"]
            )

        # Column x-positions: running median using Welford-style accumulator
        if column_x_positions and success:
            self._update_column_positions(profile, column_x_positions, bbox_y_tolerance, bbox_min_gap)

        # Units seen (normalize → myDATA code)
        if units_seen:
            for raw_unit in units_seen:
                norm = normalize_unit(raw_unit)
                code = norm["code"]
                profile["units_seen"][code] = profile["units_seen"].get(code, 0) + 1

        # VAT rates
        if vat_rates_seen:
            existing = set(profile.get("vat_rates_seen", []))
            existing.update(vat_rates_seen)
            profile["vat_rates_seen"] = sorted(existing)

        # Currency
        if currency:
            profile["currency"] = currency

        # Doc types
        profile["doc_types_seen"][doc_type] = (
            profile["doc_types_seen"].get(doc_type, 0) + 1
        )

        # Extraction log ring buffer
        log_entry = {
            "ts":             datetime.now().isoformat(),
            "invoice_number": invoice_number,
            "items":          item_count,
            "success":        success,
        }
        ring = profile.setdefault("extraction_log", [])
        ring.append(log_entry)
        if len(ring) > self.RING_BUFFER_SIZE:
            profile["extraction_log"] = ring[-self.RING_BUFFER_SIZE:]

        self._save()
        log.debug(f"[Profiles] Updated profile for {key} (invoice_count={profile['invoice_count']})")

    def get_dominant_unit(self, vat_id: str = "", name: str = "") -> Optional[str]:
        """Return the most commonly seen myDATA unit code for this supplier."""
        profile = self.get_profile(vat_id, name)
        if not profile:
            return None
        units = profile.get("units_seen", {})
        if not units:
            return None
        return max(units, key=lambda k: units[k])

    def get_expected_vat_rates(self, vat_id: str = "", name: str = "") -> List[float]:
        """Return the VAT rates seen for this supplier (sorted)."""
        profile = self.get_profile(vat_id, name)
        if not profile:
            return []
        return profile.get("vat_rates_seen", [])

    def all_profiles(self) -> List[Dict[str, Any]]:
        """Return all profiles sorted by invoice count descending."""
        return sorted(
            self._data.values(),
            key=lambda p: p.get("invoice_count", 0),
            reverse=True,
        )

    def get_low_accuracy_suppliers(self, threshold: float = 0.70) -> List[Dict[str, Any]]:
        """Return suppliers whose extraction success rate is below threshold."""
        return [
            p for p in self._data.values()
            if p.get("invoice_count", 0) >= 3
            and p.get("success_rate", 1.0) < threshold
        ]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _key(self, vat_id: str, name: str) -> str:
        if vat_id and vat_id.strip():
            # Normalize: strip "EL" prefix, strip spaces
            return re.sub(r'^EL', '', vat_id.strip().upper().replace(" ", ""))
        # Fall back to first 20 chars of name (uppercase, no punctuation)
        slug = re.sub(r'[^A-ZΑ-Ω0-9]', '', (name or "UNKNOWN").upper())
        return slug[:20] or "UNKNOWN"

    def _update_column_positions(
        self,
        profile: Dict[str, Any],
        new_positions: Dict[str, Optional[float]],
        y_tolerance: float,
        min_gap: float,
    ) -> None:
        """
        Update per-column running median using an exponential moving average.
        EMA alpha = 0.3 (recent observations weighted, but history kept).
        """
        alpha = 0.3
        existing = profile.setdefault("column_x_positions", {})
        for col, new_x in new_positions.items():
            if new_x is None:
                existing.setdefault(col, None)
                continue
            prev = existing.get(col)
            if prev is None:
                existing[col] = new_x
            else:
                existing[col] = round(alpha * new_x + (1 - alpha) * prev, 1)

        # Update bbox tuning params
        profile["y_tolerance"] = round(
            alpha * y_tolerance + (1 - alpha) * profile.get("y_tolerance", y_tolerance), 2
        )
        profile["min_gap"] = round(
            alpha * min_gap + (1 - alpha) * profile.get("min_gap", min_gap), 2
        )

    def _load(self) -> Dict[str, Any]:
        if not os.path.exists(self.profiles_path):
            return {}
        try:
            with open(self.profiles_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            log.warning(f"[Profiles] Failed to load {self.profiles_path}: {e}")
            return {}

    def _save(self) -> None:
        try:
            with open(self.profiles_path, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            log.error(f"[Profiles] Failed to save {self.profiles_path}: {e}")


# ---------------------------------------------------------------------------
# CLI — run for diagnostics
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse, json as _json

    parser = argparse.ArgumentParser(description="Supplier layout profiles tool")
    parser.add_argument("profiles_file", nargs="?", default="supplier_profiles.json")
    parser.add_argument("--list",   action="store_true", help="List all profiles")
    parser.add_argument("--low",    action="store_true", help="List low-accuracy suppliers")
    parser.add_argument("--unit",   metavar="RAW",       help="Normalize a unit string")
    args = parser.parse_args()

    if args.unit:
        result = normalize_unit(args.unit)
        print(_json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0)

    profiles = SupplierLayoutProfiles(args.profiles_file)

    if args.low:
        low = profiles.get_low_accuracy_suppliers()
        if low:
            print(f"\n{'='*60}")
            print(f"Low-accuracy suppliers (< 70% success rate):")
            print(f"{'='*60}")
            for p in low:
                print(f"  {p.get('name') or p.get('vat_id'): <30} "
                      f"success={p['success_rate']:.0%}  "
                      f"invoices={p['invoice_count']}")
        else:
            print("No low-accuracy suppliers found.")
        sys.exit(0)

    all_p = profiles.all_profiles()
    if not all_p:
        print(f"No profiles in {args.profiles_file}")
        sys.exit(0)

    print(f"\n{'='*80}")
    print(f"Supplier layout profiles ({args.profiles_file}) — {len(all_p)} entries")
    print(f"{'='*80}")
    for p in all_p:
        cols = p.get("column_x_positions") or {}
        col_summary = ", ".join(
            f"{k}={v:.0f}" for k, v in cols.items() if v is not None
        )
        units = p.get("units_seen") or {}
        unit_summary = ", ".join(
            f"{MYDATA_UNITS.get(c, {}).get('label_el', c)}×{n}"
            for c, n in sorted(units.items(), key=lambda x: -x[1])[:3]
        )
        print(
            f"  {(p.get('name') or p.get('vat_id')): <32} "
            f"inv={p.get('invoice_count', 0):>3}  "
            f"ok={p.get('success_rate', 0):.0%}  "
            f"avg_items={p.get('avg_item_count', 0):.1f}  "
            f"units=[{unit_summary}]"
        )
        if col_summary:
            print(f"    cols: {col_summary}")
    print()
