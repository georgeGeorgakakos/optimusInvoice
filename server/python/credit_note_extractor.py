#!/usr/bin/env python3
"""
Credit Note / Πιστωτικό Τιμολόγιο Extractor
Wraps the invoice extractor and adds credit-note-specific fields.
Credit notes have the same structure as invoices (supplier, customer, line items, VAT)
but reference an original invoice and represent negative amounts.
"""

import sys
import json
import re
import os

# Import invoice extractor from same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def extract_credit_note(pdf_path, ocr_text_file=None):
    """Extract credit note fields from PDF using invoice extractor + credit-specific parsing."""
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ocr_helper import extract_text_from_pdf
    
    # Get OCR text for credit-specific fields
    extraction = extract_text_from_pdf(pdf_path, max_pages=3, ocr_text_file=ocr_text_file)
    full_text = extraction["text"]
    
    # Use invoice extractor for base data
    from invoice_extractor_advanced import extract_invoice_data
    invoice_data = extract_invoice_data(pdf_path, ocr_text_file=ocr_text_file)
    
    # Override document type
    invoice_data["documentType"] = "credit_note"
    
    # ── Credit-specific fields ──
    credit_fields = {
        "originalInvoiceNumber": None,
        "originalInvoiceDate": None,
        "creditReason": None,
        "isFull": False,  # Full or partial credit
    }
    
    # Find referenced original invoice
    for pattern in [
        r'(?:ΣΧ(?:ΕΤ)?\.?\s*(?:ΤΙΜΟΛ|ΠΑΡ)|ΑΝΑΦ(?:ΟΡΑ)?\.?\s*(?:ΣΕ)?|ΣΧΕΤΙΚ[ΟΗ])\s*[:\s]?\s*([\w\-/]+\d+)',
        r'(?:ORIGINAL|REF(?:ERENCE)?\.?\s*(?:INVOICE)?)\s*[:\s#]?\s*([\w\-/]+\d+)',
        r'(?:ΑΡΧΙΚΟ\s*ΤΙΜΟΛΟΓΙΟ|ΑΚΥΡΩΣΗ\s*ΤΟΥ)\s*[:\s]?\s*([\w\-/]+\d+)',
        r'(?:ΑΝΤΙΚΡΙΖΟΜΕΝΟ|ΣΥΣΧΕΤΙΖΟΜΕΝΟ)\s*[:\s]?\s*([\w\-/]+\d+)',
    ]:
        match = re.search(pattern, full_text, re.IGNORECASE)
        if match:
            credit_fields["originalInvoiceNumber"] = match.group(1).strip()
            break
    
    # Find original invoice date
    if credit_fields["originalInvoiceNumber"]:
        date_match = re.search(
            r'(?:' + re.escape(credit_fields["originalInvoiceNumber"]) + r')\s*(?:ΗΜ/ΝΙΑ|ΗΜΕΡ|DATE)?[:\s]*(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})',
            full_text, re.IGNORECASE
        )
        if date_match:
            credit_fields["originalInvoiceDate"] = date_match.group(1)
    
    # Find credit reason
    for pattern in [
        r'(?:ΑΙΤΙΑ|ΑΙΤΙΟΛΟΓΙΑ|ΛΟΓΟΣ|REASON)[:\s]*\n?\s*(.*?)(?:\n\n|\n(?:[A-ZΑ-Ω]{3,}))',
        r'(?:ΣΚΟΠΟΣ\s*ΕΚΔΟΣΗΣ|PURPOSE)[:\s]*\n?\s*(.*?)(?:\n|$)',
    ]:
        match = re.search(pattern, full_text, re.IGNORECASE)
        if match:
            credit_fields["creditReason"] = match.group(1).strip()[:200]
            break
    
    # Check if full cancellation
    if re.search(r'ΑΚΥΡΩ(?:ΣΗ|ΤΙΚΟ)|ΟΛΙΚ[ΗΟ]\s*(?:ΠΙΣΤ|ΑΚΥΡ)|FULL\s*(?:CANCEL|CREDIT|REVERSAL)', full_text, re.IGNORECASE):
        credit_fields["isFull"] = True
    
    # Merge credit fields into result
    invoice_data.update(credit_fields)
    
    return invoice_data


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: credit_note_extractor.py <pdf_path>"}))
        sys.exit(1)
    
    result = extract_credit_note(sys.argv[1])
    
    if "--json" in sys.argv:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Credit Note #: {result.get('invoiceNumber')}")
        print(f"Original Invoice: {result.get('originalInvoiceNumber')}")
        print(f"Reason: {result.get('creditReason')}")
        print(f"Supplier: {result.get('supplier', {}).get('name')}")
        print(f"Total: {result.get('totals', {}).get('total')}")
