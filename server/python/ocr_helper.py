#!/usr/bin/env python3
"""
PDF Text Extraction Helper (Python side)

Two strategies (in priority order):
  1. pdfplumber — fast, accurate extraction for text-based PDFs (preserves Greek, tables)
  2. Pre-extracted OCR text — reads .ocr.txt file created by Node.js (tesseract.js)

pdfplumber ALWAYS runs first. OCR text is only used when pdfplumber fails or
returns very little text (scanned PDFs). This is critical because:
  - pdfplumber extracts perfect Greek text (Προϊόν No34, ΙΩΑΝΝΗΣ ΒΕΝΕΤΙΚΙΔΗΣ)
  - pdfplumber extracts structured tables (column-aware)
  - OCR text is often garbled for Greek (Προϊόν → Npolav, ΤΕΜΑΧ → TEMAX)
  - OCR loses table structure (columns become whitespace-separated text)

No system dependencies (no Tesseract, no Poppler). OCR is handled by Node.js.
VLM integration is handled in TypeScript (python-integration.ts), not here.
"""

import sys
import os


def _extract_bbox_table(page):
    """
    Reconstruct a table from a borderless PDF page using bounding-box word grouping.

    Algorithm:
      1. Extract all words with their (x0, top, x1, bottom) coordinates.
      2. Cluster words into row bands: words whose vertical midpoints are within
         Y_TOLERANCE points of each other belong to the same row.
      3. Within each row, sort words left-to-right by x0.
      4. Detect column boundaries by finding x-gap clusters across all rows,
         then assign each word to a column bucket.
      5. Return a list-of-lists (rows x cols), compatible with pdfplumber's
         extract_tables() output so _process_table() in the extractor can
         consume it unchanged.

    Y_TOLERANCE : max vertical distance (pt) to merge words into the same row.
    MIN_GAP     : minimum x-gap (pt) between adjacent word clusters to treat
                  as a column boundary.
    MIN_COLS    : discard tables with fewer than this many columns (noise filter).
    MIN_ROWS    : discard tables with fewer than this many content rows.
    """
    Y_TOLERANCE = 4
    MIN_GAP     = 12
    MIN_COLS    = 3
    MIN_ROWS    = 2

    try:
        words = page.extract_words(x_tolerance=3, y_tolerance=3, keep_blank_chars=False)
    except Exception:
        return None

    if not words:
        return None

    # Cluster words into rows by y-midpoint proximity
    rows_dict = {}
    for w in words:
        y_mid = (w["top"] + w["bottom"]) / 2
        placed = False
        for key in list(rows_dict.keys()):
            if abs(key - y_mid) <= Y_TOLERANCE:
                rows_dict[key].append(w)
                placed = True
                break
        if not placed:
            rows_dict[y_mid] = [w]

    sorted_rows = [rows_dict[k] for k in sorted(rows_dict.keys())]
    if len(sorted_rows) < MIN_ROWS + 1:
        return None

    # Find column boundaries via x-gap analysis
    all_x_starts = sorted(set(round(w["x0"]) for row in sorted_rows for w in row))
    col_boundaries = [0.0]
    prev = all_x_starts[0] if all_x_starts else 0
    for x in all_x_starts[1:]:
        if x - prev >= MIN_GAP:
            col_boundaries.append((x + prev) / 2)
        prev = x
    col_boundaries.append(float(page.width) + 1)

    num_cols = len(col_boundaries) - 1
    if num_cols < MIN_COLS:
        return None

    def col_index(x0):
        for i in range(len(col_boundaries) - 1):
            if col_boundaries[i] <= x0 < col_boundaries[i + 1]:
                return i
        return num_cols - 1

    table = []
    for row_words in sorted_rows:
        row_words_sorted = sorted(row_words, key=lambda w: w["x0"])
        row = [""] * num_cols
        for w in row_words_sorted:
            ci = col_index(w["x0"])
            row[ci] = (row[ci] + " " + w["text"]).strip() if row[ci] else w["text"]
        table.append(row)

    # Discard if majority of rows are single-cell (body text, not a table)
    multi_cell_rows = sum(1 for r in table if sum(1 for c in r if c) > 1)
    if multi_cell_rows < max(MIN_ROWS, len(table) * 0.4):
        return None

    sys.stderr.write(f"[OCR] bbox table: {len(table)} rows x {num_cols} cols\n")
    return table


