# Download-MineruWheels.ps1
# ─────────────────────────────────────────────────────────────────────────────
# Run ONCE from the repo root to pre-download all pip wheels for the MinerU
# sidecar (mineru-service) into mineru-service\wheels\ so its docker build never
# touches the internet and the container runs fully offline.
#
# This is the MinerU equivalent of Download-VlmWheels.ps1, but targets the
# SEPARATE mineru-service container, which has its OWN modern stack:
#     torch >= 2.6 (CPU) + transformers >= 4.57.3 + mineru[pipeline]
# (kept isolated from vlm-service's pinned Surya 0.6.13 / transformers 4.46.3).
#
# Usage:  .\Download-MineruWheels.ps1
#         .\Download-MineruWheels.ps1 -Force      # re-download even if present
#
# Platform tag guide (why multiple tags are needed):
#   linux_x86_64          → PyTorch custom tag (torch, torchvision only)
#   manylinux2014_x86_64  → Standard C-extension wheels (pillow, shapely, pyclipper)
#   manylinux_2_27_x86_64 → Newer C-extension wheels (onnxruntime, tokenizers,
#                           albumentations, opencv, newer numpy)
#   none-any              → Pure Python (works everywhere)
#
# IMPORTANT — Python version:
#   The mineru-service container is python:3.11-slim, so we download cp311
#   wheels (--python-version 311). Run this on ANY OS with internet — pip
#   downloads the LINUX wheels regardless of your host OS because we pass
#   explicit --platform/--python-version. (You do NOT need WSL for the download;
#   you only need internet + a working pip.)
#
# WHY A SCRIPT (not three bare pip lines):
#   MinerU's pipeline pulls a few packages that occasionally ship source-only
#   for a given tag (albumentations / onnxruntime edge cases). A single
#   --only-binary=:all: line fails hard on the first such package. This script
#   tries binary-only first, and if that fails, RETRIES that group allowing
#   source for the stragglers — so you get a complete wheel set without manual
#   trial-and-error.
# ─────────────────────────────────────────────────────────────────────────────

param(
    [switch]$Force
)

$ErrorActionPreference = "Continue"   # we check $LASTEXITCODE ourselves
$BASE   = $PSScriptRoot
$WHEELS = "$BASE\mineru-service\wheels"
$PYVER  = "311"

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

