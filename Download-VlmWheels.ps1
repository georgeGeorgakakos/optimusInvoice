# Download-VlmWheels.ps1
# ─────────────────────────────────────────────────────────────────────────────
# Run ONCE from the repo root to pre-download all pip wheels AND model weights
# into vlm-service\wheels\ + model_cache\ so docker build never touches the
# internet and the containers run fully offline.
#
# Usage:  .\Download-VlmWheels.ps1
#
# Platform tag guide (why three different tags are needed):
#   linux_x86_64         → PyTorch custom tag (torch, torchvision only)
#   manylinux2014_x86_64 → Standard C-extension wheels (numpy, pillow, opencv, pydantic...)
#   manylinux_2_27_x86_64 → Newer C-extension wheels (onnxruntime, tokenizers, newer numpy)
#   none-any             → Pure Python (no tag needed, works everywhere)
#
# Model weights downloaded:
#   Step 7: Qwen2.5-VL-3B-Instruct (~7.3 GB, open weights)
#   Step 8: google/gemma-3-4b-it   (~8.0 GB, GATED — needs HF_TOKEN in .env)
# ─────────────────────────────────────────────────────────────────────────────

$BASE   = $PSScriptRoot
$WHEELS = "$BASE\vlm-service\wheels"

function Write-Header { param($m)
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  $m" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
}
function Write-Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Write-Step { param($m) Write-Host "  -->   $m" -ForegroundColor White }
function Write-Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Write-Fail { param($m) Write-Host "  [ERR] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  OptimusInvoice - VLM Wheel + Model Pre-downloader" -ForegroundColor Cyan
Write-Host "  Downloads ~1.2 GB wheels + ~15.3 GB model weights once" -ForegroundColor DarkGray
Write-Host "  so docker build never touches the internet again." -ForegroundColor DarkGray
Write-Host ""

# ── 1. Torch + torchvision ────────────────────────────────────────────────────
Write-Header "1/9  Torch + torchvision CPU wheels (~800 MB)"
$dir = "$WHEELS\torch"
if ((Test-Path $dir) -and (Get-ChildItem $dir -Filter "torch-2*.whl" | Measure-Object).Count -gt 0) {
    Write-Ok "Already downloaded - skipping (delete $dir to re-download)"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    # Part A: torch + torchvision from PyTorch index (linux_x86_64, no deps)
    Write-Step "Part A: torch==2.5.1+cpu + torchvision==0.20.1+cpu main wheels..."
    pip download "torch==2.5.1+cpu" "torchvision==0.20.1+cpu" `
        --index-url https://download.pytorch.org/whl/cpu `
        -d $dir `
        --platform linux_x86_64 --python-version 311 `
        --only-binary=:all: --no-deps
    if ($LASTEXITCODE -ne 0) { Write-Fail "torch/torchvision download failed"; exit 1 }

    # Part B: C-extension deps using manylinux2014 tag (numpy, pillow, markupsafe)
    Write-Step "Part B: C-extension deps (numpy, pillow, markupsafe)..."
    pip download "numpy>=1.21" "pillow>=9.0" "MarkupSafe" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "numpy/pillow download failed"; exit 1 }

    # Part C: pure-Python deps (no C code, any platform tag works)
    Write-Step "Part C: pure-Python deps (filelock, sympy, jinja2, networkx, fsspec...)..."
    pip download `
        "filelock" "typing-extensions>=4.8.0" "networkx" `
        "jinja2" "fsspec" "setuptools" `
        "sympy==1.13.1" "mpmath<1.4,>=1.1.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "torch pure deps download failed"; exit 1 }

    $count = (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count
    Write-Ok "Downloaded $count wheel(s) to $dir"
}

# ── 2. transformers==4.46.3 ───────────────────────────────────────────────────
Write-Header "2/9  transformers==4.46.3 (~50 MB)"
$dir = "$WHEELS\transformers"
if ((Test-Path $dir) -and (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count -gt 0) {
    Write-Ok "Already downloaded - skipping"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-Step "Downloading transformers==4.46.3 + deps..."
    # Uses manylinux_2_27 for tokenizers, manylinux2014 for others
    # Let pip resolve using the newer tag which is a superset
    pip download "transformers==4.46.3" `
        -d $dir `
        --platform manylinux_2_27_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "transformers download failed"; exit 1 }
    $count = (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count
    Write-Ok "Downloaded $count wheel(s) to $dir"
}

# ── 3. surya-ocr==0.6.13 ─────────────────────────────────────────────────────
Write-Header "3/9  surya-ocr==0.6.13 (~100 MB)"
$dir = "$WHEELS\surya"
if ((Test-Path $dir) -and (Get-ChildItem $dir | Measure-Object).Count -gt 0) {
    Write-Ok "Already downloaded - skipping"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    # surya itself is pure-Python (none-any wheel)
    Write-Step "surya-ocr wheel (pure Python)..."
    pip download "surya-ocr==0.6.13" --no-deps -d $dir
    if ($LASTEXITCODE -ne 0) { Write-Fail "surya-ocr download failed"; exit 1 }

    # opencv-python uses manylinux2014
    Write-Step "opencv-python + pillow<11 for surya (manylinux2014)..."
    pip download "opencv-python>=4.9.0.80,<5.0.0.0" "pillow>=10.2.0,<11.0.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all: --no-deps
    if ($LASTEXITCODE -ne 0) { Write-Fail "opencv/pillow download failed"; exit 1 }

    # onnxruntime uses manylinux_2_27
    Write-Step "onnxruntime (manylinux_2_27)..."
    pip download "onnxruntime>=1.19.2,<2.0.0" `
        -d $dir `
        --platform manylinux_2_27_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "onnxruntime download failed"; exit 1 }

    # pdftext is pure-Python (none-any wheel), download without deps
    Write-Step "pdftext (pure Python, no deps)..."
    pip download "pdftext>=0.3.18,<0.4.0" --no-deps -d $dir
    if ($LASTEXITCODE -ne 0) { Write-Fail "pdftext download failed"; exit 1 }

    # pypdfium2 uses manylinux_2_17 (py3-none wheel, no Python version needed)
    Write-Step "pypdfium2 (manylinux_2_17)..."
    pip download "pypdfium2>=4.29.0,<5.0.0" `
        -d $dir `
        --platform manylinux_2_17_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "pypdfium2 download failed"; exit 1 }

    # pydantic + pydantic-core + pydantic-settings use manylinux2014
    Write-Step "pydantic (manylinux2014)..."
    pip download `
        "pydantic>=2.5.3,<3.0.0" `
        "pydantic-settings>=2.1.0,<3.0.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "pydantic download failed"; exit 1 }

    # pure-Python surya deps
    Write-Step "pure-Python surya deps (filetype, ftfy, python-dotenv, tabulate)..."
    pip download `
        "filetype>=1.2.0,<2.0.0" "ftfy>=6.1.3,<7.0.0" `
        "python-dotenv>=1.0.0,<2.0.0" "tabulate>=0.9.0,<0.10.0" `
        "wcwidth" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "surya pure deps download failed"; exit 1 }

    $count = (Get-ChildItem $dir | Measure-Object).Count
    Write-Ok "Downloaded $count file(s) to $dir"
}

