# =============================================================================
#  deployDockerFull.ps1  (rewritten)
#  Deploys OptimusInvoice as FIVE Docker containers via docker compose.
#
#  Containers (defined in docker-compose.yml):
#    optimus-app        → Node.js + React           (localhost:3000)
#    vlm-service        → Surya + Qwen 3B semantic   (localhost:8300)
#    optimus_qwen_vl    → Qwen2.5-VL-3B vision       (localhost:8400)
#    optimus_gemma_vl   → Gemma 3 4B-it GGUF         (localhost:8500)
#    optimus-mysql      → MySQL 8.0                  (localhost:3306)
#
#  WHAT THIS REWRITE ADDS vs the previous deployDockerFull.ps1
#    + Syncs server\python\*.py into every build context compose uses, with
#      SHA-256 verification (was missing — edits were silently ignored).
#    + Stages each service into its OWN build-context subfolder (matches
#      docker-compose.yml and deploySolutionLocal.ps1 exactly):
#        vlm   → .\vlm-service\   (Dockerfile + *.py + wheels\)
#        qwen  → .\qwen-vl-service\   (Dockerfile + *.py + wheels\{torch,
#                                       qwen_vl,transformers,requirements})
#        gemma → .\gemma-vl-service\  (Dockerfile + *.py + wheels\{torch,
#                                       llama,requirements})
#    + Full wheels preflight (incl. transformers + qwen_vl, previously unchecked).
#    + Smoke tests on the synced app.py before building.
#    + Creates .env if missing and injects VLM_ENGINE / BUSINESS_PORTAL_API_KEY.
#    + Enables BuildKit. Cache is RESPECTED (no --no-cache) for fast rebuilds.
#
#  Migrations: handled inside Dockerfile.app (CMD runs `pnpm db:push`), so this
#  script intentionally does NOT run db:push on the host.
#
#  Differences vs deploySolutionLocal.ps1
#    - Runs EVERYTHING in containers (incl. the Node app via Dockerfile.app).
#    - App is built with `pnpm build`, not `pnpm dev` — no hot reload.
#    - Use this for: demos, fresh-machine deployment, production-like setup.
#    - Use deploySolutionLocal.ps1 for: active development with hot reload.
# =============================================================================

$ErrorActionPreference = "Stop"
# Native commands (docker, node, ...) frequently write warnings to stderr even on
# success (e.g. "WARNING: No blkio throttle.read_bps_device support"). Two engines
# can turn that into a script-killing error:
#   - PowerShell 7.3+: governed by $PSNativeCommandUseErrorActionPreference
#   - Windows PowerShell 5.1: ANY native stderr under ErrorActionPreference=Stop
#     raises a terminating NativeCommandError, even with 2>$null.
# We set the PS7 switch where it exists, AND drop ErrorActionPreference to
# Continue for the native-command phases (we check $LASTEXITCODE for real
# failures, so we don't rely on stderr to detect them). This keeps the script
# working identically on PS 5.1 and PS 7.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$ErrorActionPreference = "Continue"
$BASE = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $BASE

# ── Build acceleration ───────────────────────────────────────────────────────
# BuildKit parallelizes layers and skips unused stages. Cache is respected, so
# only changed layers rebuild (your Dockerfiles COPY fast-changing .py last).
$env:DOCKER_BUILDKIT          = "1"
$env:COMPOSE_DOCKER_CLI_BUILD = "1"

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Header($text) {
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "  ========================================" -ForegroundColor Cyan
}
function Write-Ok($text)   { Write-Host "  [OK]  $text" -ForegroundColor Green }
function Write-Step($text) { Write-Host "  -->   $text" -ForegroundColor White }
function Write-Fail($text) { Write-Host "  [ERR] $text" -ForegroundColor Red }
function Write-Warn($text) { Write-Host "  [!!]  $text" -ForegroundColor Yellow }

function Get-FileHash256($path) {
    return (Get-FileHash -Path $path -Algorithm SHA256).Hash
}

# Copy $src → $dst, then fail hard if hashes differ. Returns nothing; exits on mismatch.
function Copy-Verified($src, $dst, $label) {
    if (-not (Test-Path $src)) { Write-Fail "Source missing: $src"; exit 1 }
    Copy-Item -Force $src $dst
    if ((Get-FileHash256 $src) -ne (Get-FileHash256 $dst)) {
        Write-Fail "SYNC FAILED: $label ($dst does not match $src)"; exit 1
    }
    Write-Ok "$label synced ($((Get-Item $dst).Length) bytes, SHA256 match)"
}

