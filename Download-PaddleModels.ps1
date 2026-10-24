# Download-PaddleModels.ps1
# ─────────────────────────────────────────────────────────────────────────────
# Pre-bake the PaddleOCR PP-StructureV3 models into ./model_cache/paddlex so the
# paddle-ocr sidecar runs fully OFFLINE (air-gapped), matching how your other
# sidecars keep pre-downloaded weights under ./model_cache.
#
# WHY THIS IS NEEDED: unlike the HF-based sidecars, PaddleOCR does NOT use the
# HuggingFace cache and does NOT download models at *build* time. It fetches them
# from Baidu's model server the first time PPStructureV3 runs. On an air-gapped
# host that first run would fail. This script does that first run ONCE on a host
# WITH internet, so the models are captured into the bind-mounted cache and can
# then be shipped to the offline host.
#
# PREREQUISITE: build the image first ->  docker compose build paddle-ocr
#
# USAGE (on a machine with internet + docker):
#   ./Download-PaddleModels.ps1
# ─────────────────────────────────────────────────────────────────────────────

# NOTE: we deliberately do NOT set $ErrorActionPreference = "Stop". Native
# commands like `docker` write informational text to stderr (e.g. "No such
# container" on first run), and under "Stop" PowerShell turns that stderr into a
# terminating error and aborts the script. We handle docker exit codes manually.

$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

# --- Helper: run docker, swallow stderr noise, surface exit codes ------------
function Invoke-DockerQuiet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$DockerArgs)
    # 2>&1 merges stderr into the pipeline so it doesn't raise NativeCommandError;
    # Out-Null discards the text. $LASTEXITCODE still reflects success/failure.
    & docker @DockerArgs 2>&1 | Out-Null
    return $LASTEXITCODE
}

# --- 0. Sanity: is docker available and is the image built? -------------------
& docker version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[Paddle] Docker is not available / not running. Start Docker Desktop and retry." -ForegroundColor Red
    exit 1
}

$img = (& docker images -q paddle-ocr-service 2>$null)
if (-not $img) {
    Write-Host "[Paddle] Image 'paddle-ocr-service' not found." -ForegroundColor Yellow
    Write-Host "[Paddle] Build it first:  docker compose build paddle-ocr" -ForegroundColor Yellow
    exit 1
}

# --- 1. Ensure the cache dir exists ------------------------------------------
$cacheDir = Join-Path $scriptRoot "model_cache\paddlex"
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
Write-Host "[Paddle] Model cache dir: $cacheDir"
$modelCacheAbs = (Resolve-Path (Join-Path $scriptRoot "model_cache")).Path

# --- 2. Remove any leftover pre-bake container (ignore "no such container") ---
Invoke-DockerQuiet rm -f optimus_paddle_prebake | Out-Null

# --- 3. Start the container to trigger the model download ---------------------
Write-Host "[Paddle] Starting paddle-ocr container to trigger model download..."
$runCode = Invoke-DockerQuiet run -d --name optimus_paddle_prebake `
    -p 8901:8900 `
    -e PADDLE_PDX_CACHE_HOME=/models/paddlex `
    -e PADDLE_LANG=el `
    -e PADDLE_REC_MODEL_NAME=el_PP-OCRv5_mobile_rec `
    -e PADDLE_USE_TABLE=1 `
    -v "${modelCacheAbs}:/models" `
    paddle-ocr-service

if ($runCode -ne 0) {
    Write-Host "[Paddle] docker run failed (exit $runCode). Check: docker logs optimus_paddle_prebake" -ForegroundColor Red
    exit 1
}

# --- 4. Wait for /health ready:true (models downloaded + pipeline built) ------
Write-Host "[Paddle] Waiting for models to download and pipeline to build (up to 15 min)..."
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 10
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8901/health" -TimeoutSec 5
        if ($resp.ready -eq $true) { $ready = $true; break }
        Write-Host "  ... still loading (attempt $($i + 1)/90)"
    } catch {
        Write-Host "  ... container not answering yet (attempt $($i + 1)/90)"
    }
}

if ($ready) {
    Write-Host "[Paddle] Models downloaded and pipeline ready. Cache populated at:" -ForegroundColor Green
    Write-Host "         $cacheDir"
} else {
    Write-Host "[Paddle] Timed out. Inspect logs:  docker logs optimus_paddle_prebake" -ForegroundColor Red
}

# --- 5. Tear down the pre-bake container --------------------------------------
Write-Host "[Paddle] Stopping pre-bake container..."
Invoke-DockerQuiet rm -f optimus_paddle_prebake | Out-Null
Write-Host "[Paddle] Done. Ship ./model_cache to the offline host."
