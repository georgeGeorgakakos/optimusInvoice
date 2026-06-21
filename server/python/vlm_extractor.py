"""
vlm_extractor.py — VLM Integration for Document Extraction Pipeline
====================================================================
Calls the sidecar VLM service to get structured extraction from document images,
then merges VLM results with OCR-based extraction for highest accuracy.

Usage in ocr_helper.py:
    from vlm_extractor import vlm_extract, merge_extractions
    vlm_result = vlm_extract(pdf_path, doc_type)
    final = merge_extractions(ocr_result, vlm_result)
"""

import os
import json
import logging
import requests
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# ─── Config ───────────────────────────────────────────────────────────
VLM_SERVICE_URL = os.environ.get("VLM_SERVICE_URL", "http://vlm-service:8100")
VLM_TIMEOUT = int(os.environ.get("VLM_TIMEOUT", "120"))  # seconds
VLM_ENABLED = os.environ.get("VLM_ENABLED", "true").lower() in ("true", "1", "yes")


def is_vlm_available() -> bool:
    """Check if VLM service is running and model is loaded."""
    if not VLM_ENABLED:
        return False
    try:
        r = requests.get(f"{VLM_SERVICE_URL}/health", timeout=5)
        data = r.json()
        return data.get("status") == "ok"
    except Exception:
        return False


def vlm_extract(pdf_path: str, doc_type: str = "auto", page: int = 0) -> Optional[dict]:
    """
    Send a PDF to the VLM service for visual extraction.

    Args:
        pdf_path: Path to PDF file
        doc_type: Document type hint (auto, dispatch_note, invoice, credit_note, cmr)
        page: Which page to process (0-indexed)

    Returns:
        Extraction result dict, or None if VLM is unavailable/failed
    """
    if not VLM_ENABLED:
        log.debug("VLM extraction disabled")
        return None

    if not os.path.exists(pdf_path):
        log.warning(f"VLM: PDF not found: {pdf_path}")
        return None

    try:
        log.info(f"[VLM] Sending {Path(pdf_path).name} to VLM service (type={doc_type}, page={page})")

        with open(pdf_path, "rb") as f:
            response = requests.post(
                f"{VLM_SERVICE_URL}/extract",
                files={"file": (Path(pdf_path).name, f, "application/pdf")},
                data={"doc_type": doc_type, "page": str(page)},
                timeout=VLM_TIMEOUT,
            )

        if response.status_code != 200:
            log.warning(f"[VLM] Service returned {response.status_code}: {response.text[:200]}")
            return None

        result = response.json()
        elapsed = result.get("elapsed_seconds", 0)
        confidence = result.get("confidence", 0)

        log.info(f"[VLM] Extraction complete: confidence={confidence}, elapsed={elapsed}s")

        # Return the extracted data
        return {
            "data": result.get("data", {}),
            "documentType": result.get("documentType"),
            "confidence": confidence,
            "source": "vlm",
            "model": result.get("model", "unknown"),
        }

    except requests.Timeout:
        log.warning(f"[VLM] Request timed out after {VLM_TIMEOUT}s")
        return None
    except requests.ConnectionError:
        log.warning("[VLM] Cannot connect to VLM service — is it running?")
        return None
    except Exception as e:
        log.error(f"[VLM] Unexpected error: {e}")
        return None


def vlm_extract_base64(image_b64: str, doc_type: str = "auto") -> Optional[dict]:
    """Send a base64-encoded image to the VLM service."""
    if not VLM_ENABLED:
        return None

    try:
        response = requests.post(
            f"{VLM_SERVICE_URL}/extract-base64",
            data={"image_b64": image_b64, "doc_type": doc_type},
            timeout=VLM_TIMEOUT,
        )
        if response.status_code != 200:
            return None

        result = response.json()
        return {
            "data": result.get("data", {}),
            "documentType": result.get("documentType"),
            "confidence": result.get("confidence", 0),
            "source": "vlm",
        }
    except Exception as e:
        log.error(f"[VLM] base64 extraction failed: {e}")
        return None


# ─── Merge Logic ──────────────────────────────────────────────────────