def extract_text_from_pdf(pdf_path, max_pages=5, ocr_text_file=None):
    """
    Extract text from PDF.

    Args:
        pdf_path: Path to PDF file
        max_pages: Max pages to process
        ocr_text_file: Path to pre-extracted OCR text from Node.js (optional)

    Returns:
        dict with: text, method, pages, tables
    """
    result = {
        "text": "",
        "method": "failed",
        "pages": 0,
        "tables": [],
    }

    # ── Strategy 1: pdfplumber FIRST (text-based PDFs) ──
    pdfplumber_text = ""
    pdfplumber_tables = []
    pdfplumber_pages = 0

    try:
        import pdfplumber
        full_text = ""
        tables = []
        with pdfplumber.open(pdf_path) as pdf:
            pdfplumber_pages = len(pdf.pages)
            for page in pdf.pages[:max_pages]:
                page_text = page.extract_text() or ""
                full_text += page_text + "\n"

                # ── Strategy A: line-drawn tables (most reliable) ──
                page_tables_found = []
                for strategy in [
                    {"vertical_strategy": "lines", "horizontal_strategy": "lines"},
                    {"vertical_strategy": "text", "horizontal_strategy": "text"},
                ]:
                    try:
                        page_tables = page.extract_tables(strategy)
                        if page_tables:
                            page_tables_found.extend(page_tables)
                    except Exception:
                        pass

                if page_tables_found:
                    tables.extend(page_tables_found)
                else:
                    # ── Strategy B: bounding-box word grouping ──
                    # Groups words by y-coordinate band (±4pt), reconstructs rows
                    # Works on borderless tables where line-based extraction fails
                    try:
                        bbox_table = _extract_bbox_table(page)
                        if bbox_table and len(bbox_table) >= 2:
                            tables.append(bbox_table)
                            sys.stderr.write(
                                f"[OCR] bbox table: {len(bbox_table)} rows on page {page.page_number}\n"
                            )
                    except Exception:
                        pass

        pdfplumber_text = full_text
        pdfplumber_tables = tables

        stripped = full_text.strip()
        if len(stripped) > 50:
            sys.stderr.write(
                f"[OCR] pdfplumber extracted {len(stripped)} chars + {len(tables)} tables — using pdfplumber\n")
            result["text"] = full_text
            result["method"] = "pdfplumber"
            result["pages"] = pdfplumber_pages
            result["tables"] = tables
            return result

        sys.stderr.write(f"[OCR] pdfplumber extracted only {len(stripped)} chars — scanned PDF, trying OCR text\n")
    except Exception as e:
        sys.stderr.write(f"[OCR] pdfplumber failed: {e}\n")

    # ── Strategy 2: Pre-extracted OCR text from Node.js (fallback) ──
    if ocr_text_file and os.path.exists(ocr_text_file):
        try:
            with open(ocr_text_file, 'r', encoding='utf-8') as f:
                text = f.read()
            if len(text.strip()) > 20:
                sys.stderr.write(f"[OCR] Using pre-extracted OCR text from Node.js ({len(text)} chars)\n")
                result["text"] = text
                result["method"] = "ocr_preextracted"
                result["pages"] = pdfplumber_pages or 1

                if pdfplumber_tables:
                    result["tables"] = pdfplumber_tables
                    sys.stderr.write(f"[OCR] Combining OCR text with {len(pdfplumber_tables)} pdfplumber tables\n")

                return result
        except Exception as e:
            sys.stderr.write(f"[OCR] Failed to read pre-extracted text: {e}\n")

    # ── Strategy 3: pdfplumber got *some* text (< 50 chars) — use it anyway ──
    if len(pdfplumber_text.strip()) > 0:
        sys.stderr.write(f"[OCR] Falling back to sparse pdfplumber text ({len(pdfplumber_text.strip())} chars)\n")
        result["text"] = pdfplumber_text
        result["method"] = "pdfplumber"
        result["pages"] = pdfplumber_pages
        result["tables"] = pdfplumber_tables
        return result

    # ── No text available ──
    sys.stderr.write("[OCR] No text extracted. Node.js OCR should provide --ocr-text for scanned PDFs.\n")
    return result


def parse_ocr_text_arg(argv=None):
    """Parse --ocr-text argument from command line args."""
    args = argv or sys.argv
    if '--ocr-text' in args:
        idx = args.index('--ocr-text')
        if idx + 1 < len(args):
            return args[idx + 1]
    return None


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: ocr_helper.py <pdf_path> [--ocr-text <text_file>]")
        sys.exit(1)

    import json

    ocr_text_file = parse_ocr_text_arg()
    result = extract_text_from_pdf(sys.argv[1], ocr_text_file=ocr_text_file)
    print(f"Method: {result['method']}")
    print(f"Pages: {result['pages']}")
    print(f"Text length: {len(result['text'])}")
    print(f"Tables: {len(result['tables'])}")
    print("--- Preview ---")
    print(result["text"][:500])