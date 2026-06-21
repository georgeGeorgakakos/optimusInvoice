#!/usr/bin/env python3
"""
vlm_constrained.py
==================

Constrained-schema invoice extraction for Optimus (enhancement #2).

Wraps the existing `qwen_vl_engine` so the model is FORCED to emit a
schema-valid line-items array, instead of free-text JSON that drifts and then
gets rescued by regex. This replaces the per-layout Format-A/B/C/C2 cascade in
`vlm_invoice_parser.py`: a single schema generalises to layouts you've never
seen, so you stop hand-writing a parser per supplier.

Two layers of guarantee
------------------------
  LAYER 1 (preferred) — GRAMMAR-CONSTRAINED DECODING
      If `lm-format-enforcer` is installed, we build a
      `prefix_allowed_tokens_fn` from the JSON schema and pass it straight into
      the model's `.generate(...)` call. The model then *cannot* produce a token
      that would break the schema. Output is valid JSON by construction.

  LAYER 2 (always on) — COERCE + REPAIR
      Whatever comes back (constrained or not) is coerced to the schema:
      numbers parsed from "1.234,56", nulls normalised, unknown keys dropped,
      missing keys defaulted, lineItems guaranteed to be a list. So even on a
      box with no enforcer library, you always get a clean object.

Integration with the current engine is one line — see `INTEGRATION` at the
bottom of this file.

Dependencies: pydantic (project dep). lm-format-enforcer is OPTIONAL.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

try:
    from pydantic import BaseModel, Field
    _HAS_PYDANTIC = True
except Exception:  # pragma: no cover
    _HAS_PYDANTIC = False


# ──────────────────────────────────────────────────────────────────────────────
# Schema
# ──────────────────────────────────────────────────────────────────────────────
if _HAS_PYDANTIC:

    class LineItem(BaseModel):
        description: str = ""
        supplierCode: str = ""
        quantity: Optional[float] = None
        unitPrice: Optional[float] = None
        totalPrice: Optional[float] = None
        vatRate: Optional[float] = None

    class Invoice(BaseModel):
        invoiceNumber: Optional[str] = None
        invoiceDate: Optional[str] = None
        orderNumber: Optional[str] = None
        supplier: Optional[str] = None
        supplierVat: Optional[str] = None
        client: Optional[str] = None
        currency: str = "EUR"
        subtotal: Optional[float] = None
        vat: Optional[float] = None
        vatRate: Optional[float] = None
        total: Optional[float] = None
        paymentMethod: Optional[str] = None
        lineItems: List[LineItem] = Field(default_factory=list)

    def invoice_json_schema() -> Dict[str, Any]:
        return Invoice.model_json_schema()
else:  # pragma: no cover
    def invoice_json_schema() -> Dict[str, Any]:
        return {}


# Canonical schema skeleton used in the prompt (kept identical to the Pydantic model).
SCHEMA_HINT = """{
  "invoiceNumber": string|null, "invoiceDate": string|null, "orderNumber": string|null,
  "supplier": string|null, "supplierVat": string|null, "client": string|null,
  "currency": string, "subtotal": number|null, "vat": number|null,
  "vatRate": number|null, "total": number|null, "paymentMethod": string|null,
  "lineItems": [
    {"description": string, "supplierCode": string, "quantity": number,
     "unitPrice": number, "totalPrice": number, "vatRate": number|null}
  ]
}"""

SYSTEM_PROMPT = (
    "You are an expert invoice data-extraction engine. You are given an image of "
    "a business invoice (Greek or English). Extract every field and EVERY line "
    "item from the products/services table. Return valid JSON only."
)

USER_PROMPT = f"""Extract all data from this invoice image into JSON matching this schema exactly:

{SCHEMA_HINT}

