# =============================================================================
#  deployDockerFull.ps1  (rewritten — adds the paddle-ocr sidecar)
#  Deploys OptimusInvoice as Docker containers via docker compose.
#
#  PaddleOCR additions vs your previous version (all marked  # <PADDLE>):
#    • STEP 0   : optional PaddleOCR model-cache check (non-fatal)
#    • STEP 4e  : stage paddle-ocr-service Python from server\python\  <-- the sync
#    • STEP 5   : smoke tests for the paddle sidecar + the app.py dispatcher
#    • STEP 6   : "paddle-ocr" added to BOTH $composeServices lists
#    • STEP 7   : paddle-ocr health probe (informational)
#    • Summary  : paddle URL line
#
#  SOURCE OF TRUTH: like every other service, the paddle Python files live in
#  server\python\ and are Copy-Verified into paddle-ocr-service\ at deploy time.
#  Put these files in server\python\ before running:
#      paddle_ocr_engine.py  paddle_kie.py  paddle_ocr_service.py
#      paddle_ppchatocr.py   (vision_postprocess.py is already there)
#  The paddle-ocr-service\ folder keeps only its static Dockerfile + requirements.txt.
# =============================================================================

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$ErrorActionPreference = "Continue"
$BASE = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $BASE

$env:DOCKER_BUILDKIT          = "1"
$env:COMPOSE_DOCKER_CLI_BUILD = "1"

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

function Copy-Verified($src, $dst, $label) {
    if (-not (Test-Path $src)) { Write-Fail "Source missing: $src"; exit 1 }
    Copy-Item -Force $src $dst
    if ((Get-FileHash256 $src) -ne (Get-FileHash256 $dst)) {
        Write-Fail "SYNC FAILED: $label ($dst does not match $src)"; exit 1
    }
    Write-Ok "$label synced ($((Get-Item $dst).Length) bytes, SHA256 match)"
}

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

cmd /c "docker network inspect optimus_ai_net >NUL 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Step "Creating shared Docker network optimus_ai_net..."
    docker network create optimus_ai_net | Out-Null
    Write-Ok "Network optimus_ai_net created"
} else {
    Write-Ok "Docker network optimus_ai_net already exists"
}

$DeployQwenVl = $false

$wheelSrc = "$BASE\vlm-service\wheels"
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

# ── MinerU sidecar wheels (mineru-service container — port 8700) ─────────────
$mineruWheelSrc = "$BASE\mineru-service\wheels"
if (-not (Test-Path (Join-Path $mineruWheelSrc "mineru"))) {
    Write-Warn "MinerU sidecar wheels NOT found in mineru-service\wheels\mineru\ — the mineru-service build will FAIL."
    Write-Warn "Download once with internet:  .\Download-MineruWheels.ps1"
    Write-Warn "Or skip MinerU for now:  docker compose up -d --scale mineru-service=0"
    $script:MineruWheelsReady = $false
} else {
    Write-Ok "MinerU sidecar wheels present (mineru-service\wheels\mineru\)"
    $script:MineruWheelsReady = $true
}

$qwenCached  = Test-Path "$BASE\model_cache\hub\models--Qwen--Qwen2.5-VL-3B-Instruct"
$gemmaCached = Test-Path "$BASE\model_cache\hub\models--ggml-org--gemma-3-4b-it-GGUF"
if ($qwenCached)  { Write-Ok "Qwen2.5-VL-3B model cache found (~7.3 GB)" }
else              { Write-Warn "Qwen2.5-VL-3B model NOT cached — first request will trigger download" }
if ($gemmaCached) { Write-Ok "Gemma 3 4B-it GGUF model cache found (~3.3 GB)" }
else              { Write-Warn "Gemma 3 4B-it GGUF NOT cached — first request will download (requires HF_TOKEN)" }

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