# Recursively copy a wheel folder into a build context (idempotent).
function Copy-WheelFolder($name, $srcRoot, $dstRoot) {
    $src = Join-Path $srcRoot $name
    $dst = Join-Path $dstRoot $name
    if (-not (Test-Path $src)) { return $false }
    if (-not (Test-Path $dstRoot)) { New-Item -ItemType Directory -Force -Path $dstRoot | Out-Null }
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Force -Recurse $src $dst
    return $true
}

# =============================================================================
# STEP 0 — Preflight checks
# =============================================================================
Write-Header "STEP 0: Preflight checks"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "Docker not found. Install Docker Desktop from https://docker.com"; exit 1
}
Write-Ok "Docker CLI found"

# Docker writes harmless warnings to stderr (e.g. "No blkio throttle..." on
# Windows/WSL2). On Windows PowerShell 5.1 with ErrorActionPreference=Stop, ANY
# native-command stderr is raised as a terminating NativeCommandError — even with
# 2>$null. To stay compatible with both PS 5.1 and PS 7, we run docker through
# cmd.exe, which absorbs stderr at the OS level so PowerShell never sees it.
# A real "Docker not running" is still detected via the exit code.
cmd /c "docker info >NUL 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker Desktop is not running. Please start it and retry."; exit 1
}
Write-Ok "Docker Desktop is running"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warn "Node.js not found on host — will use weaker fallback JWT generator."
}

if (-not (Test-Path "$BASE\docker-compose.yml")) {
    Write-Fail "docker-compose.yml not found in $BASE"; exit 1
}
Write-Ok "docker-compose.yml found"

# ── Ensure the shared network exists ─────────────────────────────────────────
# docker-compose.yml declares optimus_ai_net as `external: true`, so compose
# expects it to already exist (it won't create it). This avoids the
# "incorrect label com.docker.compose.network" clash that happens when compose
# tries to own a network that deploySolutionLocal.ps1 (or a prior run) created.
# Create it here if missing so a fresh machine still works.
cmd /c "docker network inspect optimus_ai_net >NUL 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Step "Creating shared Docker network optimus_ai_net..."
    docker network create optimus_ai_net | Out-Null
    Write-Ok "Network optimus_ai_net created"
} else {
    Write-Ok "Docker network optimus_ai_net already exists"
}

# ── Deploy toggles ───────────────────────────────────────────────────────────
# The fp32 Qwen2.5-VL-3B (qwen-vl) is being retired in favour of the faster
# Qwen3-VL-8B GGUF sidecar (qwen3vl). Set to $true only if you still want to
# build/start the old fp32 container.
$DeployQwenVl = $false

# ── Source wheels (the master copy lives under vlm-service\wheels\) ───────────
$wheelSrc = "$BASE\vlm-service\wheels"
# qwen_vl wheels (torch + transformers>=4.52) are only needed for the old fp32
# qwen-vl container. Skip requiring them when that container is not deployed.
if ($DeployQwenVl) {
    $requiredWheels = @("torch", "requirements", "surya", "llama", "transformers", "qwen_vl")
} else {
    $requiredWheels = @("requirements", "surya", "llama")
}
$missingWheels = @()
foreach ($w in $requiredWheels) {
    if (-not (Test-Path (Join-Path $wheelSrc $w))) { $missingWheels += $w }
}
if ($missingWheels.Count -gt 0) {
    Write-Fail "Missing wheel folder(s) under vlm-service\wheels\: $($missingWheels -join ', ')"
    Write-Warn "Fix: run .\Download-VlmWheels.ps1 first, then retry this script."
    exit 1
}
Write-Ok "Offline wheels present ($($requiredWheels -join ', '))"

# ── Model cache (informational) ──────────────────────────────────────────────
$qwenCached  = Test-Path "$BASE\model_cache\hub\models--Qwen--Qwen2.5-VL-3B-Instruct"
$gemmaCached = Test-Path "$BASE\model_cache\hub\models--ggml-org--gemma-3-4b-it-GGUF"
if ($qwenCached)  { Write-Ok "Qwen2.5-VL-3B model cache found (~7.3 GB)" }
else              { Write-Warn "Qwen2.5-VL-3B model NOT cached — first request will trigger download" }
if ($gemmaCached) { Write-Ok "Gemma 3 4B-it GGUF model cache found (~3.3 GB)" }
else              { Write-Warn "Gemma 3 4B-it GGUF NOT cached — first request will download (requires HF_TOKEN)" }

