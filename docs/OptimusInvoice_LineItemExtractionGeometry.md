# Optimus — Line-Item Extraction Enhancements (#1 Geometric + #2 Constrained VLM)

This package adds two new extraction paths and the machinery to combine them, so
Optimus detects line items and header fields more reliably across the messy
real-world mix of Greek (myDATA/ΑΑΔΕ) and international invoices.

It is **additive**: four standalone modules drop into `server/python/` and are
wired in with a handful of lines. Nothing in the existing 62 KB
`invoice_extractor_advanced.py` has to be rewritten.

```
server/python/
├── geometric_columns.py      # Enhancement #1 — geometry-based column reconstruction
├── vlm_constrained.py        # Enhancement #2 — constrained-schema VLM extraction
├── arithmetic_validator.py   # Shared backbone — repair, validate, confidence
└── ensemble_extractor.py     # Orchestrator — run both, score, reconcile, route to review
```

---

## 1. Why the current pipeline leaks accuracy

Three structural problems in the existing flow:

1. **It's a waterfall, not an ensemble.** `extract_from_pdf` runs the table
   parser and *only if it returns zero items* falls back to text parsing; the
   VLM regex cascade is a separate world. A partial parse (3 of 5 rows) returns
   3 and suppresses everything else. The failure is silent — the output looks
   valid.

2. **No real geometric reasoning.** Everything depends on pdfplumber detecting a
   grid. Greek invoices are frequently borderless, so the grid detection fails.
   The existing `ocr_helper._extract_bbox_table` tries geometry but buckets words
   by their **left edge** (`x0`) — fatal for right-aligned numeric columns
   (`1.234,56` and `9,90` start in different places) — and never uses the
   per-supplier column prior the profile store already maintains.

3. **The VLM emits free-text JSON** that drifts, then a per-layout regex cascade
   (Format A/B/C/C2…) tries to rescue it. Every new supplier layout means a new
   regex branch — unbounded maintenance.

The invoice's own arithmetic (qty × price = net, Σ net = subtotal, subtotal +
VAT = total) is **free ground truth** that none of the paths currently use to
*choose between* extractions or to *repair* them.

---

## 2. Enhancement #1 — Geometric column reconstruction

**File:** `geometric_columns.py` · **Input:** born-digital PDFs (real text layer)

### Concept

Reconstruct the table from *where words physically sit* on the page, not from
grid lines that may not exist.

```
1. Extract words with bounding boxes:  page.extract_words() → (x0, x1, top, bottom)
2. Cluster words into ROW BANDS by vertical midpoint (±y_tolerance pt).
3. Find the HEADER ROW: the band whose tokens best fuzzy-match canonical
   column names (ΚΩΔΙΚΟΣ, ΠΕΡΙΓΡΑΦΗ, ΠΟΣΟΤΗΤΑ, ΤΙΜΗ, ΑΞΙΑ, ΦΠΑ…).
   → each header token's centre-x becomes a COLUMN ANCHOR, labelled semantically.
4. REFINE anchors with k-means (Lloyd) over the body rows: assign each word to
   its nearest anchor, move the anchor to the median centre of its words, repeat.
   → right-aligned numeric anchors migrate to where the digits actually are.
5. Assign every body word to its nearest anchor by CENTRE-x (alignment-agnostic).
6. Emit semantically-labelled items + the detected column_x positions.
```

### The three fixes over the old `_extract_bbox_table`

| Old behaviour | New behaviour |
|---|---|
| Bucket by left edge `x0` | Assign by **centre-x** + k-means refinement → handles right-aligned prices |
| Global x-gap histogram across all rows | Columns **anchored to the header row** (or to a learned prior) |
| Ignores supplier prior | Consumes `SupplierLayoutProfiles.get_column_x()` and feeds positions back |
| Returns a raw grid; header re-guessed downstream | Returns **semantically-labelled** items directly |

### Fuzzy header matching

Header cells are matched to a canonical lexicon via `difflib` similarity
(threshold ≈ 0.72) with Greek accent folding. This kills the
keyword-patching treadmill — OCR corruption like `EIAOE` for `ΕΙΔΟΣ` resolves
without a hand-coded alias.

### The prior loop (the part that was missing)

```
        ┌─────────────────────────────────────────────┐
        │  SupplierLayoutProfiles (already existed)     │
        │  column_x_positions, Welford running median,  │
        │  trusted after ≥3 successful invoices         │
        └───────────────▲───────────────────┬───────────┘
        get_column_x()  │                   │  record_extraction(column_x_positions=…)
                        │                   ▼
        ┌───────────────┴───────────────────────────────┐
        │  geometric_columns.extract_line_items_geometric │
        │  prior present → anchor columns directly        │
        │  prior absent  → detect header, then learn it   │
        └─────────────────────────────────────────────────┘
```