# ── Qwen3.5-4B GGUF model cache (qwen35 container — port 8800) ────────────────
$q35Model  = "$BASE\model_cache\qwen35\Qwen3.5-4B-Q4_K_M.gguf"
$q35Mmproj = "$BASE\model_cache\qwen35\mmproj-F16.gguf"
if ((Test-Path $q35Model) -and (Test-Path $q35Mmproj)) {
    Write-Ok "Qwen3.5-4B GGUF + mmproj found in model_cache\qwen35\ (~3.4 GB)"
} else {
    Write-Warn "Qwen3.5-4B GGUF/mmproj NOT found in model_cache\qwen35\ — the qwen35 container will not start."
    Write-Warn "Download once:  .\Download-Qwen35.ps1  (fetches the GGUF + mmproj and the newer llama.cpp image)"
    Write-Warn "(Skip the qwen35 service for now with: docker compose up -d --scale qwen35=0)"
}

# <PADDLE> ── PaddleOCR model cache (paddle-ocr container — port 8900) ─────────
# PaddleOCR does NOT use the HF cache. PP-StructureV3 downloads its models from
# Baidu's model server into PADDLE_PDX_CACHE_HOME (=/models/paddlex) the FIRST
# time it runs. If the build/runtime host has internet, this happens on the
# first request automatically. If air-gapped, pre-bake once with
# .\Download-PaddleModels.ps1 on a networked box and ship model_cache\paddlex.
# Also note: KIE (direct image->JSON) calls the qwen35 llama-server — if qwen35
# is not up, paddle-ocr still runs but falls back to feeding Markdown to the
# vlm-service semantic_extractor instead of returning JSON directly.
$paddleCached = Test-Path "$BASE\model_cache\paddlex"
if ($paddleCached) {
    Write-Ok "PaddleOCR model cache found (model_cache\paddlex)"
} else {
    Write-Warn "PaddleOCR models NOT cached in model_cache\paddlex — they will AUTO-DOWNLOAD during STEP 7 warm-up (needs internet on this host)."
    Write-Warn "Air-gapped host? Run .\Download-PaddleModels.ps1 on a networked box first, then ship model_cache\paddlex."
}

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
# STEP 0.5 — Pre-build Docker cleanup
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
# STEP 1 — .env
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
        Add-Content -Path $envFile -Value "`n# VLM Engine`nVLM_ENGINE=surya"
        Write-Ok "VLM_ENGINE=surya added"
    } else {
        $cur = [regex]::Match($envContent, 'VLM_ENGINE\s*=\s*(\S+)').Groups[1].Value
        Write-Ok "VLM_ENGINE=$cur"
    }

    if ($envContent -notmatch 'BUSINESS_PORTAL_API_KEY') {
        Add-Content -Path $envFile -Value "`nBUSINESS_PORTAL_API_KEY="
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
DATABASE_URL="mysql://root:${MYSQL_ROOT_PASS}@optimus-mysql:3306/${MYSQL_DB}"
JWT_SECRET="${jwtSecret}"
NODE_ENV="production"
PORT=3000
VLM_SERVICE_URL="http://vlm-service:8100"
VLM_ENGINE=surya
BUSINESS_PORTAL_API_KEY=
HF_TOKEN=
"@
    Set-Content -Path $envFile -Value $envText -Encoding UTF8
    Write-Ok ".env created with auto-generated JWT secret"
    Write-Warn "ERP credentials are set via the app's Configuration page"
}

# =============================================================================
# STEP 2 — JWT secret
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
# STEP 3 — HF_TOKEN handling for Gemma 3
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
    Write-Warn "Gemma 3 GGUF not cached AND HF_TOKEN missing."
    Write-Warn "Gemma will be unavailable until cached or HF_TOKEN is set — but the rest of the stack still deploys."
    $env:GEMMA_HF_HUB_OFFLINE = "1"
    $env:HF_TOKEN = ""
}

# =============================================================================
# STEP 4 — Sync Python sources + wheels into the compose build contexts
# =============================================================================
Write-Header "STEP 4: Sync Python sources + wheels into build contexts"

$pySrc = "$BASE\server\python"