# ── Qwen3-VL-8B GGUF sidecar files (model_cache\qwen3vl\) ─────────────────────
# The qwen3vl service is the official llama.cpp server image (no build) and
# loads the GGUF + mmproj from model_cache\qwen3vl\. These must be pre-downloaded
# (the container runs no downloader). If missing, the qwen3vl container will
# fail to start — but the rest of the stack (digital + gemma) is unaffected.
$q3Model  = "$BASE\model_cache\qwen3vl\Qwen3VL-8B-Instruct-Q4_K_M.gguf"
$q3Mmproj = "$BASE\model_cache\qwen3vl\mmproj-Qwen3VL-8B-Instruct-F16.gguf"
if ((Test-Path $q3Model) -and (Test-Path $q3Mmproj)) {
    Write-Ok "Qwen3-VL-8B GGUF + mmproj found in model_cache\qwen3vl\ (~7 GB)"
} else {
    Write-Warn "Qwen3-VL-8B GGUF/mmproj NOT found in model_cache\qwen3vl\ — the qwen3vl container will not start."
    Write-Warn "Download once (needs huggingface-cli + ~7 GB):"
    Write-Warn '  huggingface-cli download Qwen/Qwen3-VL-8B-Instruct-GGUF Qwen3VL-8B-Instruct-Q4_K_M.gguf --local-dir model_cache\qwen3vl'
    Write-Warn '  huggingface-cli download Qwen/Qwen3-VL-8B-Instruct-GGUF mmproj-Qwen3VL-8B-Instruct-F16.gguf --local-dir model_cache\qwen3vl'
    Write-Warn "Then pull the PINNED llama.cpp server image (multimodal KV-cache fix #17200):"
    Write-Warn '  docker pull ghcr.io/ggml-org/llama.cpp:server-b6907'
    Write-Warn "(Skip the qwen3vl service for now with: docker compose up -d --scale qwen3vl=0)"
}

# ── Surya OCR weights (needed for scanned PDFs in offline vlm-service) ────────
# vlm-service runs with HF_HUB_OFFLINE=1 and loads Surya weights from
# model_cache/hub. If they are not pre-cached, Surya fails at startup and
# scanned PDFs can't be OCR'd. Digital PDFs still work via pdfplumber, so WARN.
$suryaDetCached = Test-Path "$BASE\model_cache\hub\models--vikp--surya_det3"
$suryaRecCached = Test-Path "$BASE\model_cache\hub\models--vikp--surya_rec2"
if ($suryaDetCached -and $suryaRecCached) {
    Write-Ok "Surya OCR weights found (vikp/surya_det3 + surya_rec2)"
} else {
    Write-Warn "Surya OCR weights NOT cached in model_cache\hub (vikp/surya_det3 + surya_rec2)."
    Write-Warn "vlm-service runs offline (HF_HUB_OFFLINE=1) — Surya will FAIL at startup and"
    Write-Warn "scanned/image PDFs cannot be OCR'd. Digital (native-text) PDFs still work via pdfplumber."
    Write-Warn "Fix: run .\Download-VlmWheels.ps1 (step 9/9 downloads the Surya weights)."
}

# =============================================================================
# STEP 0.5 — Pre-build Docker cleanup (prune dangling images only — SAFE)
# =============================================================================
Write-Header "STEP 0.5: Pre-build Docker cleanup"

$dangling = docker images -f "dangling=true" -q
if ($dangling) {
    $danglingCount = ($dangling | Measure-Object).Count
    Write-Step "Found $danglingCount dangling image(s) — pruning..."
    $pruneOutput = docker image prune -f 2>&1 | Out-String
    $reclaimMatch = [regex]::Match($pruneOutput, 'Total reclaimed space:\s*(\S+)')
    if ($reclaimMatch.Success) { Write-Ok "Reclaimed $($reclaimMatch.Groups[1].Value) of disk space" }
    else                       { Write-Ok "Dangling images removed" }
} else {
    Write-Ok "No dangling images — disk is clean"
}

# =============================================================================
# STEP 1 — .env (create if missing, inject required keys)
# =============================================================================
Write-Header "STEP 1: Environment configuration (.env)"

$envFile = "$BASE\.env"
$MYSQL_ROOT_PASS = "optimus123"
$MYSQL_DB        = "invoice_automation"
$MYSQL_PORT      = 3306

