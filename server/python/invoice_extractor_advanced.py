#!/usr/bin/env python3
"""
Advanced Invoice Data Extraction Tool
Extracts supplier invoice data from PDF with multiple parsing strategies
Full support for Greek Timologio (myDATA/ΑΑΔΕ) format
Also handles Δελτίο Αποστολής routed here as fallback
Supports JSON output for Node.js integration
"""

import os
import re
import sys
import json
from pathlib import Path
from datetime import datetime
import pdfplumber
from mydata_fields import extract_mydata_fields
from dispatch_fields import extract_dispatch_fields
from client_profile import get_client_profile

# Module-level singleton — loaded once per process. Falls back to "generic mode"
# (no client-specific patterns) if no profile JSON is configured.
_PROFILE = get_client_profile()


def parse_greek_number(text):
    """Locale-robust number parser (EU 1.234,56 and US 1,234.56 / $646.65).

    Resolves the comma/dot ambiguity:
      - both separators → the LAST one is the decimal separator
      - only a comma → 3 digits after = thousands (1,437→1437), else decimal (164,72→164.72)
      - only a dot   → 3 digits after = thousands (1.437→1437), else decimal (646.65→646.65)
    """
    if text is None:
        return None
    try:
        s = re.sub(r"[€$£¥\s]", "", str(text).strip()).replace("%", "")
        if not s or not re.search(r"\d", s):
            return None
        neg = s.startswith("-")
        s = s.lstrip("+-")
        last_comma, last_dot = s.rfind(","), s.rfind(".")
        if last_comma >= 0 and last_dot >= 0:
            if last_comma > last_dot:
                s = s.replace(".", "").replace(",", ".")
            else:
                s = s.replace(",", "")
        elif last_comma >= 0:
            after = len(s) - last_comma - 1
            s = s.replace(",", "") if (after == 3 and len(s.replace(",", "")) > 3) else s.replace(",", ".")
        elif last_dot >= 0:
            after = len(s) - last_dot - 1
            if after == 3 and len(s.replace(".", "")) > 3:
                s = s.replace(".", "")
        val = float(s)
        return -val if neg else val
    except (ValueError, TypeError):
        return None

def _normalize_item_unit(raw_unit: str) -> dict:
    """Return myDATA unit normalization keys for a line item dict."""
    if not raw_unit:
        return {}
    try:
        from supplier_layout_profiles import normalize_unit
        norm = normalize_unit(raw_unit)
        return {
            'unitMyDataCode':  norm['code'],
            'unitLabelEl':     norm['label_el'],
            'unitLabelEn':     norm['label_en'],
            'unitNormMatched': norm['matched'],
        }
    except Exception:
        return {}


