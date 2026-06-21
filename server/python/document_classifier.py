#!/usr/bin/env python3
"""
Document Type Classifier
Analyzes PDF text to detect: invoice, credit_note, cmr, dispatch_note

Special handling for Greek combined documents:
  "Τιμολόγιο Πώλησης - Δελτίο Αποστολής" = invoice (NOT dispatch_note)
"""

import sys
import json
import re


def classify_document(text: str) -> dict:
    """Classify document type from extracted text."""
    text_upper = text.upper()

    scores = {
        "invoice": 0,
        "credit_note": 0,
        "cmr": 0,
        "dispatch_note": 0,
    }

    # ══════════════════════════════════════════════════════════════
    # STEP 0: Handle combined Greek documents FIRST
    # "Τιμολόγιο Πώλησης - Δελτίο Αποστολής" = INVOICE
    # This is the standard Greek sales invoice + delivery note combo
    # ══════════════════════════════════════════════════════════════
    combined_patterns = [
        r'ΤΙΜΟΛΟΓΙ[ΟΑ]\s*ΠΩΛΗΣ[ΗΕ]\S*\s*[-–—]\s*ΔΕΛΤΙ[ΟΑ]\s*ΑΠΟΣΤΟΛ',
        r'ΤΙΜΟΛΟΓΙ[ΟΑ]\s*[-–—/]\s*ΔΕΛΤΙ[ΟΑ]\s*ΑΠΟΣΤΟΛ',
        r'ΤΙΜ\S*\s*ΠΩΛ\S*\s*[-–—]\s*ΔΕΛ\S*\s*ΑΠΟΣΤ',
    ]
    is_combined = False
    for pat in combined_patterns:
        if re.search(pat, text_upper):
            is_combined = True
            scores["invoice"] += 30  # Decisive boost
            break

    # Also handle OCR variants (partial matches due to garbled text)
    if not is_combined:
        has_timologio = bool(re.search(r'ΤΙΜΟΛ[ΟΑ]', text_upper))
        has_deltio = bool(re.search(r'ΔΕΛΤΙ[ΟΑ]', text_upper))
        has_apostoli = bool(re.search(r'ΑΠΟΣΤΟΛ', text_upper))
        has_polisi = bool(re.search(r'ΠΩΛ[ΗΕ]', text_upper))

        if has_timologio and has_deltio and has_apostoli:
            # Combined document — it's an invoice
            is_combined = True
            scores["invoice"] += 25
        elif has_timologio and has_polisi:
            scores["invoice"] += 20

    # ── Invoice / ΤΠΥ ──
    invoice_keywords = [
        (r"ΤΙΜΟΛΟΓΙΟ\s*ΠΑΡΟΧΗΣ\s*ΥΠΗΡΕΣΙΩΝ", 10),
        (r"ΤΙΜΟΛΟΓΙΟ\s*ΠΩΛΗΣΗΣ", 10),
        (r"ΤΙΜΟΛΟΓΙ[ΟA]", 6),
        (r"ΤΠΥ", 8),
        (r"ΤΔΑ", 6),
        (r"INVOICE", 6),
        (r"TAX\s*INVOICE", 8),
        (r"ΜΑΡΚ", 4),
        (r"ΦΠΑ\s*%", 4),
        (r"ΦΠΑ\s*\(€\)", 3),
        (r"ΠΛΗΡΩΤΕΟ", 4),
        (r"ΠΑΡΑΚΡΑΤ", 3),
        (r"ΑΞΙΑ\s*ΦΠΑ", 3),
        (r"ΚΑΘΑΡΗ\s*ΑΞΙΑ", 5),
        (r"ΚΑΘΑΡΗ\s*ΤΙΜΗ", 4),
        (r"ΤΙΜΗ\s*ΜΟΝΑΔ", 5),
        (r"ΕΚΠΤ\S*\s*%", 4),
        (r"SUBTOTAL|ΥΠΟΣΥΝΟΛΟ", 2),
        (r"ΣΕΙΡΑ\s.*ΑΡΙΘΜ", 4),
        (r"ΑΡΙΘΜ\S*\s*ΠΑΡ", 4),
        (r"ΣΕ\s*ΜΕΤΑΦΟΡ[ΑΆ]", 3),
        (r"24%", 2),  # VAT rate often visible
    ]

    # ── Credit Note / Πιστωτικό ──
    credit_keywords = [
        (r"ΠΙΣΤΩΤΙΚΟ\s*ΤΙΜΟΛΟΓΙ[ΟA]", 15),
        (r"ΠΙΣΤΩΤΙΚ[ΟΗ]", 10),
        (r"CREDIT\s*NOTE", 12),
        (r"CREDIT\s*MEMO", 10),
        (r"ΕΠΙΣΤΡΟΦ[ΗΕ]", 4),
        (r"ΑΚΥΡΩΤΙΚ[ΟΗ]", 6),
        (r"RETURN", 2),
    ]

    # ── CMR ──
    cmr_keywords = [
        (r"C\.?\s*M\.?\s*R\.?", 12),
        (r"CONSIGNMENT\s*NOTE", 10),
        (r"INTERNATIONAL\s*CONSIGNMENT", 12),
        (r"ΦΟΡΤΩΤΙΚ[ΗΕ]", 8),
        (r"ΔΙΕΘΝΗΣ\s*ΜΕΤΑΦΟΡ", 10),
        (r"CMR\s*CONVENTION", 10),
        (r"SENDER.*CARRIER.*CONSIGNEE", 8),
        (r"ΑΠΟΣΤΟΛΕ[ΑΥ]Σ.*ΜΕΤΑΦΟΡΕ[ΑΥ]Σ.*ΠΑΡΑΛΗΠΤ", 8),
        (r"PLACE\s*OF\s*DELIVERY", 6),
        (r"PLACE\s*OF\s*LOADING", 6),
        (r"ΤΟΠΟΣ\s*ΦΟΡΤΩΣΗΣ", 6),
        (r"ΤΟΠΟΣ\s*ΠΑΡΑΔΟΣΗΣ", 6),
        (r"GROSS\s*WEIGHT", 4),
        (r"ΜΙΚΤΟ\s*ΒΑΡΟΣ", 4),
        (r"CARRIER", 3),
    ]

    # ── Dispatch Note / Δελτίο Αποστολής ──
    dispatch_keywords = [
        (r"ΔΕΛΤΙΟ\s*ΑΠΟΣΤΟΛΗΣ\s*ΣΕΙΡΑ", 15),  # "Δελτίο Αποστολής Σειρά Μ"
        (r"ΔΕΛΤΙΟ\s*ΑΠΟΣΤΟΛΗΣ", 10),
        (r"ΔΕΛΤΙΟ\s*ΑΠΟΣΤΟΛ", 8),
        (r"ΔΑ[\s-]*[A-ZΑ-Ω]", 6),  # "ΔΑ-Μ" series code
        (r"ΑΡ\.?\s*ΠΑΡΑΣΤΑΤΙΚΟΥ", 5),  # Αρ.Παραστατικού (dispatch-specific header)
        (r"ΠΑΡΑΣΤΑΤΙΚΟ\s*\n?\s*ΔΕΛΤΙΟ", 12),  # "ΠΑΡΑΣΤΑΤΙΚΟ\nΔελτίο Αποστολής"
        (r"DISPATCH\s*NOTE", 10),
        (r"DELIVERY\s*NOTE", 10),
        (r"PACKING\s*LIST", 6),
        (r"ΑΠΟΣΤΟΛ[ΗΕ]", 3),
        (r"ΠΑΡΑΛΑΒ[ΗΕ]", 3),
        (r"ΠΑΡΑΔΟΣΗ", 3),
        (r"SHIPPING\s*NOTE", 8),
        (r"ΤΟΠΟΣ\s*ΦΟΡΤΩΣΗΣ", 4),  # Loading place (dispatch/CMR)
        (r"ΤΟΠΟΣ\s*ΠΡΟΟΡΙΣΜΟΥ", 4),  # Destination
        (r"ΜΕΡΙΚΟ\s*ΣΥΝΟΛΟ", 3),  # Subtotal column (dispatch-style)
        (r"ΟΛΙΚΟ\s*ΣΥΝΟΛΟ", 3),  # Grand total (dispatch-style)
        (r"ΤΕΛΙΚΟ\s*ΣΥΝΟΛΟ\s*ΟΛΟΓΡΑΦ", 5),  # Total in words
    ]

    for pattern, weight in invoice_keywords:
        if re.search(pattern, text_upper):
            scores["invoice"] += weight

    for pattern, weight in credit_keywords:
        if re.search(pattern, text_upper):
            scores["credit_note"] += weight

    for pattern, weight in cmr_keywords:
        if re.search(pattern, text_upper):
            scores["cmr"] += weight

    for pattern, weight in dispatch_keywords:
        if re.search(pattern, text_upper):
            scores["dispatch_note"] += weight

    # ══════════════════════════════════════════════════════════════
    # NEGATIVE SIGNALS — reduce false positives
    # ══════════════════════════════════════════════════════════════

    # "Δελτίο Αποστολής" WITHOUT "Τιμολόγιο" = pure dispatch note
    # Reduce invoice score if there's no invoice keyword at all
    has_any_invoice_kw = bool(
        re.search(r'ΤΙΜΟΛΟΓ|INVOICE|ΤΠΥ|ΤΔΑ|ΦΠΑ\s*%|ΠΛΗΡΩΤΕΟ|ΚΑΘΑΡΗ\s*ΑΞΙΑ|ΤΙΜΗ\s*ΜΟΝΑΔ', text_upper))
    if not has_any_invoice_kw and scores["dispatch_note"] > 0:
        # No invoice keywords but dispatch keywords found — boost dispatch
        scores["dispatch_note"] += 5

    # ══════════════════════════════════════════════════════════════
    # RESOLUTION RULES
    # ══════════════════════════════════════════════════════════════

    # Rule 1: Combined document — always invoice
    if is_combined:
        doc_type = "invoice"
    # Rule 2: Credit note overrides invoice
    elif scores["credit_note"] >= 10 and scores["credit_note"] >= scores["invoice"]:
        doc_type = "credit_note"
    # Rule 3: If both invoice and dispatch_note score high, prefer invoice
    # (most Greek invoices include "Δελτίο Αποστολής" in their header)
    # BUT only if invoice has meaningful signal (not just 24% or ΑΡΙΘΜ)
    elif scores["invoice"] > 0 and scores["dispatch_note"] > 0:
        if has_any_invoice_kw and scores["invoice"] >= scores["dispatch_note"] * 0.7:
            doc_type = "invoice"
        else:
            doc_type = max(scores, key=scores.get)
    else:
        doc_type = max(scores, key=scores.get)

    # Default to invoice if no clear signal
    if scores[doc_type] == 0:
        doc_type = "invoice"

    confidence = min(100, scores[doc_type] * 5)

    return {
        "documentType": doc_type,
        "confidence": confidence,
        "scores": scores,
    }


def classify_from_pdf(pdf_path: str, ocr_text_file: str = None) -> dict:
    """Extract text from PDF (with OCR fallback) and classify."""
    try:
        import sys, os
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from ocr_helper import extract_text_from_pdf

        extraction = extract_text_from_pdf(pdf_path, max_pages=3, ocr_text_file=ocr_text_file)
        text = extraction["text"]

        if not text or len(text.strip()) < 20:
            return {
                "documentType": "invoice",
                "confidence": 0,
                "error": f"No text extracted (method: {extraction['method']})",
            }

        result = classify_document(text)
        result["extractionMethod"] = extraction["method"]
        result["textPreview"] = text[:500]
        return result
    except Exception as e:
        return {
            "documentType": "invoice",
            "confidence": 0,
            "error": str(e),
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: document_classifier.py <pdf_path> [--ocr-text <text_file>]"}))
        sys.exit(1)

    ocr_text_file = None
    if '--ocr-text' in sys.argv:
        idx = sys.argv.index('--ocr-text')
        if idx + 1 < len(sys.argv):
            ocr_text_file = sys.argv[idx + 1]

    result = classify_from_pdf(sys.argv[1], ocr_text_file=ocr_text_file)
    print(json.dumps(result, ensure_ascii=False))