if (Test-Path $envFile) {
    Write-Ok ".env exists — checking required keys..."
    $envContent = Get-Content $envFile -Raw

    if ($envContent -notmatch 'VLM_ENGINE') {
        Add-Content -Path $envFile -Value "`n# ── VLM Engine (surya | qwen_vl_local | gemma_vl_local) ──`nVLM_ENGINE=surya"
        Write-Ok "VLM_ENGINE=surya added"
    } else {
        $cur = [regex]::Match($envContent, 'VLM_ENGINE\s*=\s*(\S+)').Groups[1].Value
        Write-Ok "VLM_ENGINE=$cur"
    }

    if ($envContent -notmatch 'BUSINESS_PORTAL_API_KEY') {
        Add-Content -Path $envFile -Value "`n# ── Business Portal (GEMI) Open Data API ──`n# Register at https://opendata.businessportal.gr/register/ for an API key.`nBUSINESS_PORTAL_API_KEY="
        Write-Ok "BUSINESS_PORTAL_API_KEY placeholder added"
    }
} else {
    Write-Step "Generating .env ..."
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $jwtSecret = node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))"
    } else {
        $jwtSecret = -join ((48..57) + (97..102) | Get-Random -Count 128 | ForEach-Object { [char]$_ })
    }
    $envText = @"
# ── Database ────────────────────────────────────────────────
DATABASE_URL="mysql://root:${MYSQL_ROOT_PASS}@optimus-mysql:3306/${MYSQL_DB}"

# ── Security ────────────────────────────────────────────────
JWT_SECRET="${jwtSecret}"

# ── App ─────────────────────────────────────────────────────
NODE_ENV="production"
PORT=3000

# ── VLM Service ─────────────────────────────────────────────
VLM_SERVICE_URL="http://vlm-service:8100"

# ── VLM Engine (surya | qwen_vl_local | gemma_vl_local) ──
VLM_ENGINE=surya

# ── Business Portal (GEMI) Open Data API ────────────────────
# Register at https://opendata.businessportal.gr/register/ for an API key.
BUSINESS_PORTAL_API_KEY=

# ── HuggingFace (only needed if Gemma 3 GGUF is not pre-cached) ──
HF_TOKEN=
"@
    Set-Content -Path $envFile -Value $envText -Encoding UTF8
    Write-Ok ".env created with auto-generated JWT secret"
    Write-Warn "ERP credentials are set via the app's Configuration page"
}

# =============================================================================
# STEP 2 — JWT secret (export for compose interpolation)
# =============================================================================
Write-Header "STEP 2: JWT secret"

$jwtSecret = $env:JWT_SECRET
if (-not $jwtSecret -and (Test-Path $envFile)) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^JWT_SECRET=" } | Select-Object -First 1
    if ($line) { $jwtSecret = ($line -replace "^JWT_SECRET=", "") -replace '"', '' }
}
if (-not $jwtSecret) {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $jwtSecret = node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))"
    } else {
        $jwtSecret = -join ((48..57) + (97..102) | Get-Random -Count 128 | ForEach-Object { [char]$_ })
    }
    Write-Warn "JWT_SECRET was missing — generated a new one (persist it in .env for token continuity)."
}
$env:JWT_SECRET = $jwtSecret
Write-Ok "JWT_SECRET ready ($($jwtSecret.Length) chars)"

# =============================================================================
# STEP 3 — HF_TOKEN handling for Gemma 3 (gated model)
#   CASE A: Gemma cached            → strict offline, no token
#   CASE B: not cached, HF_TOKEN set → runtime download
#   CASE C: not cached, no token     → fail with instructions
# =============================================================================
Write-Header "STEP 3: HF_TOKEN handling (Gemma 3 gated model)"

$hfToken = $env:HF_TOKEN
if (-not $hfToken -and (Test-Path $envFile)) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^HF_TOKEN=" } | Select-Object -First 1
    if ($line) { $hfToken = ($line -replace "^HF_TOKEN=", "") -replace '"', '' }
}

if ($gemmaCached) {
    Write-Ok "Gemma 3 GGUF cached — running OFFLINE (HF_HUB_OFFLINE=1)"
    $env:GEMMA_HF_HUB_OFFLINE = "1"
    $env:HF_TOKEN = ""
} elseif ($hfToken) {
    Write-Warn "Gemma 3 GGUF not cached. Container will download at runtime (~10 min)."
    $env:GEMMA_HF_HUB_OFFLINE = "0"
    $env:HF_TOKEN = $hfToken
} else {
    Write-Fail "Gemma 3 GGUF not cached AND HF_TOKEN missing."
    Write-Warn ""
    Write-Warn "  PATH 1 — Pre-download cache (recommended):"
    Write-Warn "    1. Accept license: https://huggingface.co/google/gemma-3-4b-it"
    Write-Warn "    2. Create token:   https://huggingface.co/settings/tokens"
    Write-Warn "    3. Add to .env:    HF_TOKEN=hf_xxxxxxxxxxxxx"
    Write-Warn "    4. Run:            .\Download-VlmWheels.ps1"
    Write-Warn "    5. Re-run:         .\deployDockerFull.ps1"
    Write-Warn ""
    Write-Warn "  PATH 2 — Runtime download: add HF_TOKEN=hf_xxxx to .env, then re-run."
    exit 1
}

