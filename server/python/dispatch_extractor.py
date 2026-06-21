#!/usr/bin/env python3
"""
Dispatch Note / Δελτίο Αποστολής Extractor
Extracts sender, recipient, items, delivery details from dispatch notes.

Handles both:
  A) Text-based PDFs (pdfplumber → clean tables)
  B) Scanned/vector PDFs (OCR → messy text with PSM3 + PSM6 passes)

OCR-specific challenges solved:
  - ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ header often garbled → use position-based detection
  - PSM 3 loses column alignment → merge with PSM 6 (table-optimized)
  - ΤΕΜΑΧ appears as TEMAX, τεΜΑΧ, τεΜαχ → case-insensitive matching
  - Random "το", "|", pipes inserted by OCR → stripped during parsing
"""

import sys
import json
import re


def parse_greek_number(text):
    """Parse Greek number format (1.234,56) to float."""
    if not text:
        return None
    text = str(text).strip()
    # Remove common OCR artifacts
    text = text.rstrip('.')  # trailing period
    if re.match(r'^\d{1,3}(\.\d{3})*(,\d+)?$', text):
        text = text.replace('.', '').replace(',', '.')
    else:
        text = text.replace(',', '.')
    text = re.sub(r'[^\d.]', '', text)
    try:
        return float(text)
    except:
        return None


def _find_section_start(text_upper, keywords):
    """Find section start with flexible whitespace (pdfjs inserts extra spaces)."""
    for kw in keywords:
        pattern = r'\s+'.join(re.escape(w) for w in kw.split())
        m = re.search(pattern, text_upper)
        if m:
            return m.start()
    return -1