def _pick_best_string(ocr_val: Optional[str], vlm_val: Optional[str], field_name: str = "") -> Optional[str]:
    """Pick the better string value between OCR and VLM extraction."""
    ocr_val = (ocr_val or "").strip()
    vlm_val = (vlm_val or "").strip()

    if not ocr_val and not vlm_val:
        return None
    if not ocr_val:
        return vlm_val
    if not vlm_val:
        return ocr_val

    # Both present — prefer the one that looks more "clean"
    # VLM tends to be better for names, addresses (no OCR garble)
    # OCR tends to be better for numbers (more precise digit reading)

    # For numeric-ish fields, prefer OCR
    numeric_fields = {"vatNumber", "phone", "invoiceNumber", "documentNumber", "quantity",
                      "unitPrice", "totalPrice", "netAmount", "vatAmount", "totalAmount",
                      "subtotal", "totalQuantity"}
    if field_name in numeric_fields:
        # Prefer whichever has more digit characters
        ocr_digits = sum(1 for c in ocr_val if c.isdigit())
        vlm_digits = sum(1 for c in vlm_val if c.isdigit())
        if ocr_digits >= vlm_digits:
            return ocr_val
        return vlm_val

    # For text fields (names, addresses), prefer VLM (better Greek rendering)
    text_fields = {"name", "address", "city", "profession", "description", "email", "doy"}
    if field_name in text_fields:
        # VLM usually produces cleaner Greek text
        return vlm_val

    # Default: prefer VLM if it looks reasonable
    return vlm_val if len(vlm_val) >= 2 else ocr_val


def _pick_best_number(ocr_val, vlm_val) -> Optional[float]:
    """Pick the better numeric value."""
    def to_float(v):
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            v = v.replace(",", ".").strip()
            try:
                return float(v)
            except ValueError:
                return None
        return None

    ocr_f = to_float(ocr_val)
    vlm_f = to_float(vlm_val)

    if ocr_f is not None and vlm_f is not None:
        # Both have values — prefer the one that seems reasonable
        # If they agree (within 1%), great
        if abs(ocr_f - vlm_f) / max(abs(ocr_f), abs(vlm_f), 0.001) < 0.01:
            return ocr_f
        # If they disagree, prefer VLM for totals (reads full number from image)
        # but prefer OCR for line items (regex is more precise for parsed numbers)
        return vlm_f  # Default to VLM
    return ocr_f if ocr_f is not None else vlm_f


def _merge_party(ocr_party: Optional[dict], vlm_party: Optional[dict]) -> dict:
    """Merge sender/recipient/supplier party data."""
    ocr_party = ocr_party or {}
    vlm_party = vlm_party or {}

    merged = {}
    all_keys = set(list(ocr_party.keys()) + list(vlm_party.keys()))
    for key in all_keys:
        merged[key] = _pick_best_string(
            ocr_party.get(key),
            vlm_party.get(key),
            field_name=key,
        )
    return {k: v for k, v in merged.items() if v}


def _merge_items(ocr_items: list, vlm_items: list) -> list:
    """
    Merge line items from OCR and VLM extraction.

    Strategy:
    - If counts match, merge field-by-field (VLM for descriptions, OCR for numbers)
    - If counts differ, prefer whichever has more items
    - Fill in missing fields from the other source
    """
    if not ocr_items and not vlm_items:
        return []

    if not ocr_items:
        return vlm_items
    if not vlm_items:
        return ocr_items

    # If same count, merge each item
    if len(ocr_items) == len(vlm_items):
        merged = []
        for ocr_item, vlm_item in zip(ocr_items, vlm_items):
            item = {}
            # Description: prefer VLM (cleaner Greek)
            item["description"] = _pick_best_string(
                ocr_item.get("description"),
                vlm_item.get("description"),
                "description"
            )
            # Code: prefer VLM (fewer OCR artifacts)
            item["code"] = _pick_best_string(
                ocr_item.get("code") or ocr_item.get("supplierCode"),
                vlm_item.get("code") or vlm_item.get("supplierCode"),
                "code"
            )
            # Numbers: prefer OCR (regex-extracted, more precise)
            for num_field in ["quantity", "unitPrice", "totalPrice", "netAmount",
                              "amount", "vatAmount", "totalWithVat", "discount"]:
                val = _pick_best_number(ocr_item.get(num_field), vlm_item.get(num_field))
                if val is not None:
                    item[num_field] = val
            # Unit: prefer VLM
            item["unit"] = _pick_best_string(
                ocr_item.get("unit"), vlm_item.get("unit"), "unit"
            )
            # Carry over any extra fields from either source
            for extra_key in set(list(ocr_item.keys()) + list(vlm_item.keys())):
                if extra_key not in item:
                    item[extra_key] = vlm_item.get(extra_key) or ocr_item.get(extra_key)

            merged.append({k: v for k, v in item.items() if v is not None})
        return merged

    # Different counts — prefer whichever has more
    if len(vlm_items) > len(ocr_items):
        log.info(f"[VLM Merge] VLM found {len(vlm_items)} items vs OCR {len(ocr_items)} — using VLM as base")
        return vlm_items
    else:
        log.info(f"[VLM Merge] OCR found {len(ocr_items)} items vs VLM {len(vlm_items)} — using OCR as base")
        return ocr_items