# =============================================================================
# STEP 4 — Sync Python sources + wheels into the compose build contexts
#   THIS IS THE STEP THE OLD deployDockerFull WAS MISSING.
#
#   Compose build contexts (from docker-compose.yml):
#     vlm-service  → context ./vlm-service       (Dockerfile COPYs app.py, wheels/)
#     qwen         → context ./qwen-vl-service   (Dockerfile COPYs *.py + wheels/)
#     gemma        → context ./gemma-vl-service  (Dockerfile COPYs *.py + wheels/)
# =============================================================================
Write-Header "STEP 4: Sync Python sources + wheels into build contexts"

$pySrc = "$BASE\server\python"

# ── 4a. vlm-service (context ./vlm-service) ─────────────────────────────────
Write-Step "Syncing vlm-service Python files..."
Copy-Verified "$pySrc\vlm_service.py"        "$BASE\vlm-service\app.py"                  "vlm-service/app.py"
Copy-Verified "$pySrc\vlm_invoice_parser.py" "$BASE\vlm-service\vlm_invoice_parser.py"   "vlm_invoice_parser.py"
Copy-Verified "$pySrc\semantic_extractor.py" "$BASE\vlm-service\semantic_extractor.py"   "semantic_extractor.py"
Copy-Verified "$pySrc\vision_validator.py"   "$BASE\vlm-service\vision_validator.py"     "vision_validator.py"
Copy-Verified "$pySrc\mydata_fields.py"      "$BASE\vlm-service\mydata_fields.py"        "mydata_fields.py"
Copy-Verified "$pySrc\client_profile.py"     "$BASE\vlm-service\client_profile.py"       "client_profile.py"
Copy-Verified "$pySrc\dispatch_fields.py"    "$BASE\vlm-service\dispatch_fields.py"      "dispatch_fields.py"
Copy-Verified "$pySrc\qwen3vl_engine.py"     "$BASE\vlm-service\qwen3vl_engine.py"       "qwen3vl_engine.py"
# vlm wheels already live at vlm-service\wheels\ (the source) — nothing to stage.

# ── 4b. qwen-vl-service (context = .\qwen-vl-service) ────────────────────────
# Only staged when $DeployQwenVl is enabled — the old fp32 vision container is
# retired by default in favour of the qwen3vl GGUF sidecar.
if ($DeployQwenVl) {
    Write-Step "Staging qwen-vl-service build context (.\qwen-vl-service)..."
    $qwenDir = "$BASE\qwen-vl-service"
    if (-not (Test-Path $qwenDir)) { New-Item -ItemType Directory -Force -Path $qwenDir | Out-Null }
    Copy-Verified "$BASE\Dockerfile.qwen_vl"  "$qwenDir\Dockerfile"          "qwen Dockerfile"
    Copy-Verified "$pySrc\qwen_vl_engine.py"  "$qwenDir\qwen_vl_engine.py"  "qwen_vl_engine.py"
    Copy-Verified "$pySrc\qwen_vl_service.py" "$qwenDir\qwen_vl_service.py" "qwen_vl_service.py"
    # vision_postprocess + semantic_extractor are imported by qwen_vl_engine for the
    # accuracy post-processing (number/VAT/currency fixes). The Dockerfile COPYs them,
    # so they must be staged into the build context here too — else the fix no-ops.
    Copy-Verified "$pySrc\vision_postprocess.py" "$qwenDir\vision_postprocess.py" "vision_postprocess.py"
    Copy-Verified "$pySrc\semantic_extractor.py" "$qwenDir\semantic_extractor.py" "semantic_extractor.py"
    Write-Step "Staging Qwen wheels (torch, qwen_vl, transformers, requirements)..."
    foreach ($w in @("torch", "qwen_vl", "transformers", "requirements")) {
        if (-not (Copy-WheelFolder $w $wheelSrc "$qwenDir\wheels")) {
            Write-Fail "Wheel folder '$w' missing — cannot stage for qwen build"; exit 1
        }
    }
    Write-Ok "Qwen context ready at .\qwen-vl-service\"
} else {
    Write-Step "Skipping qwen-vl-service (fp32 retired — using qwen3vl GGUF sidecar)"
}

