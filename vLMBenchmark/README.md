# Optimus VLM Benchmark Kit

Test Vision Language Models on your actual Greek invoices **before** integrating them into the Optimus pipeline. See exactly how Qwen2.5-VL, Mistral, Llama Vision, and Gemma perform on your documents.

## Quick Start (5 minutes)

### 1. Setup

```bash
chmod +x setup.sh
./setup.sh
```

This installs Ollama, pulls your chosen models, and installs Python dependencies.

**Or manually:**

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama serve  # Start in background

# Pull at least one model
ollama pull qwen2.5vl:7b     # ~4.7 GB — recommended first choice

# Python deps
pip install requests pdf2image Pillow rich
sudo apt install poppler-utils  # for PDF rendering
```

### 2. Test a Single Invoice

```bash
python quick_test.py your_invoice.pdf
```

That's it. You'll see the extracted JSON in seconds.

### 3. Full Benchmark

```bash
# Test all your invoices against multiple models
python benchmark.py --pdf invoices/ --models qwen,mistral

# With ground truth for accuracy scoring
python benchmark.py --pdf invoices/ --ground-truth ground_truth.json --models qwen,mistral
```

---

## Models Available

| Key | Model | Size | Type | Best For |
|-----|-------|------|------|----------|
| `qwen` | Qwen2.5-VL-7B | 4.7 GB | Vision | **Best first choice** — sees the document image, understands layout |
| `mistral` | Mistral 7B | 4.1 GB | Text | CPU-friendly fallback — receives OCR text |
| `llama` | Llama 3.2 Vision 11B | 7.9 GB | Vision | Alternative to Qwen — Meta's VLM |
| `gemma` | Gemma 3 12B | 8.1 GB | Vision | Google's latest VLM |

**Vision models** see the actual invoice image — they understand layout, table structure, and spatial relationships without needing OCR first.

**Text models** receive Tesseract OCR output as text — they reason about the noisy text to extract fields. Faster but less accurate on layout-heavy documents.

## Ground Truth

Edit `ground_truth.json` to add your known-correct values. The benchmark scores each model's extraction against these values.

**Keys** = PDF filename without extension. Fill in only the fields you know:

```json
{
  "my_invoice_001": {
    "documentType": "invoice",
    "invoiceNumber": "ΤΔΑ-01-138703",
    "date": "09/01/2026",
    "supplier": {
      "name": "ΦΟΥΡΝΑΡΑΚΗΣ",
      "taxId": "123456789"
    },
    "totalAmount": "1234.56",
    "lineItems": [
      {"supplierCode": "002450120", "quantity": "10", "unitPrice": "50.00"}
    ]
  }
}
```

Fields set to `null` are skipped in accuracy scoring.

## What to Look For

After running the benchmark:

| Metric | Good | Needs Work | Don't Integrate |
|--------|------|------------|-----------------|
| JSON Parse Rate | >90% | 70-90% | <70% |
| Header Field Accuracy | >85% | 60-85% | <60% |
| Line Item Count | Exact match | ±1-2 items | Way off |
| Inference Time | <30s | 30-90s | >120s |

**Decision framework:**
- **>90% header accuracy, >90% parse rate** → Ready to integrate as primary extractor
- **70-90%** → Good as a "second opinion" alongside Tesseract+regex
- **<70%** → Model not suitable for your invoice formats (try a different one)

## Command Reference

```bash
# Single file, default model (Qwen)
python quick_test.py invoice.pdf

# Single file, choose model
python quick_test.py invoice.pdf --model mistral
python quick_test.py invoice.pdf --model llama

# Save extraction result
python quick_test.py invoice.pdf --save result.json

# Full benchmark — directory of PDFs
python benchmark.py --pdf invoices/ --models qwen,mistral

# With accuracy scoring
python benchmark.py --pdf invoices/ --ground-truth ground_truth.json

# All models, verbose output, save results
python benchmark.py --pdf invoices/ --models qwen,mistral,llama,gemma --verbose --save-results results.json

# Custom Ollama URL (remote server)
python benchmark.py --pdf invoices/ --ollama-url http://gpu-server:11434

# Lower DPI for faster rendering (lower quality)
python benchmark.py --pdf invoices/ --dpi 150
```

## Hardware Notes

| Setup | Expected Performance |
|-------|---------------------|
| CPU only (no GPU) | Mistral: ~30-60s/page, Qwen: ~120-180s/page |
| 8 GB VRAM (RTX 3070) | Qwen: ~15-30s/page, Mistral: ~10-20s/page |
| 16 GB VRAM (RTX 4080) | Qwen: ~5-15s/page, Mistral: ~5-10s/page |
| 24 GB VRAM (RTX 4090) | All models: ~3-10s/page |

Ollama automatically uses GPU if available (CUDA/ROCm). No configuration needed.

## Troubleshooting

**"Ollama not running"** → Run `ollama serve` in a separate terminal

**"Model not found"** → Run `ollama pull qwen2.5vl:7b` (or whichever model)

**"poppler not found"** → `sudo apt install poppler-utils` (Linux) or `brew install poppler` (Mac)

**Slow inference** → Try `--dpi 150` for faster rendering, or use `mistral` (text-only) which is faster

**Out of memory** → Ollama auto-quantizes, but if still failing, try smaller models or reduce DPI

**Greek characters garbled** → This is normal in OCR text — vision models (Qwen) handle Greek much better since they see the actual characters in the image

## File Structure

```
vlm-benchmark/
├── benchmark.py         # Full multi-model benchmark with scoring
├── quick_test.py        # Quick single-invoice test
├── setup.sh             # One-click setup script
├── ground_truth.json    # Template for accuracy scoring
└── README.md            # This file
```
