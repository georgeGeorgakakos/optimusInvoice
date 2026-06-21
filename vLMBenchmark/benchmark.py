#!/usr/bin/env python3
"""
╔═══════════════════════════════════════════════════════════════════╗
║              Optimus VLM Benchmark Tool                          ║
║                                                                  ║
║  Tests Vision Language Models on your actual Greek invoices      ║
║  and compares accuracy vs your current Tesseract+regex pipeline  ║
╚═══════════════════════════════════════════════════════════════════╝

Usage:
    python benchmark.py --pdf invoices/          # Directory of PDFs
    python benchmark.py --pdf invoice.pdf        # Single PDF
    python benchmark.py --pdf invoices/ --ground-truth ground_truth.json
    python benchmark.py --pdf invoices/ --models qwen,mistral
    python benchmark.py --pdf invoices/ --models qwen --verbose

Requirements:
    pip install requests pdf2image Pillow rich
    + Ollama running with models pulled (see setup.sh)
"""

import argparse
import base64
import json
import os
import re
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Optional

try:
    import requests
    from PIL import Image
    from pdf2image import convert_from_path
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
    from rich import box
except ImportError as e:
    print(f"\n  Missing dependency: {e}")
    print("  Run: pip install requests pdf2image Pillow rich\n")
    sys.exit(1)

console = Console()

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

MODELS = {
    "qwen": {
        "name": "qwen2.5vl:7b",
        "display": "Qwen2.5-VL-7B",
        "type": "vision",           # sends images
        "description": "Vision-Language Model — sees the invoice image directly",
    },
    "mistral": {
        "name": "mistral:7b",
        "display": "Mistral 7B",
        "type": "text",             # receives OCR text only
        "description": "Text LLM — receives Tesseract OCR text as input",
    },
    "llama": {
        "name": "llama3.2-vision:11b",
        "display": "Llama 3.2 Vision 11B",
        "type": "vision",
        "description": "Meta's Vision-Language Model — alternative to Qwen",
    },
    "gemma": {
        "name": "gemma3:12b",
        "display": "Gemma 3 12B",
        "type": "vision",
        "description": "Google's Vision-Language Model",
    },
}

# Extraction prompt — carefully engineered for Greek invoices
EXTRACTION_PROMPT = """You are an expert invoice data extractor for Greek business documents.
Extract ALL fields from this invoice into a JSON object. The invoice may be in Greek.

Return ONLY valid JSON with this exact structure (use null for missing fields):
{
  "documentType": "invoice|credit_note|receipt_of_goods|dispatch_note|proforma",
  "invoiceNumber": "string",
  "date": "DD/MM/YYYY",
  "supplier": {
    "name": "string",
    "taxId": "string (ΑΦΜ)",
    "address": "string"
  },
  "buyer": {
    "name": "string",
    "taxId": "string (ΑΦΜ)"
  },
  "currency": "EUR",
  "totalNetValue": "number as string",
  "totalVat": "number as string",
  "totalAmount": "number as string",
  "vatRate": "number as string (e.g. 24)",
  "lineItems": [
    {
      "lineNumber": 1,
      "supplierCode": "string",
      "description": "string",
      "quantity": "number as string",
      "unit": "string (ΤΕΜ/KG/etc)",
      "unitPrice": "number as string",
      "netAmount": "number as string",
      "vatRate": "string"
    }
  ]
}

IMPORTANT RULES:
- Numbers use comma as decimal separator in Greek (e.g., 1.234,56 = 1234.56). Convert to dot notation.
- Greek field labels: ΣΥΝΟΛΟ=Total, ΦΠΑ=VAT, ΚΑΘΑΡΗ ΑΞΙΑ=Net Value, ΠΟΣΟΤΗΤΑ=Quantity, ΤΙΜΗ=Price
- ΑΦΜ = Tax Identification Number (9 digits)
- Extract ALL line items, not just the first few
- Return ONLY the JSON, no markdown, no explanation"""

TEXT_EXTRACTION_PROMPT = """You are an expert invoice data extractor. Below is OCR text from a Greek invoice PDF.
The OCR may have errors, merged words, or formatting issues. Do your best to extract the data.

OCR TEXT:
{ocr_text}

""" + EXTRACTION_PROMPT

# ═══════════════════════════════════════════════════════════════════
# OLLAMA CLIENT
# ═══════════════════════════════════════════════════════════════════