# ── 4c. gemma-vl-service (context = .\gemma-vl-service) ──────────────────────
Write-Step "Staging gemma-vl-service build context (.\gemma-vl-service)..."
$gemmaDir = "$BASE\gemma-vl-service"
if (-not (Test-Path $gemmaDir)) { New-Item -ItemType Directory -Force -Path $gemmaDir | Out-Null }
Copy-Verified "$BASE\Dockerfile.gemma_vl"  "$gemmaDir\Dockerfile"           "gemma Dockerfile"
Copy-Verified "$pySrc\gemma_vl_engine.py"  "$gemmaDir\gemma_vl_engine.py"  "gemma_vl_engine.py"
Copy-Verified "$pySrc\gemma_vl_service.py" "$gemmaDir\gemma_vl_service.py" "gemma_vl_service.py"
# Same as qwen: postprocess + semantic_extractor must be in the gemma build context.
Copy-Verified "$pySrc\vision_postprocess.py" "$gemmaDir\vision_postprocess.py" "vision_postprocess.py"
Copy-Verified "$pySrc\semantic_extractor.py" "$gemmaDir\semantic_extractor.py" "semantic_extractor.py"
Write-Step "Staging Gemma wheels (torch, llama, requirements)..."
foreach ($w in @("torch", "llama", "requirements")) {
    if (-not (Copy-WheelFolder $w $wheelSrc "$gemmaDir\wheels")) {
        Write-Fail "Wheel folder '$w' missing — cannot stage for gemma build"; exit 1
    }
}
# pdfplumber wheel — gemma builds STRICTLY offline (no PyPI fallback), so the
# pdfplumber wheel + deps must be present in wheels\requirements\. If missing,
# pre-download once:  pip download pdfplumber==0.11.9 -d gemma-vl-service\wheels\requirements\
$pdfplumberWheel = Get-ChildItem "$gemmaDir\wheels\requirements" -Filter "pdfplumber*" -ErrorAction SilentlyContinue
if (-not $pdfplumberWheel) {
    Write-Warn "pdfplumber wheel missing in gemma wheels\requirements\ — the gemma build will FAIL (offline)."
    Write-Warn "  Run once with internet:  pip download pdfplumber==0.11.9 -d \"$gemmaDir\wheels\requirements\""
} else {
    Write-Ok "pdfplumber wheel present for gemma offline build"
}
# Verify the llama-cpp-python wheel is actually present (Gemma's llama.cpp backend).
$llamaWheel = Get-ChildItem "$gemmaDir\wheels\llama" -Filter "llama_cpp_python*" -ErrorAction SilentlyContinue
if (-not $llamaWheel) { $llamaWheel = Get-ChildItem "$gemmaDir\wheels\llama" -Filter "llama-cpp-python*" -ErrorAction SilentlyContinue }
if (-not $llamaWheel) {
    Write-Fail "llama-cpp-python wheel missing from gemma-vl-service\wheels\llama\ (needed for Gemma GGUF backend)."
    Write-Warn "Fix: run .\Download-VlmWheels.ps1"; exit 1
}
Write-Ok "Gemma context ready at .\gemma-vl-service\ (llama-cpp-python: $($llamaWheel.Name))"

# =============================================================================
# STEP 5 — Smoke tests on the synced files (catch truncation / wrong file early)
# =============================================================================
Write-Header "STEP 5: Smoke tests"

$appContent = Get-Content "$BASE\vlm-service\app.py" -Raw
$semContent = Get-Content "$BASE\vlm-service\semantic_extractor.py" -Raw
$parContent = Get-Content "$BASE\vlm-service\vlm_invoice_parser.py" -Raw

if ($appContent.Length -lt 1000)               { Write-Fail "SMOKE: app.py too small"; exit 1 }
if ($appContent -notmatch "extract.pdf")        { Write-Fail "SMOKE: app.py missing /extract-pdf"; exit 1 }
if ($appContent -notmatch "semantic_extractor") { Write-Fail "SMOKE: app.py missing semantic_extractor"; exit 1 }
if ($appContent -notmatch "gemma_vl_local")     { Write-Fail "SMOKE: app.py missing gemma_vl_local dispatcher"; exit 1 }
if ($parContent.Length -lt 1000)               { Write-Fail "SMOKE: vlm_invoice_parser too small"; exit 1 }
if ($semContent -notmatch '_validate_extraction') {
    Write-Warn "semantic_extractor.py missing _validate_extraction() — extraction quality degraded (non-fatal)"
} else {
    Write-Ok "Validation pass present in semantic_extractor.py"
}

