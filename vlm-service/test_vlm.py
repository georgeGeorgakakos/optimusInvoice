#!/usr/bin/env python3
"""
Test VLM service — Multi-Engine (Surya + GOT-OCR2 + Chandra)

Usage:
  python test_vlm.py <pdf_path> [doc_type] [engine]

Examples:
  python test_vlm.py ../data/invoices/DeltioApostolis.pdf dispatch_note surya
  python test_vlm.py ../data/invoices/DeltioApostolis.pdf dispatch_note got
  python test_vlm.py ../data/invoices/DeltioApostolis.pdf dispatch_note chandra
  python test_vlm.py ../data/invoices/DeltioApostolis.pdf dispatch_note surya,chandra
"""

import sys
import json
import time
import requests

VLM_URL = "http://localhost:8300"


def test_health():
    try:
        r = requests.get(f"{VLM_URL}/health", timeout=5)
        data = r.json()
        print(f"  Status: {data.get('status')}")
        print(f"  Default engine: {data.get('default_engine')}")
        engines = data.get("engines", {})
        for name, info in engines.items():
            loaded = "✅" if info.get("loaded") else "⬜"
            params = info.get("params", "")
            print(f"  {loaded} {name} ({params}): {info.get('type', 'unknown')}")
        return True
    except requests.ConnectionError:
        print("  ❌ Cannot connect — is the service running?")
        return False


def test_extract(pdf_path, doc_type="auto", engine="surya"):
    print(f"\nExtracting: {pdf_path}")
    print(f"  doc_type={doc_type}, engine={engine}")

    # Chandra needs much longer timeout
    if "chandra" in engine:
        timeout = 3600  # 1 hour
        print(f"  ⏳ Chandra is 9B params — expect 30-60 min on CPU...")
    elif "got" in engine:
        timeout = 600
    else:
        timeout = 120

    with open(pdf_path, "rb") as f:
        start = time.time()
        r = requests.post(
            f"{VLM_URL}/extract",
            files={"file": f},
            data={"doc_type": doc_type, "page": "0", "engine": engine},
            timeout=timeout,
        )

    elapsed = time.time() - start

    if r.status_code != 200:
        print(f"  ❌ HTTP {r.status_code}: {r.text[:500]}")
        return

    result = r.json()
    print(f"  ✅ Completed in {elapsed:.1f}s (server: {result.get('elapsed_seconds')}s)")
    print(f"  Engines used: {result.get('engines_used')}")

    engines_data = result.get("engines", {})
    for eng_name, eng_data in engines_data.items():
        status = eng_data.get("status", "unknown")
        if status != "ok":
            print(f"\n  [{eng_name}] ❌ {status}")
            continue
        print(f"\n  [{eng_name}] {eng_data.get('chars', 0)} chars in {eng_data.get('elapsed', '?')}s")
        text = eng_data.get("text", "")
        preview = text[:600].replace("\n", "\n    ")
        print(f"    {preview}")
        if len(text) > 600:
            print(f"    ... ({len(text)} total chars)")

    print(f"\n  Confidence: {result.get('confidence')}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python test_vlm.py <pdf_path> [doc_type] [engine]")
        print("  engine: surya (default, ~80s)")
        print("          got (~7min)")
        print("          chandra (~30-60min)")
        print("          surya,chandra (parallel)")
        sys.exit(1)

    pdf_path = sys.argv[1]
    doc_type = sys.argv[2] if len(sys.argv) > 2 else "auto"
    engine = sys.argv[3] if len(sys.argv) > 3 else "surya"

    print(f"Testing VLM service at {VLM_URL}...")
    if not test_health():
        sys.exit(1)

    test_extract(pdf_path, doc_type, engine)