def check_ollama() -> bool:
    """Check if Ollama is running."""
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        return r.status_code == 200
    except:
        return False


def get_available_models() -> list[str]:
    """Get list of models pulled in Ollama."""
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        if r.status_code == 200:
            return [m["name"] for m in r.json().get("models", [])]
    except:
        pass
    return []


def image_to_base64(img: Image.Image, max_size: int = 2048) -> str:
    """Convert PIL Image to base64, resizing if needed."""
    # Resize for faster inference
    w, h = img.size
    if max(w, h) > max_size:
        ratio = max_size / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def run_vision_model(model_name: str, images: list[Image.Image], prompt: str,
                     timeout: int = 180) -> tuple[str, float]:
    """Send images to a vision model via Ollama. Returns (response_text, elapsed_seconds)."""
    b64_images = [image_to_base64(img) for img in images]

    payload = {
        "model": model_name,
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": b64_images,
            }
        ],
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": 4096,
        },
    }

    start = time.time()
    r = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=timeout)
    elapsed = time.time() - start

    if r.status_code != 200:
        raise Exception(f"Ollama error {r.status_code}: {r.text[:200]}")

    return r.json()["message"]["content"], elapsed


def run_text_model(model_name: str, ocr_text: str, prompt_template: str,
                   timeout: int = 120) -> tuple[str, float]:
    """Send OCR text to a text-only model via Ollama. Returns (response_text, elapsed_seconds)."""
    prompt = prompt_template.replace("{ocr_text}", ocr_text)

    payload = {
        "model": model_name,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": 4096,
        },
    }

    start = time.time()
    r = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=timeout)
    elapsed = time.time() - start

    if r.status_code != 200:
        raise Exception(f"Ollama error {r.status_code}: {r.text[:200]}")

    return r.json()["message"]["content"], elapsed


# ═══════════════════════════════════════════════════════════════════
# PDF PROCESSING
# ═══════════════════════════════════════════════════════════════════

def pdf_to_images(pdf_path: str, dpi: int = 300) -> list[Image.Image]:
    """Convert PDF pages to PIL Images."""
    return convert_from_path(pdf_path, dpi=dpi, fmt="png")


def extract_ocr_text(images: list[Image.Image]) -> str:
    """Run basic OCR with Tesseract (for text-model fallback). Requires pytesseract."""
    try:
        import pytesseract
        texts = []
        for img in images:
            text = pytesseract.image_to_string(img, lang="ell+eng", config="--psm 3")
            texts.append(text)
        return "\n\n--- PAGE BREAK ---\n\n".join(texts)
    except ImportError:
        console.print("[yellow]  pytesseract not installed — text models will receive empty OCR.[/]")
        console.print("[yellow]  Install: pip install pytesseract  (+ Tesseract binary)[/]")
        return ""


# ═══════════════════════════════════════════════════════════════════
# RESPONSE PARSING
# ═══════════════════════════════════════════════════════════════════

def parse_json_response(raw: str) -> Optional[dict]:
    """Try to extract JSON from model response (may have markdown fences, preamble, etc.)."""
    # Strip markdown fences
    cleaned = re.sub(r"```(?:json)?\s*", "", raw)
    cleaned = re.sub(r"```\s*$", "", cleaned)
    cleaned = cleaned.strip()

    # Try direct parse
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Try to find JSON object in text
    match = re.search(r"\{[\s\S]*\}", cleaned)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return None


# ═══════════════════════════════════════════════════════════════════
# EVALUATION
# ═══════════════════════════════════════════════════════════════════

def normalize_str(s: Optional[str]) -> str:
    """Normalize a string for comparison."""
    if not s:
        return ""
    return re.sub(r"\s+", " ", str(s).strip().lower())


