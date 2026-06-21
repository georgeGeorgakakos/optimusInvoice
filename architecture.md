# OptimusInvoice — Engine & Container Architecture

# George Georgakakos
How invoice extraction is routed across containers, which model backs each
engine, and where every service lives. This is the reference for "when I pick
an engine in the UI, where does it actually run?"

---

## TL;DR

Every upload hits **`vlm-service` first** — it is the single entry point and the
dispatcher. It runs three engines *in-process* (Surya, GOT-OCR2, semantic LLM)
and **proxies** the two heavy vision engines (Qwen, Gemma) to their own
containers over HTTP.

Two engines run on **llama.cpp** (`llama-cpp-python`): the semantic text model
and Gemma vision. The rest run on PyTorch/transformers.

---

## Engine routing & backend map

| UI engine        | Runs in            | Container          | Port  | Backend            | Model                                                    | How it's reached            |
|------------------|--------------------|--------------------|-------|--------------------|----------------------------------------------------------|-----------------------------|
| `surya`          | vlm-service        | `vlm-service`      | 8100  | surya-ocr (PyTorch)| `surya_det3` + `surya_rec2`                              | In-process                  |
| `got_ocr2`       | vlm-service        | `vlm-service`      | 8100  | transformers       | GOT-OCR2                                                  | In-process                  |
| `semantic_llm`   | vlm-service        | `vlm-service`      | 8100  | **llama-cpp-python**| `qwen2.5-3b-instruct-q4_k_m.gguf` (~2 GB)               | In-process                  |
| `qwen_vl_local`  | separate container | `optimus_qwen_vl`  | 8400  | transformers       | `Qwen/Qwen2.5-VL-3B-Instruct`                            | HTTP proxy from vlm-service |
| `gemma_vl_local` | separate container | `optimus_gemma_vl` | 8500  | **llama-cpp-python**| `gemma-3-4b-it-Q4_K_M.gguf` + `mmproj-model-f16.gguf`    | HTTP proxy from vlm-service |

> The dispatch logic lives in `server/python/vlm_service.py`, in the
> `/extract-pdf` handler (the `used_engine == ...` branches). `surya`/`auto` and
> `got_ocr2` are handled locally; `qwen_vl_local` and `gemma_vl_local` call
> `_proxy_vision_container(...)`.

---

## Container map

| Container          | Host port | Internal port | Holds                                                        | transformers pin |
|--------------------|-----------|---------------|-------------------------------------------------------------|------------------|
| `optimus-app`      | 3000      | 3000          | Node + React UI; runs `pnpm db:push` on boot                | —                |
| `vlm-service`      | 8300      | 8100          | Surya + GOT-OCR2 + semantic LLM + **dispatcher**            | `==4.46.3`       |
| `optimus_qwen_vl`  | 8400      | 8400          | Qwen2.5-VL-3B vision                                         | `>=4.52`         |
| `optimus_gemma_vl` | 8500      | 8500          | Gemma 3 4B-it vision (GGUF / llama.cpp)                      | n/a (llama.cpp)  |
| `optimus-mysql`    | 3306      | 3306          | MySQL 8.0 database                                           | —                |

---

## Request flow

```
                         ┌──────────────────────────────────────────────┐
   Browser  ──upload──▶  │  vlm-service  (entry point + dispatcher)      │
   :3000                 │  port 8100 (host 8300)                        │
                         │                                              │
                         │   surya ───────┐                            │
                         │   got_ocr2 ────┼──▶ run in-process           │
                         │   semantic_llm ┘    (llama.cpp for semantic) │
                         │                                              │
                         │   qwen_vl_local ──HTTP──▶ optimus_qwen_vl:8400│
                         │   gemma_vl_local ─HTTP──▶ optimus_gemma_vl:8500│
                         └──────────────────────────────────────────────┘
```

A concrete trace from the logs (qwen path):

```
vlm-service : [QwenVL-Proxy] Forwarding 92966 bytes to http://optimus_qwen_vl:8400/extract-pdf
qwen        : [QwenVL-Service] Received PDF: 92966 bytes
qwen        : Generation complete — 448 tokens in 603.0s (0.74 tok/s)
vlm-service : extract-pdf: engine=qwen_vl_local, chars=874, elapsed=603.7s
```

The matching byte count (92966) shows the same request crossing the container
boundary.

---

## Why qwen and gemma are separate containers

Not arbitrary — it's a dependency split:

- **Qwen** needs `transformers>=4.52`, but `vlm-service` is pinned to
  `transformers==4.46.3` (required by Surya). They cannot share one Python
  environment, so Qwen runs in its own container.
- **Gemma** avoids transformers entirely — it runs the Q4_K_M GGUF through
  `llama-cpp-python`, which is ~15× faster than transformers bf16 on CPU. Its
  own container keeps the llama.cpp build isolated.

This is also why adding a new transformers-based or GGUF vision model (e.g.
DeepSeek-OCR) means a **new sidecar container**, not a change to vlm-service.

---

## Where llama.cpp is used

`llama-cpp-python` (the Python binding for the llama.cpp C++ engine) backs two
engines:

1. **`semantic_llm`** — `qwen2.5-3b-instruct-q4_k_m.gguf`, loaded inside
   `vlm-service` (`server/python/semantic_extractor.py`). Default `SEMANTIC_MODEL=qwen2.5:3b`.
2. **`gemma_vl_local`** — `gemma-3-4b-it-Q4_K_M.gguf` + `mmproj-model-f16.gguf`,
   in `optimus_gemma_vl` (`server/python/gemma_vl_engine.py`), using a
   `Gemma3ChatHandler` for multimodal input.

The other engines (Surya, GOT-OCR2, Qwen vision) use PyTorch/transformers.

---

## Proxy target URLs (differ by deploy path)

The proxy targets are set via env vars on `vlm-service`. The hostname differs
depending on how you deploy, because Docker resolves either the compose service
name or the explicit container name:

| Deploy path                       | QWEN_VL_SERVICE_URL              | GEMMA_VL_SERVICE_URL              |
|-----------------------------------|----------------------------------|-----------------------------------|
| `docker-compose` (deployDockerFull) | `http://qwen-vl:8400`          | `http://gemma-vl:8500`            |
| standalone `docker run` (deploySolutionLocal) | `http://optimus_qwen_vl:8400` | `http://optimus_gemma_vl:8500` |

Both resolve over the `optimus_ai_net` Docker network.

---

## Performance note (CPU inference)

These models are CPU-bound and slow. Observed in production logs:

| Engine          | Typical time / invoice | Notes                                  |
|-----------------|------------------------|----------------------------------------|
| `surya`         | ~5s detect + ~3-4 min recognize | Fast detection; recognition scales with text |
| `semantic_llm`  | ~5-6 min               | Text-PDF path                          |
| `qwen_vl_local` | ~4-10 min (0.74 tok/s) | Engine self-estimates ~39 min for big pages |
| `gemma_vl_local`| faster than qwen (Q4_K_M) | llama.cpp quantized                |

For demos, `surya` is the sensible default. The vision engines benefit
enormously from a GPU; on CPU they are minutes-per-invoice.

---

## Health endpoints

All services expose `GET /health` (returns `200 OK`). The vlm-service health
also reports `surya: loaded | loading` so you can see warmup progress.

| Service          | Health URL                       |
|------------------|----------------------------------|
| app              | `http://localhost:3000`          |
| vlm-service      | `http://localhost:8300/health`   |
| qwen-vl          | `http://localhost:8400/health`   |
| gemma-vl         | `http://localhost:8500/health`   |