For a supplier seen ≥3 times, columns are anchored from the learned prior and
extraction becomes near-deterministic. The store API was already complete; this
enhancement simply *connects both ends*.

### Measured behaviour on the 10 bundled sample invoices

| Invoice | Items | Structural conf | Notes |
|---|---|---|---|
| FI45483162319 / FI46283593249 / FI69383660620 (Fiverr) | 2 / 3 / 2 | **1.0** | Clean tabular; perfect |
| INV01447600 (New Relic) | 2 | 0.8 | |
| Invoice INV-4537 | 2 | 0.8 | |
| invoice_INV-2025-1024844 | 1 | 0.8 | |
| invoice_105 / 0000000590 (BGN dual-currency) | 1 | 0.6 | Continuation + dual currency — **VLM-path case** |
| Adobe / github-tripsta | 0–1 | 0.0–0.4 | Multi-tax / receipt layout — **VLM-path case** |

The clean tabular invoices (the majority) extract correctly with high
confidence. The pathological ones (dual-currency continuation lines,
multi-tax-rate Adobe layout) are deliberately **not** over-fitted here — they are
routed to the VLM path and arbitrated by arithmetic. That division of labour is
the whole point of the ensemble.

---

## 3. Enhancement #2 — Constrained-schema VLM extraction

**File:** `vlm_constrained.py` · **Input:** scanned/photo invoices, novel layouts

### Concept

Force Qwen2.5-VL to emit a **schema-valid** object so you stop maintaining a
regex parser per layout. Two layers of guarantee:

**Layer 1 — grammar-constrained decoding (preferred).**
If `lm-format-enforcer` is installed, we build a `prefix_allowed_tokens_fn` from
the invoice JSON schema and pass it into `.generate(...)`. The model then
*cannot* emit a token that breaks the schema — valid JSON by construction.
Integration is a single kwarg:

```python
from vlm_constrained import get_prefix_allowed_tokens_fn
fn = get_prefix_allowed_tokens_fn(_qwen_vl_processor.tokenizer)
output_ids = _qwen_vl_model.generate(
    **inputs, max_new_tokens=512, do_sample=False,
    prefix_allowed_tokens_fn=fn,        # ← the only added line
)
```

**Layer 2 — coerce + repair (always on).**
Whatever the model returns is coerced to the schema regardless of the
environment:

* JSON pulled out of markdown fences / surrounding prose;
* **truncated** generations (model hit the token limit mid-array) recovered by
  brace-balancing and closing the object;
* Greek numbers (`1.234,56`) and string numbers (`"30,00"`) parsed to floats;
* unknown keys dropped, missing keys defaulted, `lineItems` guaranteed a list;
* validated against the Pydantic schema.

So even on a box with no enforcer library you always get a clean object.

### Verified (no model required — coercion tested on synthetic outputs)

| Input | Result |
|---|---|
| Clean JSON with `"1.234,56"` | parsed → 1234.56 |
| Markdown-fenced JSON inside prose, `"30,00"` | extracted → 30.0 |
| **Truncated** mid-array generation | recovered + closed |
| Total garbage ("I couldn't read it") | valid empty object |

This replaces `vlm_invoice_parser.py`'s Format-A/B/C/C2 cascade: one schema
generalises to unseen layouts.

---

## 4. Shared backbone — arithmetic validation, repair, confidence

**File:** `arithmetic_validator.py`

The invoice's internal arithmetic is turned into three capabilities used by
*both* paths:

**Repair** — if two of {quantity, unit_price, net} are present, solve for the
third instead of dropping the row:

```
net   missing →  net   = qty × price
price missing →  price = net / qty
qty   missing →  qty   = net / price   (snapped to integer if near-integer)
```

It also derives `vat_amount = net × rate/100`, and recomputes `net` from
`qty × price` when the three disagree by more than a rounding margin.

**Validate** — per line `qty × price ≈ net`; per document `Σ net ≈ subtotal` and
`subtotal + vat ≈ total` (within 2 cents / 1–2 %). Missing header totals simply
skip that check.

**Score** — a single 0–1 confidence:

```
confidence = 0.60 · line_consistency      (fraction of lines where qty·price=net)
           + 0.30 · totals_reconciliation  (Σnet=subtotal, subtotal+vat=total)
           + 0.10 · completeness           (rows with description + amount)
```