# ── 4a. vlm-service ──────────────────────────────────────────────────────────
Write-Step "Syncing vlm-service Python files..."
Copy-Verified "$pySrc\vlm_service.py"        "$BASE\vlm-service\app.py"                  "vlm-service/app.py"
Copy-Verified "$pySrc\vlm_invoice_parser.py" "$BASE\vlm-service\vlm_invoice_parser.py"   "vlm_invoice_parser.py"
Copy-Verified "$pySrc\semantic_extractor.py" "$BASE\vlm-service\semantic_extractor.py"   "semantic_extractor.py"
Copy-Verified "$pySrc\vision_validator.py"   "$BASE\vlm-service\vision_validator.py"     "vision_validator.py"
Copy-Verified "$pySrc\mydata_fields.py"      "$BASE\vlm-service\mydata_fields.py"        "mydata_fields.py"
Copy-Verified "$pySrc\client_profile.py"     "$BASE\vlm-service\client_profile.py"       "client_profile.py"
Copy-Verified "$pySrc\dispatch_fields.py"    "$BASE\vlm-service\dispatch_fields.py"      "dispatch_fields.py"
Copy-Verified "$pySrc\qwen3vl_engine.py"     "$BASE\vlm-service\qwen3vl_engine.py"       "qwen3vl_engine.py"
Copy-Verified "$pySrc\qwen35_engine.py"      "$BASE\vlm-service\qwen35_engine.py"        "qwen35_engine.py"
# NOTE: MinerU is NOT staged into vlm-service — it lives in its own mineru-service
# sidecar (staged in STEP 4d below). vlm-service reaches it over HTTP.
# NOTE: paddle-ocr is likewise its own sidecar (staged in STEP 4e). vlm-service
# reaches it over HTTP at :8900.