# ── Vision-validator wiring guard ────────────────────────────────────────────
# app.py (== vlm_service.py) must call the validator, the module must be present,
# and vlm-service\Dockerfile must COPY it — else the container crashes at startup.
$vlmDockerfile = Get-Content "$BASE\vlm-service\Dockerfile" -Raw
if ($appContent -match 'validate_vision_extraction') {
    if (-not (Test-Path "$BASE\vlm-service\vision_validator.py")) {
        Write-Fail "app.py calls the validator but vision_validator.py is missing from the build context"; exit 1
    }
    if ($vlmDockerfile -notmatch 'COPY\s+vision_validator\.py') {
        Write-Fail "vlm-service\Dockerfile does NOT 'COPY vision_validator.py' — container will crash with ModuleNotFoundError"
        Write-Warn "Add near the other COPY *.py lines in vlm-service\Dockerfile:  COPY vision_validator.py ."
        exit 1
    }
    Write-Ok "Vision validator wired correctly (app calls it, module present, Dockerfile copies it)"
} else {
    Write-Warn "app.py does NOT call validate_vision_extraction — qwen/gemma outputs will NOT be reconciliation-checked"
}
Write-Ok "Smoke tests passed"

# =============================================================================
# STEP 6 — Build and start all containers (cache respected; BuildKit on)
# =============================================================================
Write-Header "STEP 6: Build and start all containers"

New-Item -ItemType Directory -Force -Path "$BASE\data\client_profiles" | Out-Null
New-Item -ItemType Directory -Force -Path "$BASE\model_cache"          | Out-Null

Write-Step "Running docker compose up --build -d ..."
Write-Warn "First run builds images and downloads Surya weights inside the vlm container."
Write-Warn "If Qwen3-VL/Gemma not cached: runtime download adds time."
Write-Warn "Subsequent runs reuse cached layers and start in 1-2 min."

# Build/start an explicit service list so the retired fp32 qwen-vl is never
# built or started. qwen3vl (the GGUF sidecar) uses a pre-pulled image, so it
# isn't "built" — but listing it here ensures it starts.
if ($DeployQwenVl) {
    $composeServices = @("mysql", "vlm", "qwen-vl", "gemma-vl", "qwen3vl", "app")
} else {
    $composeServices = @("mysql", "vlm", "gemma-vl", "qwen3vl", "app")
    # Make sure any previously-running fp32 qwen-vl is stopped + removed so it
    # doesn't linger holding ~15GB.
    docker compose stop qwen-vl 2>$null | Out-Null
    docker compose rm -f qwen-vl 2>$null | Out-Null
}
Write-Host "    Services: $($composeServices -join ', ')" -ForegroundColor DarkGray

docker compose up --build -d @composeServices
if ($LASTEXITCODE -ne 0) {
    Write-Fail "docker compose up FAILED"
    Write-Warn "Check logs: docker compose logs --tail 50"
    exit 1
}
Write-Ok "Containers started in detached mode"

# =============================================================================
# STEP 7 — Wait for services to become healthy
# =============================================================================
Write-Header "STEP 7: Waiting for services to be ready"

Write-Step "Waiting for MySQL (healthcheck: mysqladmin ping)..."
$maxWait = 90; $waited = 0; $mysqlReady = $false
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 5; $waited += 5
    $health = docker inspect -f "{{.State.Health.Status}}" optimus-mysql 2>$null
    if ($health -eq "healthy") { $mysqlReady = $true; break }
    Write-Host "  ...MySQL $health ($waited`s / $maxWait`s)" -ForegroundColor DarkGray
}
if ($mysqlReady) { Write-Ok "MySQL is healthy" } else { Write-Warn "MySQL not healthy after ${maxWait}s — docker logs optimus-mysql" }

Write-Step "Waiting for vlm-service (probing GET http://localhost:8300/health)..."
$maxWait = 600; $waited = 0; $vlmReady = $false
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 10; $waited += 10
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8300/health" -TimeoutSec 3 -ErrorAction Stop
        if ($resp.status -eq "ok") {
            Write-Ok "vlm-service responding (semantic: $($resp.semantic_llm))"
            $vlmReady = $true; break
        }
    } catch {
        Write-Host "  ...vlm starting ($waited`s / $maxWait`s)" -ForegroundColor DarkGray
    }
}
if (-not $vlmReady) { Write-Warn "vlm-service /health did not return ok after ${maxWait}s — docker logs vlm-service" }

Write-Step "Waiting for optimus-app (HTTP probe on port 3000)..."
$maxWait = 240; $waited = 0; $appReady = $false
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 5; $waited += 5
    try {
        $response = Invoke-WebRequest "http://localhost:3000" -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $appReady = $true; break }
    } catch {}
    Write-Host "  ...waiting for app ($waited`s / $maxWait`s)" -ForegroundColor DarkGray
}
if ($appReady) { Write-Ok "App is up!" } else { Write-Warn "App did not respond after ${maxWait}s — docker compose logs app" }