The old code used `qty × price` only as a **reject filter** inside
`_is_valid_item`. Here it lifts recall (dropped rows get repaired) **and**
produces the calibrated number the review queue routes on.

---

## 5. The ensemble — replacing the waterfall

**File:** `ensemble_extractor.py`

```
            ┌──────────── candidates (run in parallel) ────────────┐
   PDF ───► │  geometric (#1, prior-aware)                          │
            │  vlm       (#2, constrained schema)        [optional] │
            │  legacy    (existing table/text extractor) [optional] │
            └───────────────────────┬───────────────────────────────┘
                                    ▼
                   score each with arithmetic_validator
                                    ▼
                    pick highest confidence  ──►  winning line items + header
                                    ▼
        review_recommended = TRUE if any of:
            • best confidence  < 0.75
            • two strongest candidates disagree on item count by > 25 %
            • document totals don't reconcile
                                    ▼
        on a confident geometric win → record column_x to the supplier profile
```

The whole module is **dependency-injected**: extractors are passed in as
callables/candidates, so it runs and tests without the VLM model or a DB.

### Verified end-to-end (real Fiverr PDF + a deliberately disagreeing mock VLM)

```
chosen: geometric   confidence: 1.0   review_recommended: true
reasons: chose 'geometric' (conf=1.0);
         'geometric' found 2 items, 'vlm' found 1 — disagree
items:   Translation 1×164.72=164.72 ; Service Fee 1×12.18=12.18
```

Correct items selected, and review correctly flagged on disagreement even though
confidence was maximal — fail-safe, not fail-silent.

---

## 6. Integration steps

### a) Geometric + ensemble (no model needed)

In `invoice_extractor_advanced.py`, after header parsing, prefer the ensemble:

```python
import ensemble_extractor as ee

result = ee.extract(
    self.pdf_path,
    supplier_vat=self.invoice_data.get("supplier_vat", ""),
    supplier_name=self.invoice_data.get("supplier", ""),
    profiles=self._profiles,                    # already constructed in __init__
    use_vlm=False,                              # flip on once the VLM service is up
    header={
        "subtotal": self.invoice_data.get("calc_subtotal"),
        "vat":      self.invoice_data.get("calc_vat"),
        "total":    self.invoice_data.get("grand_total"),
        "invoice_number": self.invoice_data.get("invoice_number", ""),
    },
)
if result.line_items:
    self.line_items = result.line_items
    self.invoice_data["extraction_confidence"] = result.confidence
    self.invoice_data["review_recommended"]    = result.review_recommended
    self.invoice_data["extraction_provenance"] = result.candidates
# else: fall through to the existing table/text logic as a final fallback
```

### b) Constrained decoding (when you want Layer 1)

`pip install lm-format-enforcer` into the `vlm-service` image, then add the
single `prefix_allowed_tokens_fn=` kwarg shown in §3 to
`qwen_vl_engine.extract_invoice_from_image`. Nothing else changes — Layer 2 was
already protecting you.

### c) Surface confidence in the UI

`extraction_confidence` and `review_recommended` flow through `invoice.extractedData`
into `InvoiceDetail.tsx`. Route `review_recommended` invoices into the existing
Approvals queue, and render `extraction_provenance` as the "matched because…"
trace.

---

## 7. Dependencies

| Module | Requires | Optional |
|---|---|---|
| `geometric_columns` | pdfplumber (existing) | — |
| `arithmetic_validator` | stdlib only | — |
| `vlm_constrained` | pydantic (existing) | `lm-format-enforcer` (Layer 1) |
| `ensemble_extractor` | pdfplumber | pdf2image + the Qwen engine (for `use_vlm=True`) |

All four are pure-Python and import-safe when optional pieces are absent.

---

## 8. Tuning knobs

| Where | Knob | Default | Effect |
|---|---|---|---|
| `geometric_columns` | `y_tolerance` | 4.0 pt | Row-band merge tolerance |
| `geometric_columns` | `_best_label` threshold | 0.72 | Header fuzzy-match strictness |
| `arithmetic_validator` | `ABS_TOL` / `REL_TOL` | 0.02 / 1 % | Rounding slack |
| `ensemble_extractor` | `REVIEW_BELOW` | 0.75 | Accept-without-review floor |
| `ensemble_extractor` | `DISAGREEMENT_FRACTION` | 0.25 | Item-count divergence → review |

These are the levers to calibrate against `vLMBenchmark/ground_truth.json` once
you wire the ensemble into the benchmark harness.
