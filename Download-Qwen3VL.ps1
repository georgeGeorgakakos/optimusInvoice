# =============================================================================
# Download-Qwen3VL.ps1 - proactive one-shot setup for the Qwen3-VL-8B sidecar
# -----------------------------------------------------------------------------
# Downloads the verified Q4_K_M GGUF + F16 mmproj into model_cache\qwen3vl\ and
# pulls the PINNED llama.cpp server image (multimodal KV-cache fix, build b6907).
#
# Uses the huggingface_hub PYTHON API directly (hf_hub_download) instead of the
# CLI - this avoids the 'huggingface-cli'->'hf' rename and PATH issues entirely.
# Only needs `python` on PATH (which you have).
#
# Run ONCE before deploying. ~5 GB (model) + ~1 GB (mmproj) + the server image.
# Re-running is safe (hf_hub_download skips files already fully downloaded).
#
# Repo:  Qwen/Qwen3-VL-8B-Instruct-GGUF   (Apache-2.0, official Qwen GGUF)
#   LLM   : Qwen3VL-8B-Instruct-Q4_K_M.gguf       (~5.03 GB)
#   mmproj: mmproj-Qwen3VL-8B-Instruct-F16.gguf   (vision encoder, ~1 GB)
# =============================================================================

$ErrorActionPreference = "Stop"
$BASE   = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path $BASE "model_cache\qwen3vl"
$Repo   = "Qwen/Qwen3-VL-8B-Instruct-GGUF"
$LlmFile    = "Qwen3VL-8B-Instruct-Q4_K_M.gguf"
$MmprojFile = "mmproj-Qwen3VL-8B-Instruct-F16.gguf"
$LlamaImage = "ghcr.io/ggml-org/llama.cpp:server-b6907"

function Write-Ok   ($m) { Write-Host "[OK]   $m" -ForegroundColor Green }
function Write-Step ($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Warn ($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

Write-Step "Qwen3-VL-8B sidecar setup"

# -- 1. Ensure huggingface_hub (the Python package) is installed --------------
python -c "import huggingface_hub" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "huggingface_hub not installed - installing..."
    python -m pip install -U huggingface_hub --quiet
}

# -- 2. Create the target dir -------------------------------------------------
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# -- 3. Download both files via the Python API (no CLI, no PATH needed) --------
function Download-HFFile($repo, $file, $outDir) {
    $target = Join-Path $outDir $file
    if (Test-Path $target) { Write-Ok "$file already present - skipping"; return }
    Write-Step "Downloading $file"
    $py = @"
from huggingface_hub import hf_hub_download
p = hf_hub_download(repo_id=r'''$repo''', filename=r'''$file''', local_dir=r'''$outDir''')
print(p)
"@
    $py | python -
    if ($LASTEXITCODE -ne 0) { throw "Download failed for $file" }
    if (-not (Test-Path $target)) {
        $found = Get-ChildItem -Path $outDir -Recurse -Filter $file -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { Move-Item -Force $found.FullName $target }
    }
    if (-not (Test-Path $target)) { throw "$file not found at $target after download" }
    Write-Ok "Downloaded $file"
}

Download-HFFile $Repo $LlmFile    $OutDir
Download-HFFile $Repo $MmprojFile $OutDir

# -- 4. Pull the PINNED llama.cpp server image --------------------------------
Write-Step "Pulling pinned llama.cpp server image: $LlamaImage"
docker pull $LlamaImage
if ($LASTEXITCODE -ne 0) { throw "docker pull failed for $LlamaImage" }
Write-Ok "llama.cpp server image ready"

# -- 5. Summary ---------------------------------------------------------------
Write-Step "Done - Qwen3-VL-8B sidecar is ready"
Write-Host "Files in $OutDir :"
Get-ChildItem $OutDir -File | ForEach-Object { Write-Host ("   {0,-45} {1,8:N0} MB" -f $_.Name, ($_.Length/1MB)) }
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. (Optional) free RAM: docker compose stop qwen-vl"
Write-Host "  2. Deploy:              .\deployDockerFull.ps1"
Write-Host "  3. UI -> Configuration -> Default Engine -> 'Qwen3-VL-8B'"
Write-Host "  4. Verify:              docker compose logs -f qwen3vl"