# ── 4b. qwen-vl-service ──────────────────────────────────────────────────────
if ($DeployQwenVl) {
    Write-Step "Staging qwen-vl-service build context (.\qwen-vl-service)..."
    $qwenDir = "$BASE\qwen-vl-service"
    if (-not (Test-Path $qwenDir)) { New-Item -ItemType Directory -Force -Path $qwenDir | Out-Null }
    Copy-Verified "$BASE\Dockerfile.qwen_vl"  "$qwenDir\Dockerfile"          "qwen Dockerfile"
    Copy-Verified "$pySrc\qwen_vl_engine.py"  "$qwenDir\qwen_vl_engine.py"  "qwen_vl_engine.py"
    Copy-Verified "$pySrc\qwen_vl_service.py" "$qwenDir\qwen_vl_service.py" "qwen_vl_service.py"
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

# ── 4c. gemma-vl-service ─────────────────────────────────────────────────────
Write-Step "Staging gemma-vl-service build context (.\gemma-vl-service)..."
$gemmaDir = "$BASE\gemma-vl-service"
if (-not (Test-Path $gemmaDir)) { New-Item -ItemType Directory -Force -Path $gemmaDir | Out-Null }
Copy-Verified "$BASE\Dockerfile.gemma_vl"  "$gemmaDir\Dockerfile"           "gemma Dockerfile"
Copy-Verified "$pySrc\gemma_vl_engine.py"  "$gemmaDir\gemma_vl_engine.py"  "gemma_vl_engine.py"
Copy-Verified "$pySrc\gemma_vl_service.py" "$gemmaDir\gemma_vl_service.py" "gemma_vl_service.py"
Copy-Verified "$pySrc\vision_postprocess.py" "$gemmaDir\vision_postprocess.py" "vision_postprocess.py"
Copy-Verified "$pySrc\semantic_extractor.py" "$gemmaDir\semantic_extractor.py" "semantic_extractor.py"
Write-Step "Staging Gemma wheels (torch, llama, requirements)..."
foreach ($w in @("torch", "llama", "requirements")) {
    if (-not (Copy-WheelFolder $w $wheelSrc "$gemmaDir\wheels")) {
        Write-Fail "Wheel folder '$w' missing — cannot stage for gemma build"; exit 1
    }
}
$pdfplumberWheel = Get-ChildItem "$gemmaDir\wheels\requirements" -Filter "pdfplumber*" -ErrorAction SilentlyContinue
if (-not $pdfplumberWheel) {
    Write-Warn "pdfplumber wheel missing in gemma wheels\requirements\ — the gemma build will FAIL (offline)."
} else {
    Write-Ok "pdfplumber wheel present for gemma offline build"
}
$llamaWheel = Get-ChildItem "$gemmaDir\wheels\llama" -Filter "llama_cpp_python*" -ErrorAction SilentlyContinue
if (-not $llamaWheel) { $llamaWheel = Get-ChildItem "$gemmaDir\wheels\llama" -Filter "llama-cpp-python*" -ErrorAction SilentlyContinue }
if (-not $llamaWheel) {
    Write-Fail "llama-cpp-python wheel missing from gemma-vl-service\wheels\llama\ (needed for Gemma GGUF backend)."
    Write-Warn "Fix: run .\Download-VlmWheels.ps1"; exit 1
}
Write-Ok "Gemma context ready at .\gemma-vl-service\ (llama-cpp-python: $($llamaWheel.Name))"

# ── 4d. mineru-service ───────────────────────────────────────────────────────
Write-Step "Staging mineru-service build context (.\mineru-service)..."
$mineruDir = "$BASE\mineru-service"
if (-not (Test-Path $mineruDir)) { New-Item -ItemType Directory -Force -Path $mineruDir | Out-Null }
Copy-Verified "$BASE\Dockerfile.mineru"      "$mineruDir\Dockerfile"          "mineru Dockerfile"
Copy-Verified "$pySrc\mineru_reader.py"      "$mineruDir\mineru_reader.py"    "mineru_reader.py"
Copy-Verified "$pySrc\mineru_service.py"     "$mineruDir\mineru_service.py"   "mineru_service.py"
if ($script:MineruWheelsReady) {
    Write-Ok "mineru-service context ready at .\mineru-service\ (offline wheels present)"
} else {
    Write-Warn "mineru-service context staged, but wheels are MISSING — its build will fail until you run .\Download-MineruWheels.ps1 (or scale it to 0)."
}

# <PADDLE> ── 4e. paddle-ocr-service ──────────────────────────────────────────
# PaddleOCR PP-StructureV3 + KIE sidecar (CPU) → invoice JSON. Reached by
# vlm-service over HTTP at :8900. Python source-of-truth is server\python\ (same
# pattern as every other service). The Dockerfile + requirements.txt are STATIC
# inside paddle-ocr-service\ (not synced) — only the .py files are staged here.
# vision_postprocess.py is staged too so the KIE step can run the same
# number/VAT-hallucination guards as the qwen/gemma paths.
Write-Step "Staging paddle-ocr-service build context (.\paddle-ocr-service)..."
$paddleDir = "$BASE\paddle-ocr-service"
if (-not (Test-Path $paddleDir)) { New-Item -ItemType Directory -Force -Path $paddleDir | Out-Null }
if (-not (Test-Path "$paddleDir\Dockerfile")) {
    Write-Fail "paddle-ocr-service\Dockerfile missing — did you place the paddle-ocr-service\ folder?"; exit 1
}
if (-not (Test-Path "$paddleDir\requirements.txt")) {
    Write-Fail "paddle-ocr-service\requirements.txt missing — did you place the paddle-ocr-service\ folder?"; exit 1
}
Copy-Verified "$pySrc\paddle_ocr_engine.py"  "$paddleDir\paddle_ocr_engine.py"  "paddle_ocr_engine.py"
Copy-Verified "$pySrc\paddle_kie.py"         "$paddleDir\paddle_kie.py"         "paddle_kie.py"
Copy-Verified "$pySrc\paddle_ocr_service.py" "$paddleDir\paddle_ocr_service.py" "paddle_ocr_service.py"
Copy-Verified "$pySrc\paddle_ppchatocr.py"   "$paddleDir\paddle_ppchatocr.py"   "paddle_ppchatocr.py"
Copy-Verified "$pySrc\vision_postprocess.py" "$paddleDir\vision_postprocess.py" "vision_postprocess.py"
Write-Ok "paddle-ocr-service context ready at .\paddle-ocr-service\"

# =============================================================================
# STEP 5 — Smoke tests
# =============================================================================
Write-Header "STEP 5: Smoke tests"

$appContent = Get-Content "$BASE\vlm-service\app.py" -Raw
$semContent = Get-Content "$BASE\vlm-service\semantic_extractor.py" -Raw
$parContent = Get-Content "$BASE\vlm-service\vlm_invoice_parser.py" -Raw

if ($appContent.Length -lt 1000)               { Write-Fail "SMOKE: app.py too small"; exit 1 }
if ($appContent -notmatch "extract.pdf")        { Write-Fail "SMOKE: app.py missing /extract-pdf"; exit 1 }
if ($appContent -notmatch "semantic_extractor") { Write-Fail "SMOKE: app.py missing semantic_extractor"; exit 1 }
if ($appContent -notmatch "gemma_vl_local")     { Write-Fail "SMOKE: app.py missing gemma_vl_local dispatcher"; exit 1 }
if ($appContent -notmatch "qwen35_local")       { Write-Warn "SMOKE: app.py missing qwen35_local dispatcher — the Qwen3.5 engine will not be reachable (non-fatal)" }
else                                            { Write-Ok "qwen35_local dispatcher present in app.py" }
# <PADDLE> app.py must know the paddle_ocr engine (dispatch branch + proxy helper)
if ($appContent -notmatch "paddle_ocr")         { Write-Warn "SMOKE: app.py missing paddle_ocr dispatcher — the PaddleOCR engine will not be reachable (non-fatal). Re-apply the vlm_service.py edits." }
else                                            { Write-Ok "paddle_ocr dispatcher present in app.py" }
if ($appContent -notmatch "PADDLE_OCR_SERVICE_URL") { Write-Warn "SMOKE: app.py missing PADDLE_OCR_SERVICE_URL — the proxy target env is not wired (non-fatal)" }
else                                            { Write-Ok "PADDLE_OCR_SERVICE_URL wired in app.py" }
if ($parContent.Length -lt 1000)               { Write-Fail "SMOKE: vlm_invoice_parser too small"; exit 1 }
if ($semContent -notmatch '_validate_extraction') {
    Write-Warn "semantic_extractor.py missing _validate_extraction() — extraction quality degraded (non-fatal)"
} else {
    Write-Ok "Validation pass present in semantic_extractor.py"
}

# ── MinerU sidecar wiring guard (informational) ──────────────────────────────
$vlmDockerfile = Get-Content "$BASE\vlm-service\Dockerfile" -Raw
if (Test-Path "$BASE\mineru-service\mineru_service.py") {
    Write-Ok "MinerU sidecar staged (mineru-service\ — reached over HTTP at :8700; falls back to Surya if down)"
} else {
    Write-Warn "mineru-service\mineru_service.py not staged — the mineru engine will fall back to Surya."
}

# <PADDLE> ── paddle-ocr sidecar wiring guard ────────────────────────────────
$paddleSvc = Get-Content "$BASE\paddle-ocr-service\paddle_ocr_service.py" -Raw
if ($paddleSvc -notmatch "extract.pdf") {
    Write-Warn "SMOKE: paddle_ocr_service.py missing /extract-pdf (non-fatal)"
} else {
    Write-Ok "paddle-ocr sidecar staged (paddle-ocr-service\ — reached over HTTP at :8900; KIE via qwen35)"
}

# ── Vision-validator wiring guard ────────────────────────────────────────────
if ($appContent -match 'validate_vision_extraction') {
    if (-not (Test-Path "$BASE\vlm-service\vision_validator.py")) {
        Write-Fail "app.py calls the validator but vision_validator.py is missing from the build context"; exit 1
    }
    if ($vlmDockerfile -notmatch 'COPY\s+vision_validator\.py') {
        Write-Fail "vlm-service\Dockerfile does NOT 'COPY vision_validator.py' — container will crash with ModuleNotFoundError"
        exit 1
    }
    Write-Ok "Vision validator wired correctly (app calls it, module present, Dockerfile copies it)"
} else {
    Write-Warn "app.py does NOT call validate_vision_extraction — qwen/gemma outputs will NOT be reconciliation-checked"
}
Write-Ok "Smoke tests passed"

# =============================================================================
# STEP 6 — Build and start all containers
# =============================================================================
Write-Header "STEP 6: Build and start all containers"

New-Item -ItemType Directory -Force -Path "$BASE\data\client_profiles" | Out-Null
New-Item -ItemType Directory -Force -Path "$BASE\model_cache"          | Out-Null

Write-Step "Running docker compose up --build -d ..."
Write-Warn "First run builds images and downloads Surya weights inside the vlm container."
Write-Warn "First paddle-ocr build compiles paddlepaddle/paddleocr from PyPI (needs internet on the build host)."
Write-Warn "If Qwen3-VL/Gemma not cached: runtime download adds time."
Write-Warn "Subsequent runs reuse cached layers and start in 1-2 min."

# <PADDLE> "paddle-ocr" added to BOTH branches of the service list.
if ($DeployQwenVl) {
    $composeServices = @("mysql", "vlm", "qwen-vl", "gemma-vl", "qwen3vl", "qwen35", "mineru-service", "paddle-ocr", "app")
} else {
    $composeServices = @("mysql", "vlm", "gemma-vl", "qwen3vl", "qwen35", "mineru-service", "paddle-ocr", "app")
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

# <PADDLE> ── PaddleOCR warm-up wait (auto model download on first run) ────────
# The paddle-ocr container warms PP-StructureV3 in a background thread on boot,
# which DOWNLOADS the models into the bind-mounted model_cache\paddlex the FIRST
# time — nothing else to run. This replaces a separate Download-PaddleModels.ps1
# for hosts with internet: we just wait for /health ready:true so the cache is
# fully populated before the deploy reports done. On every FUTURE deploy the
# cache already exists and this returns in seconds.
$paddleCacheDir = "$BASE\model_cache\paddlex"
$paddleFirstRun = (-not (Test-Path $paddleCacheDir)) -or `
                  ((Get-ChildItem $paddleCacheDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0)
if ($paddleFirstRun) {
    Write-Step "Waiting for paddle-ocr FIRST-RUN model download (PP-StructureV3 -> model_cache\paddlex)..."
    Write-Warn "First run downloads PaddleOCR models (needs internet on this host). This can take several minutes."
    $maxWait = 900
} else {
    Write-Step "Waiting for paddle-ocr (models already cached in model_cache\paddlex)..."
    $maxWait = 300
}
$waited = 0; $paddleReady = $false
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 10; $waited += 10
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8900/health" -TimeoutSec 3 -ErrorAction Stop
        if ($resp.ready -eq $true) { $paddleReady = $true; break }
        Write-Host "  ...paddle-ocr loading (ready=$($resp.ready)) ($waited`s / $maxWait`s)" -ForegroundColor DarkGray
    } catch {
        Write-Host "  ...paddle-ocr starting ($waited`s / $maxWait`s)" -ForegroundColor DarkGray
    }
}
if ($paddleReady) {
    Write-Ok "PaddleOCR ready — models cached in model_cache\paddlex (reused on every future deploy)"
} else {
    Write-Warn "paddle-ocr not ready after ${maxWait}s — docker logs -f optimus_paddle_ocr"
    Write-Warn "If this host is AIR-GAPPED, the model download cannot run here. Pre-bake on a"
    Write-Warn "networked box with .\Download-PaddleModels.ps1 and ship model_cache\paddlex over."
}

Write-Step "Checking optional vision services (informational only)..."
$gemmaHealth = docker inspect -f "{{.State.Health.Status}}" optimus_gemma_vl 2>$null
$qwen3Health = docker inspect -f "{{.State.Health.Status}}" optimus_qwen3vl  2>$null
$qwen35Health = docker inspect -f "{{.State.Health.Status}}" optimus_qwen35  2>$null
$mineruHealth = docker inspect -f "{{.State.Health.Status}}" optimus_mineru  2>$null
$paddleHealth = docker inspect -f "{{.State.Health.Status}}" optimus_paddle_ocr 2>$null   # <PADDLE>
if ($DeployQwenVl) {
    $qwenHealth = docker inspect -f "{{.State.Health.Status}}" optimus_qwen_vl 2>$null
    Write-Host "    qwen-vl  : $qwenHealth"  -ForegroundColor DarkGray
    if ($qwenHealth -ne "healthy") { Write-Warn "Qwen2.5-VL still loading — docker logs -f optimus_qwen_vl" }
}
Write-Host "    gemma-vl : $gemmaHealth" -ForegroundColor DarkGray
Write-Host "    qwen3vl  : $qwen3Health" -ForegroundColor DarkGray
Write-Host "    qwen35   : $qwen35Health" -ForegroundColor DarkGray
Write-Host "    mineru   : $mineruHealth" -ForegroundColor DarkGray
Write-Host "    paddle   : $paddleHealth" -ForegroundColor DarkGray   # <PADDLE>
if ($gemmaHealth -ne "healthy") { Write-Warn "Gemma 3 still loading    — docker logs -f optimus_gemma_vl" }
if ($qwen3Health -ne "healthy") { Write-Warn "Qwen3-VL-8B still loading — docker logs -f optimus_qwen3vl" }
if ($qwen35Health -ne "healthy") { Write-Warn "Qwen3.5-4B still loading  — docker logs -f optimus_qwen35" }
if ($mineruHealth -ne "healthy") { Write-Warn "MinerU still loading     — docker logs -f optimus_mineru" }
# <PADDLE> paddle-ocr first run downloads PP-StructureV3 models — can take minutes.
if ($paddleHealth -ne "healthy") { Write-Warn "PaddleOCR still loading   — docker logs -f optimus_paddle_ocr (first run downloads PP-StructureV3 models)" }

# =============================================================================
# STEP 8 — Seed default engine config
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
Write-Host "  GemmaVL  : http://localhost:8500/health  (Gemma 3 4B-it GGUF)" -ForegroundColor Cyan
Write-Host "  Qwen3VL  : http://localhost:8600/health  (Qwen3-VL-8B GGUF)" -ForegroundColor Cyan
Write-Host "  Qwen35   : http://localhost:8800/health  (Qwen3.5-4B GGUF)" -ForegroundColor Cyan
Write-Host "  MinerU   : http://localhost:8700/health  (MinerU reader sidecar)" -ForegroundColor Cyan
Write-Host "  Paddle   : http://localhost:8900/health  (PaddleOCR PP-StructureV3 + KIE)" -ForegroundColor Cyan   # <PADDLE>
Write-Host "  MySQL    : localhost:3306  (db: invoice_automation)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Useful commands:" -ForegroundColor DarkGray
Write-Host "    docker compose logs -f app             # app logs (tail)" -ForegroundColor DarkGray
Write-Host "    docker compose logs -f vlm             # OCR + semantic logs" -ForegroundColor DarkGray
Write-Host "    docker compose logs -f mineru-service  # MinerU reader logs" -ForegroundColor DarkGray
Write-Host "    docker compose logs -f paddle-ocr      # PaddleOCR sidecar logs" -ForegroundColor DarkGray
Write-Host "    docker compose ps                      # all container statuses" -ForegroundColor DarkGray
Write-Host "    docker compose down                    # stop everything" -ForegroundColor DarkGray
Write-Host ""