def normalize_number(s: Optional[str]) -> Optional[float]:
    """Parse a number that may use comma as decimal separator."""
    if not s:
        return None
    cleaned = str(s).replace(" ", "").replace(".", "").replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def evaluate_extraction(extracted: dict, ground_truth: dict) -> dict:
    """Compare extracted data against ground truth. Returns per-field accuracy."""
    results = {}

    # Header fields
    header_fields = [
        ("documentType", "exact"),
        ("invoiceNumber", "exact"),
        ("date", "exact"),
        ("totalAmount", "numeric"),
        ("totalNetValue", "numeric"),
        ("totalVat", "numeric"),
        ("vatRate", "numeric"),
    ]

    for field, compare_type in header_fields:
        gt_val = ground_truth.get(field)
        ex_val = extracted.get(field)

        if gt_val is None:
            results[field] = {"status": "skip", "reason": "no ground truth"}
            continue

        if compare_type == "exact":
            match = normalize_str(str(ex_val)) == normalize_str(str(gt_val))
        elif compare_type == "numeric":
            gt_num = normalize_number(str(gt_val))
            ex_num = normalize_number(str(ex_val))
            if gt_num is None:
                match = False
            elif ex_num is None:
                match = False
            else:
                match = abs(gt_num - ex_num) < 0.02  # tolerance for rounding
        else:
            match = False

        results[field] = {
            "status": "match" if match else "miss",
            "expected": str(gt_val),
            "got": str(ex_val) if ex_val else "(missing)",
        }

    # Supplier
    gt_supplier = ground_truth.get("supplier", {})
    ex_supplier = extracted.get("supplier", {})
    if gt_supplier:
        for sf in ["name", "taxId"]:
            gt_v = gt_supplier.get(sf)
            if gt_v:
                ex_v = ex_supplier.get(sf) if isinstance(ex_supplier, dict) else None
                match = normalize_str(str(ex_v)) == normalize_str(str(gt_v)) if ex_v else False
                results[f"supplier.{sf}"] = {
                    "status": "match" if match else "miss",
                    "expected": str(gt_v),
                    "got": str(ex_v) if ex_v else "(missing)",
                }

    # Line items
    gt_items = ground_truth.get("lineItems", [])
    ex_items = extracted.get("lineItems", [])

    results["lineItemCount"] = {
        "status": "match" if len(ex_items) == len(gt_items) else "miss",
        "expected": str(len(gt_items)),
        "got": str(len(ex_items)),
    }

    # Per-item comparison (by index)
    item_matches = 0
    item_total = 0
    for i, gt_item in enumerate(gt_items):
        if i >= len(ex_items):
            break
        ex_item = ex_items[i]

        for item_field in ["supplierCode", "description", "quantity", "unitPrice", "netAmount"]:
            gt_v = gt_item.get(item_field)
            if gt_v is None:
                continue
            ex_v = ex_item.get(item_field)
            item_total += 1

            if item_field in ["quantity", "unitPrice", "netAmount"]:
                gt_n = normalize_number(str(gt_v))
                ex_n = normalize_number(str(ex_v))
                if gt_n and ex_n and abs(gt_n - ex_n) < 0.02:
                    item_matches += 1
            else:
                if normalize_str(str(ex_v)) == normalize_str(str(gt_v)):
                    item_matches += 1

    results["lineItemFieldAccuracy"] = {
        "status": "info",
        "expected": str(item_total),
        "got": f"{item_matches}/{item_total} ({round(item_matches/max(item_total,1)*100)}%)",
    }

    return results


# ═══════════════════════════════════════════════════════════════════
# REPORTING
# ═══════════════════════════════════════════════════════════════════