# ── 4. requirements.txt deps + huggingface-hub ────────────────────────────────
Write-Header "4/9  FastAPI service deps + huggingface-hub (~80 MB)"
$dir = "$WHEELS\requirements"
if ((Test-Path $dir) -and (Get-ChildItem $dir | Measure-Object).Count -gt 0) {
    Write-Ok "Already downloaded - skipping"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    # FastAPI service deps — download explicitly (skip surya/chandra from requirements.txt
    # as those are handled in step 3 and would cause conflicts here)
    # pillow is intentionally excluded — surya needs pillow<11, requirements would pull 12.x
    Write-Step "FastAPI + uvicorn + PDF libs + tiktoken (manylinux2014, no pillow)..."
    pip download `
        "fastapi==0.115.6" `
        "uvicorn[standard]==0.34.0" `
        "python-multipart==0.0.20" `
        "tiktoken>=0.7.0" `
        "httpx>=0.23.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "FastAPI deps download failed"; exit 1 }

    # pdf2image -- no-deps so it doesn't pull pillow 12
    Write-Step "pdf2image (no-deps)..."
    pip download "pdf2image>=1.17.0" --no-deps `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "pdf2image download failed"; exit 1 }

    # pdfplumber + its deps (pdfminer.six, pypdfium2) -- explicit, no pillow
    Write-Step "pdfplumber + pdfminer.six + pypdfium2 (no pillow)..."
    pip download "pdfminer.six==20251230" --no-deps `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    pip download "pdfplumber>=0.11.0" --no-deps `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    # pypdfium2 needed by pdfplumber (manylinux_2_17 tag)
    pip download "pypdfium2>=4.18.0" --no-deps `
        -d $dir `
        --platform manylinux_2_17_x86_64 --python-version 311 `
        --only-binary=:all:
    # cryptography needed by pdfminer.six
    pip download "cryptography>=36.0.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "pdfplumber deps download failed"; exit 1 }

    # uvloop — Linux-only dep of uvicorn[standard], skipped on Windows during pip download
    Write-Step "uvloop (Linux-only uvicorn dep, manylinux2014)..."
    pip download "uvloop>=0.14.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "uvloop download failed"; exit 1 }

    # huggingface-hub — pinned to 0.36.2 (last version before hf-xet dep was added)
    # newer versions require hf-xet which has its own complex deps
    Write-Step "huggingface-hub==0.29.3 (manylinux2014)..."
    pip download "huggingface-hub==0.29.3" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "huggingface-hub download failed"; exit 1 }

    $count = (Get-ChildItem $dir | Measure-Object).Count
    Write-Ok "Downloaded $count file(s) to $dir"
}

# ── 5. llama-cpp-python — source tarball ──────────────────────────────────────
Write-Header "5/9  llama-cpp-python (~50 MB source tarball)"
$dir = "$WHEELS\llama"
if ((Test-Path $dir) -and (Get-ChildItem $dir | Measure-Object).Count -gt 0) {
    Write-Ok "Already downloaded - skipping"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-Step "Downloading llama-cpp-python source tarball..."
    Write-Warn "Docker will compile it from source (~2 min, one-time only)."
    pip download "llama-cpp-python>=0.3.2" --no-deps -d $dir
    if ($LASTEXITCODE -ne 0) { Write-Fail "llama-cpp-python download failed"; exit 1 }

    # Build deps (pyproject.toml [build-system].requires)
    Write-Step "Downloading build deps (scikit-build-core, pyproject-metadata, ninja)..."
    pip download "scikit-build-core[pyproject]>=0.9.2" "pyproject-metadata" "ninja" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "llama build deps download failed"; exit 1 }

    # Runtime deps of llama-cpp-python (typing-extensions + numpy already in other folders)
    Write-Step "Downloading llama-cpp-python runtime deps (diskcache, jinja2)..."
    pip download "diskcache>=5.6.1" "jinja2>=2.11.3" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "llama runtime deps download failed"; exit 1 }

    $count = (Get-ChildItem $dir | Measure-Object).Count
    Write-Ok "Downloaded $count file(s) to $dir"
}


# ── 6. qwen-vl-utils wheels ──────────────────────────────────────────────
Write-Header "6/9  qwen-vl-utils + transformers>=4.52 + accelerate wheels (~30 MB)"
$dir = "$WHEELS\qwen_vl"
if ((Test-Path $dir) -and (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count -gt 0) {
    Write-Ok "Already downloaded - skipping"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # accelerate + sentencepiece are also needed by Gemma 3 — they get reused via
    # the same wheels folder (deploy script copies it into both qwen + gemma build contexts).
    Write-Step "Downloading qwen-vl-utils + transformers>=4.52 + accelerate + sentencepiece..."
    pip download `
        "qwen-vl-utils>=0.0.8" `
        "transformers>=4.52.0" `
        "accelerate>=0.30.0" `
        "sentencepiece>=0.2.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version 311 `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) { Write-Fail "qwen-vl-utils/transformers/accelerate download failed"; exit 1 }
    $count = (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count
    Write-Ok "Downloaded $count wheel(s) to $dir"
}

