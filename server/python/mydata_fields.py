#!/usr/bin/env python3
"""
myDATA field extraction helpers for Greek invoices.

Covers the four myDATA / ΑΑΔΕ header fields required by METRO PoC §4:

  - MARK                  — Mark in the myDATA registry, 15+ digits
  - UID                   — Unique Identifier, 40-char hex (with/without dashes)
  - Authentication Code   — ΚΩΔΙΚΟΣ ΑΥΘΕΝΤΙΚΟΠΟΙΗΣΗΣ, long alphanumeric
  - Provider              — Πάροχος Ηλ. Τιμολόγησης (e-invoicing provider name)

Label variants differ across providers (Epsilon Net, IMPACT, SoftOne, Entersoft,
Galaxy, custom myDATA portals). The pattern set below covers the most common
variants observed; refine as new templates are met during the PoC.

Designed to be called from:
  - server/python/invoice_extractor_advanced.py  (alongside _extract_greek_header)
  - server/python/vlm_invoice_parser.py          (alongside parse_invoice_fields)

Both call sites can import:
    from mydata_fields import extract_mydata_fields
"""

import re
from typing import Dict, Optional


# ── Pre-compiled patterns ────────────────────────────────────────────────────

_MARK_PATTERNS = [
    re.compile(r'(?:ΜΑΡΚ|MARK)[\s:]*([0-9]{15,})', re.IGNORECASE),
    re.compile(r'\bM\.?A\.?R\.?K\.?[\s:]+([0-9]{15,})', re.IGNORECASE),
]

_UID_PATTERNS = [
    # Standard myDATA UID: 40-char hex, sometimes with dashes
    re.compile(r'\bUID[\s:]+([A-F0-9]{40})\b', re.IGNORECASE),
    re.compile(r'\bUID[\s:]+([A-F0-9\-]{40,50})\b', re.IGNORECASE),
    # Greek label variants
    re.compile(r'(?:Μοναδικός\s+Κωδικός(?:\s+Σήμανσης)?|Μοναδ\.?\s*Κωδ\.?)[\s:]+([A-F0-9\-]{20,})', re.IGNORECASE),
    # Generic "Unique ID" with long alphanumeric value
    re.compile(r'(?:Unique\s+ID|Unique\s+Identifier)[\s:]+([A-Z0-9\-]{20,})', re.IGNORECASE),
]



_AUTH_CODE_PATTERNS = [
    # Greek standard label — auth codes are alphanumeric (not pure hex), so [A-Z0-9]
    re.compile(
        r'(?:ΚΩΔ(?:ΙΚΟΣ)?\s*ΑΥΘΕΝΤΙΚ\S*|Κωδικός\s+Αυθεντικοπο\S*)[\s:]+([A-Z0-9\-/+=]{20,})',
        re.IGNORECASE,
    ),
    # English variants
    re.compile(r'(?:Authentication\s+Code|Auth\.?\s*Code)[\s:]+([A-Z0-9\-/+=]{20,})', re.IGNORECASE),
    # "Σήμα Παραστατικού" used by some providers (often hex but allow alphanumeric)
    re.compile(r'(?:Σήμα\s+Παραστατικού|Document\s+Signature)[\s:]+([A-Z0-9\-/+=]{20,})', re.IGNORECASE),
]


_PROVIDER_PATTERNS = [
    # Explicit label
    re.compile(r'Πάροχος(?:\s+Ηλ\.?\s*Τιμολόγησης)?[\s:]+([^\n]{3,80})', re.IGNORECASE),
    # English equivalent
    re.compile(
        r'(?:E-?Invoicing\s+Provider|Electronic\s+Invoicing\s+Provider)[\s:]+([^\n]{3,80})',
        re.IGNORECASE,
    ),
    # Known provider names in "Provided by / Issued via" footer lines
    re.compile(
        r'(?:Provided\s+by|Issued\s+via|Through)[\s:]+'
        r'(Epsilon\s*Net|EpsilonNet|IMPACT|SoftOne|Soft1|Entersoft|Galaxy\S*|Epsilon\s+Singular)',
        re.IGNORECASE,
    ),
]


# ── Public API ───────────────────────────────────────────────────────────────

def extract_mydata_fields(text: str) -> Dict[str, Optional[str]]:
    """
    Extract the four myDATA header fields from the raw invoice text.

    Returns a dict with stable keys (None when not found):

        {
            "mark":               "400000000123456",
            "uid":                "ABCDEF0123...",
            "authenticationCode": "...",
            "provider":           "Epsilon Net"
        }
    """
    result: Dict[str, Optional[str]] = {
        "mark": None,
        "uid": None,
        "authenticationCode": None,
        "provider": None,
    }

    if not text:
        return result

    # MARK
    for pat in _MARK_PATTERNS:
        m = pat.search(text)
        if m:
            result["mark"] = m.group(1).strip()
            break

    # UID — guard against matching the MARK value
    for pat in _UID_PATTERNS:
        m = pat.search(text)
        if m:
            val = m.group(1).strip()
            if val and val != result["mark"]:
                result["uid"] = val
                break

    # Authentication Code — guard against collision with MARK and UID
    for pat in _AUTH_CODE_PATTERNS:
        m = pat.search(text)
        if m:
            val = m.group(1).strip()
            if val and val != result["mark"] and val != result["uid"]:
                result["authenticationCode"] = val
                break

    # Provider — strip trailing URLs / phone noise after the name
    for pat in _PROVIDER_PATTERNS:
        m = pat.search(text)
        if m:
            provider = m.group(1).strip()
            provider = re.split(r'\s{2,}|[,;|]|www\.|http', provider)[0].strip()
            if provider and len(provider) > 2:
                result["provider"] = provider
                break

    return result


# ── CLI for ad-hoc testing ──────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import json
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: mydata_fields.py <text_file>"}))
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        raw = f.read()
    print(json.dumps(extract_mydata_fields(raw), ensure_ascii=False, indent=2))
