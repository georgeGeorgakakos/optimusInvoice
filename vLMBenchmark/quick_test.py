#!/usr/bin/env python3
"""
Quick single-invoice test. Run without ground truth to see what the model extracts.

Usage:
    python quick_test.py invoice.pdf                   # Uses qwen2.5vl by default
    python quick_test.py invoice.pdf --model mistral   # Use Mistral instead
    python quick_test.py invoice.pdf --model qwen --save result.json
"""

import argparse
import json
import sys
import os

# Add parent to path
sys.path.insert(0, os.path.dirname(__file__))

from benchmark import (
    check_ollama, get_available_models, MODELS,
    pdf_to_images, extract_ocr_text,
    run_vision_model, run_text_model,
    parse_json_response, EXTRACTION_PROMPT, TEXT_EXTRACTION_PROMPT,
    console,
)

from rich.panel import Panel
from rich.syntax import Syntax


def main():
    parser = argparse.ArgumentParser(description="Quick test: extract one invoice")
    parser.add_argument("pdf", help="Path to invoice PDF")
    parser.add_argument("--model", default="qwen", help="Model key (qwen/mistral/llama/gemma)")
    parser.add_argument("--save", help="Save JSON result to file")
    parser.add_argument("--dpi", type=int, default=300)
    args = parser.parse_args()

    if not check_ollama():
        console.print("[red]Ollama not running. Start with: ollama serve[/red]")
        sys.exit(1)

    model_info = MODELS.get(args.model)
    if not model_info:
        console.print(f"[red]Unknown model: {args.model}. Choose from: {', '.join(MODELS.keys())}[/red]")
        sys.exit(1)

    console.print(Panel(
        f"[bold]Quick Test[/bold]\n"
        f"PDF: {args.pdf}\n"
        f"Model: {model_info['display']} ({model_info['type']})",
        border_style="blue"
    ))

    # Render
    console.print("\n[cyan]Rendering PDF...[/cyan]")
    images = pdf_to_images(args.pdf, dpi=args.dpi)
    console.print(f"  {len(images)} page(s) at {args.dpi} DPI")

    # Run model
    console.print(f"\n[cyan]Running {model_info['display']}...[/cyan]")
    if model_info["type"] == "vision":
        raw, elapsed = run_vision_model(model_info["name"], images, EXTRACTION_PROMPT)
    else:
        console.print("  Running OCR first...")
        ocr_text = extract_ocr_text(images)
        console.print(f"  OCR: {len(ocr_text)} chars")
        raw, elapsed = run_text_model(model_info["name"], ocr_text, TEXT_EXTRACTION_PROMPT)

    console.print(f"\n[green]✓ Done in {elapsed:.1f}s[/green]  ({len(raw)} chars)")

    # Parse
    extracted = parse_json_response(raw)
    if extracted:
        formatted = json.dumps(extracted, indent=2, ensure_ascii=False)
        console.print(Panel(
            Syntax(formatted, "json", theme="monokai", line_numbers=False),
            title="Extracted Data",
            border_style="green"
        ))

        # Quick stats
        items = extracted.get("lineItems", [])
        supplier = extracted.get("supplier", {})
        if isinstance(supplier, dict):
            console.print(f"  Supplier: {supplier.get('name', '?')}")
        console.print(f"  Invoice #: {extracted.get('invoiceNumber', '?')}")
        console.print(f"  Date: {extracted.get('date', '?')}")
        console.print(f"  Total: {extracted.get('totalAmount', '?')}")
        console.print(f"  Line items: {len(items)}")

        if args.save:
            with open(args.save, "w", encoding="utf-8") as f:
                json.dump(extracted, f, indent=2, ensure_ascii=False)
            console.print(f"\n[green]Saved to {args.save}[/green]")
    else:
        console.print("[red]✗ Could not parse JSON from response[/red]")
        console.print(f"\n[dim]Raw response:[/dim]\n{raw[:1000]}")


if __name__ == "__main__":
    main()
