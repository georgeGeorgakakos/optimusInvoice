# MODEL VERSIONS — OptimusInvoice

> **Optimus Invoice Automation** — Powered by **Optimus Research by George Georgakakos**
> Precise, verified versions of every AI model and supporting library in the
> extraction stack — and **why each model is used**.

**Verification method:** all library versions below were read directly from the
running containers via `pip show` on **2026-06-20**. They are ground truth, not
config constraints. Re-verify after any image rebuild with the commands in
[§5](#5-how-to-re-verify).

---

## 1. Summary — Models & Why They're Used

| # | Model | Identifier | Quant / Precision | Why this model | Container |
|---|---|---|---|---|---|
| 1 | Surya detection | `vikp/surya_det3` | full (PyTorch) | Finds text regions on the page — the spatial map every downstream step needs | `vlm-service` |
| 2 | Surya recognition | `vikp/surya_rec2` | full (PyTorch) | Best open OCR for **Greek + Latin mixed** invoices; reads the regions Surya found | `vlm-service` |
| 3 | Semantic LLM | `Qwen2.5-3B-Instruct` (GGUF) | **Q4_K_M** (4-bit) | Turns messy OCR text into clean structured JSON; small enough to run on CPU | `vlm-service` |
| 4 | Vision model A | `Qwen/Qwen2.5-VL-3B-Instruct` | safetensors (full) | Reads hard layouts **as an image** when OCR+LLM struggles | `qwen-vl` |
| 5 | Vision model B | `ggml-org/gemma-3-4b-it-GGUF` | **Q4_K_M** + mmproj **f16** | Lighter GGUF vision alternative to Qwen-VL (CPU-friendly) | `gemma-vl` |
| — | Native text | `pdfplumber` (not a model) | — | Reads digital PDFs directly — instant, exact, no OCR cost | `vlm-service` |

1. Native digital PDFs
   pdfplumber → Qwen2.5-3B → JSON

2. Scanned / image PDFs
   Surya Detection + Surya Recognition → Qwen2.5-3B → JSON

3. Hard layouts / OCR failure
   Qwen2.5-VL-3B → JSON

4. Alternative vision path
   Gemma 3 4B IT GGUF + mmproj → JSON

---

## 2. Library Versions (verified per container)

### `vlm-service` — port 8100 (host 8300)

| Package | Installed version |
|---|---|
| `surya-ocr` | **0.6.13** |
| `transformers` | **4.46.3** |
| `llama-cpp-python` | **0.3.16** |
| `pdfplumber` | **0.11.9** |

### `qwen-vl` (`optimus_qwen_vl`) — port 8400

| Package | Installed version |
|---|---|
| `transformers` | **5.4.0** |
| `torch` | **2.5.1+cpu** |

### `gemma-vl` (`optimus_gemma_vl`) — port 8500

| Package | Installed version |
|---|---|
| `llama-cpp-python` | **0.3.16** |

---

## 3. Per-Model Detail — What It Does & Why It Was Chosen

### 1 — Surya detection · `vikp/surya_det3`
- **surya-ocr:** 0.6.13 · **transformers:** 4.46.3 (pinned)
- **Architecture:** EfficientViT semantic segmentation
- **What it does:** locates text regions / bounding boxes on each page
- **Why this model:** invoices are dense, multi-column, table-heavy documents.
  A dedicated detection pass produces a reliable region map so recognition isn't
  fed the whole page blindly — this is what makes table and line-item extraction
  tractable. It is also the source of the bounding boxes used for the
  side-by-side PDF review highlighting.
- **Size:** ~300 MB · **Speed:** ~5 s/page · **Storage:** volume `vlm-cache`

### 2 — Surya recognition · `vikp/surya_rec2`
- **surya-ocr:** 0.6.13 · **transformers:** 4.46.3
- **Architecture:** DonutSwin encoder + OCR decoder
- **What it does:** reads the actual text inside each detected region
- **Why this model:** the target invoices are **Greek and mixed Greek/Latin**
  with numbers, currency symbols and accents. Surya recognition handles Greek
  script and mixed layouts far better than general OCR (e.g. Tesseract), which
  garbles Greek + tabular data. Configured `SURYA_LANGS=el,en`.
- **Size:** ~200 MB · **Storage:** volume `vlm-cache`

### 3 — Semantic LLM · Qwen2.5-3B-Instruct (GGUF)
- **Runtime:** llama-cpp-python 0.3.16 · **Quant:** Q4_K_M (4-bit)
- **File:** `qwen2.5-3b-instruct-q4_k_m.gguf` · **Alias:** `SEMANTIC_MODEL=qwen2.5:3b`
- **What it does:** converts raw OCR text into structured invoice JSON
  (supplier, number, date, line items, VAT, totals, currency)
- **Why this model:** OCR output is unordered, noisy text — rules alone can't
  reliably map it to fields across many supplier formats. A small instruct LLM
  generalises across layouts. **3B + Q4_K_M 4-bit** was chosen specifically so it
  runs on a **CPU-only** box within acceptable time and RAM, instead of needing a
  GPU. A regex parser is the fallback if it times out.
- **Size:** 2.1 GB · **Context:** `LLAMA_N_CTX=4096` (≥4096 avoids JSON
  truncation on long invoices) · **Storage:** `./model_cache/llama`

### 4 — Vision model A · Qwen/Qwen2.5-VL-3B-Instruct
- **transformers:** 5.4.0 · **torch:** 2.5.1+cpu
- **Model class:** `Qwen2_5_VLForConditionalGeneration` · **Format:** safetensors (2 shards)
- **What it does:** reads the invoice **directly as an image** and emits JSON —
  no separate OCR step
- **Why this model:** some invoices (unusual layouts, stamps, overlapping
  graphics) defeat the OCR→LLM pipeline. A vision-language model "sees" the whole
  page and reasons over layout + text together, recovering fields the two-stage
  path misses. Qwen2.5-VL-3B is a strong open VLM that fits CPU RAM.
- **Engine name:** `qwen_vl_local` · **Size:** 7.3 GB · **Offline:** `HF_HUB_OFFLINE=1`
- **Storage:** host `./model_cache/` → `/models`

> ⚠️ **Version note:** the requirement is often quoted as `transformers>=4.52`.
> The container actually runs **5.4.0** — a *major* version ahead. It works (the
> engine loads and extracts), so the real constraint is "5.4.0 is known-good."
> Do **not** downgrade to a literal 4.52.x on the basis of older notes without
> testing.

### 5 — Vision model B · ggml-org/gemma-3-4b-it-GGUF
- **Runtime:** llama-cpp-python 0.3.16 · **Quant:** Q4_K_M (4-bit)
- **Files:** `gemma-3-4b-it-Q4_K_M.gguf` + `mmproj-model-f16.gguf` (vision projector, f16)
- **Chat handler:** embedded `Gemma3ChatHandler` (llama.cpp PR #1989 backport)
- **What it does:** alternative image→JSON vision path
- **Why this model:** provides a **second, independent vision engine** so results
  can be compared and so the system isn't dependent on a single VLM. The **GGUF /
  llama.cpp** route is lighter on CPU and memory than the safetensors Qwen-VL
  path, making it attractive for lower-spec hardware.
- **Engine name:** `gemma_vl_local` · **Size:** ~2.5 GB + 851 MB mmproj
- **Gated:** requires HuggingFace license + `HF_TOKEN`
- **Storage:** host `./model_cache/` → `/models`
- **Status:** 🔴 returns 0 chars on extraction — not usable until fixed

### — pdfplumber (library, not a model)
- **pdfplumber:** 0.11.9
- **What it does:** reads text directly from digital PDFs (`useNativeText` ON)
- **Why used:** most modern supplier invoices are **digitally generated** with a
  real text layer (New Relic, Adobe, Fiverr, Avise). For those, OCR is wasted
  effort — pdfplumber extracts the exact text in <1 s with zero error. It runs as
  a pre-flight; scanned/image-only PDFs fall through to Surya automatically.
- **Size:** < 1 MB · **Speed:** < 1 s

---

## 4. Compatibility Matrix

The reason for the two-container split, in exact numbers:

| Stack | transformers | Why incompatible with the other |
|---|---|---|
| Surya (`vlm-service`) | **4.46.3** | Surya 0.6.13 breaks on transformers ≥4.52 |
| Qwen2.5-VL (`qwen-vl`) | **5.4.0** | `Qwen2_5_VLForConditionalGeneration` needs ≥4.52 |

`4.46.3` and `5.4.0` cannot coexist in one Python environment → separate
containers are mandatory. Gemma uses llama.cpp (GGUF) and is unaffected by
`transformers` either way.

---

## 5. How to Re-verify

Run after any rebuild; replace this doc's numbers if they change:

```powershell
docker compose exec vlm sh -c "pip show surya-ocr transformers llama-cpp-python pdfplumber 2>/dev/null | grep -E 'Name|Version'"
docker compose exec qwen-vl sh -c "pip show transformers torch 2>/dev/null | grep -E 'Name|Version'"
docker compose exec gemma-vl sh -c "pip show llama-cpp-python 2>/dev/null | grep -E 'Name|Version'"
```

For the GGUF model files actually present on disk:

```powershell
docker compose exec vlm sh -c "ls -la /models/llama/"
docker compose exec gemma-vl sh -c "ls -la /models/models--ggml-org--gemma-3-4b-it-GGUF/snapshots/*/"
```

---

*Versions verified 2026-06-20 from running containers.*
*Optimus Invoice Automation — Powered by Optimus Research by George Georgakakos.*