# Background vision services — model load can take 2-25 min.
Write-Step "Checking optional vision services (informational only)..."
$gemmaHealth = docker inspect -f "{{.State.Health.Status}}" optimus_gemma_vl 2>$null
$qwen3Health = docker inspect -f "{{.State.Health.Status}}" optimus_qwen3vl  2>$null
if ($DeployQwenVl) {
    $qwenHealth = docker inspect -f "{{.State.Health.Status}}" optimus_qwen_vl 2>$null
    Write-Host "    qwen-vl  : $qwenHealth"  -ForegroundColor DarkGray
    if ($qwenHealth -ne "healthy") { Write-Warn "Qwen2.5-VL still loading — docker logs -f optimus_qwen_vl" }
}
Write-Host "    gemma-vl : $gemmaHealth" -ForegroundColor DarkGray
Write-Host "    qwen3vl  : $qwen3Health" -ForegroundColor DarkGray
if ($gemmaHealth -ne "healthy") { Write-Warn "Gemma 3 still loading    — docker logs -f optimus_gemma_vl" }
if ($qwen3Health -ne "healthy") { Write-Warn "Qwen3-VL-8B still loading — docker logs -f optimus_qwen3vl" }

# =============================================================================
# STEP 8 — Seed default engine config (vlmEngine=surya)
# =============================================================================
Write-Header "STEP 8: Seed default engine (vlmEngine=surya)"

if ($mysqlReady) {
    $seedSql = @"
INSERT INTO configuration (userId, settingsJson, createdAt, updatedAt)
SELECT 1, '{"vlmEngine":"surya","useNativeText":false}', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM configuration WHERE userId = 1)
ON DUPLICATE KEY UPDATE
  settingsJson = JSON_SET(COALESCE(settingsJson, '{}'), '`$.vlmEngine', 'surya'),
  updatedAt = NOW();
"@
    $seedSql | docker exec -i optimus-mysql mysql -uroot -p$MYSQL_ROOT_PASS $MYSQL_DB 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "Default engine seeded to surya" }
    else { Write-Warn "Could not seed engine config — set manually via Configuration page" }
} else {
    Write-Warn "Skipped engine seed (MySQL not ready)"
}

# =============================================================================
# STEP 9 — Post-build Docker cleanup
# =============================================================================
Write-Header "STEP 9: Post-build Docker cleanup"

$dangling = docker images -f "dangling=true" -q
if ($dangling) {
    $danglingCount = ($dangling | Measure-Object).Count
    Write-Step "Found $danglingCount dangling image(s) created by this deploy — pruning..."
    $pruneOutput = docker image prune -f 2>&1 | Out-String
    $reclaimMatch = [regex]::Match($pruneOutput, 'Total reclaimed space:\s*(\S+)')
    if ($reclaimMatch.Success) { Write-Ok "Reclaimed $($reclaimMatch.Groups[1].Value) of disk space" }
    else                       { Write-Ok "Dangling images removed" }
} else {
    Write-Ok "No dangling images created — disk usage stable"
}

Write-Step "Docker disk usage after deploy:"
$df = docker system df 2>&1 | Out-String
foreach ($line in ($df -split "`n")) {
    if ($line.Trim()) { Write-Host "    $line" -ForegroundColor DarkGray }
}

# =============================================================================
# Summary
# =============================================================================
Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  DONE — all containers running" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  App      : http://localhost:3000" -ForegroundColor Cyan
Write-Host "  VLM      : http://localhost:8300/health  (Surya + pdfplumber + semantic Qwen)" -ForegroundColor Cyan
Write-Host "  QwenVL   : http://localhost:8400/health  (Qwen2.5-VL-3B vision)" -ForegroundColor Cyan
Write-Host "  GemmaVL  : http://localhost:8500/health  (Gemma 3 4B-it GGUF)" -ForegroundColor Cyan
Write-Host "  MySQL    : localhost:3306  (db: invoice_automation)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor DarkGray
Write-Host "    docker compose logs -f app          # app logs (tail)" -ForegroundColor DarkGray
Write-Host "    docker compose logs -f vlm          # OCR + semantic logs" -ForegroundColor DarkGray
Write-Host "    docker compose logs -f gemma-vl     # Gemma weights loading progress" -ForegroundColor DarkGray
Write-Host "    docker compose ps                   # all container statuses" -ForegroundColor DarkGray
Write-Host "    docker compose down                 # stop everything" -ForegroundColor DarkGray
Write-Host "    docker compose down -v              # stop AND delete volumes (CAUTION: wipes DB!)" -ForegroundColor DarkGray
Write-Host "    docker compose up --build app       # rebuild app only after code change" -ForegroundColor DarkGray
Write-Host "    docker compose restart vlm          # restart vlm without rebuild" -ForegroundColor DarkGray
Write-Host ""