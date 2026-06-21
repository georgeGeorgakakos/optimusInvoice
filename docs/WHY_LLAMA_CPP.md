# Why llama.cpp/GGUF is the production backend

This document explains, in plain language, why Optimus Invoice runs the
Gemma 3 vision engine on **llama.cpp + GGUF Q4_K_M** rather than the more
"obvious" choice of HuggingFace **transformers + bfloat16**.

The short answer: **llama.cpp is ~15× faster on CPU**. The interesting
question is *why* — because the reason is counter-intuitive and applies to
every future model you might add to this system.

---

## What each backend actually is

### `transformers` + bf16 — the "default" path

This is what most tutorials show. It's the standard way to run HuggingFace
models:

```python
from transformers import AutoModelForImageTextToText
model = AutoModelForImageTextToText.from_pretrained("google/gemma-3-4b-it")
```

It's a Python library that uses PyTorch for compute, and it is **designed for
GPU first**. On CPU it "works" but it's not optimized — it just takes the
PyTorch operations that were written for CUDA and runs them through generic
CPU backends (OpenBLAS, oneDNN). Weights are stored as **bfloat16** —
16 bits per weight, the same precision used during GPU training.

### llama.cpp + GGUF — a different philosophy

llama.cpp is a completely different approach. It's a **C++ inference engine
built specifically for CPU** by Georgi Gerganov. It does not use PyTorch at
all. It has hand-tuned AVX2/AVX-512 SIMD kernels written in intrinsics.

Weights are stored in its own format called **GGUF**, with aggressive
quantization. "Q4_K_M" means weights are encoded at ~4.5 bits each instead
of the usual 16.

```python
from llama_cpp import Llama
llm = Llama(model_path="gemma-3-4b-it-Q4_K_M.gguf", n_threads=10)
```

Same model. Different stack. ~15× faster on the same hardware.

---

## The essential difference: what's the actual bottleneck?

Most developers assume "faster CPU = faster LLM". **This is wrong for
inference on CPU.**

The real bottleneck is **memory bandwidth**, not compute. For every single
token the model generates, it must:

1. Read **all** the weights from RAM (8 GB for bf16, 2.5 GB for Q4)
2. Multiply them by a small input vector
3. Sum the results

Step 1 is what kills your speed. On a typical desktop CPU:

- **DDR4 RAM bandwidth:** ~25 GB/s sustained
- **CPU compute capacity:** hundreds of GFLOPS (massively over-provisioned —
  it sits idle waiting for RAM)

Doing the math for **one token of generation**:

| Backend | Bytes to read | Theoretical ceiling at 25 GB/s |
|---|---|---|
| bf16 transformers | 8 GB | 320 ms per token → **3.1 tok/s max** |
| Q4_K_M llama.cpp | 2.5 GB | 100 ms per token → **10 tok/s max** |

Just by making the weights smaller, you raise the ceiling **3.2×**. That's
the first multiplier — and it has nothing to do with how fast the CPU is.

This is also why "buy a faster CPU" doesn't help much for LLM inference on
CPU. You'd need faster *RAM*, which is much harder to change.

---

## Why transformers is even slower than its own ceiling

Of the 3.1 tok/s theoretical ceiling, transformers achieves roughly
**0.4 tok/s** in practice. That's only **13% efficiency**. Why?

- **PyTorch CPU paths are generic** — designed to work correctly on every
  CPU architecture, not to run fast on any specific one.
- **Python overhead in the hot path** — every forward pass goes through
  Python, which has GIL contention and dispatch overhead per operation.
- **Memory layout is sub-optimal** — tensors aren't packed for CPU cache
  locality; they were arranged for GPU memory access patterns.
- **bf16 operations often upcast to fp32 on CPU** because older CPUs lack
  native bf16 SIMD instructions. So you "save" memory but lose it during
  compute.

llama.cpp, on the other hand, reaches roughly **7 tok/s** — about **70%
efficiency** against its theoretical ceiling. Why?

- **Pure C++, zero Python in the hot path.** Python is only called for I/O
  (loading the image, returning the result string).
- **AVX2/AVX-512 intrinsics.** A single CPU instruction processes 8-16
  weights simultaneously. Generic PyTorch code can't do this.
- **Block-wise dequantization.** Converting Q4 → fp16 happens entirely
  inside L1 cache and never goes back to RAM. The decompressed weights are
  used immediately and discarded.
- **Custom memory layout.** Weights are arranged in the order they're
  consumed during inference, maximizing cache hit rates.

---

## The stacked speedups

Starting from the baseline and multiplying:

```
bf16 transformers:    0.4 tok/s   (baseline)
                          ↓
Quantization (Q4):    × 4×        (smaller weights = less RAM to read)
                      1.6 tok/s
                          ↓
SIMD kernels:         × 3×        (hand-tuned vs PyTorch generic)
                      4.8 tok/s
                          ↓
Cache locality:       × 1.5×      (better memory layout)
                      ~7 tok/s    (observed)
```

**Total: ~17× theoretical, ~15× practical.**

For invoice extraction, that means **2 minutes per invoice instead of
30 minutes**. The difference between "neat demo" and "production system".

---

## Why transformers "can't" close the gap

It's not that the HuggingFace team didn't try. The two libraries have
fundamentally different **missions**:

| transformers | llama.cpp |
|---|---|
| Generic — supports 400+ model architectures | Specific — supports ~30 well |
| Python-first for research and fine-tuning | C++ for deployment |
| GPU is the primary target | CPU is the primary target |
| Optimizes for flexibility over raw speed | Optimizes for speed over flexibility |
| Handles training + evaluation + inference | Inference only |

If you tried to add llama.cpp's optimizations to transformers, you'd lose the
flexibility and generality that's the whole reason transformers exists. They
are **different tools for different jobs**.

For production CPU inference, llama.cpp is unambiguously the right choice —
not "a bit better" but **15× better**. That converts a model from "interesting
to try" into "actually shippable".

---

## The decision rule

> **If a GGUF version of your model exists and you're running on CPU,
> use llama.cpp. In every other case (training, fine-tuning, GPU inference,
> exotic architectures), use transformers.**

Applied to Optimus Invoice:

- **Surya** (digital PDFs, near-instant) — its own engine, no change needed.
- **Qwen2.5-VL-3B** (difficult scans) — transformers, because Qwen-specific
  CPU kernels exist there and are good enough; no GGUF in our pipeline.
- **Gemma 3 4B** (A/B comparison, backup engine) — **llama.cpp**, because
  Gemma has a high-quality GGUF release on `ggml-org` and we run on CPU.

The rule scales to future models too. Llama 3.2 Vision? GGUF if available.
Mistral Pixtral? GGUF if available. Some niche OCR model with no GGUF?
transformers.

---

## Quality concerns: is Q4_K_M "lossy"?

Yes, slightly — but in ways that don't matter for this use case.

K-quants (the `_K_M` family) are not naive 4-bit truncation. Weights are
grouped into blocks of 32, each block has its own fp16 scale factor, and
the weights inside the block are 4-bit signed integers stretched by that
scale. Effectively this gives you ~4.5 bits per weight while preserving
~99% of the original model's behavior on most benchmarks.

For tasks that depend on *exact* token probabilities (creative writing,
math reasoning), this small quality loss can matter. For **structured field
extraction from invoices** — reading visible text from an image and emitting
it as JSON — the difference is imperceptible. The vision encoder does most
of the work; the LLM is essentially a sophisticated transcription tool, and
Q4 has more than enough fidelity for that.

If you ever do hit a quality regression caused by quantization (not by
prompt issues), the upgrade path is:

1. **Q5_K_M** — 5.5 bits/weight, ~6 tok/s, almost-bf16 quality
2. **Q6_K** — 6.5 bits/weight, ~5 tok/s, indistinguishable from bf16
3. **Q8_0** — 8 bits/weight, ~4 tok/s, definitively indistinguishable
4. Only then go back to **bf16 transformers**

In a year of running Q4 quants for OCR-style tasks, escalating past Q4_K_M
is genuinely rare. Q4_K_M is the sweet spot.

---

## TL;DR

| | transformers bf16 | llama.cpp Q4_K_M |
|---|---|---|
| Designed for | GPU + research flexibility | CPU + production deployment |
| Weights size | 8 GB | 2.5 GB |
| RAM read per token | 8 GB | 2.5 GB |
| Theoretical ceiling | 3.1 tok/s | 10 tok/s |
| Observed speed (12-core CPU) | 0.4 tok/s | 7 tok/s |
| Per invoice (1024 tokens) | ~30 min | ~2 min |
| Quality | reference | ~99% of reference |

The bottleneck on CPU inference is memory bandwidth, not compute. Smaller
weights win automatically. Hand-tuned SIMD kernels win even more. Both
optimizations stack, and that's how you get 15× speedup with no quality loss
that matters for the task.

This is why llama.cpp is the production backend for the Gemma 3 vision
engine in Optimus Invoice — and the same logic applies to any future
CPU-deployed model in this pipeline.