def extract_dispatch_note(pdf_path, ocr_text_file=None):
    """Extract dispatch note fields from PDF."""
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ocr_helper import extract_text_from_pdf

    result = {
        "documentType": "dispatch_note",
        "success": True,
        "documentNumber": None,
        "series": None,
        "date": None,
        "time": None,
        "sender": {"name": None, "vatNumber": None, "address": None},
        "recipient": {"name": None, "vatNumber": None, "address": None, "phone": None, "email": None, "city": None,
                      "doy": None, "profession": None},
        "deliveryAddress": None,
        "loadingPlace": None,
        "destinationPlace": None,
        "transportMethod": None,
        "paymentMethod": None,
        "vehicleNumber": None,
        "purpose": None,
        "items": [],
        "totalQuantity": None,
        "totalAmount": None,
        "totalAmountWords": None,
        "notes": None,
        "extractionMethod": "pdfplumber",
        "rawTextPreview": "",
    }

    extraction = extract_text_from_pdf(pdf_path, max_pages=3, ocr_text_file=ocr_text_file)
    full_text = extraction["text"]
    tables = extraction.get("tables", [])
    result["extractionMethod"] = extraction["method"]
    result["rawTextPreview"] = full_text[:1000]

    if not full_text or len(full_text.strip()) < 20:
        result["success"] = False
        return result

    # ── Split PSM3 and PSM6 sections if present ──
    psm6_marker = '=== PSM6_TABLE_PASS ==='
    psm3_text = full_text
    psm6_text = ''
    if psm6_marker in full_text:
        psm3_text = full_text[:full_text.index(psm6_marker)]
        psm6_text = full_text[full_text.index(psm6_marker) + len(psm6_marker):]

    # Use PSM3 for header fields (better text quality), PSM6 for items (better table structure)
    header_text = psm3_text if psm3_text.strip() else full_text
    lines = header_text.split("\n")
    text_upper = header_text.upper()

    # ══════════════════════════════════════════════════════════════
    # SECTION BOUNDARIES
    # ══════════════════════════════════════════════════════════════

    # Try exact match first, then fuzzy for garbled OCR
    customer_start = _find_section_start(text_upper, [
        'ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ', 'ΣΤΟΙΧΕΙΑ ΑΓΟΡΑΣΤΗ', 'ΣΤΟΙΧΕΙΑ ΠΑΡΑΛΗΠΤΗ',
    ])

    # Fallback: find ΕΠΩΝΥΜΙΑ that appears AFTER document header fields
    # In dispatch notes, the structure is always:
    #   1. Sender info (top of page, often template placeholders)
    #   2. Document fields (Σειρά, Αρ.Παραστατικού, Ημερομηνία)
    #   3. ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ → ΕΠΩΝΥΜΙΑ: <recipient name>
    # So: find ΕΠΩΝΥΜΙΑ that appears after Αρ.Παραστατικού
    doc_header_end = -1
    for pattern in [r'Αρ\.?\s*Π\w*τικο[ύυ]', r'Ημερομην[ίι]α', r'Ώρα\s*Έναρξης', r'Τρόπος\s*Πληρωμ']:
        m = re.search(pattern, header_text, re.IGNORECASE)
        if m and m.end() > doc_header_end:
            doc_header_end = m.end()

    if customer_start < 0 and doc_header_end > 0:
        # ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ header is garbled — use position of first ΕΠΩΝΥΜΙΑ after doc header
        after_header = header_text[doc_header_end:]
        m = re.search(r'ΕΠΩΝΥΜ[ΙΊ]Α', after_header, re.IGNORECASE)
        if m:
            customer_start = doc_header_end + m.start()
            sys.stderr.write(
                f"[Dispatch] Found ΕΠΩΝΥΜΙΑ at pos {customer_start} (after doc header at {doc_header_end})\n")

    sys.stderr.write(f"[Dispatch] Section boundaries: customer={customer_start}, doc_header_end={doc_header_end}\n")

    # ══════════════════════════════════════════════════════════════
    # DOCUMENT NUMBER & SERIES
    # ══════════════════════════════════════════════════════════════

    doc_num_found = False
    for line in lines:
        m = re.search(r'Αρ\.?\s*Π\w*τικο[ύυ][:\s]+(\d+)', line, re.IGNORECASE)
        if m:
            result["documentNumber"] = m.group(1).strip()
            doc_num_found = True
            break

    if not doc_num_found:
        for line in lines:
            m = re.search(r'(?:Αριθμ[όο]ς|Αρ\.)\s*(?:Παρ\w*)?[:\s]+(\d{1,6})\b', line, re.IGNORECASE)
            if m:
                result["documentNumber"] = m.group(1).strip()
                doc_num_found = True
                break

    # Series — prioritize labeled "Σειρά: ΔΑ-Μ" over inline "Σειρά Μ"
    # Pass 1: labeled with colon (most reliable)
    for line in lines:
        m = re.search(r'Σειρ[άα]\s*:\s*([Α-Ωα-ωA-Za-z\-]{1,10})', line, re.IGNORECASE)
        if m:
            result["series"] = m.group(1).strip()
            break
    # Pass 2: inline without colon (fallback)
    if not result["series"]:
        for line in lines:
            m = re.search(r'Σειρ[άα]\s+([Α-Ωα-ωA-Za-z\-]{1,5})\b', line, re.IGNORECASE)
            if m:
                result["series"] = m.group(1).strip()
                break

    if result["series"] and result["documentNumber"]:
        if result["series"] not in (result["documentNumber"] or ''):
            result["documentNumber"] = f"{result['series']}-{result['documentNumber']}"

    # Date
    for line in lines:
        m = re.search(r'(?:Ημερομην[ίι]α|Date|Ημ/ν[ίι]α)[:\s]*\s*(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})', line,
                      re.IGNORECASE)
        if m:
            result["date"] = m.group(1)
            break
    if not result["date"]:
        for line in lines:
            m = re.search(r'(\d{1,2}[./]\d{1,2}[./]\d{2,4})', line)
            if m:
                result["date"] = m.group(1)
                break

    # Time
    for line in lines:
        m = re.search(r'(?:Ώρα|Ωρα)\s*(?:Έναρξης|Εναρξης)?[:\s]*\s*(\d{1,2}:\d{2}(?::\d{2})?)', line, re.IGNORECASE)
        if m:
            result["time"] = m.group(1)
            break

    # Payment
    for line in lines:
        m = re.search(r'(?:Τρ[οό]πος\s*Πληρωμ[ήη]ς|ΤΡΟΠΟΣ\s*ΠΛΗΡΩΜΗΣ)[:\s]*\s*(.+?)(?:\n|$)', line, re.IGNORECASE)
        if m:
            result["paymentMethod"] = m.group(1).strip()
            break

    # Loading / Destination
    for line in lines:
        m = re.search(r'(?:Τ[οό]πος\s*Φ[οό]ρτωσης|ΤΟΠΟΣ\s*ΦΟΡΤΩΣΗΣ)[:\s]*\s*(.+?)(?:\n|$)', line, re.IGNORECASE)
        if m:
            result["loadingPlace"] = m.group(1).strip()
            break
    for line in lines:
        m = re.search(r'(?:Τ[οό]πος\s*Προορισμο[ύυ]|ΤΟΠΟΣ\s*ΠΡΟΟΡΙΣΜΟΥ)[:\s]*\s*(.+?)(?:\n|$)', line, re.IGNORECASE)
        if m:
            result["destinationPlace"] = m.group(1).strip()
            break

    # ══════════════════════════════════════════════════════════════
    # RECIPIENT — from ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ or position-based
    # ══════════════════════════════════════════════════════════════

    if customer_start >= 0:
        # Find end of customer block (next major section or double newline)
        customer_end = len(header_text)
        # Look for item table header
        for end_kw in ['ΑΙΤΙΟΛΟΓ', 'ΠΕΡΙΓΡΑΦ', 'ΕΙΔΟΣ', 'Προϊόν', 'NPOION']:
            pos = header_text.upper().find(end_kw, customer_start + 20)
            if pos > customer_start and pos < customer_end:
                customer_end = pos

        customer_block = header_text[customer_start:customer_end]
        _parse_customer_block(customer_block, result["recipient"])
        sys.stderr.write(
            f"[Dispatch] Recipient: {result['recipient']['name']} (ΑΦΜ: {result['recipient'].get('vatNumber')})\n")

    # ══════════════════════════════════════════════════════════════
    # SENDER — from text BEFORE customer section
    # (often empty/template in dispatch notes)
    # ══════════════════════════════════════════════════════════════

    if customer_start > 0:
        before_customer = header_text[:customer_start]
        # Look for ΕΠΩΝΥΜΙΑ before customer section
        m = re.search(r'(?:ΕΠΩΝΥΜ[ΙΊ]Α|Επωνυμ[ίι]α)[:\s]+(.+?)(?:\n|$)', before_customer, re.IGNORECASE)
        if m:
            name = m.group(1).strip()
            if name and not name.startswith('<') and not name.startswith('«') and len(name) > 2:
                result["sender"]["name"] = name

        # Sender ΑΦΜ (before customer section only, handles OCR garble ΑΦΙΜ)
        for m in re.finditer(r'ΑΦ\.?[ΙΜ]?\.?Μ?\.?[:\s]*(?:EL\s*[-–]?\s*)?(\d{9,10})', before_customer, re.IGNORECASE):
            result["sender"]["vatNumber"] = m.group(1)
            break

    # If no sender found and no customer_start, try first ΕΠΩΝΥΜΙΑ
    # but be careful not to grab recipient's name
    if not result["sender"]["name"] and customer_start < 0:
        # Without section boundaries, we can't reliably distinguish sender from recipient
        # Skip sender assignment — better empty than wrong
        pass

    # Ensure recipient ΑΦΜ not duplicated to sender
    if result["sender"].get("vatNumber") == result["recipient"].get("vatNumber"):
        if result["recipient"].get("name"):
            # Recipient has name + VAT, sender probably shouldn't have this VAT
            result["sender"]["vatNumber"] = None

    # ══════════════════════════════════════════════════════════════
    # LINE ITEMS — from pdfplumber tables (best quality)
    # ══════════════════════════════════════════════════════════════
    for table in tables:
        if not table or len(table) < 2:
            continue
        header = [str(c).upper() if c else "" for c in table[0]]
        header_text_str = " ".join(header)

        is_item_table = any(kw in header_text_str for kw in [
            "ΑΙΤΙΟΛΟΓ", "ΠΕΡΙΓΡΑΦ", "ΕΙΔΟΣ", "ΕΙΔΗ", "DESCRIPTION", "PRODUCT",
            "ΟΝΟΜΑΣΙΑ", "ΠΡΟΪΟΝ",
        ])

        if is_item_table:
            desc_col = _find_col(header, ["ΑΙΤΙΟΛΟΓ", "ΠΕΡΙΓΡΑΦ", "ΕΙΔΟΣ", "ΕΙΔΗ", "DESCRIPTION", "ΟΝΟΜΑΣΙΑ", "ΠΡΟΪΟΝ"])
            qty_col = _find_col(header, ["ΠΟΣΟΤ", "ΠΟΣ", "QTY", "QUANTITY"])
            unit_col = _find_col(header, ["ΜΟΝΑΔ", "Μ.Μ", "M.M", "UNIT", "ΜΕΤΡΗΣ"])
            code_col = _find_col(header, ["ΚΩΔ", "CODE", "A/A", "Α/Α"])
            amount_col = _find_col(header, ["ΜΕΡΙΚΟ", "ΜΕΡΙΚ", "ΣΥΝΟΛΟ", "ΑΞΙΑ", "AMOUNT", "TOTAL", "VALUE"])
            price_col = _find_col(header, ["ΤΙΜΗ", "ΤΙΜΉ", "PRICE"])

            for row in table[1:]:
                if not row or all(not c for c in row):
                    continue
                row_text = ' '.join(str(c or '') for c in row).upper()
                if any(kw in row_text for kw in ['ΟΛΙΚΟ ΣΥΝΟΛΟ', 'ΤΕΛΙΚΟ ΣΥΝΟΛΟ', 'ΓΕΝΙΚΟ ΣΥΝΟΛΟ']):
                    continue

                item = {
                    "description": _get_cell(row, desc_col),
                    "quantity": parse_greek_number(_get_cell(row, qty_col)),
                    "unit": _get_cell(row, unit_col),
                    "code": _get_cell(row, code_col),
                    "amount": parse_greek_number(_get_cell(row, amount_col)),
                    "unitPrice": parse_greek_number(_get_cell(row, price_col)),
                }
                if item["description"]:
                    item["description"] = _fix_ocr_product_number(item["description"])
                    if item.get("amount") is not None:
                        item["totalPrice"] = item["amount"]
                    result["items"].append(item)

    # ══════════════════════════════════════════════════════════════
    # LINE ITEMS — from OCR text (when pdfplumber has no tables)
    # PREFER PSM 6 for items — it preserves table column alignment
    # ══════════════════════════════════════════════════════════════
    if not result["items"]:
        # Strategy: try PSM 6 first (better table structure), fall back to PSM 3
        psm6_items = _extract_items_from_text(psm6_text) if psm6_text.strip() else []
        psm3_items = _extract_items_from_text(psm3_text) if psm3_text.strip() else []

        if len(psm6_items) >= len(psm3_items):
            result["items"] = psm6_items
            sys.stderr.write(f"[Dispatch] Using PSM 6 items: {len(psm6_items)} (PSM 3 had {len(psm3_items)})\n")
        else:
            result["items"] = psm3_items
            sys.stderr.write(f"[Dispatch] Using PSM 3 items: {len(psm3_items)} (PSM 6 had {len(psm6_items)})\n")

            # Merge any PSM 6 items not in PSM 3 results
            if psm6_items:
                existing_descs = set(i.get("description", "")[:15] for i in result["items"])
                for item in psm6_items:
                    desc_prefix = item.get("description", "")[:15]
                    if desc_prefix and desc_prefix not in existing_descs:
                        result["items"].append(item)
                        existing_descs.add(desc_prefix)

    # ── Totals ──
    total_qty = sum(i.get("quantity", 0) or 0 for i in result["items"])
    if total_qty > 0:
        result["totalQuantity"] = total_qty

    total_amount = sum(i.get("amount", 0) or 0 for i in result["items"])
    if total_amount > 0:
        result["totalAmount"] = round(total_amount, 2)

    # Check explicit total in text (both PSM 3 and PSM 6)
    for text_to_check in [psm3_text, psm6_text, full_text]:
        m = re.search(
            r'(?:ΟΛΙΚΟ\s*ΣΥΝΟΛΟ|ΤΕΛΙΚΟ\s*ΣΥΝΟΛΟ|OAIKO\s*ΣΥΝΟΛΟ|ΓΕΝΙΚΟ\s*ΣΥΝΟΛΟ)[:\s]*([\d.,]+)',
            text_to_check, re.IGNORECASE
        )
        if m:
            explicit_total = parse_greek_number(m.group(1))
            if explicit_total:
                result["totalAmount"] = explicit_total
                break

    # Total in words
    m = re.search(
        r'(?:ΟΛΟΓΡΑΦ[ΩΩ]Σ|ΟΛΟΓΡΑΦΩΣ)[:\s]*\n?\s*(.+?)(?:\n\n|\n\s*(?:ΤΕΛΙΚΟ|ΕΚΔΟΣΗ|ΠΑΡΑΔΟΣΗ|ΠΑΡΑΛΑΒΗ))',
        full_text, re.IGNORECASE | re.DOTALL
    )
    if m:
        result["totalAmountWords"] = m.group(1).strip()

    return result