# Returns $true if the folder already has at least one .whl (and -Force not set).
function Test-AlreadyDownloaded { param($dir, $pattern = "*.whl")
if ($Force) { return $false }
return (Test-Path $dir) -and ((Get-ChildItem $dir -Filter $pattern -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
}

# Try a pip download with --only-binary first; if it fails, retry the SAME
# request allowing source for stragglers (drops --only-binary). Returns $true
# on success of either attempt.
function Invoke-PipDownload {
    param(
        [string[]]$Packages,
        [string]$Dir,
        [string]$Platform,
        [string[]]$ExtraArgs = @()
    )
    $common = @("-d", $Dir, "--python-version", $PYVER)
    if ($Platform) { $common += @("--platform", $Platform) }
    $common += $ExtraArgs

    Write-Step "binary-only: pip download $($Packages -join ' ')"
    pip download @Packages @common --only-binary=:all:
    if ($LASTEXITCODE -eq 0) { return $true }

    Write-Warn "binary-only download failed — retrying allowing source for stragglers..."
    # When allowing source, a --platform constraint can't be combined with
    # building sdists, so drop --platform for the fallback and let pip use the
    # host. (The resulting sdists are platform-independent source; binary deps
    # already came down in the first pass.)
    $fallback = @("-d", $Dir, "--python-version", $PYVER) + $ExtraArgs
    pip download @Packages @fallback
    if ($LASTEXITCODE -eq 0) {
        Write-Warn "fallback succeeded — note: some packages came as source (sdist). The container build will compile them (build-essential is installed in Dockerfile.mineru)."
        return $true
    }
    return $false
}

Write-Host ""
Write-Host "  OptimusInvoice - MinerU Sidecar Wheel Pre-downloader" -ForegroundColor Cyan
Write-Host "  Target: mineru-service\wheels\  (torch 2.7 + transformers 4.57 + mineru[pipeline])" -ForegroundColor DarkGray
Write-Host "  Downloads ~1.5-2.5 GB of wheels once so the mineru build is offline." -ForegroundColor DarkGray
Write-Host ""

# ── Preflight: pip present? ──────────────────────────────────────────────────
if (-not (Get-Command pip -ErrorAction SilentlyContinue)) {
    Write-Fail "pip not found on PATH. Install Python 3.x (with pip) and retry."
    exit 1
}
New-Item -ItemType Directory -Force -Path $WHEELS | Out-Null

# ── 1. torch 2.7.x CPU + torchvision ─────────────────────────────────────────
Write-Header "1/3  torch (CPU) + torchvision  (~800 MB)"
$dir = "$WHEELS\torch"
if (Test-AlreadyDownloaded $dir "torch-2*.whl") {
    Write-Ok "Already downloaded - skipping (use -Force to re-download)"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # Part A: torch + torchvision main wheels from PyTorch CPU index (no-deps —
    # the big binary wheels only, fetched with the linux_x86_64 tag).
    Write-Step "Part A: torch>=2.6,<3 + torchvision (CPU) main wheels..."
    pip download "torch>=2.6,<3" "torchvision" `
        --index-url https://download.pytorch.org/whl/cpu `
        -d $dir `
        --platform linux_x86_64 --python-version $PYVER `
        --only-binary=:all: --no-deps
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "torch/torchvision download failed. Check internet + that the PyTorch CPU index has a cp311 linux wheel for the resolved version."
        exit 1
    }
    # Part B: torch's pure-Python runtime deps (filelock, sympy, networkx,
    # jinja2, fsspec, typing-extensions, MarkupSafe, mpmath). The container build
    # is fully offline (--no-index), so these MUST be present or the torch
    # install fails with "No matching distribution found for filelock". These
    # come from regular PyPI (manylinux2014 tag covers the C-less ones).
    Write-Step "Part B: torch pure-Python deps (filelock, sympy, networkx, jinja2, fsspec...)..."
    pip download `
        "filelock" "typing-extensions>=4.8.0" "networkx" `
        "jinja2" "fsspec" "setuptools" "MarkupSafe" `
        "sympy==1.13.1" "mpmath<1.4,>=1.1.0" "numpy" "pillow>=10.0" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version $PYVER `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "torch pure-Python deps download failed"
        exit 1
    }
    $count = (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count
    Write-Ok "Downloaded $count torch wheel(s) to $dir"
}

# ── 2. FastAPI service deps ──────────────────────────────────────────────────
Write-Header "2/3  Service deps (fastapi, uvicorn, multipart, pdfplumber)  (~30 MB)"
$dir = "$WHEELS\requirements"
if (Test-AlreadyDownloaded $dir) {
    Write-Ok "Already downloaded - skipping (use -Force to re-download)"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $ok = Invoke-PipDownload `
        -Packages @("fastapi", "uvicorn[standard]", "python-multipart", "pdfplumber") `
        -Dir $dir `
        -Platform "manylinux_2_27_x86_64"
    if (-not $ok) { Write-Fail "service deps download failed"; exit 1 }
    # uvicorn[standard] pulls uvloop / watchfiles / websockets — these are
    # Linux-only (or platform-specific) packages. When this script runs on
    # WINDOWS, pip evaluates the host platform marker and SKIPS uvloop entirely
    # (no Windows wheel exists), so it never lands even with --platform. Download
    # them explicitly with the Linux tag so the offline container build resolves
    # `uvicorn[standard]`.
    Write-Step "Explicitly fetching uvicorn[standard]'s Linux-only extras (uvloop, watchfiles, websockets)..."
    pip download "uvloop" "watchfiles" "websockets" `
        -d $dir `
        --platform manylinux2014_x86_64 --python-version $PYVER `
        --only-binary=:all:
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "uvloop/watchfiles/websockets download failed — uvicorn[standard] may fail in the container."
        Write-Warn "Retry manually: pip download uvloop watchfiles websockets -d `"$dir`" --platform manylinux2014_x86_64 --python-version 311 --only-binary=:all:"
    }
    $count = (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count
    Write-Ok "Downloaded $count service wheel(s) to $dir"
}

# ── 3. mineru[pipeline] + its full dependency tree ───────────────────────────
# This is the heavy one: transformers>=4.57.3, accelerate, onnxruntime,
# albumentations, shapely, pyclipper, omegaconf, ftfy, opencv, etc.
Write-Header "3/3  mineru[pipeline] + deps (transformers 4.57, onnxruntime, ...)  (~1.5 GB)"
$dir = "$WHEELS\mineru"
if (Test-AlreadyDownloaded $dir "mineru*") {
    Write-Ok "Already downloaded - skipping (use -Force to re-download)"
} else {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $torchDir = "$WHEELS\torch"
    # Pass A: the full mineru[pipeline] tree as WHEELS, with:
    #   - PINNED version (==3.4.0): without a pin pip backtracks through ~60
    #     mineru releases trying to satisfy onnxruntime/pylatexenc and dies with
    #     ResolutionImpossible. The pin makes it deterministic.
    #   - manylinux_2_28 tag: onnxruntime / opencv / scikit-image publish their
    #     current Linux wheels under 2_28, NOT the older 2014/2_27 tags. Using an
    #     older tag makes pip reject every mineru version.
    # This grabs everything that HAS a Linux wheel (the vast majority).
    Write-Step "Pass A: mineru[pipeline]==3.4.0 full tree (multi manylinux tag, binary)..."
    # mineru's deps span MULTIPLE manylinux tag families: onnxruntime/opencv/
    # scikit-image/numpy publish under manylinux_2_28, while pypdfium2 (and some
    # others) only publish under manylinux_2_17 / manylinux2014. A single
    # --platform can't match both → pip rejects the tree. --platform is
    # REPEATABLE: passing all tags lets pip accept a wheel matching ANY of them.
    #
    # --no-binary=pylatexenc: pylatexenc 2.10 (which mineru pins, <3) is
    # SOURCE-ONLY — only its 3.0 ALPHA prereleases have wheels, and those are
    # excluded by the <3 pin. Under a blanket --only-binary=:all:, pip can't see
    # the 2.10 sdist and aborts the ENTIRE resolution. Carving pylatexenc out
    # with --no-binary lets pip accept its sdist while every other package stays
    # a pre-built wheel. (Per-package --no-binary is allowed alongside --platform;
    # only a blanket source build is forbidden.) The sdist compiles in the image
    # (build-essential present). pylatexenc is pure-Python, so it builds anywhere.
    pip download "mineru[pipeline]==3.4.0" `
        -d $dir `
        --platform manylinux_2_28_x86_64 `
        --platform manylinux_2_27_x86_64 `
        --platform manylinux_2_17_x86_64 `
        --platform manylinux2014_x86_64 `
        --python-version $PYVER `
        --only-binary=:all: --no-binary=pylatexenc `
        --find-links $torchDir
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "mineru[pipeline]==3.4.0 wheel download failed."
        Write-Warn "If pip rejected --no-binary with --platform, run the two-step fallback:"
        Write-Warn "  1) pip download mineru[pipeline]==3.4.0 ... --only-binary=:all: --no-deps"
        Write-Warn "  2) grab each dep; pylatexenc via: pip download 'pylatexenc>=2.10,<3' --no-deps --no-binary=:all:"
        Write-Warn "Or paste the pip error and we'll adjust."
        exit 1
    }
    # Pass B: pylatexenc is SOURCE-ONLY on PyPI (no wheels exist). mineru pins
    # pylatexenc>=2.10,<3. Grab its sdist (pure-Python; compiles in the image,
    # which has build-essential). --platform is NOT allowed with sdists, so omit
    # it; the resulting tarball is platform-independent source.
    Write-Step "Pass B: pylatexenc (source-only sdist)..."
    pip download "pylatexenc>=2.10,<3" `
        -d $dir `
        --no-deps --no-binary=:all:
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "pylatexenc sdist download failed"
        exit 1
    }
    $count = (Get-ChildItem $dir -Filter "*.whl" | Measure-Object).Count
    $sdist = (Get-ChildItem $dir -Filter "*.tar.gz" -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Ok "Downloaded $count wheel(s) + $sdist sdist(s) to $dir"
    if ($sdist -gt 0) {
        Write-Warn "$sdist package(s) came as source — Dockerfile.mineru has build-essential/cmake to compile them at build time."
    }
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Header "DONE — MinerU sidecar wheels ready"
$total = (Get-ChildItem $WHEELS -Recurse -Filter "*.whl" -ErrorAction SilentlyContinue | Measure-Object).Count
$size  = "{0:N1}" -f ((Get-ChildItem $WHEELS -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB)
Write-Host ""
Write-Ok "Total: $total wheel(s), ~$size GB in $WHEELS"
Write-Host ""
Write-Host "  Folders:" -ForegroundColor DarkGray
foreach ($sub in @("torch", "requirements", "mineru")) {
    $p = "$WHEELS\$sub"
    if (Test-Path $p) {
        $c = (Get-ChildItem $p -ErrorAction SilentlyContinue | Measure-Object).Count
        Write-Host "    mineru-service\wheels\$sub\  ($c files)" -ForegroundColor DarkGray
    }
}
Write-Host ""
Write-Host "  Next:  .\deployDockerFull.ps1   (builds mineru-service offline)" -ForegroundColor Cyan
Write-Host ""