# ── 7. Qwen2.5-VL-3B model weights ───────────────────────────────────────────
Write-Header "7/9  Qwen2.5-VL-3B-Instruct model weights (~7.3 GB)"
$modelDir = "$BASE\model_cache\hub\models--Qwen--Qwen2.5-VL-3B-Instruct"
if (Test-Path $modelDir) {
    Write-Ok "Model already cached at model_cache\ -- skipping download"
} else {
    Write-Warn "This downloads ~7.3 GB. Takes 10-30 minutes on first run."
    Write-Warn "Saved to model_cache\ and mounted into the container as a volume."
    Write-Warn "Downloads ONCE -- all future builds and restarts reuse the cache."
    Write-Host ""
    Write-Step "Downloading Qwen/Qwen2.5-VL-3B-Instruct to model_cache\..."
    # Write download script to a temp file to avoid PowerShell quoting issues
    $downloadScript = @"
import sys
import os
from huggingface_hub import snapshot_download
cache_dir = sys.argv[1]
print(f'Downloading Qwen2.5-VL-3B-Instruct to: {cache_dir}')
snapshot_download(
    repo_id='Qwen/Qwen2.5-VL-3B-Instruct',
    cache_dir=cache_dir,
    ignore_patterns=['*.msgpack', '*.h5', 'flax_model*', 'tf_model*'],
)
print('Download complete.')
"@
    $tmpScript = [System.IO.Path]::GetTempFileName() + '.py'
    Set-Content -Path $tmpScript -Value $downloadScript -Encoding UTF8
    $cacheDir = "$BASE\model_cache"
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    python $tmpScript $cacheDir
    Remove-Item $tmpScript -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Model download failed. Check internet connection and retry."
        Write-Warn "You can retry by deleting model_cache\hub\models--Qwen--Qwen2.5-VL-3B-Instruct and running this script again."
        exit 1
    }
    Write-Ok "Qwen2.5-VL-3B-Instruct downloaded to model_cache\\"
}