# ══════════════════════════════════════════════════════════════
# ITEM EXTRACTION FROM OCR TEXT
# ══════════════════════════════════════════════════════════════

# Extended unit pattern — handles all OCR variants:
#   ΤΕΜΑΧ. / τεΜΑΧ. / TEMAX. / TEMAX, / ΤΕΜ / TEM etc.
UNIT_RE = r'(?:ΤΕΜΑΧ\.?|ΤΕΜ\.?|ΤΕΜΑΧΙΑ|TEMAX[.,]?|TEM|ΣΕΤ|SET|ΠΑΚ|PAK|ΜΕΤ\.?|MET|ΚΙΛ\.?|ΛΙΤ\.?|ΖΕΥ|ΚΙΒΩΤ|ΚΙΒ\.?|ΔΕΜ\.?)'


def _extract_items_from_text(text):
    """Extract line items from OCR text."""
    items = []
    if not text or not text.strip():
        return items

    lines = text.split("\n")

    end_keywords = ['ΟΛΙΚΟ ΣΥΝΟΛΟ', 'OAIKO ΣΥΝΟΛΟ', 'ΤΕΛΙΚΟ ΣΥΝΟΛΟ', 'ΓΕΝΙΚΟ ΣΥΝΟΛΟ',
                    'ΟΛΟΓΡΑΦ', 'ΕΚΔΟΣΗ', 'ΠΑΡΑΔΟΣΗ', 'ΠΑΡΑΛΑΒΗ', 'ΥΠΟΓΡΑΦ',
                    'NAPAAABM', 'NAPAAOEH', 'NAPAAABH']

    for line in lines:
        stripped = line.strip()
        if not stripped or len(stripped) < 8:
            continue
        upper = stripped.upper()

        # Skip headers, footers, section titles
        if any(kw in upper for kw in end_keywords):
            continue
        if any(kw in upper for kw in ['ΑΙΤΙΟΛΟΓ', 'ΜΟΝΑΔΑ ΜΕΤΡΗΣ', 'ΣΤΟΙΧΕΙΑ', 'ΠΑΡΑΣΤΑΤ',
                                      'ΣΕΙΡΑ', 'ΣΕΙΡΆ', 'ΗΜΕΡΟΜΗΝΙΑ', 'PAGE ---']):
            continue

        item = _parse_dispatch_item_line(stripped)
        if item:
            items.append(item)

    # Post-process: fix common OCR digit errors in product descriptions
    for item in items:
        item["description"] = _fix_ocr_product_number(item.get("description", ""))
        # Add totalPrice alias for frontend compatibility
        if item.get("amount") is not None:
            item["totalPrice"] = item["amount"]

    if items:
        sys.stderr.write(f"[Dispatch] Extracted {len(items)} items from text\n")
    return items


