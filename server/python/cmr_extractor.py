#!/usr/bin/env python3
"""
CMR (International Consignment Note) Extractor
Extracts sender, carrier, consignee, goods, places, weights from CMR documents.
"""

import sys
import json
import re

def parse_number(text):
    """Parse number from various formats."""
    if not text:
        return None
    text = str(text).strip()
    # Greek format: 1.234,56
    if re.match(r'^\d{1,3}(\.\d{3})*(,\d+)?$', text):
        text = text.replace('.', '').replace(',', '.')
    # Standard format
    text = re.sub(r'[^\d.]', '', text)
    try:
        return float(text)
    except:
        return None


def extract_cmr(pdf_path, ocr_text_file=None):
    """Extract CMR fields from PDF."""
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ocr_helper import extract_text_from_pdf
    
    result = {
        "documentType": "cmr",
        "success": True,
        "cmrNumber": None,
        "date": None,
        "sender": {"name": None, "address": None, "country": None},
        "carrier": {"name": None, "address": None, "country": None, "vehicle": None},
        "consignee": {"name": None, "address": None, "country": None},
        "placeOfLoading": None,
        "placeOfDelivery": None,
        "dateOfLoading": None,
        "goods": [],
        "totalPackages": None,
        "totalGrossWeight": None,
        "totalVolume": None,
        "freightCharges": None,
        "instructions": None,
        "extractionMethod": "pdfplumber",
        "rawTextPreview": "",
    }
    
    extraction = extract_text_from_pdf(pdf_path, max_pages=2, ocr_text_file=ocr_text_file)
    full_text = extraction["text"]
    result["extractionMethod"] = extraction["method"]
    result["rawTextPreview"] = full_text[:500]
    
    if not full_text or len(full_text.strip()) < 20:
        result["success"] = False
        return result
    lines = full_text.split("\n")
    text_upper = full_text.upper()
    
    # ── Helper: get content lines after a label line ──
    def get_content_after(patterns, max_lines=5):
        """Find label line matching patterns, return next non-empty content lines."""
        for i, line in enumerate(lines):
            for pat in patterns:
                if re.search(pat, line, re.IGNORECASE):
                    content = []
                    for j in range(i+1, min(i+1+max_lines, len(lines))):
                        l = lines[j].strip()
                        if not l:
                            if content:
                                break
                            continue
                        # Stop if we hit another section label
                        if re.match(r'^(Empf[aä]nger|Consignee|Absender|Sender|Auslieferort|Place of|Frachtf|Carrier|Ort und|Beigef|Kennzeichen|Marks|Anweisung|Vorbehalte)', l, re.IGNORECASE):
                            break
                        content.append(l)
                    if content:
                        return content
        return []
    
    # ── Sender (Box 1) ──
    sender_lines = get_content_after([
        r'Sender\s*\(name.*country\)',
        r'Absender\s*\(Name.*Land\)',
    ], max_lines=8)
    if sender_lines:
        result["sender"]["name"] = sender_lines[0]
        addr_parts = []
        for sl in sender_lines[1:]:
            vat = re.search(r'VAT[:\s]*(\S+)', sl, re.IGNORECASE)
            if vat:
                # Store VAT as country identifier
                continue
            addr_parts.append(sl)
        if addr_parts:
            result["sender"]["address"] = ", ".join(addr_parts)
        # Detect country from address
        for sl in sender_lines:
            country = re.search(r'\b(GREECE|ROMANIA|BULGARIA|GERMANY|FRANCE|ITALY|TURKEY|NETHERLANDS|BELGIUM)\b', sl, re.IGNORECASE)
            if country:
                country_map = {"GREECE": "GR", "ROMANIA": "RO", "BULGARIA": "BG", "GERMANY": "DE", "FRANCE": "FR", "ITALY": "IT", "TURKEY": "TR", "NETHERLANDS": "NL", "BELGIUM": "BE"}
                result["sender"]["country"] = country_map.get(country.group(1).upper(), country.group(1)[:2].upper())
                break
    
    # ── Consignee (Box 2) ──
    consignee_lines = get_content_after([
        r'Consignee\s*\(name.*country\)',
        r'Empf[aä]nger\s*\(Name.*Land\)',
    ], max_lines=8)
    if consignee_lines:
        result["consignee"]["name"] = consignee_lines[0]
        addr_parts = []
        for cl in consignee_lines[1:]:
            vat = re.search(r'VAT[:\s]*(\S+)', cl, re.IGNORECASE)
            if vat:
                continue
            addr_parts.append(cl)
        if addr_parts:
            result["consignee"]["address"] = ", ".join(addr_parts)
        for cl in consignee_lines:
            country = re.search(r'\b(GREECE|ROMANIA|BULGARIA|GERMANY|FRANCE|ITALY)\b', cl, re.IGNORECASE)
            if country:
                country_map = {"GREECE": "GR", "ROMANIA": "RO", "BULGARIA": "BG", "GERMANY": "DE", "FRANCE": "FR", "ITALY": "IT"}
                result["consignee"]["country"] = country_map.get(country.group(1).upper(), country.group(1)[:2].upper())
                break
    
    # ── Place of Delivery (Box 3) ──
    delivery_lines = get_content_after([
        r'Place of delivery',
        r'Auslieferort',
    ], max_lines=3)
    if delivery_lines:
        result["placeOfDelivery"] = delivery_lines[0]
    
    # ── Place of Loading (Box 4) ──
    # Bilingual CMR: German label first, then English, then value
    loading_match = re.search(
        r'(?:Place and date of taking over|Ort und Datum der [UÜ]bernahme).*?\n.*?\n\s*\n?\s*([A-Z][A-Za-z].+?)(?:\n|$)',
        full_text, re.IGNORECASE
    )
    if loading_match:
        val = loading_match.group(1).strip()
        if not re.match(r'^(Place|Ort|Auslieferort|Empf|Vorbehalte|Carrier|Beigef)', val):
            result["placeOfLoading"] = val
    # Fallback: look for the city directly
    if not result["placeOfLoading"]:
        aspropyrgos = re.search(r'(Aspropyrgos[,\s]*\w+)', full_text, re.IGNORECASE)
        if aspropyrgos:
            result["placeOfLoading"] = aspropyrgos.group(1).strip()
    
    # ── Carrier (Box 16) ──
    carrier_lines = get_content_after([
        r'Carrier\s*\(name.*country\)',
        r'Frachtf[uü]hrer\s*\(Name.*Land\)',
    ], max_lines=5)
    if carrier_lines:
        # Filter out OCR noise - look for the actual carrier name
        for cl in carrier_lines:
            # Skip very short noise
            if len(cl) < 3:
                continue
            result["carrier"]["name"] = cl
            break
        for cl in carrier_lines:
            if "TRANSPORT" in cl.upper():
                if not result["carrier"]["name"] or len(result["carrier"]["name"]) < 5:
                    result["carrier"]["name"] = cl
                break
    
    # ── Vehicle registration ──
    vehicle_match = re.search(r'(?:CB\d{4}\w+[/]\w+)', full_text)
    if vehicle_match:
        result["carrier"]["vehicle"] = vehicle_match.group(0)
    
    # ── Goods (Boxes 6-12) ──
    # Look for content after "Nature of the goods" or "Bezeichnung des Gutes"
    goods_lines = get_content_after([
        r'Nature of the goods',
        r'Bezeichnung des Gutes',
        r'Method of packing',
    ], max_lines=10)
    goods_items = []
    for gl in goods_lines:
        gl = gl.strip()
        if not gl or len(gl) < 3:
            continue
        # Skip known header fragments
        if any(skip in gl.lower() for skip in ['statistik', 'volumen', 'volume', 'bruttogew', 'gross weight']):
            continue
        goods_items.append({"description": gl})
    
    # Combine into single goods entry
    if goods_items:
        combined_desc = " ".join([g["description"] for g in goods_items])
        result["goods"] = [{"description": combined_desc}]
    
    # ── Weight ──
    weight_match = re.search(r'(\d+)\s*kg', full_text, re.IGNORECASE)
    if weight_match:
        result["totalGrossWeight"] = parse_number(weight_match.group(1))
    
    # ── Packages / Pallets ──
    pallets_match = re.search(r'(\d+)\s*pallets?', full_text, re.IGNORECASE)
    if pallets_match:
        result["totalPackages"] = int(pallets_match.group(1))
    
    # ── Date ──
    date_match = re.search(r'(\d{1,2}\.\d{1,2}\.\d{4})', full_text)
    if date_match:
        result["date"] = date_match.group(1)
    
    # ── CMR Number ──
    cmr_no_match = re.search(r'(?:Control|Nr|No)[:\s.]*\s*(\d{5,})', full_text, re.IGNORECASE)
    if cmr_no_match:
        result["cmrNumber"] = cmr_no_match.group(1)
    
    # ── VAT numbers ──
    vat_matches = re.findall(r'VAT[:\s]*(\S+)', full_text, re.IGNORECASE)
    if len(vat_matches) >= 1:
        result["sender"]["vatNumber"] = vat_matches[0]
    if len(vat_matches) >= 2:
        result["consignee"]["vatNumber"] = vat_matches[1]
    # Carrier VAT is typically the last one
    if len(vat_matches) >= 3:
        result["carrier"]["vatNumber"] = vat_matches[-1]
    
    # ── Special instructions ──
    instr_lines = get_content_after([
        r"Sender's instructions",
        r'Anweisungen des Absenders',
    ], max_lines=3)
    if instr_lines:
        instr_text = " ".join(instr_lines).strip()
        # Filter out form template text
        if len(instr_text) > 5 and not re.match(r'^\W*(amtl|Zu bezahlen|Behandlung|Sondervorschrift)', instr_text):
            result["instructions"] = instr_text
    
    # ── Carrier name cleanup ──
    if result["carrier"]["name"]:
        # OCR sometimes merges carrier name with vehicle plate
        name = result["carrier"]["name"]
        # Remove plate numbers that got merged
        if result["carrier"].get("vehicle"):
            name = name.replace(result["carrier"]["vehicle"], "").strip()
        # Look for "TRANS LIMITED LTD" or similar in the full text
        carrier_name_match = re.search(r'(TRANS\s+\w+(?:\s+\w+)?)\s*(?:LTD|LIMITED|TRANSPORT)', full_text, re.IGNORECASE)
        if carrier_name_match:
            result["carrier"]["name"] = carrier_name_match.group(0).strip()
    
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: cmr_extractor.py <pdf_path>"}))
        sys.exit(1)
    
    ocr_text_file = None
    if '--ocr-text' in sys.argv:
        idx = sys.argv.index('--ocr-text')
        if idx + 1 < len(sys.argv):
            ocr_text_file = sys.argv[idx + 1]
    
    output = extract_cmr(sys.argv[1], ocr_text_file=ocr_text_file)
    
    if "--json" in sys.argv:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print(f"CMR Number: {output['cmrNumber']}")
        print(f"Date: {output['date']}")
        print(f"Sender: {output['sender']['name']}")
        print(f"Carrier: {output['carrier']['name']}")
        print(f"Consignee: {output['consignee']['name']}")
        print(f"Loading: {output['placeOfLoading']}")
        print(f"Delivery: {output['placeOfDelivery']}")
        print(f"Goods: {len(output['goods'])} items")
        print(f"Weight: {output['totalGrossWeight']} kg")