Rules:
- Extract ALL line items in the table — do not stop after the first.
- quantity x unitPrice should equal totalPrice for each line.
- Greek numbers use comma as decimal (1.234,56 = 1234.56). Output plain numbers.
- Use null for fields not present. Output ONLY the JSON object."""


# ──────────────────────────────────────────────────────────────────────────────
# LAYER 1 — grammar-constrained decoding (optional)
# ──────────────────────────────────────────────────────────────────────────────
def get_prefix_allowed_tokens_fn(tokenizer):
    """
    Build a prefix_allowed_tokens_fn enforcing the invoice JSON schema, using
    lm-format-enforcer if available. Returns None if the library or pydantic is
    missing, in which case the caller relies on LAYER 2 (coerce + repair).

    Usage in qwen_vl_engine.extract_invoice_from_image():

        from vlm_constrained import get_prefix_allowed_tokens_fn
        fn = get_prefix_allowed_tokens_fn(_qwen_vl_processor.tokenizer)
        output_ids = _qwen_vl_model.generate(
            **inputs, max_new_tokens=..., do_sample=False,
            prefix_allowed_tokens_fn=fn,   # <- only added line
        )
    """
    if not _HAS_PYDANTIC:
        return None
    try:
        from lmformatenforcer import JsonSchemaParser
        from lmformatenforcer.integrations.transformers import (
            build_transformers_prefix_allowed_tokens_fn,
        )
    except Exception:
        return None

    parser = JsonSchemaParser(invoice_json_schema())
    return build_transformers_prefix_allowed_tokens_fn(tokenizer, parser)


def constrained_decoding_available() -> bool:
    try:
        import lmformatenforcer  # noqa: F401
        return _HAS_PYDANTIC
    except Exception:
        return False


# ──────────────────────────────────────────────────────────────────────────────
# LAYER 2 — coerce + repair (always on)
# ──────────────────────────────────────────────────────────────────────────────
def _to_number(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    s = re.sub(r"[€$£¥\s]", "", s).replace("%", "")
    if not re.search(r"\d", s):
        return None
    neg = s.startswith("-")
    s = s.lstrip("+-")
    last_c, last_d = s.rfind(","), s.rfind(".")
    try:
        if last_c >= 0 and last_d >= 0:
            s = s.replace(".", "").replace(",", ".") if last_c > last_d else s.replace(",", "")
        elif last_c >= 0:
            after = len(s) - last_c - 1
            s = s.replace(",", "") if (after == 3 and len(s.replace(",", "")) > 3) else s.replace(",", ".")
        elif last_d >= 0:
            after = len(s) - last_d - 1
            if after == 3 and len(s.replace(".", "")) > 3:
                s = s.replace(".", "")
        val = float(s)
        return -val if neg else val
    except ValueError:
        return None


def _to_str(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def extract_first_json(text: str) -> Optional[Dict[str, Any]]:
    """Pull the first balanced {...} object out of arbitrary model text."""
    if not text:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned.strip())
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    # brace-balance scan (handles trailing prose / truncation)
    start = cleaned.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(cleaned)):
        if cleaned[i] == "{":
            depth += 1
        elif cleaned[i] == "}":
            depth -= 1
            if depth == 0:
                frag = cleaned[start:i + 1]
                try:
                    return json.loads(frag)
                except json.JSONDecodeError:
                    break
    # last resort: close an open object (truncated generation)
    frag = cleaned[start:]
    frag = re.sub(r",\s*$", "", frag.rstrip())
    for closer in ("}", "]}", "]}}"):
        try:
            return json.loads(frag + closer)
        except json.JSONDecodeError:
            continue
    return None


def coerce_to_schema(raw: Any) -> Dict[str, Any]:
    """
    Coerce arbitrary model output (str or dict) into a schema-valid invoice dict.
    ALWAYS returns a well-formed object, even from junk input.
    """
    data = raw if isinstance(raw, dict) else (extract_first_json(raw or "") or {})

    items_in = data.get("lineItems") or data.get("line_items") or []
    if not isinstance(items_in, list):
        items_in = []

    line_items: List[Dict[str, Any]] = []
    for it in items_in:
        if not isinstance(it, dict):
            continue
        desc = _to_str(it.get("description") or it.get("desc"))
        qty = _to_number(it.get("quantity") or it.get("qty"))
        price = _to_number(it.get("unitPrice") or it.get("unit_price"))
        total = _to_number(it.get("totalPrice") or it.get("net_amount")
                           or it.get("total"))
        if not (desc or qty or price or total):
            continue
        line_items.append({
            "description": desc or "",
            "supplierCode": _to_str(it.get("supplierCode")
                                    or it.get("product_code")) or "",
            "quantity": qty,
            "unitPrice": price,
            "totalPrice": total,
            "unit_price": price,      # snake aliases for downstream compatibility
            "net_amount": total,
            "vatRate": _to_number(it.get("vatRate") or it.get("vat_percent")),
            "vat_percent": _to_number(it.get("vatRate") or it.get("vat_percent")),
        })

    out = {
        "invoiceNumber": _to_str(data.get("invoiceNumber")),
        "invoiceDate": _to_str(data.get("invoiceDate") or data.get("date")),
        "orderNumber": _to_str(data.get("orderNumber")),
        "supplier": _to_str(data.get("supplier")),
        "supplierVat": _to_str(data.get("supplierVat") or data.get("supplier_vat")),
        "client": _to_str(data.get("client")),
        "currency": _to_str(data.get("currency")) or "EUR",
        "subtotal": _to_number(data.get("subtotal")),
        "vat": _to_number(data.get("vat")),
        "vatRate": _to_number(data.get("vatRate")),
        "total": _to_number(data.get("total") or data.get("grandTotal")),
        "paymentMethod": _to_str(data.get("paymentMethod")),
        "lineItems": line_items,
    }

    # Validate against pydantic if present (drops anything still off-schema)
    if _HAS_PYDANTIC:
        try:
            out = Invoice(**{k: v for k, v in out.items()
                             if k != "lineItems"},
                          lineItems=[LineItem(**{kk: vv for kk, vv in li.items()
                                                 if kk in LineItem.model_fields})
                                     for li in line_items]).model_dump()
            # re-attach snake aliases lost in pydantic dump
            for src, dst in zip(line_items, out["lineItems"]):
                dst["unit_price"] = dst.get("unitPrice")
                dst["net_amount"] = dst.get("totalPrice")
                dst["vat_percent"] = dst.get("vatRate")
        except Exception:
            pass
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Orchestrator
# ──────────────────────────────────────────────────────────────────────────────
def extract_constrained(pil_image, engine=None) -> Dict[str, Any]:
    """
    Run constrained VLM extraction on a PIL image.

    `engine` is the qwen_vl_engine module (injected for testability). If None,
    it is imported lazily. Returns:
        {"structured": <schema-valid invoice dict>,
         "raw": <raw model text>, "constrained": bool, "latency_ms": float}
    """
    if engine is None:
        import qwen_vl_engine as engine  # type: ignore

    result = engine.extract_invoice_from_image(pil_image)  # uses LAYER 1 if wired
    raw_text = result.get("text", "")
    structured = result.get("structured")
    coerced = coerce_to_schema(structured if structured else raw_text)
    return {
        "structured": coerced,
        "raw": raw_text,
        "constrained": constrained_decoding_available(),
        "latency_ms": result.get("latency_ms"),
    }


# ── self-test (no model needed) ────────────────────────────────────────────────
if __name__ == "__main__":
    print("constrained decoding available:", constrained_decoding_available())
    print("pydantic available:", _HAS_PYDANTIC)

    # 1) clean JSON
    clean = '{"supplier":"ACME","total":206.90,"lineItems":[{"description":"X","quantity":2,"unitPrice":"1.234,56"}]}'
    # 2) JSON inside prose + markdown fence
    messy = 'Here you go:\n```json\n{"supplier":"ACME","lineItems":[{"description":"Y","quantity":"3","totalPrice":"30,00"}]}\n```'
    # 3) truncated generation (model hit token limit mid-array)
    trunc = '{"supplier":"ACME","total":100,"lineItems":[{"description":"Z","quantity":1,"unitPrice":100}'
    # 4) total garbage
    junk = 'I could not read the invoice.'

    for name, blob in [("clean", clean), ("messy", messy),
                       ("truncated", trunc), ("junk", junk)]:
        out = coerce_to_schema(blob)
        print(f"\n[{name}] supplier={out['supplier']} "
              f"items={len(out['lineItems'])} total={out['total']}")
        for li in out["lineItems"]:
            print("   ", json.dumps({k: li[k] for k in
                                     ("description", "quantity", "unitPrice", "totalPrice")},
                                    ensure_ascii=False))