def _parse_dispatch_item_line(line):
    """Parse a single dispatch note item line from OCR text.

    OCR produces lines like:
      Προϊόν No34 ΤΕΜΑΧ. 34,00 34,00
      Προϊόν Nois το τεΜΑΧ. 43,50 43,50
      Προϊόν Νο11 | ΤΕΜΑΧ. | 5,00 5,00
      Προϊόν No4 το τεΜΑΧ. 56,00 56,00

    Key: clean OCR artifacts (|, "το", trailing .) THEN find unit marker.
    """
    # Clean OCR artifacts
    cleaned = line
    cleaned = re.sub(r'\s*\|\s*', ' ', cleaned)  # Remove pipe characters
    cleaned = re.sub(r'\s+το\s+', ' ', cleaned, flags=re.IGNORECASE)  # Remove stray "το"
    cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip()  # Collapse whitespace

    # Pattern: description + unit + number(s)
    m = re.match(
        rf'^(.+?)\s+({UNIT_RE})\s+([\d.,]+)(?:\s+([\d.,]+))?(?:\s+([\d.,]+))?',
        cleaned, re.IGNORECASE
    )
    if not m:
        return None

    desc = m.group(1).strip()
    unit = m.group(2).strip().upper()

    # Normalize unit
    if any(u in unit for u in ('ΤΕΜΑΧ', 'TEMAX', 'TEM')):
        unit = 'ΤΕΜ'
    elif any(u in unit for u in ('ΚΙΒΩΤ', 'ΚΙΒ')):
        unit = 'ΚΙΒ'
    else:
        unit = re.sub(r'[.,]', '', unit)[:3]

    # Skip header lines
    if any(kw in desc.upper() for kw in ['ΑΙΤΙΟΛΟΓ', 'ΠΕΡΙΓΡΑΦ', 'ΕΙΔΟΣ', 'ΜΟΝΑΔ']):
        return None

    # Parse numbers
    nums = []
    for g in [m.group(3), m.group(4), m.group(5)]:
        if g:
            v = parse_greek_number(g)
            if v is not None:
                nums.append(v)

    if not nums:
        return None

    item = {
        "description": desc,
        "unit": unit,
        "quantity": nums[0],
    }
    if len(nums) >= 2:
        item["amount"] = nums[-1]

    # Extract product code from description if present
    code_m = re.match(r'^(\d{3,12})\s+(.+)', desc)
    if code_m:
        item["code"] = code_m.group(1)
        item["description"] = code_m.group(2).strip()

    return item