def print_extraction_result(model_key: str, model_info: dict, extracted: dict,
                            elapsed: float, evaluation: Optional[dict] = None):
    """Pretty-print a single model's extraction result."""
    console.print()
    console.print(Panel(
        f"[bold]{model_info['display']}[/bold]  ({model_info['type']} model)\n"
        f"[dim]{model_info['description']}[/dim]\n"
        f"[cyan]Inference time: {elapsed:.1f}s[/cyan]",
        border_style="blue" if extracted else "red",
        title=f"Model: {model_key}",
    ))

    if not extracted:
        console.print("  [red]✗ Failed to parse JSON response[/red]")
        return

    # Header fields
    tbl = Table(show_header=True, header_style="bold", box=box.SIMPLE_HEAVY, padding=(0, 1))
    tbl.add_column("Field", style="bold", width=20)
    tbl.add_column("Extracted Value", width=35)
    if evaluation:
        tbl.add_column("Expected", width=25)
        tbl.add_column("", width=3)

    fields = [
        ("Document Type", extracted.get("documentType")),
        ("Invoice Number", extracted.get("invoiceNumber")),
        ("Date", extracted.get("date")),
        ("Supplier Name", extracted.get("supplier", {}).get("name") if isinstance(extracted.get("supplier"), dict) else None),
        ("Supplier ΑΦΜ", extracted.get("supplier", {}).get("taxId") if isinstance(extracted.get("supplier"), dict) else None),
        ("Total Net", extracted.get("totalNetValue")),
        ("Total VAT", extracted.get("totalVat")),
        ("Total Amount", extracted.get("totalAmount")),
        ("VAT Rate", extracted.get("vatRate")),
        ("Line Items", str(len(extracted.get("lineItems", [])))),
    ]

    eval_map = {
        "Document Type": "documentType", "Invoice Number": "invoiceNumber",
        "Date": "date", "Total Net": "totalNetValue", "Total VAT": "totalVat",
        "Total Amount": "totalAmount", "VAT Rate": "vatRate",
        "Supplier Name": "supplier.name", "Supplier ΑΦΜ": "supplier.taxId",
        "Line Items": "lineItemCount",
    }

    for label, val in fields:
        val_str = str(val) if val else "[dim]—[/dim]"
        if evaluation:
            ek = eval_map.get(label)
            ev = evaluation.get(ek, {}) if ek else {}
            expected = ev.get("expected", "")
            status = ev.get("status", "skip")
            icon = "✓" if status == "match" else "✗" if status == "miss" else "—"
            color = "green" if status == "match" else "red" if status == "miss" else "dim"
            tbl.add_row(label, val_str, expected, f"[{color}]{icon}[/]")
        else:
            tbl.add_row(label, val_str)

    console.print(tbl)

    # Line items preview
    items = extracted.get("lineItems", [])
    if items:
        console.print(f"\n  [bold]Line Items ({len(items)}):[/bold]")
        li_tbl = Table(show_header=True, header_style="bold dim", box=box.SIMPLE, padding=(0, 1))
        li_tbl.add_column("#", width=3)
        li_tbl.add_column("Code", width=14)
        li_tbl.add_column("Description", width=30)
        li_tbl.add_column("Qty", width=8, justify="right")
        li_tbl.add_column("Price", width=10, justify="right")
        li_tbl.add_column("Net", width=12, justify="right")

        for i, item in enumerate(items[:15]):  # show first 15
            li_tbl.add_row(
                str(i + 1),
                str(item.get("supplierCode", "—")),
                str(item.get("description", "—"))[:30],
                str(item.get("quantity", "—")),
                str(item.get("unitPrice", "—")),
                str(item.get("netAmount", "—")),
            )
        if len(items) > 15:
            li_tbl.add_row("...", f"+ {len(items) - 15} more", "", "", "", "")

        console.print(li_tbl)

    if evaluation:
        lifa = evaluation.get("lineItemFieldAccuracy", {})
        if lifa:
            console.print(f"  [bold]Line item field accuracy:[/bold] {lifa.get('got', 'N/A')}")