def merge_extractions(ocr_result: dict, vlm_result: Optional[dict]) -> dict:
    """
    Merge OCR-based extraction with VLM extraction.

    Priority rules:
    - Document type: VLM (better at classification)
    - Names/addresses: VLM (cleaner Greek text, no OCR artifacts)
    - Numbers/amounts: OCR (regex is more precise for parsed digits)
    - Line items: merge by position if same count; prefer more items if different
    - Missing fields: fill from whichever source has them

    Args:
        ocr_result: Result from OCR + regex extraction pipeline
        vlm_result: Result from VLM service (or None if unavailable)

    Returns:
        Merged extraction dict
    """
    if not vlm_result or not vlm_result.get("data"):
        return ocr_result

    vlm_data = vlm_result["data"]
    if vlm_data.get("_parse_error"):
        log.warning("[VLM Merge] VLM output couldn't be parsed — using OCR only")
        return ocr_result

    merged = dict(ocr_result)  # Start with OCR as base

    # Document type — prefer VLM
    if vlm_data.get("documentType"):
        merged["documentType"] = vlm_data["documentType"]

    # Merge party data (sender, recipient, supplier, customer)
    for party_key in ["sender", "recipient"]:
        if party_key in vlm_data or party_key in ocr_result:
            merged[party_key] = _merge_party(
                ocr_result.get(party_key),
                vlm_data.get(party_key),
            )

    # Merge flat string/number fields
    flat_string_fields = [
        "documentNumber", "series", "date", "invoiceNumber", "invoiceDate",
        "supplierName", "customerName", "supplierVatNumber", "customerVatNumber",
        "supplierAddress", "customerAddress", "supplierCode",
        "loadingPlace", "destinationPlace", "paymentMethod",
        "purpose", "transportMethod", "vehicleNumber", "deliveryAddress",
        "mark", "creditReason", "originalInvoiceNumber", "notes",
        "cmrNumber", "placeOfLoading", "placeOfDelivery",
    ]
    for field in flat_string_fields:
        if field in vlm_data or field in ocr_result:
            merged[field] = _pick_best_string(
                ocr_result.get(field),
                vlm_data.get(field),
                field_name=field,
            )

    flat_number_fields = [
        "subtotal", "vatAmount", "totalAmount", "totalQuantity",
        "withholdingTax", "payableAmount",
        "totalPackages", "totalGrossWeight", "totalVolume", "freightCharges",
    ]
    for field in flat_number_fields:
        if field in vlm_data or field in ocr_result:
            val = _pick_best_number(ocr_result.get(field), vlm_data.get(field))
            if val is not None:
                merged[field] = val

    # Merge line items
    ocr_items = ocr_result.get("items") or ocr_result.get("lineItems") or ocr_result.get("goods") or []
    vlm_items = vlm_data.get("items") or vlm_data.get("lineItems") or vlm_data.get("goods") or []

    if ocr_items or vlm_items:
        items_key = "items" if "items" in ocr_result else "lineItems" if "lineItems" in ocr_result else "goods" if "goods" in ocr_result else "items"
        merged[items_key] = _merge_items(ocr_items, vlm_items)

    # Add VLM metadata
    merged["_vlm_used"] = True
    merged["_vlm_confidence"] = vlm_result.get("confidence", 0)
    merged["_vlm_model"] = vlm_result.get("model", "unknown")

    log.info(f"[VLM Merge] Merged OCR + VLM extraction (VLM confidence={vlm_result.get('confidence', 0):.0%})")

    return merged