# ══════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════

def _find_col(header, keywords):
    for i, h in enumerate(header):
        for kw in keywords:
            if kw in h:
                return i
    return None


def _fix_ocr_product_number(desc):
    """Fix common OCR digit↔letter misreads in product numbers.

    OCR frequently confuses:
      1 → l, I, |, i, ι, ί, ῖ, Ι   (one → various I/L/iota forms)
      4 → d, D, ד                    (four → lowercase d)
      5 → s, S, ς                    (five → lowercase s)
      7 → ?, ΄, 7                    (seven → question mark)
      0 → o, O, ο, Ο                 (zero → letter O)
      3 → 3                          (three — usually OK)

    Also fixes prefix: Nα→No, Na→No (Greek alpha misread as Latin a or o)
    """
    # First fix the prefix: "Nα", "Na", "Να" should all become "No"
    # (OCR sometimes reads "No" as "Nα" with Greek alpha)
    desc = re.sub(r'\bN[aα](\d)', r'No\1', desc)  # Na3 → No3, Nα3 → No3
    desc = re.sub(r'\bΝ[aα](\d)', r'Νο\1', desc)  # Greek Ν + alpha → Νο

    def fix_no_digits(m):
        prefix = m.group(1)  # "No" or "Νο"
        garbled = m.group(2)

        fixed = ''
        for ch in garbled:
            # 1: various I, L, iota forms (including polytonic ῖ, ί, ΐ)
            if ch in ('l', 'L', 'I', '|', 'i', 'ι', 'Ι', 'ί', 'ῖ', 'ΐ', 'ἰ', 'ἱ', '¡'):
                fixed += '1'
            # 0: letter O forms
            elif ch in ('o', 'O', 'ο', 'Ο', 'σ'):
                fixed += '0'
            # 4: d/D
            elif ch in ('d', 'D'):
                fixed += '4'
            # 5: s/S
            elif ch in ('s', 'S', 'ς'):
                fixed += '5'
            # 7: question mark, accent
            elif ch in ('?', '\u0384', '\u1fbf', '\u2019', '`'):
                fixed += '7'
            # 8: b/B
            elif ch in ('b', 'B', 'β'):
                fixed += '8'
            # 9: g/q
            elif ch in ('q', 'g'):
                fixed += '9'
            # 2: z/Z (rare)
            elif ch in ('z', 'Z', 'ζ'):
                fixed += '2'
            # Keep actual digits
            elif ch.isdigit():
                fixed += ch
            else:
                fixed += ch

        return prefix + fixed

    # Match "No" or "Νο" (Latin or Greek N) followed by 1-5 mixed chars
    # Use (?=\s|$) instead of \b because ? and | aren't word characters
    desc = re.sub(r'(N[oο]|Ν[oο])([^\s]{1,5})(?=\s|$)', fix_no_digits, desc, flags=re.IGNORECASE)

    return desc


