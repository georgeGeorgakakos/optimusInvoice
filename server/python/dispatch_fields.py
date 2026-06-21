#!/usr/bin/env python3
"""
Dispatch field extraction for combined Greek documents.

Problem this solves
-------------------
For "Τιμολόγιο Πώλησης - Δελτίο Αποστολής" (combined ΤΔΑ) documents, the
classifier correctly returns documentType="invoice" — but the invoice branch
of the extraction pipeline does NOT capture dispatch fields (date, vehicle,
purpose), even though those fields are present in the document text and are
required by the METRO PoC §4 spec.

This module provides a generic extractor that can be called from any branch
of the pipeline (invoice, dispatch_note, credit_note) and returns the three
dispatch fields. Missing fields are returned as None.

Usage
-----
    from dispatch_fields import extract_dispatch_fields

    dispatch = extract_dispatch_fields(raw_text)
    # → {"dispatchDate": "01/03/2026", "vehicleNumber": "ABC-1234", "purpose": "ΠΩΛΗΣΗ"}
"""

import re
from typing import Dict, Optional


# ── Pre-compiled patterns ────────────────────────────────────────────────────

_DISPATCH_DATE_PATTERNS = [
    re.compile(
        r'(?:Ημ(?:ερ)?\.?\s*Διακίν|Ημερομηνία\s+Διακίν|'
        r'Ημ(?:ερ)?\.?\s*Αποστολ|Date\s+of\s+Dispatch|Dispatch\s+Date)'
        r'[^\n]{0,40}?(\d{1,2}[\./\-]\d{1,2}[\./\-]\d{2,4})',
        re.IGNORECASE,
    ),
    # Time-prefixed variant: "Ώρα Διακίνησης ... Ημ/νία 01/03/2026"
    re.compile(
        r'(?:Ώρα\s+Διακίν[^\n]{0,80}?)(\d{1,2}[\./\-]\d{1,2}[\./\-]\d{2,4})',
        re.IGNORECASE,
    ),
]

_VEHICLE_PATTERNS = [
    re.compile(
        r'(?:Αρ(?:ιθμ)?\.?\s*(?:Αυτοκινήτου|Οχήματος|Πινακίδας)|'
        r'Πινακίδα(?:\s+Οχήματος)?|Vehicle\s+(?:No|Number|Plate)|Plate\s+(?:No|Number))'
        r'[\s:.\-]+([A-ZΑ-Ω]{2,3}[\s\-]?\d{3,4}[A-ZΑ-Ω]?)',
        re.IGNORECASE,
    ),
    # Bare Greek plate near "Όχημα" / "Φορτηγό"
    re.compile(
        r'(?:Όχημα|Φορτηγό|Truck)[\s:]+([A-ZΑ-Ω]{2,3}[\s\-]?\d{3,4}[A-ZΑ-Ω]?)',
        re.IGNORECASE,
    ),
]

_PURPOSE_PATTERNS = [
    re.compile(
        r'(?:Σκοπός\s+Διακίν(?:ησης)?|Αιτία\s+Διακίν(?:ησης)?|'
        r'Αιτία\s+Αποστολ(?:ής)?|Purpose\s+of\s+Dispatch)'
        r'[\s:]+([^\n]{3,80})',
        re.IGNORECASE,
    ),
]

# Standard Greek dispatch-purpose keywords — used as a fallback when no labelled
# field is present (e.g., a stamp / box that just contains one of these words)
_KNOWN_PURPOSES = [
    "ΠΩΛΗΣΗ",
    "ΕΠΙΣΤΡΟΦΗ",
    "ΔΕΙΓΜΑΤΙΣΜΟΣ",
    "ΕΠΙΣΚΕΥΗ",
    "ΕΝΔΟΔΙΑΚΙΝΗΣΗ",
    "ΑΠΟΘΗΚΕΥΣΗ",
    "ΦΥΛΑΞΗ",
]


# ── Public API ───────────────────────────────────────────────────────────────

def extract_dispatch_fields(text: str) -> Dict[str, Optional[str]]:
    """
    Extract dispatch-related fields from invoice/ΤΔΑ text.

    Returns:
        {
            "dispatchDate":  "01/03/2026" or None,
            "vehicleNumber": "ABC-1234" or None,
            "purpose":       "ΠΩΛΗΣΗ" or None,
        }
    """
    result: Dict[str, Optional[str]] = {
        "dispatchDate": None,
        "vehicleNumber": None,
        "purpose": None,
    }

    if not text:
        return result

    # Dispatch date
    for pat in _DISPATCH_DATE_PATTERNS:
        m = pat.search(text)
        if m:
            result["dispatchDate"] = m.group(1).strip()
            break

    # Vehicle number — normalise whitespace around the plate
    for pat in _VEHICLE_PATTERNS:
        m = pat.search(text)
        if m:
            plate = re.sub(r'\s+', '', m.group(1)).strip()
            if plate:
                result["vehicleNumber"] = plate
                break

    # Purpose — labelled first, then fallback to known-purpose keywords
    for pat in _PURPOSE_PATTERNS:
        m = pat.search(text)
        if m:
            val = m.group(1).strip().rstrip('.,;:')
            # Trim trailing noise — purposes are short
            val = re.split(r'\s{3,}|[\|]', val)[0].strip()
            if val:
                result["purpose"] = val
                break

    if not result["purpose"]:
        upper = text.upper()
        for kw in _KNOWN_PURPOSES:
            if kw in upper:
                result["purpose"] = kw
                break

    return result


if __name__ == "__main__":
    import sys
    import json
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: dispatch_fields.py <text_file>"}))
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        raw = f.read()
    print(json.dumps(extract_dispatch_fields(raw), ensure_ascii=False, indent=2))