# ── 8. Gemma 3 4B-it GGUF model weights (Q4_K_M + mmproj) ─────────────────────
# Switched from google/gemma-3-4b-it (transformers, ~8GB) to ggml-org/gemma-3-4b-it-GGUF
# (Q4_K_M ~2.5GB + mmproj ~800MB) for 10-15x faster CPU inference via llama.cpp.
Write-Header "8/9  ggml-org/gemma-3-4b-it-GGUF (Q4_K_M ~2.5 GB + mmproj ~800 MB)"
$gemmaModelDir = "$BASE\model_cache\hub\models--ggml-org--gemma-3-4b-it-GGUF"
if (Test-Path $gemmaModelDir) {
    Write-Ok "Gemma 3 GGUF already cached at model_cache\ -- skipping download"
} else {
    # Read HF_TOKEN from .env. The ggml-org GGUF repo MAY require auth depending
    # on Google's gating policy — we pass the token if available, fall through
    # to anonymous download if not (and re-prompt if that fails).
    $envFile = "$BASE\.env"
    $hfToken = ""
    if (Test-Path $envFile) {
        $envContent = Get-Content $envFile -Raw
        $hfTokenMatch = [regex]::Match($envContent, 'HF_TOKEN\s*=\s*(\S+)')
        if ($hfTokenMatch.Success) { $hfToken = $hfTokenMatch.Groups[1].Value }
    }

    Write-Warn "Downloading ~3.3 GB (Q4_K_M model + mmproj projector)."
    Write-Warn "Takes 5-15 minutes on first run depending on connection."
    Write-Warn "Saved to model_cache\ and mounted into the container as a volume."
    Write-Host ""
    Write-Step "Downloading ggml-org/gemma-3-4b-it-GGUF to model_cache\..."

    # Download script — uses snapshot_download with allow_patterns to fetch
    # ONLY the Q4_K_M model + mmproj (not all quant variants, saves 20+ GB).
    $downloadScript = @"
import sys
from huggingface_hub import snapshot_download
cache_dir = sys.argv[1]
token = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
print(f'Downloading ggml-org/gemma-3-4b-it-GGUF to: {cache_dir}')
print(f'Auth token: {"provided" if token else "anonymous"}')
try:
    snapshot_download(
        repo_id='ggml-org/gemma-3-4b-it-GGUF',
        cache_dir=cache_dir,
        token=token,
        # Fetch only the Q4_K_M variant + projector (not all quantizations)
        # NOTE: ggml-org repo names the mmproj file 'mmproj-model-f16.gguf' (851 MB)
        # — it's shared across all quants of this model, not per-quant.
        allow_patterns=[
            'gemma-3-4b-it-Q4_K_M.gguf',
            'mmproj-model-f16.gguf',
            '*.json',
            'README*',
        ],
    )
    print('Download complete.')
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
"@
    $tmpScript = [System.IO.Path]::GetTempFileName() + '.py'
    Set-Content -Path $tmpScript -Value $downloadScript -Encoding UTF8
    $cacheDir = "$BASE\model_cache"
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    python $tmpScript $cacheDir $hfToken
    Remove-Item $tmpScript -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Gemma 3 GGUF download failed."
        Write-Warn ""
        Write-Warn "If the failure was a 401 (gated repo), the GGUF repo also requires auth."
        Write-Warn "Required steps:"
        Write-Warn "  1. Accept license:  https://huggingface.co/google/gemma-3-4b-it"
        Write-Warn "  2. Create token:    https://huggingface.co/settings/tokens (Read permission)"
        Write-Warn "  3. Add to .env:     HF_TOKEN=hf_xxxxxxxxxxxxx"
        Write-Warn "  4. Re-run this script"
        Write-Warn ""
        Write-Warn "Other causes: network issue / proxy / firewall."
        Write-Warn "Retry: delete model_cache\hub\models--ggml-org--gemma-3-4b-it-GGUF and re-run."
        exit 1
    }
    Write-Ok "ggml-org/gemma-3-4b-it-GGUF downloaded to model_cache\\"
}