def print_summary(all_results: dict, pdf_files: list[str]):
    """Print final comparison summary across all models and files."""
    console.print()
    console.print(Panel("[bold white]BENCHMARK SUMMARY[/bold white]", border_style="bright_blue"))

    # Overall accuracy per model
    summary_tbl = Table(show_header=True, header_style="bold", box=box.DOUBLE_EDGE, padding=(0, 2))
    summary_tbl.add_column("Model", width=22)
    summary_tbl.add_column("Avg Time", width=10, justify="right")
    summary_tbl.add_column("JSON Parse %", width=12, justify="right")
    summary_tbl.add_column("Header Accuracy", width=16, justify="right")
    summary_tbl.add_column("Item Count Acc.", width=16, justify="right")
    summary_tbl.add_column("Item Field Acc.", width=16, justify="right")

    for model_key, runs in all_results.items():
        model_info = MODELS.get(model_key, {})
        total_runs = len(runs)
        parsed = sum(1 for r in runs if r.get("extracted"))
        parse_pct = round(parsed / max(total_runs, 1) * 100)

        avg_time = sum(r.get("elapsed", 0) for r in runs) / max(total_runs, 1)

        # Header accuracy (across files with ground truth)
        header_matches = 0
        header_total = 0
        item_count_matches = 0
        item_count_total = 0
        item_field_text = "N/A"

        for r in runs:
            ev = r.get("evaluation")
            if not ev:
                continue
            for k, v in ev.items():
                if k in ["lineItemCount", "lineItemFieldAccuracy"]:
                    continue
                if v.get("status") == "match":
                    header_matches += 1
                if v.get("status") in ["match", "miss"]:
                    header_total += 1
            if ev.get("lineItemCount", {}).get("status") == "match":
                item_count_matches += 1
            if ev.get("lineItemCount", {}).get("status") in ["match", "miss"]:
                item_count_total += 1

        header_pct = f"{round(header_matches/max(header_total,1)*100)}% ({header_matches}/{header_total})" if header_total > 0 else "N/A"
        item_count_pct = f"{round(item_count_matches/max(item_count_total,1)*100)}%" if item_count_total > 0 else "N/A"

        color = "green" if parse_pct >= 90 else "yellow" if parse_pct >= 70 else "red"
        summary_tbl.add_row(
            model_info.get("display", model_key),
            f"{avg_time:.1f}s",
            f"[{color}]{parse_pct}%[/]",
            header_pct,
            item_count_pct,
            item_field_text,
        )

    console.print(summary_tbl)

    console.print("\n[bold]Recommendations:[/bold]")
    console.print("  • JSON Parse % shows how reliably the model returns valid structured output")
    console.print("  • Header Accuracy shows how many header fields (invoice #, date, amounts) matched ground truth")
    console.print("  • A model with >90% parse rate and >80% header accuracy is ready for integration")
    console.print("  • Vision models (Qwen, Llama) typically outperform text-only (Mistral) on layout-heavy invoices")
    console.print()


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Optimus VLM Benchmark — Test models on your invoices")
    parser.add_argument("--pdf", required=True, help="Path to PDF file or directory of PDFs")
    parser.add_argument("--models", default="qwen,mistral",
                        help=f"Comma-separated model keys: {','.join(MODELS.keys())} (default: qwen,mistral)")
    parser.add_argument("--ground-truth", help="Path to ground_truth.json for accuracy scoring")
    parser.add_argument("--dpi", type=int, default=300, help="DPI for PDF rendering (default: 300)")
    parser.add_argument("--verbose", action="store_true", help="Print raw model responses")
    parser.add_argument("--save-results", help="Save results JSON to this path")
    parser.add_argument("--ollama-url", default=OLLAMA_URL, help=f"Ollama API URL (default: {OLLAMA_URL})")
    args = parser.parse_args()

    global OLLAMA_URL
    OLLAMA_URL = args.ollama_url

    # ── Banner ──
    console.print(Panel(
        "[bold bright_blue]Optimus VLM Benchmark Tool[/bold bright_blue]\n"
        "[dim]Testing Vision Language Models on your invoice documents[/dim]",
        border_style="bright_blue",
    ))

    # ── Check Ollama ──
    console.print("\n[bold]1. Checking Ollama...[/bold]")
    if not check_ollama():
        console.print(f"  [red]✗ Ollama not running at {OLLAMA_URL}[/red]")
        console.print("  Install: curl -fsSL https://ollama.com/install.sh | sh")
        console.print("  Start:   ollama serve")
        sys.exit(1)
    console.print(f"  [green]✓ Ollama running at {OLLAMA_URL}[/green]")

    available = get_available_models()
    console.print(f"  Available models: {', '.join(available) if available else '(none)'}")

    # ── Resolve models ──
    requested = [m.strip() for m in args.models.split(",")]
    active_models = {}

    for mk in requested:
        if mk not in MODELS:
            console.print(f"  [yellow]⚠ Unknown model key '{mk}' — skipping[/yellow]")
            continue
        model_name = MODELS[mk]["name"]
        # Check if model (or a variant) is available
        found = any(model_name.split(":")[0] in a for a in available)
        if found:
            active_models[mk] = MODELS[mk]
            console.print(f"  [green]✓ {MODELS[mk]['display']} — ready[/green]")
        else:
            console.print(f"  [yellow]⚠ {MODELS[mk]['display']} ({model_name}) not pulled[/yellow]")
            console.print(f"    Pull it: ollama pull {model_name}")
            # Still add it — Ollama will auto-pull on first request (slow)
            ans = input(f"    Try anyway (Ollama will download ~4-8GB)? [y/N]: ").strip().lower()
            if ans == "y":
                active_models[mk] = MODELS[mk]

    if not active_models:
        console.print("\n  [red]No models available. Pull at least one:[/red]")
        for mk, mi in MODELS.items():
            console.print(f"    ollama pull {mi['name']}  # {mi['display']}")
        sys.exit(1)

    # ── Collect PDF files ──
    console.print(f"\n[bold]2. Collecting PDFs...[/bold]")
    pdf_path = Path(args.pdf)
    if pdf_path.is_file():
        pdf_files = [str(pdf_path)]
    elif pdf_path.is_dir():
        pdf_files = sorted([str(p) for p in pdf_path.glob("*.pdf")])
    else:
        console.print(f"  [red]✗ Path not found: {args.pdf}[/red]")
        sys.exit(1)

    if not pdf_files:
        console.print(f"  [red]✗ No PDF files found in {args.pdf}[/red]")
        sys.exit(1)

    console.print(f"  Found {len(pdf_files)} PDF(s)")
    for f in pdf_files[:5]:
        console.print(f"    • {Path(f).name}")
    if len(pdf_files) > 5:
        console.print(f"    ... and {len(pdf_files) - 5} more")

    # ── Load ground truth ──
    ground_truth = {}
    if args.ground_truth:
        console.print(f"\n[bold]3. Loading ground truth...[/bold]")
        try:
            with open(args.ground_truth, "r", encoding="utf-8") as f:
                ground_truth = json.load(f)
            console.print(f"  [green]✓ Loaded ground truth for {len(ground_truth)} invoices[/green]")
        except Exception as e:
            console.print(f"  [yellow]⚠ Could not load ground truth: {e}[/yellow]")
    else:
        console.print(f"\n[bold]3. No ground truth provided[/bold] (pass --ground-truth for accuracy scoring)")

    # ── Run benchmark ──
    console.print(f"\n[bold]4. Running benchmark...[/bold]")
    all_results: dict[str, list] = {mk: [] for mk in active_models}

    for pdf_file in pdf_files:
        fname = Path(pdf_file).stem
        console.print(f"\n{'─'*60}")
        console.print(f"[bold white]Processing: {Path(pdf_file).name}[/bold white]")
        console.print(f"{'─'*60}")

        # Render PDF
        try:
            images = pdf_to_images(pdf_file, dpi=args.dpi)
            console.print(f"  Rendered {len(images)} page(s) at {args.dpi} DPI")
        except Exception as e:
            console.print(f"  [red]✗ Failed to render PDF: {e}[/red]")
            continue

        # Get OCR text for text-only models
        ocr_text = None

        gt = ground_truth.get(fname)

        for model_key, model_info in active_models.items():
            console.print(f"\n  [cyan]► Running {model_info['display']}...[/cyan]")

            try:
                if model_info["type"] == "vision":
                    raw_response, elapsed = run_vision_model(
                        model_info["name"], images, EXTRACTION_PROMPT
                    )
                else:
                    # Text model needs OCR
                    if ocr_text is None:
                        console.print("    Running Tesseract OCR first...")
                        ocr_text = extract_ocr_text(images)
                        if ocr_text:
                            console.print(f"    OCR: {len(ocr_text)} chars extracted")
                        else:
                            console.print("    [yellow]OCR produced no text[/yellow]")

                    raw_response, elapsed = run_text_model(
                        model_info["name"], ocr_text or "(empty OCR)", TEXT_EXTRACTION_PROMPT
                    )

                if args.verbose:
                    console.print(f"\n    [dim]Raw response ({len(raw_response)} chars):[/dim]")
                    console.print(f"    [dim]{raw_response[:500]}{'...' if len(raw_response) > 500 else ''}[/dim]")

                extracted = parse_json_response(raw_response)

                evaluation = None
                if extracted and gt:
                    evaluation = evaluate_extraction(extracted, gt)

                run_data = {
                    "file": pdf_file,
                    "elapsed": elapsed,
                    "extracted": extracted,
                    "evaluation": evaluation,
                    "raw_length": len(raw_response),
                }
                all_results[model_key].append(run_data)

                print_extraction_result(model_key, model_info, extracted, elapsed, evaluation)

            except Exception as e:
                console.print(f"    [red]✗ Error: {e}[/red]")
                all_results[model_key].append({
                    "file": pdf_file, "elapsed": 0, "extracted": None, "error": str(e)
                })

    # ── Summary ──
    print_summary(all_results, pdf_files)

    # ── Save results ──
    if args.save_results:
        # Convert for JSON serialization
        serializable = {}
        for mk, runs in all_results.items():
            serializable[mk] = []
            for r in runs:
                sr = {**r}
                sr.pop("raw_response", None)
                serializable[mk].append(sr)

        with open(args.save_results, "w", encoding="utf-8") as f:
            json.dump(serializable, f, indent=2, ensure_ascii=False, default=str)
        console.print(f"[green]Results saved to {args.save_results}[/green]")


if __name__ == "__main__":
    main()