class AdvancedInvoiceExtractor:
    """Extract invoice data from PDF files with multiple strategies"""

    def __init__(self, pdf_path, profiles_path="supplier_profiles.json"):
        self.pdf_path = pdf_path
        self.invoice_data = {}
        self.line_items = []
        self.raw_text = ""
        self.all_tables = []
        self._extraction_strategy = "unknown"

        # Supplier layout profiles
        try:
            from supplier_layout_profiles import SupplierLayoutProfiles
            self._profiles = SupplierLayoutProfiles(profiles_path)
        except Exception:
            self._profiles = None

    def extract_from_pdf(self, ocr_text_file=None):
        """Extract invoice data using multiple strategies, with OCR fallback"""
        try:
            from ocr_helper import extract_text_from_pdf
            extraction = extract_text_from_pdf(self.pdf_path, ocr_text_file=ocr_text_file)
            self.raw_text = extraction["text"]
            self.all_tables = extraction.get("tables", [])

            if not self.raw_text or len(self.raw_text.strip()) < 20:
                sys.stderr.write(f"[Extractor] No text extracted from PDF (method: {extraction['method']})\n")
                return False

            sys.stderr.write(f"[Extractor] Got {len(self.raw_text)} chars via {extraction['method']}\n")

            self._extract_greek_header(self.raw_text)

            # ── myDATA header fields (UID, Auth Code, Provider) — augments existing MARK ──
            mydata = extract_mydata_fields(self.raw_text)
            if mydata.get("mark") and not self.invoice_data.get("mark"):
                self.invoice_data["mark"] = mydata["mark"]
            self.invoice_data["uid"]                = mydata.get("uid")
            self.invoice_data["authenticationCode"] = mydata.get("authenticationCode")
            self.invoice_data["provider"]           = mydata.get("provider")

            # ── Dispatch fields (combined ΤΔΑ support) ──────────────────────
            dispatch = extract_dispatch_fields(self.raw_text)
            self.invoice_data["dispatchDate"]  = dispatch.get("dispatchDate")
            self.invoice_data["vehicleNumber"] = dispatch.get("vehicleNumber")
            self.invoice_data["purpose"]       = dispatch.get("purpose")

            # Detect document currency (USD/EUR/GBP) — overrides the EUR default
            # so US invoices ($) are not mislabelled as euros.
            self.invoice_data['currency'] = self._detect_currency(self.raw_text)

            header_info = {
                "total": self.invoice_data.get("grand_total")
                         or self.invoice_data.get("payable_amount"),
                "subtotal": self.invoice_data.get("header_subtotal"),
                "invoice_number": self.invoice_data.get("invoice_number", ""),
            }

            # ── Run the legacy table/text parser into a CANDIDATE (not directly
            # into self.line_items), so the ensemble can score it against the
            # geometric candidate and pick whichever reconciles best. On complex
            # layouts the legacy parser often wins; on borderless tables geometric
            # wins. Reconciliation decides per-invoice.
            legacy_items = []
            _saved = self.line_items
            self.line_items = []
            try:
                for table in self.all_tables:
                    self._process_table(table)
                if not self.line_items:
                    self._extract_items_from_text(self.raw_text)
                legacy_items = self.line_items
            except Exception as e:
                sys.stderr.write(f"[Extractor] Legacy candidate failed: {e}\n")
                legacy_items = []
            finally:
                self.line_items = _saved

            # ── Ensemble path (geometric #1 + legacy candidate + arithmetic) ──
            result = None
            try:
                import ensemble_extractor as ee
                extra = [ee.Candidate(name="legacy", line_items=legacy_items,
                                      header=dict(header_info))] if legacy_items else None
                result = ee.extract(
                    self.pdf_path,
                    supplier_vat=self.invoice_data.get("vat_number", ""),
                    supplier_name=self.invoice_data.get("supplier", ""),
                    profiles=self._profiles,
                    use_vlm=False,
                    header=dict(header_info),
                    extra_candidates=extra,
                )
            except Exception as e:
                sys.stderr.write(f"[Extractor] Ensemble failed, using legacy: {e}\n")
                result = None

            if result and result.line_items:
                self.line_items = result.line_items
                self._extraction_strategy = f"ensemble:{result.chosen}"
                self.invoice_data["extraction_confidence"] = result.confidence
                self.invoice_data["review_recommended"]    = result.review_recommended
                self.invoice_data["extraction_provenance"] = result.candidates
            else:
                # Last resort: use whatever the legacy parser produced.
                self.line_items = legacy_items

            self._deduplicate_items()
            self._finalize_totals()

            # The ensemble already recorded the supplier profile (with accurate
            # bbox column positions) on a confident geometric win; record here
            # only on the legacy path, to avoid double-counting invoice_count and
            # poisoning column_x with estimated positions.
            if not (result and result.line_items):
                self._record_supplier_profile(success=True)

            return True
        except Exception as e:
            sys.stderr.write(f"Error extracting from PDF: {e}\n")
            import traceback
            traceback.print_exc(file=sys.stderr)
            return False

    def _extract_greek_header(self, text):
        """Extract header info with full Greek Timologio support"""
        lines = text.split('\n')

        customer_section_start = None
        for i, line in enumerate(lines):
            upper = line.upper()
            if any(kw in upper for kw in [
                'ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ', 'ΣΤΟΙΧΕΙΑ ΑΓΟΡΑΣΤ',
                'ΣΤΟΙΧΕΊΑ ΠΕΛΆΤΗ', 'ΣΤΟΙΧΕΊΑ ΑΓΟΡΑΣΤ',
            ]):
                customer_section_start = i
                break
            if any(kw in line for kw in ['Στοιχεία Πελάτη', 'Στοιχεία Αγοραστ']):
                customer_section_start = i
                break

        # ─── SUPPLIER NAME ───
        for i, line in enumerate(lines):
            if customer_section_start and i >= customer_section_start:
                break
            match = re.search(r'(?:Επωνυμ[ίι]α|ΕΠΩΝΥΜΙΑ|ΕΠΩΝΥΜΊΑ)[:\s]+(.+)', line, re.IGNORECASE)
            if match:
                name = match.group(1).strip()
                name = re.sub(r'\s*(Α\.?Φ\.?Μ\.?|ΑΦΜ).*$', '', name).strip()
                if len(name) > 2:
                    self.invoice_data['supplier'] = name
                    break

        if not self.invoice_data.get('supplier'):
            limit = min(customer_section_start or 15, 15)
            for i, line in enumerate(lines[:limit]):
                legal = re.search(
                    r'(.{3,}?)\s*\b(?:Α\.?Ε\.|Ε\.Π\.Ε\.|Ο\.Ε\.|Ι\.Κ\.Ε\.|S\.A\.|LTD\.?|INC\.?|LLC\.?)\s*$',
                    line, re.IGNORECASE
                )
                if legal:
                    name = legal.group(0).strip()
                    if len(name) > 3 and not any(kw in name.upper() for kw in ['ΠΕΛΑΤ', 'ΑΓΟΡΑΣΤ', 'ΣΕΛΙΔΑ']):
                        self.invoice_data['supplier'] = name
                        break

        # ── International invoice fallback: issuer appears AFTER line items ──
        # Run this BEFORE the OCR fallback so "Purchased on X through Y Ltd" wins
        # over address fragments. Client-specific skip is delegated to _PROFILE
        # so this works for any tenant (METRO, Ferryscanner, etc.).
        if not self.invoice_data.get('supplier'):
            COMPANY_SUFFIXES = r'\b(LTD|LLC|INC|SA|SRL|GMBH|KG|OOD|EOOD|LIMITED|BV|NV|AG|CORP)\b'
            CLIENT_HINTS = r'(bill\s+to|billed\s+to|client|buyer|account\s+billed)'
            # "Purchased on Fiverr.com through Fiverr Limited" → issuer
            m = re.search(r'Purchased\s+on\s+\S+\s+through\s+(.+?)(?:\n|$)', '\n'.join(lines), re.IGNORECASE)
            if m:
                self.invoice_data['supplier'] = m.group(1).strip()
            else:
                # Generic: find a company-suffix line in lower 40% of document
                start_search = max(10, len(lines) // 2)
                for line in lines[start_search:]:
                    line = line.strip()
                    if not line or len(line) > 120:
                        continue
                    if re.search(CLIENT_HINTS, line, re.IGNORECASE):
                        continue
                    if _PROFILE.should_skip_as_issuer(line):
                        continue
                    if re.search(COMPANY_SUFFIXES, line, re.IGNORECASE):
                        self.invoice_data['supplier'] = line
                        break

        # ─── SUPPLIER VAT ───
        for i, line in enumerate(lines):
            if customer_section_start and i >= customer_section_start:
                break
            match = re.search(r'(?:Α\.?Φ\.?Μ\.?|ΑΦΜ)\s*[.:;]?\s*(?:EL\s*[-–]?\s*)?(\d{9,10})', line, re.IGNORECASE)
            if match:
                vat = match.group(1)
                # Don't treat the receiving client's own VAT as the supplier's VAT.
                if not _PROFILE.is_client_vat(vat):
                    self.invoice_data['vat_number'] = vat
                    break

        # ─── CUSTOMER INFO ───
        if customer_section_start:
            customer_lines = lines[customer_section_start:customer_section_start + 15]
            for line in customer_lines:
                if not self.invoice_data.get('customer_vat'):
                    m = re.search(r'(?:Α\.?Φ\.?Μ\.?|ΑΦΜ)\s*[.:]?\s*(?:EL\s*[-–]?\s*)?(\d{9,10})', line, re.IGNORECASE)
                    if m:
                        self.invoice_data['customer_vat'] = m.group(1)
                if not self.invoice_data.get('customer_name'):
                    m = re.search(r'(?:Επωνυμ[ίι]α|ΕΠΩΝΥΜΙΑ|ΕΠΩΝΥΜΊΑ)[:\s]+(.+)', line, re.IGNORECASE)
                    if m:
                        self.invoice_data['customer_name'] = m.group(1).strip()
                if not self.invoice_data.get('customer_address'):
                    m = re.search(r'(?:Διε[ύυ]θυνση|ΔΙΕΥΘΥΝΣΗ)[:\s]+(.+)', line, re.IGNORECASE)
                    if m:
                        self.invoice_data['customer_address'] = m.group(1).strip()
                if not self.invoice_data.get('customer_phone'):
                    m = re.search(r'(?:ΤΗΛΕΦ[ΩΩ]ΝΟ|ΤΗΛ\.?)[:\s]*(\d[\d\s\-]+)', line, re.IGNORECASE)
                    if m:
                        self.invoice_data['customer_phone'] = m.group(1).strip()
                if not self.invoice_data.get('customer_email'):
                    m = re.search(r'E-?mail[:\s]*(\S+@\S+)', line, re.IGNORECASE)
                    if m:
                        self.invoice_data['customer_email'] = m.group(1).strip()
                if not self.invoice_data.get('customer_city'):
                    m = re.search(r'(?:ΠΟΛΗ|ΠΌΛΗ|CITY)[:\s]+(.+)', line, re.IGNORECASE)
                    if m:
                        self.invoice_data['customer_city'] = m.group(1).strip()
                if not self.invoice_data.get('customer_doy'):
                    m = re.search(r'(?:Δ\.?Ο\.?Υ\.?|ΔΟΥ)[:\s]+(.+)', line, re.IGNORECASE)
                    if m:
                        self.invoice_data['customer_doy'] = m.group(1).strip()

        # ── Profile-driven customer fallback (works for any tenant) ──
        # If the structured "Στοιχεία Πελάτη" section didn't yield a name/VAT/address,
        # use the active client profile to fill in what we can.
        if not self.invoice_data.get('customer_name'):
            matched = _PROFILE.match_name(text)
            if matched:
                # Strip trailing month names ("METRO AEBE Feb 19") — common OCR artefact
                matched = re.sub(
                    r'\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*$',
                    '', matched, flags=re.IGNORECASE).strip()
                self.invoice_data['customer_name'] = matched
        if not self.invoice_data.get('customer_vat'):
            for v in _PROFILE.vats:
                if v and v in text:
                    # Strip leading EL prefix to match the stored short form
                    self.invoice_data['customer_vat'] = v.lstrip('EL').lstrip('el')
                    break
        if not self.invoice_data.get('customer_address'):
            addr = _PROFILE.match_address(text)
            if addr:
                self.invoice_data['customer_address'] = addr

        # ─── INVOICE NUMBER ───
        found_inv = False
        for i, line in enumerate(lines):
            upper = line.upper().strip()
            if ('ΣΕΙΡΑ' in upper or 'ΣΕΙΡΆ' in upper) and ('Α.Α' in upper or 'A.A' in upper):
                for j in range(i + 1, min(i + 4, len(lines))):
                    val_line = lines[j].strip()
                    if val_line and not any(
                            kw in val_line.upper() for kw in ['ΣΕΙΡΑ', 'ΣΕΙΡΆ', 'ΗΜΕΡΟΜΗΝΙΑ', 'ΗΜΕΡΟΜΗΝΊΑ']):
                        parts = val_line.split()
                        if len(parts) >= 2:
                            series = parts[0]
                            number = parts[1]
                            self.invoice_data['invoice_number'] = f"{series}-{number}"
                            for p in parts:
                                if re.match(r'^\d{15,}$', p):
                                    self.invoice_data['mark'] = p
                            found_inv = True
                            break
                break

        if not found_inv:
            for line in lines:
                m = re.search(r'(?:Αρ\.?\s*Παραστατικο[ύυ]|Αρ\.?\s*Παρ\.?)[:\s]*(\w[\w\-/]*)', line, re.IGNORECASE)
                if m:
                    num = m.group(1).strip()
                    series_m = re.search(r'Σειρ[άα][:\s]*\s*([Α-Ωα-ωA-Za-z\-]+)', line)
                    if not series_m:
                        idx = lines.index(line) if line in lines else -1
                        if idx >= 0:
                            nearby = ' '.join(lines[max(0, idx - 3):idx + 3])
                            series_m = re.search(r'Σειρ[άα][:\s]*\s*([Α-Ωα-ωA-Za-z\-]+\s*\w*)', nearby, re.IGNORECASE)
                    if series_m:
                        self.invoice_data['invoice_number'] = f"{series_m.group(1).strip()}-{num}"
                    else:
                        self.invoice_data['invoice_number'] = num
                    found_inv = True
                    break

        if not found_inv:
            for line in lines:
                patterns = [
                    r'(?:Αριθμ[όο]ς|Αρ\.?|Αριθ\.?)\s*(?:Τιμολ[ογ]*\.?|Παρ[αά]στ\.?|Παρ.?κ[οό][υύ])?\s*[:\s]*([\w\-/]+\d+)',
                    r'(?:ΑΡΙΘΜΟΣ|ΑΡΙΘΜ)\s*(?:ΠΑΡ|ΤΙΜΟΛ)[^:]*[:\s]*([\w\-]+)',
                    r'(ΤΔΑ[\s-]*\d+[\s-]*\d+)',
                    r'(?:Α/Α|A/A)[:\s]+([Α-Ωα-ωA-Za-z]*\d[\w\-]*)',
                    r'(?:INVOICE|INV)[#\s.:-]*(\S+)',
                ]
                for pat in patterns:
                    m = re.search(pat, line, re.IGNORECASE)
                    if m:
                        self.invoice_data['invoice_number'] = m.group(1).strip()
                        break
                if self.invoice_data.get('invoice_number'):
                    break

        # ─── DATE ───
        MONTH_NAMES_RE = (
            r'(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?'
            r'|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
        )
        for line in lines:
            m = re.search(r'(?:Ημερομην[ίι]α|Ημ/ν[ίι]α|Date)[:\s]*\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})', line,
                          re.IGNORECASE)
            if m:
                self.invoice_data['invoice_date'] = m.group(1)
                break
        if not self.invoice_data.get('invoice_date'):
            for line in lines:
                m = re.search(r'(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})', line)
                if m:
                    self.invoice_data['invoice_date'] = m.group(0)
                    break
        # Month-name formats: "Feb 19, 2026" / "19 Feb 2026" (Fiverr, Adobe, etc.)
        if not self.invoice_data.get('invoice_date'):
            full_text = '\n'.join(lines)
            m = (
                    re.search(rf'Date\s+issued\s*\n\s*({MONTH_NAMES_RE}\s+\d{{1,2}},?\s+\d{{4}})', full_text, re.IGNORECASE) or
                    re.search(rf'Date\s*[:\-]\s*({MONTH_NAMES_RE}\s+\d{{1,2}},?\s+\d{{4}})', full_text, re.IGNORECASE) or
                    re.search(rf'(\d{{1,2}}\s+{MONTH_NAMES_RE}\s+\d{{4}})', full_text, re.IGNORECASE) or
                    re.search(rf'({MONTH_NAMES_RE}\s+\d{{1,2}},?\s+\d{{4}})', full_text, re.IGNORECASE)
            )
            if m:
                self.invoice_data['invoice_date'] = m.group(1).strip().rstrip(',')

        # ─── MARK ───
        if not self.invoice_data.get('mark'):
            for line in lines:
                m = re.search(r'(?:ΜΑΡΚ|MARK)[:\s]*(\d{15,})', line, re.IGNORECASE)
                if m:
                    self.invoice_data['mark'] = m.group(1)
                    break
                m = re.search(r'\b(\d{15,18})\b', line)
                if m:
                    self.invoice_data['mark'] = m.group(1)
                    break

        # ─── PAYMENT METHOD ───
        for line in lines:
            m = re.search(r'(?:Τρ[οό]πος\s*Πληρωμ[ήη]ς|ΤΡΟΠΟΣ\s*ΠΛΗΡΩΜΗΣ)[:\s]*\s*(.+?)(?:\n|$)', line, re.IGNORECASE)
            if m:
                self.invoice_data['payment_method'] = m.group(1).strip()
                break

        # ─── E-MAIL ───
        for line in lines:
            m = re.search(r'E-?mail\s*(?:Αποστολ[ήη]ς)?[:\s]*(\S+@\S+)', line, re.IGNORECASE)
            if m:
                self.invoice_data['dispatch_email'] = m.group(1).strip()
                break

        # ─── LOADING / DESTINATION ───
        for line in lines:
            m = re.search(r'(?:Τ[οό]πος\s*Φ[οό]ρτωσης|ΤΟΠΟΣ\s*ΦΟΡΤΩΣΗΣ)[:\s]*\s*(.+?)(?:\n|$)', line, re.IGNORECASE)
            if m:
                self.invoice_data['loading_place'] = m.group(1).strip()
                break
        for line in lines:
            m = re.search(r'(?:Τ[οό]πος\s*Προορισμο[ύυ]|ΤΟΠΟΣ\s*ΠΡΟΟΡΙΣΜΟΥ)[:\s]*\s*(.+?)(?:\n|$)', line, re.IGNORECASE)
            if m:
                self.invoice_data['destination_place'] = m.group(1).strip()
                break

        # ─── TOTALS ───
        for line in lines:
            upper = line.upper().strip()
            m = re.search(r'ΠΛΗΡΩΤ[ΈΕ]Ο\s*\(?€?\)?\s*[:\s]*([0-9.,]+)', upper)
            if m:
                self.invoice_data['payable_amount'] = parse_greek_number(m.group(1))

            if 'ΣΥΝΟΛΑ' in upper or 'ΣΎΝΟΛΑ' in upper:
                nums = re.findall(r'[\d]+[.,][\d]+', line)
                parsed = [parse_greek_number(n) for n in nums]
                parsed = [n for n in parsed if n is not None]
                if parsed:
                    self.invoice_data['totals_row'] = parsed

            m = re.search(r'(?:ΟΛΙΚΟ|ΤΕΛΙΚΟ|ΓΕΝΙΚΟ)\s*ΣΥΝΟΛΟ\s*[:\s]*([\d.,]+)', upper)
            if m:
                val = parse_greek_number(m.group(1))
                if val:
                    self.invoice_data['grand_total'] = val

            # ── English totals (US / international invoices) ──
            # "Invoice Total (USD): $745.65", "Grand Total", "Amount Due", "Balance Due"
            if not self.invoice_data.get('grand_total'):
                m = re.search(
                    r'(?:INVOICE\s+TOTAL|GRAND\s+TOTAL|TOTAL\s+DUE|AMOUNT\s+DUE|BALANCE\s+DUE)'
                    r'\s*\(?\s*[A-Z]{0,3}\s*\)?\s*[:\-]?\s*[$€£]?\s*([\d.,]+)',
                    upper)
                if m:
                    val = parse_greek_number(m.group(1))
                    if val:
                        self.invoice_data['grand_total'] = val
            # "Sub-Total: $745.65" / "Subtotal"
            if not self.invoice_data.get('header_subtotal'):
                m = re.search(r'SUB-?\s?TOTAL\s*\(?\s*[A-Z]{0,3}\s*\)?\s*[:\-]?\s*[$€£]?\s*([\d.,]+)', upper)
                if m:
                    val = parse_greek_number(m.group(1))
                    if val:
                        self.invoice_data['header_subtotal'] = val

        # ─── WITHHOLDING TAX ───
        for line in lines:
            m = re.search(r'Παρακρατο[ύυ]μενοι.*?(\d+[.,]\d+)\s*$', line)
            if m:
                self.invoice_data['withholding_tax'] = parse_greek_number(m.group(1))

        # ── OCR FALLBACK: supplier from first 20 lines ──
        if self.invoice_data.get('supplier') == 'Unknown Supplier' or not self.invoice_data.get('supplier'):
            for line in lines[:20]:
                stripped = line.strip()
                # Skip street address lines (e.g. "115М Tsarigradsko Shose Blvd.")
                if re.search(r'\d+\S*\s+\S+.*(?:Blvd|Blvd\.|St\.|Ave|Ave\.|Road|Rd\.|Str\.|Shose|Street)', stripped, re.IGNORECASE):
                    continue
                # Skip postal code / city lines ("Sofia, 1784" / "Tel Aviv, Israel 6473409")
                if re.search(r'\b\d{4,}\b', stripped) and ',' in stripped:
                    continue
                # Skip lines that look like the active client (METRO, Ferryscanner, etc.)
                if _PROFILE.should_skip_as_issuer(stripped):
                    continue
                m = re.search(r'(.{5,}?)\s*(?:Α\.?Ε\.?|A\.?E\.?|Ε\.?Π\.?Ε\.?|S\.?A\.?|LTD)', stripped, re.IGNORECASE)
                if m:
                    name = m.group(0).strip()
                    if not any(kw in name.upper() for kw in ['ΠΕΛΑΤ', 'ΑΓΟΡΑΣΤ', 'ΣΕΛΙΔΑ', 'PAGE', 'EIΔΟΣ', 'ΕΙΔΟΣ']):
                        self.invoice_data['supplier'] = name
                        break

        # ── OCR FALLBACK: Invoice number from ΤΔΑ ──
        if self.invoice_data.get('invoice_number') == 'N/A':
            for line in lines[:30]:
                m = re.search(r'(ΤΔΑ|TAA|TΔA|TDA)[\s-]*(\d+)[\s-]*(\d+)', line)
                if m:
                    self.invoice_data['invoice_number'] = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
                    break
            if self.invoice_data.get('invoice_number') == 'N/A':
                for line in lines[:30]:
                    m = re.search(r'(\d{2})[\s-]*(\d{5,7})', line)
                    if m and int(m.group(2)) > 10000:
                        self.invoice_data['invoice_number'] = f"{m.group(1)}-{m.group(2)}"
                        break

        # Defaults
        self.invoice_data.setdefault('invoice_number', 'N/A')
        self.invoice_data.setdefault('supplier', 'Unknown Supplier')
        self.invoice_data.setdefault('invoice_date', datetime.now().strftime('%d/%m/%Y'))
        self.invoice_data.setdefault('currency', 'EUR')

    def _process_table(self, table):
        """Process table data from PDF"""
        self._extraction_strategy = "table"
        if not table or len(table) < 2:
            return

        header_row = table[0]
        if not header_row:
            return

        col_map = self._identify_columns(header_row)
        if not col_map:
            return

        pending_desc_parts = []
        pre_item_desc_parts = []
        current_item = None

        for row in table[1:]:
            if not row:
                continue

            row_text = ' '.join(str(c or '') for c in row).strip().upper()

            # Stop at summary / footer rows
            # TOTAL is only a stopper when it's the dominant content of the row,
            # not when it's "Total (EUR)" which is a column header already processed.
            is_total_row = (
                    re.match(r'^TOTAL\b', row_text) and
                    not re.search(r'\d', row_text)  # no numbers → it's a header-echo, skip
            ) if 'TOTAL' in row_text else False

            if is_total_row or any(kw in row_text for kw in [
                'ΣΥΝΟΛΑ', 'ΣΎΝΟΛΑ', 'ΣΥΝΟΛΟ', 'ΣΎΝΟΛΟ',
                'ΠΛΗΡΩΤ', 'ΠΑΡΑΚΡΑΤ', 'ΚΡΑΤΗΣ', 'ΧΑΡΤΟΣΗΜ',
                'ΣΥΝΟΛ. ΑΞΙΑ', 'ΑΝΆΛΥΣΗ', 'ΑΝΑΛΥΣΗ',
                'ΟΛΙΚΟ ΣΥΝΟΛΟ', 'ΤΕΛΙΚΟ ΣΥΝΟΛΟ', 'ΓΕΝΙΚΟ ΣΥΝΟΛΟ',
                # International invoice payment/footer section
                'METHOD', 'PAID WITH', 'PURCHASED ON', 'HAVE AN INVOICE',
            ]):
                break

            has_code = False
            has_numbers = False
            has_description = False

            code_idx = col_map.get('code') or col_map.get('aa')
            if code_idx is not None and code_idx < len(row):
                cell = str(row[code_idx] or '').strip()
                if cell and re.match(r'^\d+$', cell):
                    has_code = True

            desc_idx = col_map.get('description')
            if desc_idx is not None and desc_idx < len(row):
                cell = str(row[desc_idx] or '').strip()
                if cell and len(cell) > 2 and not re.match(r'^[\d.,\s€%]+$', cell):
                    has_description = True

            for key in ['unit_price', 'net_amount', 'quantity']:
                idx = col_map.get(key)
                if idx is not None and idx < len(row):
                    cell = str(row[idx] or '').strip()
                    if cell and parse_greek_number(cell) is not None and parse_greek_number(cell) > 0:
                        has_numbers = True
                        break

            if (has_code or has_description) and has_numbers:
                if current_item and self._is_valid_item(current_item):
                    if pending_desc_parts:
                        existing = current_item.get('description', '')
                        current_item['description'] = ' '.join([existing] + pending_desc_parts).strip()
                        pending_desc_parts = []
                    self.line_items.append(current_item)

                current_item = self._extract_item_by_columns(row, col_map)
                if pre_item_desc_parts and current_item:
                    existing = current_item.get('description', '')
                    current_item['description'] = ' '.join(pre_item_desc_parts + [existing]).strip()
                    pre_item_desc_parts = []
                pending_desc_parts = []

            elif current_item:
                if desc_idx is not None and desc_idx < len(row):
                    cell = str(row[desc_idx] or '').strip()
                    if cell and not re.match(r'^[\d.,\s€%]+$', cell):
                        pending_desc_parts.append(cell)
            else:
                if desc_idx is not None and desc_idx < len(row):
                    cell = str(row[desc_idx] or '').strip()
                    if cell and not re.match(r'^[\d.,\s€%]+$', cell):
                        pre_item_desc_parts.append(cell)

        if current_item and self._is_valid_item(current_item):
            if pending_desc_parts:
                existing = current_item.get('description', '')
                current_item['description'] = ' '.join([existing] + pending_desc_parts).strip()
            self.line_items.append(current_item)

    def _identify_columns(self, header_row):
        """Identify column positions from header text."""
        col_map = {}

        for idx, cell in enumerate(header_row):
            if cell is None:
                continue
            text = str(cell).upper().strip()

            if text in ['A/A', 'Α/Α', 'A/A', 'Α/A']:
                col_map['aa'] = idx
            elif any(kw in text for kw in ['ΚΩΔΙΚ', 'ΚΩΔΙΚΟΣ', 'ΚΩΔ.', 'ΚΩΔ', 'CODE', 'ITEM',
                                           'ΕΙΔΟΣ', 'ΕΙΔΗ', 'EIAOE', 'EIAO']):
                col_map['code'] = idx
            elif any(kw in text for kw in [
                'ΑΙΤΙΟΛΟΓ', 'ΠΕΡΙΓΡΑΦ', 'DESCRIPTION', 'PRODUCT', 'ΟΝΟΜΑΣΙΑ', 'ΠΡΟΪΟΝ', 'ΠΡΟΙΟΝ',
                'SERVICE',   # Fiverr: "Service" column header
            ]):
                col_map['description'] = idx
            elif any(kw in text for kw in [
                'ΠΟΣΟΤ', 'ΠΟΣ.', 'ΠΟΣΟ', 'QTY', 'QUANTITY', 'ΤΕΜΑΧ', 'TEMAX',
            ]):
                col_map['quantity'] = idx
            elif any(kw in text for kw in ['UNIT PRICE', 'ΤΙΜΗ', 'ΤΙΜΉ', 'Τ.Μ']):
                col_map['unit_price'] = idx
            elif text == 'PRICE' or (text.startswith('PRICE') and 'UNIT' not in text):
                # "Price" alone = unit price; "Unit Price" already caught above
                col_map['unit_price'] = idx
            elif any(kw in text for kw in ['ΜΟΝΑΔ', 'Μ.Μ', 'M.M', 'ΜΕΤΡΗΣ', 'UNIT', 'ΜΟΝ']):
                if 'ΤΙΜΗ' not in text and 'ΤΙΜΉ' not in text and 'PRICE' not in text:
                    col_map['unit'] = idx
            elif any(kw in text for kw in ['ΕΚΠΤ', 'ΈΚΠΤ', 'DISCOUNT', 'ΕΚΠ']):
                if 'discount1' not in col_map:
                    col_map['discount1'] = idx
                elif 'discount2' not in col_map:
                    col_map['discount2'] = idx
                else:
                    col_map['discount3'] = idx
            elif any(kw in text for kw in ['ΜΕΡΙΚΟ', 'ΜΕΡΙΚ', 'ΑΞΙΑ', 'ΑΞΊΑ', 'ΚΑΘΑΡ', 'AMOUNT', 'NET', 'VALUE']):
                if 'ΦΠΑ' not in text and 'ΤΕΛ' not in text:
                    col_map['net_amount'] = idx
                elif 'ΦΠΑ' in text:
                    col_map['vat_amount'] = idx
                elif 'ΤΕΛ' in text:
                    col_map['total_amount'] = idx
            elif re.match(r'^TOTAL\b', text):
                # "Total (EUR)" / "Total" at end of Fiverr/international headers → net_amount
                if 'net_amount' not in col_map:
                    col_map['net_amount'] = idx
            elif 'ΣΥΝΟΛΟ' in text and 'ΟΛΙΚΟ' not in text and 'ΤΕΛΙΚΟ' not in text and 'ΓΕΝΙΚΟ' not in text:
                if 'net_amount' not in col_map:
                    col_map['net_amount'] = idx
            elif any(x in text for x in ['ΦΠΑ %', 'ΦΠΑ%', '% ΦΠΑ', '%ΦΠΑ', 'VAT %', 'VAT%', '% VAT']):
                col_map['vat_pct'] = idx
            elif text in ['ΦΠΑ'] and 'vat_pct' not in col_map:
                col_map['vat_pct'] = idx
            elif 'ΦΠΑ' in text and ('€' in text or '(' in text or 'ΑΞΙΑ' in text):
                col_map['vat_amount'] = idx

        has_text = 'description' in col_map or 'code' in col_map or 'aa' in col_map
        has_numeric = any(k in col_map for k in ['quantity', 'unit_price', 'net_amount', 'total_amount'])
        return col_map if (has_text and has_numeric) else None

    def _extract_item_by_columns(self, row, col_map):
        """Extract item using identified column positions"""
        item = {}

        def get_cell(key):
            idx = col_map.get(key)
            if idx is not None and idx < len(row) and row[idx]:
                return str(row[idx]).strip()
            return None

        code = get_cell('code')
        if not code:
            code = get_cell('aa')
        if code:
            item['product_code'] = code
            item['supplierCode'] = code

        desc = get_cell('description')
        if desc:
            item['description'] = re.sub(r'\s+', ' ', desc).strip()

        unit = get_cell('unit')
        if unit:
            item['unit'] = unit

        qty = parse_greek_number(get_cell('quantity'))
        if qty is not None:
            item['quantity'] = qty

        price = parse_greek_number(get_cell('unit_price'))
        if price is not None:
            item['unit_price'] = price
            item['unitPrice'] = price

        for disc_key in ['discount1', 'discount2', 'discount3']:
            disc = parse_greek_number(get_cell(disc_key))
            if disc is not None:
                item[f'discount_{disc_key[-1]}'] = disc

        net = parse_greek_number(get_cell('net_amount'))
        if net is not None:
            item['net_amount'] = net
            item['totalPrice'] = net

        total = parse_greek_number(get_cell('total_amount'))
        if total is not None:
            item['total_with_vat'] = total
            if not net:
                item['totalPrice'] = total

        vat_pct = parse_greek_number(get_cell('vat_pct'))
        if vat_pct is not None:
            item['vat_percent'] = vat_pct
            item['vatRate'] = vat_pct

        vat_amt = parse_greek_number(get_cell('vat_amount'))
        if vat_amt is not None:
            item['vat_amount'] = vat_amt

        return item if item else None

    def _extract_items_from_text(self, text):
        """Extract line items from raw text — robust OCR-tolerant parser."""
        if self._extraction_strategy == "unknown":
            self._extraction_strategy = "text"
        lines = text.split('\n')

        in_items = False
        item_lines = []
        header_keywords = [
            lambda u: ('A/A' in u or 'Α/Α' in u) and ('ΠΕΡΙΓΡΑΦ' in u or 'ΚΩΔ' in u),
            lambda u: ('ΚΩΔ' in u) and ('ΠΟΣΟΤ' in u or 'ΤΙΜΗ' in u or 'ΤΙΜΉ' in u),
            lambda u: 'ΑΙΤΙΟΛΟΓ' in u and ('ΠΟΣΟΤ' in u or 'ΜΟΝΑΔ' in u or 'ΜΕΤΡΗΣ' in u or 'ΜΕΡΙΚΟ' in u),
            lambda u: 'ΑΙΤΙΟΛΟΓ' in u and 'ΣΥΝΟΛΟ' in u,
            lambda u: ('ΕΙΔΟ' in u or 'EIAO' in u or 'EIAOE' in u) and (
                    'ΠΕΡΙΓΡΑΦ' in u or 'ΠEPITPA' in u or 'ΜΟΝ' in u or 'M.M' in u),
            lambda u: ('ΠΕΡΙΓΡΑΦ' in u or 'TIEPITPA' in u) and (
                    'ΜΟΝ' in u or 'ΤΙΜΗ' in u or 'ΠΟΣΟΤ' in u or 'MONAAO' in u),
            lambda u: ('TIEPITPA' in u or 'NEPIIPA' in u or 'MEPITPA' in u) and any(
                x in u for x in ['MONAAO', 'MONAA', 'TIMH', 'TIOZOT', 'ITOSO']),
            lambda u: 'M.M' in u and ('TIMH' in u or 'MONAAO' in u or 'KA@APH' in u or 'ΚΑΘΑΡ' in u),
            # ── International invoice headers (Fiverr, Adobe, GitHub, etc.) ──
            lambda u: 'SERVICE' in u and 'QUANTITY' in u and ('PRICE' in u or 'TOTAL' in u),
            lambda u: 'DESCRIPTION' in u and 'QUANTITY' in u and ('PRICE' in u or 'AMOUNT' in u),
            lambda u: 'ITEM' in u and 'QUANTITY' in u and ('PRICE' in u or 'AMOUNT' in u),
            lambda u: 'PRODUCT' in u and ('QUANTITY' in u or 'QTY' in u) and ('PRICE' in u or 'AMOUNT' in u),
        ]

        end_keywords = ['ΣΥΝΟΛΑ', 'ΣΎΝΟΛΑ', 'ΣΥΝΟΛΟ', 'ΣΎΝΟΛΟ', 'ΠΛΗΡΩΤ', 'ΠΑΡΑΚΡΑΤ',
                        'ΣΥΝΟΛ. ΑΞΙΑ', 'ΣΕ ΜΕΤΑΦΟΡ', 'ΑΝΑΓΡΑΦΕΤΕ', 'ΠΕΙΡΑΙΩΣ', 'EUROBANK',
                        'ALPHA GR', 'IBAN', 'ΕΚΔΟΣΗ', 'ΠΑΡΑΛΑΒΗ', 'Σε Μεταφορ',
                        'ΟΛΙΚΟ ΣΥΝΟΛΟ', 'ΤΕΛΙΚΟ ΣΥΝΟΛΟ', 'ΓΕΝΙΚΟ ΣΥΝΟΛΟ', 'ΟΛΟΓΡΑΦ',
                        # International invoice end markers
                        'METHOD', 'PAID WITH', 'PURCHASED ON', 'HAVE AN INVOICE',
                        'RETHINK WHAT', 'ELECTRONIC DOCUMENT', 'COMPANY NO',
                        'BILL TO', 'BILLED TO', 'REMIT TO']

        for line in lines:
            upper = line.upper().strip()
            if not in_items:
                for check in header_keywords:
                    if check(upper):
                        in_items = True
                        sys.stderr.write(f"[Extractor] Header detected: {line.strip()[:80]}\n")
                        break
            else:
                if any(kw in upper for kw in end_keywords):
                    in_items = False
                    continue
                if line.strip():
                    item_lines.append(line.strip())

        # ── STRATEGY 2: Direct row detection ──
        if len(item_lines) < 5:
            sys.stderr.write(f"[Extractor] Only {len(item_lines)} items via header — trying direct row detection\n")
            direct_lines = []
            for line in lines:
                stripped = line.strip()
                if not stripped or len(stripped) < 15:
                    continue
                m = re.match(r'^[^0-9]{0,3}(\d{4,12})\s+(.+)', stripped)
                if not m:
                    continue
                rest = m.group(2)
                has_unit = bool(re.search(r'\b(?:TEM|SET|NAK|MAK|PAK|FAK|ΤΕΜ|ΣΕΤ|ΠΑΚ|ΤΕΜΑΧ)\b', rest, re.IGNORECASE))
                decimals = re.findall(r'\d+[.,]\d{2}', rest)
                if has_unit or len(decimals) >= 2:
                    direct_lines.append(stripped)

            if len(direct_lines) > len(item_lines):
                sys.stderr.write(f"[Extractor] Direct detection found {len(direct_lines)} rows\n")
                item_lines = direct_lines

        # ── STRATEGY 2b: Dispatch-note style ──
        if len(item_lines) < 3:
            sys.stderr.write(f"[Extractor] Trying dispatch-note text patterns\n")
            dispatch_lines = []
            unit_pat = r'(?:ΤΕΜΑΧ\.?|ΤΕΜ\.?|ΤΕΜΑΧΙΑ|ΣΕΤ|ΠΑΚ|ΜΕΤ\.?|ΚΙΛ\.?|ΛΙΤ\.?|ΖΕΥ|ΚΙΒΩΤ|ΚΙΒ\.?|ΔΕΜ\.?|TEMAX)'
            for line in lines:
                stripped = line.strip()
                if not stripped or len(stripped) < 8:
                    continue
                upper = stripped.upper()
                if any(kw in upper for kw in end_keywords + ['ΑΙΤΙΟΛΟΓ', 'ΠΕΡΙΓΡΑΦ', 'ΕΙΔΟΣ', 'ΜΟΝΑΔΑ ΜΕΤΡΗΣ']):
                    continue
                m = re.match(rf'^(.+?)\s+({unit_pat})\s+([\d.,]+)(?:\s+([\d.,]+))?', stripped, re.IGNORECASE)
                if m:
                    dispatch_lines.append(stripped)

            if len(dispatch_lines) > len(item_lines):
                sys.stderr.write(f"[Extractor] Dispatch pattern found {len(dispatch_lines)} rows\n")
                item_lines = dispatch_lines

        if not item_lines:
            sys.stderr.write("[Extractor] No item lines found in text\n")
            return

        # ── STITCH PASS: merge wrapped description lines ──
        # A line is a "continuation" (not a new item) when it:
        #   - has no leading product code (no 4-12 digit prefix)
        #   - has no unit marker (ΤΕΜ, SET, etc.)
        #   - contains no standalone numbers that look like price/qty
        # We merge it onto the previous item line so _parse_product_line
        # sees the full description in one string.
        stitched_lines = []
        _HAS_CODE_RE    = re.compile(r'^[^0-9]{0,3}\d{4,12}\s')
        _HAS_UNIT_RE    = re.compile(self.UNIT_RE, re.IGNORECASE)
        _HAS_NUMBERS_RE = re.compile(r'(?:^|\s)(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d+|\d{2,})\s*$')

        for line in item_lines:
            stripped = line.strip()
            if not stripped:
                continue

            is_continuation = (
                    not _HAS_CODE_RE.match(stripped)
                    and not _HAS_UNIT_RE.search(stripped)
                    and not _HAS_NUMBERS_RE.search(stripped)
                    and len(stripped) < 80        # long number-heavy lines are new rows
                    and re.search(r'[Α-Ωα-ωA-Za-z]', stripped)  # must have text chars
            )

            if is_continuation and stitched_lines:
                # Append to previous line's description part
                stitched_lines[-1] = stitched_lines[-1] + " " + stripped
                sys.stderr.write(f"[Extractor] Stitched continuation: ...{stripped[:40]}\n")
            else:
                stitched_lines.append(stripped)

        orig_count = len(item_lines)
        item_lines  = stitched_lines
        if len(item_lines) != orig_count:
            sys.stderr.write(
                f"[Extractor] Stitch pass: {orig_count} → {len(item_lines)} lines\n"
            )

        sys.stderr.write(f"[Extractor] Processing {len(item_lines)} candidate lines\n")

        for line in item_lines:
            item = self._parse_product_line(line)
            if item and self._is_valid_item(item):
                self.line_items.append(item)

        # ── STRATEGY 1b: International format fallback ──
        # Handles lines like: "Translation 1 164.72 164.72"
        # (Description  IntQty  DecimalPrice  DecimalTotal — no Greek unit marker)
        if not self.line_items and item_lines:
            sys.stderr.write("[Extractor] Trying international invoice line format\n")
            INTL_PAT = re.compile(
                r'^(.{2,60}?)\s+(-?\d{1,5})\s+([\d,\.]+)\s+([\d,\.]+)\s*$'
            )
            SKIP_INTL = {
                'total', 'total (eur)', 'total(eur)', 'method', 'date',
                'service', 'quantity', 'unit price', 'paid with card',
                'electronic document', 'page 1 of 1', 'original',
            }
            MONTH_START = re.compile(
                r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b', re.IGNORECASE
            )
            for line in item_lines:
                m = INTL_PAT.match(line.strip())
                if not m:
                    continue
                desc  = m.group(1).strip()
                if desc.lower() in SKIP_INTL or MONTH_START.match(desc):
                    continue
                qty   = float(m.group(2))
                price = parse_greek_number(m.group(3))
                total = parse_greek_number(m.group(4))
                if price is None or total is None:
                    continue
                # Sanity: qty × price ≈ total
                if qty != 0:
                    expected  = abs(qty) * price
                    tolerance = max(0.10, abs(total) * 0.05)
                    if abs(expected - abs(total)) > tolerance:
                        continue
                item = {
                    'description': desc,
                    'quantity':    qty,
                    'unit_price':  price,
                    'unitPrice':   price,
                    'net_amount':  total,
                    'totalPrice':  total,
                    'vatRate':     0,
                    'vat_percent': 0,
                    'unit':        'EA',
                }
                self.line_items.append(item)
                sys.stderr.write(f"[Extractor] Intl item: {desc} qty={qty} price={price} total={total}\n")

        sys.stderr.write(f"[Extractor] Extracted {len(self.line_items)} valid line items\n")

        # ── STRATEGY 3: Merge items from PSM 6 table pass ──
        psm6_marker = '=== PSM6_TABLE_PASS ==='
        if psm6_marker in text:
            psm6_text = text[text.index(psm6_marker) + len(psm6_marker):]
            psm6_lines = psm6_text.split('\n')
            existing_codes = set(i.get('supplierCode') for i in self.line_items if i.get('supplierCode'))
            existing_descs = set(i.get('description', '')[:20] for i in self.line_items if i.get('description'))

            psm6_items = []
            for line in psm6_lines:
                stripped = line.strip()
                if not stripped or len(stripped) < 10:
                    continue
                m = re.match(r'^[^0-9]{0,3}(\d{4,12})\s+(.+)', stripped)
                if m:
                    rest = m.group(2)
                    has_unit = bool(re.search(r'\b(?:TEM|SET|NAK|MAK|PAK|FAK|ΤΕΜ|ΣΕΤ|ΠΑΚ|ΤΕΜΑΧ|TEMAX)\b', rest, re.IGNORECASE))
                    if has_unit:
                        item = self._parse_product_line(stripped)
                        if item and self._is_valid_item(item):
                            psm6_items.append(item)
                            continue
                item = self._parse_product_line(stripped)
                if item and self._is_valid_item(item):
                    psm6_items.append(item)

            new_count = 0
            for item in psm6_items:
                code = item.get('supplierCode', '')
                desc_prefix = item.get('description', '')[:20]
                if code and code not in existing_codes:
                    self.line_items.append(item)
                    existing_codes.add(code)
                    new_count += 1
                elif not code and desc_prefix and desc_prefix not in existing_descs:
                    self.line_items.append(item)
                    existing_descs.add(desc_prefix)
                    new_count += 1

            if new_count > 0:
                sys.stderr.write(f"[Extractor] PSM 6 pass added {new_count} additional items (total: {len(self.line_items)})\n")

    # ── Unit regex: Greek full + abbreviated + OCR garbled ──
    UNIT_RE = r'\b(ΤΕΜΑΧ\.?|ΤΕΜ\.?|ΤΕΜΑΧΙΑ|TEM|TEMA|TEMI|TEMAX|ΣΕΤ|SET|ΠΑΚ|PAK|NAK|MAK|FAK|ΤΜΧ|TMX|ΚΙΛ|KIA|ΛΙΤ|ΜΕΤ|MET|ΖΕΥ|KIT|BOX|ΚΙΒΩΤ|ΚΙΒ|ΔΕΜ)\b'

    def _parse_product_line(self, line):
        """Parse a single product line from OCR text.

        CRITICAL FIX: Find the LAST unit marker followed by a digit.
        This prevents matching unit words inside descriptions like:
          "ΣΕΤ ΓΕΡΜΑΝ ΚΛΕΙΔΙΑ" — "ΣΕΤ" followed by text → skip
          "...8 ΤΕΜ. ΣΕΤ 1 27,00" — "ΣΕΤ" before "1" → correct anchor

        Number sequence (after unit):
          QTY, GROSS_PRICE, [DISC1%], [DISC2%], [DISC3%], NET_PRICE, NET_AMOUNT, VAT%, [RECYCLING_FEE]

        Uses VAT% position (6/13/17/24%) as anchor to separate price numbers
        from trailing recycling fees.
        """

        code = ''
        rest = line

        # ── Try code-first format ──
        m = re.match(r'^[^0-9]{0,3}(\d{4,12})\s+(.+)', line)
        if m:
            code = m.group(1)
            rest = m.group(2)

        # ── Find the BEST unit marker: LAST one followed by a digit ──
        unit = ''
        unit_match = None

        for candidate in re.finditer(self.UNIT_RE, rest, re.IGNORECASE):
            after = rest[candidate.end():].lstrip()
            # Real column unit is followed by a number (quantity) or a dash (—)
            if after and (after[0].isdigit() or after[0] in '-—'):
                unit_match = candidate

        if unit_match:
            unit = unit_match.group(1).upper()
            # Normalize common variants
            if unit in ('ΤΕΜΑΧ', 'ΤΕΜΑΧ.', 'ΤΕΜΑΧΙΑ', 'TEMA', 'TEMI', 'TEMAX'):
                unit = 'ΤΕΜ'
            elif unit in ('ΚΙΒΩΤ', 'ΚΙΒ'):
                unit = 'ΚΙΒ'
            elif unit in ('ΔΕΜ',):
                unit = 'ΔΕΜ'
            else:
                unit = unit[:3]

            description = rest[:unit_match.start()].strip()
            numbers_part = rest[unit_match.end():].strip()
        elif code:
            # No unit found but have code — try splitting description from numbers
            parts = re.split(r'\s{2,}', rest)
            if len(parts) >= 3:
                description = parts[0].strip()
                numbers_part = ' '.join(parts[1:])
            else:
                words = rest.split()
                split_idx = None
                for i, word in enumerate(words):
                    if re.match(r'^\d+$', word) or re.match(r'^\d+,\d+$', word):
                        remaining = ' '.join(words[i:])
                        num_count = len(re.findall(r'\b(?:\d+,\d+|\d+%|\d+)\b', remaining))
                        text_count = len(re.findall(r'[A-ZΑ-Ωa-zα-ω]{2,}', remaining))
                        if num_count >= 3 and num_count > text_count:
                            split_idx = i
                            break

                if split_idx is not None:
                    description = ' '.join(words[:split_idx]).strip()
                    numbers_part = ' '.join(words[split_idx:])
                else:
                    return None
        else:
            return None

        if not description or len(description) < 2:
            if code:
                description = f"Item {code}"
            else:
                return None

        # ── Tokenize the numeric part ──
        # Order matters: grouped-with-decimals first (1.234,56 / 1,234.56),
        # then grouped-thousands (1.437 / 1,437), then plain decimals (646.65),
        # then percents, then bare integers. parse_greek_number resolves locale.
        raw_tokens = re.findall(
            r'(\d{1,3}(?:[.,]\d{3})+[.,]\d{1,2}|\d{1,3}(?:[.,]\d{3})+|\d+[.,]\d+|\d+%|\d+)',
            numbers_part
        )

        nums = []
        pcts = []
        all_tokens = []  # (value, is_pct) — preserves order for VAT-aware parsing
        for token in raw_tokens:
            if '%' in token:
                val = float(token.replace('%', ''))
                pcts.append(val)
                all_tokens.append((val, True))
            else:
                val = parse_greek_number(token)
                if val is not None:
                    nums.append(val)
                    all_tokens.append((val, False))

        if len(nums) < 1:
            if unit:
                return {
                    'description': description,
                    'product_code': code or None,
                    'supplierCode': code or None,
                    'unit': unit,
                    'quantity': 0,
                }
            return None

        item = {
            'description': description,
            'unit': unit,
        }
        if code:
            item['product_code'] = code
            item['supplierCode'] = code

        # ── Smart number parsing using VAT% as anchor ──
        # Find VAT% position (last occurrence of 6/13/17/24%) in token stream
        vat_token_idx = None
        vat_rate = None
        for i in range(len(all_tokens) - 1, -1, -1):
            val, is_pct = all_tokens[i]
            if is_pct and val in (6, 13, 17, 24):
                vat_token_idx = i
                vat_rate = val
                break

        # Collect non-percentage numbers BEFORE the VAT% token
        # This excludes recycling fees that come AFTER VAT%
        price_nums = []
        if vat_token_idx is not None:
            for i in range(vat_token_idx):
                val, is_pct = all_tokens[i]
                if not is_pct:
                    price_nums.append(val)
        else:
            price_nums = nums[:]

        # ── Assign fields from price_nums ──
        # Expected order: QTY, GROSS_PRICE, [NET_PRICE], NET_AMOUNT
        if len(price_nums) >= 1:
            item['quantity'] = price_nums[0]

        if len(price_nums) >= 2:
            item['unitPrice'] = price_nums[1]
            item['unit_price'] = price_nums[1]

        if len(price_nums) >= 3:
            # Last number is net_amount (ΚΑΘΑΡΗ ΑΞΙΑ)
            item['totalPrice'] = price_nums[-1]
            item['net_amount'] = price_nums[-1]
            if len(price_nums) >= 4:
                # Second-to-last is net unit price (ΚΑΘΑΡΗ ΤΙΜΗ)
                item['netPrice'] = price_nums[-2]
        elif len(price_nums) == 2:
            # Only qty + amount (dispatch note style)
            item['totalPrice'] = price_nums[1]
            item['net_amount'] = price_nums[1]
            if price_nums[0] > 0:
                item['unitPrice'] = round(price_nums[1] / price_nums[0], 4)
                item['unit_price'] = item['unitPrice']
            else:
                item['unitPrice'] = price_nums[1]
                item['unit_price'] = price_nums[1]

        # ── Discounts: percentages that aren't VAT rates ──
        discount_pcts = [p for p in pcts if p not in (6, 13, 17, 24)]
        if discount_pcts:
            item['discount_1'] = discount_pcts[0]
            if len(discount_pcts) >= 2:
                item['discount_2'] = discount_pcts[1]
            if len(discount_pcts) >= 3:
                item['discount_3'] = discount_pcts[2]

        # ── VAT rate ──
        if vat_rate is not None:
            item['vatRate'] = vat_rate
            item['vat_percent'] = vat_rate
        else:
            vat_pcts = [p for p in pcts if p in (6, 13, 17, 24)]
            if vat_pcts:
                item['vatRate'] = vat_pcts[-1]
                item['vat_percent'] = vat_pcts[-1]
            else:
                item['vatRate'] = 24
                item['vat_percent'] = 24

        # ── Cross-validation ──
        qty = item.get('quantity', 0)
        gross_price = item.get('unit_price', item.get('unitPrice', 0))
        net_amount = item.get('net_amount', 0)

        if qty > 0 and gross_price > 0 and net_amount > 0:
            gross_total = qty * gross_price
            if net_amount > gross_total * 1.05 and gross_total > 0:
                sys.stderr.write(
                    f"[Extractor] Warning: net_amount {net_amount} > gross {gross_total} for {code}\n"
                )

        return item

    def _is_valid_item(self, item):
        """Validate that item has minimum required fields"""
        if not item:
            return False
        has_identity = item.get('description') or item.get('product_code')
        has_data = item.get('quantity') or item.get('net_amount') or item.get('unit_price')
        desc = (item.get('description') or '').upper()

        # Greek summary / footer keywords
        if any(kw in desc for kw in ['ΣΥΝΟΛΑ', 'ΣΎΝΟΛΑ', 'ΠΛΗΡΩΤ', 'ΠΑΡΑΚΡΑΤ', 'ΚΡΑΤΗΣ',
                                     'ΟΛΙΚΟ ΣΥΝΟΛΟ', 'ΤΕΛΙΚΟ ΣΥΝΟΛΟ', 'ΓΕΝΙΚΟ ΣΥΝΟΛΟ',
                                     'ΟΛΟΓΡΑΦ']):
            return False

        # International invoice junk rows:
        # "Total (EUR)", "Method", "Paid with Card", "Page 1 of", "Electronic Document"
        if any(kw in desc for kw in [
            'TOTAL (EUR)', 'TOTAL(EUR)',
            'METHOD', 'PAID WITH', 'PURCHASED ON',
            'PAGE 1 OF', 'PAGE 1', 'ELECTRONIC DOCUMENT',
            'HAVE AN INVOICE', 'RETHINK WHAT', 'COMPANY NO',
        ]):
            return False

        # Month-name prefix junk ("Feb 19", "Sofia", etc.)
        MONTH_PAT = r'^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+\d'
        if re.match(MONTH_PAT, desc):
            return False

        # Sanity: qty × price should roughly equal net_amount (within 5% or 10 cents)
        qty = item.get('quantity') or 0
        price = item.get('unit_price') or item.get('unitPrice') or 0
        net = item.get('net_amount') or item.get('totalPrice') or 0
        if qty and price and net:
            expected = abs(qty) * price
            tolerance = max(0.10, abs(net) * 0.05)
            if abs(expected - abs(net)) > tolerance and abs(net) > 0.01:
                return False

        return has_identity and has_data

    def _detect_currency(self, text):
        """Detect the invoice currency. An explicit 'Total (USD)' label wins;
        then ISO codes; then a $ vs € symbol count. Defaults to EUR."""
        t = text or ""
        m = re.search(r'(?:Invoice\s+|Grand\s+)?Total\s*\(\s*(USD|EUR|GBP)\s*\)', t, re.IGNORECASE)
        if m:
            return m.group(1).upper()
        if re.search(r'\bUSD\b', t):
            return 'USD'
        if re.search(r'\bGBP\b', t):
            return 'GBP'
        if re.search(r'\bEUR\b|€', t):
            return 'EUR'
        usd, eur = t.count('$'), t.count('€')
        if usd > eur and usd > 0:
            return 'USD'
        return 'EUR'

    def _finalize_totals(self):
        """Calculate totals from line items or extracted data"""
        subtotal = 0
        vat_total = 0
        for item in self.line_items:
            net = item.get('net_amount', 0) or 0
            subtotal += net
            # Only apply VAT rate if it is explicitly set on the item (not defaulted)
            vat_rate = item.get('vat_percent')
            if vat_rate is None:
                vat_rate = item.get('vatRate')
            vat_amt = item.get('vat_amount')
            if vat_amt:
                vat_total += vat_amt
            elif vat_rate is not None and vat_rate > 0:
                vat_total += net * vat_rate / 100
            # If vat_rate is 0 or not set, add nothing (e.g. international service invoices)

        self.invoice_data['calc_subtotal'] = round(subtotal, 2)
        self.invoice_data['calc_vat'] = round(vat_total, 2)
        self.invoice_data['calc_total'] = round(subtotal + vat_total, 2)

        grand = self.invoice_data.get('grand_total')
        if grand and subtotal == 0:
            self.invoice_data['calc_total'] = grand

        totals_row = self.invoice_data.get('totals_row', [])
        if totals_row and (subtotal == 0):
            non_zero = [v for v in totals_row if v > 0]
            if len(non_zero) >= 2:
                sorted_vals = sorted(non_zero)
                self.invoice_data['calc_subtotal'] = sorted_vals[-2] if len(sorted_vals) >= 2 else sorted_vals[0]
                self.invoice_data['calc_vat'] = sorted_vals[-2] if len(sorted_vals) >= 3 else 0
                self.invoice_data['calc_total'] = sorted_vals[-1]

    def _deduplicate_items(self):
        """Remove duplicate line items"""
        self._items_before_dedup = len(self.line_items)
        seen = set()
        unique = []
        for item in self.line_items:
            key = (
                item.get('product_code', ''),
                item.get('description', '')[:40],
                str(item.get('quantity', '')),
                str(item.get('net_amount', ''))
            )
            if key not in seen:
                seen.add(key)
                unique.append(item)
        self.line_items = unique

    def _record_supplier_profile(self, success: bool) -> None:
        """Record this extraction result into the supplier layout profile store."""
        if not self._profiles:
            return
        try:
            vat_id = self.invoice_data.get('vat_number', '')
            name   = self.invoice_data.get('supplier', '')

            # Collect column x-positions from any bbox tables we found
            col_positions: dict = {}
            for table in self.all_tables:
                if not table or len(table) < 2:
                    continue
                header = table[0]
                if not header:
                    continue
                from invoice_extractor_advanced import AdvancedInvoiceExtractor as _AEI
                col_map = self._identify_columns(header)
                if col_map:
                    # Estimate x-position per column using the header cell index
                    # multiplied by a nominal cell width (80pt) — real positions
                    # come from the bbox extractor in ocr_helper when available
                    for col_name, idx in col_map.items():
                        if col_positions.get(col_name) is None:
                            col_positions[col_name] = float(idx) * 80.0

            # Units seen across all extracted items
            units_seen = [
                item.get('unit', '') for item in self.line_items
                if item.get('unit')
            ]

            # VAT rates seen
            vat_rates = list({
                item.get('vat_percent') or item.get('vatRate')
                for item in self.line_items
                if item.get('vat_percent') or item.get('vatRate')
            })

            self._profiles.record_extraction(
                vat_id          = vat_id,
                name            = name,
                invoice_number  = self.invoice_data.get('invoice_number', ''),
                item_count      = len(self.line_items),
                success         = success,
                column_x_positions = col_positions if col_positions else None,
                units_seen      = units_seen or None,
                vat_rates_seen  = [float(v) for v in vat_rates if v is not None] or None,
                doc_type        = self.invoice_data.get('doc_type', 'invoice'),
            )
        except Exception as e:
            sys.stderr.write(f"[Extractor] Profile recording failed (non-fatal): {e}\n")

    def to_json(self):
        """Convert extracted data to JSON-serializable dict"""
        subtotal = self.invoice_data.get('calc_subtotal', 0) or self.invoice_data.get('header_subtotal', 0)
        vat_total = self.invoice_data.get('calc_vat', 0)
        total = self.invoice_data.get('calc_total', 0) or self.invoice_data.get('grand_total', 0)
        payable = self.invoice_data.get('payable_amount')
        currency = self.invoice_data.get('currency', 'EUR')

        return {
            'success': True,
            'invoiceNumber': self.invoice_data.get('invoice_number', 'N/A'),
            'invoiceDate': self.invoice_data.get('invoice_date', ''),
            'currency': currency,
            # ── myDATA header fields (required by METRO PoC §4) ──
            'mark':               self.invoice_data.get('mark', ''),
            'uid':                self.invoice_data.get('uid'),
            'authenticationCode': self.invoice_data.get('authenticationCode'),
            'provider':           self.invoice_data.get('provider'),
            # ── Dispatch fields (required for combined ΤΔΑ per PoC §4) ──
            'dispatchDate':       self.invoice_data.get('dispatchDate'),
            'vehicleNumber':      self.invoice_data.get('vehicleNumber'),
            'purpose':            self.invoice_data.get('purpose'),
            'supplier': {
                'name': self.invoice_data.get('supplier', 'Unknown'),
                'code': self.invoice_data.get('supplier_code', ''),
                'vatNumber': self.invoice_data.get('vat_number', ''),
            },
            'customer': {
                'name': self.invoice_data.get('customer_name', ''),
                'vatNumber': self.invoice_data.get('customer_vat', ''),
                'address': self.invoice_data.get('customer_address', ''),
                'phone': self.invoice_data.get('customer_phone', ''),
                'email': self.invoice_data.get('customer_email', ''),
                'city': self.invoice_data.get('customer_city', ''),
                'doy': self.invoice_data.get('customer_doy', ''),
            },
            'lineItems': [
                {
                    'description': item.get('description', ''),
                    'supplierCode': item.get('product_code', item.get('supplierCode', '')),
                    'quantity': item.get('quantity', 0),
                    'unitPrice': item.get('unit_price', item.get('unitPrice', 0)),
                    'totalPrice': item.get('net_amount', item.get('totalPrice', 0)),
                    'vatRate': item.get('vat_percent', item.get('vatRate', 24)),
                    'unit': item.get('unit', ''),
                    **_normalize_item_unit(item.get('unit', '')),
                    'discount1': item.get('discount_1', 0),
                    'discount2': item.get('discount_2', 0),
                    'discount3': item.get('discount_3', 0),
                }
                for item in self.line_items
            ],
            'totals': {
                'subtotal': subtotal,
                'vat': vat_total,
                'total': total,
                'payable': payable,
                'currency': currency,
            },
            'withholdingTax': self.invoice_data.get('withholding_tax'),
            'paymentMethod': self.invoice_data.get('payment_method'),
            # ── Extraction debug metadata (surfaced in UI debug panel) ──
            '_extractionStrategy': self._extraction_strategy,
            '_rawTextLen': len(self.raw_text),
            '_tablesFound': len(self.all_tables),
            '_itemsBeforeDedup': getattr(self, '_items_before_dedup', len(self.line_items)),
            '_supplierProfile': (
                self._profiles.get_profile(
                    vat_id=self.invoice_data.get('vat_number', ''),
                    name=self.invoice_data.get('supplier', ''),
                ) if self._profiles else None
            ),
            'loadingPlace': self.invoice_data.get('loading_place'),
            'destinationPlace': self.invoice_data.get('destination_place'),
            'rawTextPreview': self.raw_text[:2000],
        }


def extract_invoice_data(pdf_path, ocr_text_file=None):
    """Convenience wrapper for use by other scripts."""
    extractor = AdvancedInvoiceExtractor(pdf_path)
    success = extractor.extract_from_pdf(ocr_text_file=ocr_text_file)
    if success:
        return extractor.to_json()
    return {
        'success': False,
        'error': 'Failed to extract data from PDF',
        'lineItems': [],
        'supplier': {'name': 'Unknown', 'code': '', 'vatNumber': ''},
        'customer': {'name': '', 'vatNumber': ''},
        'totals': {'subtotal': 0, 'vat': 0, 'total': 0},
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: python invoice_extractor_advanced.py <pdf_file> [--json]")
        sys.exit(1)

    pdf_file = sys.argv[1]
    json_mode = '--json' in sys.argv

    if not os.path.exists(pdf_file):
        if json_mode:
            json.dump({'success': False, 'error': f"PDF file not found: {pdf_file}", 'lineItems': []}, sys.stdout)
        else:
            sys.stderr.write(f"Error: PDF file '{pdf_file}' not found\n")
        sys.exit(1)

    extractor = AdvancedInvoiceExtractor(pdf_file)

    ocr_text_file = None
    if '--ocr-text' in sys.argv:
        idx = sys.argv.index('--ocr-text')
        if idx + 1 < len(sys.argv):
            ocr_text_file = sys.argv[idx + 1]

    success = extractor.extract_from_pdf(ocr_text_file=ocr_text_file)

    if json_mode:
        if success:
            result = extractor.to_json()
            json.dump(result, sys.stdout, ensure_ascii=False)
        else:
            json.dump({'success': False, 'error': 'Failed to extract data from PDF', 'lineItems': []}, sys.stdout)
        sys.exit(0 if success else 1)
    else:
        if not success:
            sys.stderr.write("Error extracting from PDF\n")
            sys.exit(1)

        data = extractor.to_json()
        print(f"{'═' * 50}")
        print(f"  Invoice Extraction Results")
        print(f"{'═' * 50}")
        print(f"  Invoice #:  {data['invoiceNumber']}")
        print(f"  Date:       {data['invoiceDate']}")
        print(f"  MARK:       {data.get('mark', 'N/A')}")
        print(f"  UID:        {data.get('uid') or 'N/A'}")
        print(f"  Auth Code:  {data.get('authenticationCode') or 'N/A'}")
        print(f"  Provider:   {data.get('provider') or 'N/A'}")
        print(f"  Supplier:   {data['supplier']['name']} (ΑΦΜ: {data['supplier']['vatNumber']})")
        print(f"  Customer:   {data['customer']['name']} (ΑΦΜ: {data['customer']['vatNumber']})")
        if data.get('dispatchDate') or data.get('vehicleNumber') or data.get('purpose'):
            print(f"  Dispatch:   date={data.get('dispatchDate') or 'N/A'}  "
                  f"vehicle={data.get('vehicleNumber') or 'N/A'}  "
                  f"purpose={data.get('purpose') or 'N/A'}")
        print(f"{'─' * 50}")
        print(f"  Line Items: {len(data['lineItems'])}")
        for i, item in enumerate(data['lineItems'], 1):
            disc = ''
            if item.get('discount1'):
                disc = f"  Disc: {item['discount1']}%"
                if item.get('discount2'):
                    disc += f"+{item['discount2']}%"
            print(f"  {i}. [{item['supplierCode']}] {item['description']}")
            print(f"     Qty: {item['quantity']}  Price: {item['unitPrice']}  Net: {item['totalPrice']}  VAT: {item['vatRate']}%{disc}")
        print(f"{'─' * 50}")
        print(f"  Subtotal:  {data['totals']['subtotal']}")
        print(f"  VAT:       {data['totals']['vat']}")
        print(f"  Total:     {data['totals']['total']}")
        if data['totals'].get('payable'):
            print(f"  Payable:   {data['totals']['payable']}")
        if data.get('withholdingTax'):
            print(f"  Withhold:  {data['withholdingTax']}")
        print(f"{'═' * 50}")


if __name__ == '__main__':
    main()