# ── 9. Surya OCR model weights (det3 + rec2) ─────────────────────────────────
# CRITICAL for offline operation: vlm-service runs with HF_HUB_OFFLINE=1, so the
# Surya detection + recognition weights MUST be pre-cached into model_cache\hub\
# (the path HF_HOME=/models points at inside the container). Without this, Surya
# fails at startup with LocalEntryNotFoundError on vikp/surya_det3 and any scanned
# (non-digital) PDF cannot be OCR'd.
Write-Header "9/9  Surya OCR model weights — vikp/surya_det3 + vikp/surya_rec2 (~900 MB)"
$suryaDet = "$BASE\model_cache\hub\models--vikp--surya_det3"
$suryaRec = "$BASE\model_cache\hub\models--vikp--surya_rec2"
if ((Test-Path $suryaDet) -and (Test-Path $suryaRec)) {
    Write-Ok "Surya weights already cached at model_cache\ -- skipping download"
} else {
    Write-Warn "This downloads ~900 MB (detection ~150 MB + recognition ~750 MB)."
    Write-Warn "Saved to model_cache\ and mounted into vlm-service as a volume."
    Write-Warn "Required so Surya runs OFFLINE for scanned PDFs."
    Write-Host ""
    Write-Step "Downloading vikp/surya_det3 + vikp/surya_rec2 to model_cache\..."
    $suryaScript = @"
import sys
from huggingface_hub import snapshot_download
cache_dir = sys.argv[1]
for repo in ('vikp/surya_det3', 'vikp/surya_rec2'):
    print(f'Downloading {repo} to: {cache_dir}')
    snapshot_download(
        repo_id=repo,
        cache_dir=cache_dir,
        ignore_patterns=['*.msgpack', '*.h5', 'flax_model*', 'tf_model*'],
    )
print('Surya weights download complete.')
"@
    $tmpSurya = [System.IO.Path]::GetTempFileName() + '.py'
    Set-Content -Path $tmpSurya -Value $suryaScript -Encoding UTF8
    $cacheDir = "$BASE\model_cache"
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    python $tmpSurya $cacheDir
    Remove-Item $tmpSurya -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Surya weights download failed. Check internet connection and retry."
        Write-Warn "Retry by deleting model_cache\hub\models--vikp--surya_* and re-running."
        exit 1
    }
    Write-Ok "Surya weights (det3 + rec2) downloaded to model_cache\"
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  All wheels + model weights downloaded." -ForegroundColor Green
$totalMB = [math]::Round((Get-ChildItem "$WHEELS" -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB)
Write-Host "  Wheels:       ~${totalMB} MB in vlm-service\wheels\" -ForegroundColor Green
if (Test-Path "$BASE\model_cache") {
    $modelGB = [math]::Round((Get-ChildItem "$BASE\model_cache" -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1GB, 1)
    Write-Host "  Model cache:  ~${modelGB} GB in model_cache\" -ForegroundColor Green
}
Write-Host ""
Write-Host "  Next: run .\deploySolutionLocal.ps1" -ForegroundColor Green
Write-Host "  Docker build will run fully offline." -ForegroundColor Green
Write-Host "  Containers will run with HF_HUB_OFFLINE=1 (zero network calls)." -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""