def _get_cell(row, idx):
    if idx is not None and idx < len(row) and row[idx]:
        return str(row[idx]).strip()
    return None


def _parse_customer_block(block, party_dict):
    """Parse ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ / ΕΠΩΝΥΜΙΑ block for recipient details."""
    for line in block.split("\n"):
        line = line.strip()
        if not line:
            continue

        # ΕΠΩΝΥΜΙΑ: ΙΩΑΝΝΗΣ ΒΕΝΕΤΙΚΙΔΗΣ
        m = re.search(r'(?:ΕΠΩΝΥΜ[ΙΊ]Α|Επωνυμ[ίι]α)[:\s]+(.+?)(?:\s*\|?\s*$)', line, re.IGNORECASE)
        if m and not party_dict.get("name"):
            name = m.group(1).strip().rstrip('|').strip()
            if name and len(name) > 2:
                party_dict["name"] = name
            continue

        # ΔΙΕΥΘΥΝΣΗ: Ν.ΚΑΖΑΝΤΖΑΚΗ
        m = re.search(r'(?:ΔΙΕΥΘΥΝΣΗ|Διε[ύυ]θυνση)[:\s]+(.+?)(?:\s+ΑΦΜ|$)', line, re.IGNORECASE)
        if m and not party_dict.get("address"):
            party_dict["address"] = m.group(1).strip()

        # ΑΦΜ: EL - 1000000000 (can be on same line as ΔΙΕΥΘΥΝΣΗ)
        # OCR sometimes garbles ΑΦΜ to ΑΦΙΜ or ΑΦ.Μ
        m = re.search(r'ΑΦ\.?[ΙΜ]?\.?Μ?\.?[:\s]*(?:EL\s*[-–]?\s*)?(\d{9,10})', line, re.IGNORECASE)
        if m and not party_dict.get("vatNumber"):
            party_dict["vatNumber"] = m.group(1).strip()

        # Δ.Ο.Υ.
        m = re.search(r'(?:Δ\.?Ο\.?Υ\.?|ΔΟΥ)[.:\s]+(.+?)(?:\s*$)', line, re.IGNORECASE)
        if m and not party_dict.get("doy"):
            party_dict["doy"] = m.group(1).strip()

        # ΤΗΛΕΦΩΝΟ
        m = re.search(r'(?:ΤΗΛΕΦ[ΩΩ]ΝΟ|ΤΗΛ\.?)[:\s]*(\d[\d\s\-]+)', line, re.IGNORECASE)
        if m and not party_dict.get("phone"):
            party_dict["phone"] = m.group(1).strip()

        # ΕΠΑΓΓΕΛΜΑ
        m = re.search(r'(?:ΕΠΑΓΓΕΛΜΑ|Επ[άα]γγελμα)[:\s]+(.+?)(?:\s+E-?mail|$)', line, re.IGNORECASE)
        if m and not party_dict.get("profession"):
            party_dict["profession"] = m.group(1).strip()

        # E-mail
        m = re.search(r'E-?mail[:\s]*(\S+@\S+)', line, re.IGNORECASE)
        if m and not party_dict.get("email"):
            party_dict["email"] = m.group(1).strip()

        # ΠΟΛΗ
        m = re.search(r'(?:ΠΟΛΗ|ΠΌΛΗ|Π[οό]λη|CITY)[:\s]+(.+)', line, re.IGNORECASE)
        if m and not party_dict.get("city"):
            party_dict["city"] = m.group(1).strip()

        # ΓΕ.ΜΗ.
        m = re.search(r'(?:ΓΕ\.?\s*ΜΗ\.?|ΓΕΜΗ)[:\s]+(.+)', line, re.IGNORECASE)
        if m and not party_dict.get("gemh"):
            val = m.group(1).strip()
            if val and val != '-':
                party_dict["gemh"] = val


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: dispatch_extractor.py <pdf_path>"}))
        sys.exit(1)

    ocr_text_file = None
    if '--ocr-text' in sys.argv:
        idx = sys.argv.index('--ocr-text')
        if idx + 1 < len(sys.argv):
            ocr_text_file = sys.argv[idx + 1]

    output = extract_dispatch_note(sys.argv[1], ocr_text_file=ocr_text_file)

    if "--json" in sys.argv:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print(f"Document #: {output['documentNumber']}")
        print(f"Series: {output['series']}")
        print(f"Date: {output['date']}")
        print(f"Sender: {output['sender']['name']} (ΑΦΜ: {output['sender'].get('vatNumber', 'N/A')})")
        print(f"Recipient: {output['recipient']['name']} (ΑΦΜ: {output['recipient'].get('vatNumber', 'N/A')})")
        print(f"Items: {len(output['items'])}")
        for i, item in enumerate(output['items'], 1):
            print(
                f"  {i}. {item['description']} — {item.get('quantity', '?')} {item.get('unit', '')} = {item.get('amount', '?')}")
        print(f"Total: {output.get('totalAmount', 'N/A')}")