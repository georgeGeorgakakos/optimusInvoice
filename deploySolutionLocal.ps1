# Optimus Invoice Automation - Full Local Deploy
# Handles: pnpm, node_modules, MySQL (Docker), .env, migrations, VLM, app
# Run from anywhere: .\deploySolutionLocal.ps1

$BASE = $PSScriptRoot

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Header { param($m)
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  $m" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
}
function Write-Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Write-Step { param($m) Write-Host "  -->   $m" -ForegroundColor White }
function Write-Fail { param($m) Write-Host "  [ERR] $m" -ForegroundColor Red }

# ─────────────────────────────────────────────────────────────────────────────
# STEP 0 — Preflight: Node, pnpm, Docker
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 0: Preflight checks"

# Node.js
try   { $nodeVer = node --version 2>&1; Write-Ok "Node.js $nodeVer" }
catch { Write-Fail "Node.js not found. Install from https://nodejs.org"; exit 1 }

# pnpm — install globally if missing
try {
    $pnpmVer = pnpm --version 2>&1
    Write-Ok "pnpm $pnpmVer"
} catch {
    Write-Warn "pnpm not found — installing globally..."
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to install pnpm"; exit 1 }
    Write-Ok "pnpm installed"
}

# Docker
try   { docker info 2>&1 | Out-Null; Write-Ok "Docker Desktop is running" }
catch { Write-Fail "Docker Desktop is not running. Please start it and retry."; exit 1 }

# Ensure shared Docker network exists (needed for vlm-service ↔ qwen-vl-service ↔ gemma-vl-service)
$netExists = docker network inspect optimus_ai_net 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Step "Creating Docker network optimus_ai_net..."
    docker network create optimus_ai_net | Out-Null
    Write-Ok "Network optimus_ai_net created"
} else {
    Write-Ok "Docker network optimus_ai_net already exists"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 0.5 — Pre-build Docker cleanup
# Removes dangling images (<none>:<none>) left over from previous deploys.
# When `docker build -t vlm-service` runs again, the previous vlm-service:latest
# image becomes "dangling" (loses its tag but keeps its layers). Over 10-20
# deploys that adds up to 50-100+ GB of wasted disk. This step keeps the slate
# clean.
#
# SAFE: prunes ONLY untagged images. Tagged images (mysql:8.0, base layers,
# etc.) are preserved — base images are required by FROM directives in our
# Dockerfiles and re-downloading them would cost ~10 min.
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 0.5: Pre-build Docker cleanup"

$dangling = docker images -f "dangling=true" -q
if ($dangling) {
    $danglingCount = ($dangling | Measure-Object).Count
    Write-Step "Found $danglingCount dangling image(s) from previous deploys — pruning..."
    $pruneOutput = docker image prune -f 2>&1 | Out-String
    # Parse "Total reclaimed space: X.XGB" from prune output if present
    $reclaimMatch = [regex]::Match($pruneOutput, 'Total reclaimed space:\s*(\S+)')
    if ($reclaimMatch.Success) {
        Write-Ok "Reclaimed $($reclaimMatch.Groups[1].Value) of disk space"
    } else {
        Write-Ok "Dangling images removed"
    }
} else {
    Write-Ok "No dangling images — disk is clean"
}

# Show current Docker disk usage (informational only — never fails the build)
$df = docker system df 2>&1 | Out-String
if ($df -match 'Images\s+\d+\s+\d+\s+(\S+)') {
    Write-Step "Current Docker images footprint: $($Matches[1])"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Install Node dependencies
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 1: Node.js dependencies"

Set-Location $BASE

if (-not (Test-Path "$BASE\node_modules")) {
    Write-Step "node_modules not found — running pnpm install..."
    pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "pnpm install failed"; exit 1 }
    Write-Ok "Dependencies installed"
} else {
    Write-Ok "node_modules already present — skipping install"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — MySQL via Docker
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 2: MySQL database"

$MYSQL_CONTAINER  = "optimus-mysql"
$MYSQL_ROOT_PASS  = "optimus123"
$MYSQL_DB         = "invoice_automation"
$MYSQL_PORT       = 3306

$mysqlRunning = docker inspect -f "{{.State.Running}}" $MYSQL_CONTAINER 2>$null

if ($mysqlRunning -eq "true") {
    Write-Ok "MySQL container '$MYSQL_CONTAINER' is already running"
} else {
    $mysqlExists = docker inspect $MYSQL_CONTAINER 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Step "Starting existing MySQL container..."
        docker start $MYSQL_CONTAINER | Out-Null
    } else {
        Write-Step "Creating MySQL container on port $MYSQL_PORT..."
        docker run -d `
            --name $MYSQL_CONTAINER `
            -e MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASS `
            -e MYSQL_DATABASE=$MYSQL_DB `
            -p "${MYSQL_PORT}:3306" `
            --restart unless-stopped `
            mysql:8.0
        if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to start MySQL container"; exit 1 }
    }

    Write-Step "Waiting for MySQL to be ready..."
    $maxWait  = 60
    $interval = 3
    $elapsed  = 0
    $dbReady  = $false

    while ($elapsed -lt $maxWait) {
        Start-Sleep -Seconds $interval
        $elapsed += $interval
        $result = docker exec $MYSQL_CONTAINER mysqladmin ping -uroot -p$MYSQL_ROOT_PASS --silent 2>$null
        if ($LASTEXITCODE -eq 0) {
            $dbReady = $true
            break
        }
        Write-Host "  ...waiting for MySQL ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
    }

    if (-not $dbReady) {
        Write-Fail "MySQL did not become ready in ${maxWait}s"
        Write-Warn "Check logs: docker logs $MYSQL_CONTAINER --tail 30"
        exit 1
    }

    Write-Ok "MySQL is ready"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Create .env if missing
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 3: Environment configuration (.env)"

$envFile = "$BASE\.env"

if (Test-Path $envFile) {
    Write-Ok ".env already exists — checking for required keys..."

    # Ensure VLM_ENGINE is present — add it if missing
    $envContent = Get-Content $envFile -Raw
    if ($envContent -notmatch 'VLM_ENGINE') {
        Write-Step "Adding VLM_ENGINE=surya to .env..."
        Add-Content -Path $envFile -Value "`n# ── VLM Engine (surya | qwen_vl_local | gemma_vl_local) ────`nVLM_ENGINE=surya"
        Write-Ok "VLM_ENGINE added"
    } else {
        $currentEngine = [regex]::Match($envContent, 'VLM_ENGINE\s*=\s*(\S+)').Groups[1].Value
        Write-Ok "VLM_ENGINE=$currentEngine"
    }

    # Ensure BUSINESS_PORTAL_API_KEY placeholder is present (do not overwrite a real key)
    if ($envContent -notmatch 'BUSINESS_PORTAL_API_KEY') {
        Write-Step "Adding BUSINESS_PORTAL_API_KEY placeholder to .env..."
        Add-Content -Path $envFile -Value "`n# ── Business Portal (GEMI) Open Data API ─────────────────────`n# Register at https://opendata.businessportal.gr/register/ to get a key`nBUSINESS_PORTAL_API_KEY="
        Write-Ok "BUSINESS_PORTAL_API_KEY placeholder added — fill it in to enable ΑΦΜ auto-fill"
    }
} else {
    Write-Step "Generating .env file..."

    $jwtSecret = node -e "process.stdout.write(require('crypto').randomBytes(64).toString('hex'))"

    $envContent = @"
# ── Database ────────────────────────────────────────────────
DATABASE_URL="mysql://root:${MYSQL_ROOT_PASS}@localhost:${MYSQL_PORT}/${MYSQL_DB}"

# ── Security ────────────────────────────────────────────────
JWT_SECRET="${jwtSecret}"

# ── App ─────────────────────────────────────────────────────
NODE_ENV="development"
PORT=3000

# ── VLM Service ─────────────────────────────────────────────
VLM_SERVICE_URL="http://localhost:8300"

# ── VLM Engine (surya | qwen_vl_local | gemma_vl_local) ──
VLM_ENGINE=surya

# ── Business Portal (GEMI) Open Data API ────────────────────
# Register at https://opendata.businessportal.gr/register/ for an API key.
# Enables ΑΦΜ auto-fill in the Client Profile UI.
BUSINESS_PORTAL_API_KEY=

# ── ERP credentials are configured inside the app ───────────
# (Configuration page at http://localhost:3000/configuration)
"@

    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    Write-Ok ".env created with auto-generated JWT secret"
    Write-Warn "ERP credentials must be set via the app's Configuration page"
    Write-Warn "BUSINESS_PORTAL_API_KEY is empty — set it to enable ΑΦΜ auto-fill"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Run database migrations
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 4: Database migrations"

Set-Location $BASE

Write-Step "Running pnpm db:push..."
pnpm db:push
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Database migration failed"
    Write-Warn "Check that DATABASE_URL in .env is correct and MySQL is reachable"
    exit 1
}
Write-Ok "Migrations applied successfully"

# ── Seed default configuration (vlmEngine=surya) ─────────────────────────────
# Ensures the engine is always surya after every deploy, regardless of what
# was previously saved in the database.
Write-Step "Seeding default engine configuration (vlmEngine=surya)..."
$seedSql = @"
INSERT INTO configuration (userId, settingsJson, createdAt, updatedAt)
SELECT 1, '{"vlmEngine":"surya","useNativeText":false}', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM configuration WHERE userId = 1)
ON DUPLICATE KEY UPDATE
  settingsJson = JSON_SET(COALESCE(settingsJson, '{}'), '$.vlmEngine', 'surya'),
  updatedAt = NOW();
"@
$seedSql | docker exec -i optimus-mysql mysql -uroot -poptimus123 invoice_automation 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Default engine set to surya"
} else {
    Write-Warn "Could not seed engine config — set manually in Configuration page"
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Rebuild VLM Docker containers (vlm-service + qwen-vl-service + gemma-vl-service)
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 5a: VLM Docker container (Surya + transformers==4.46.3)"

Write-Step "Syncing Python files into build context..."
Copy-Item -Force "$BASE\server\python\vlm_service.py"        "$BASE\vlm-service\app.py"
Copy-Item -Force "$BASE\server\python\vlm_invoice_parser.py" "$BASE\vlm-service\vlm_invoice_parser.py"
Copy-Item -Force "$BASE\server\python\semantic_extractor.py" "$BASE\vlm-service\semantic_extractor.py"
Copy-Item -Force "$BASE\server\python\vision_validator.py"   "$BASE\vlm-service\vision_validator.py"
Copy-Item -Force "$BASE\server\python\mydata_fields.py"   "$BASE\vlm-service\mydata_fields.py"
Copy-Item -Force "$BASE\server\python\client_profile.py"  "$BASE\vlm-service\client_profile.py"
Copy-Item -Force "$BASE\server\python\dispatch_fields.py" "$BASE\vlm-service\dispatch_fields.py"
# ── Verify sync ──────────────────────────────────────────────────────────────
function Get-FileHash256 { param($path)
return (Get-FileHash -Path $path -Algorithm SHA256).Hash
}

$srcAppHash    = Get-FileHash256 "$BASE\server\python\vlm_service.py"
$dstAppHash    = Get-FileHash256 "$BASE\vlm-service\app.py"
$srcParserHash = Get-FileHash256 "$BASE\server\python\vlm_invoice_parser.py"
$dstParserHash = Get-FileHash256 "$BASE\vlm-service\vlm_invoice_parser.py"
$srcSemHash    = Get-FileHash256 "$BASE\server\python\semantic_extractor.py"
$dstSemHash    = Get-FileHash256 "$BASE\vlm-service\semantic_extractor.py"

if ($srcAppHash -ne $dstAppHash) {
    Write-Fail "SYNC FAILED: app.py does not match server\python\vlm_service.py"; exit 1
}
Write-Ok "app.py verified ($((Get-Item "$BASE\vlm-service\app.py").Length) bytes, SHA256 match)"

if ($srcParserHash -ne $dstParserHash) {
    Write-Fail "SYNC FAILED: vlm_invoice_parser.py hashes do not match"; exit 1
}
Write-Ok "vlm_invoice_parser.py verified ($((Get-Item "$BASE\vlm-service\vlm_invoice_parser.py").Length) bytes, SHA256 match)"

if ($srcSemHash -ne $dstSemHash) {
    Write-Fail "SYNC FAILED: semantic_extractor.py hashes do not match"; exit 1
}
Write-Ok "semantic_extractor.py verified ($((Get-Item "$BASE\vlm-service\semantic_extractor.py").Length) bytes, SHA256 match)"

# ── Smoke tests ──────────────────────────────────────────────────────────────
$appContent    = Get-Content "$BASE\vlm-service\app.py" -Raw
$parserContent = Get-Content "$BASE\vlm-service\vlm_invoice_parser.py" -Raw
$semContent    = Get-Content "$BASE\vlm-service\semantic_extractor.py" -Raw
if ($appContent.Length -lt 1000)                    { Write-Fail "SMOKE TEST: app.py too small";            exit 1 }
if ($appContent -notmatch "extract.pdf")             { Write-Fail "SMOKE TEST: missing /extract-pdf";        exit 1 }
if ($appContent -notmatch "semantic_extractor")      { Write-Fail "SMOKE TEST: missing semantic_extractor";  exit 1 }
if ($appContent -notmatch "gemma_vl_local")          { Write-Fail "SMOKE TEST: missing gemma_vl_local dispatcher"; exit 1 }
if ($parserContent.Length -lt 1000)                 { Write-Fail "SMOKE TEST: vlm_invoice_parser too small"; exit 1 }
# Validation pass — newer semantic_extractor.py adds _validate_extraction() that
# catches hallucinated VAT numbers, swaps recipient name ↔ contactPerson, flags
# reconciliation issues. Missing this = degraded extraction quality, not fatal.
if ($semContent -notmatch '_validate_extraction') {
    Write-Warn "SMOKE TEST: semantic_extractor.py is missing _validate_extraction() — extraction quality will be degraded"
} else {
    Write-Ok "Validation pass present in semantic_extractor.py"
}
Write-Ok "Smoke tests passed"

# ── Vision-validator wiring guard ────────────────────────────────────────────
# Three things must line up or the validator silently never runs (or the
# container crashes at startup): app.py must call it, the module must be in the
# build context, and vlm-service\Dockerfile must COPY it into the image.
$dockerfileContent = Get-Content "$BASE\vlm-service\Dockerfile" -Raw
if ($appContent -match 'validate_vision_extraction') {
    if (-not (Test-Path "$BASE\vlm-service\vision_validator.py")) {
        Write-Fail "app.py calls the validator but vision_validator.py is missing from the build context"; exit 1
    }
    if ($dockerfileContent -notmatch 'COPY\s+vision_validator\.py') {
        Write-Fail "vlm-service\Dockerfile does NOT 'COPY vision_validator.py' — container will crash with ModuleNotFoundError at startup"
        Write-Warn "Add near the other COPY *.py lines in vlm-service\Dockerfile:  COPY vision_validator.py ."
        exit 1
    }
    Write-Ok "Vision validator wired correctly (app calls it, module present, Dockerfile copies it)"
} else {
    Write-Warn "app.py (vlm_service.py) does NOT call validate_vision_extraction — qwen/gemma outputs will NOT be reconciliation-checked"
}

# ── Surya offline-weights guard ──────────────────────────────────────────────
# vlm-service runs offline (HF_HUB_OFFLINE=1) with HF_HOME=/models (model_cache
# mount). Surya loads vikp/surya_det3 + vikp/surya_rec2 from /models/hub. Without
# those weights Surya fails at startup and scanned PDFs can't be OCR'd (digital
# PDFs still work via pdfplumber). Warn — don't fail — native-text is unaffected.
$suryaDetCache = "$BASE\model_cache\hub\models--vikp--surya_det3"
$suryaRecCache = "$BASE\model_cache\hub\models--vikp--surya_rec2"
if ((Test-Path $suryaDetCache) -and (Test-Path $suryaRecCache)) {
    Write-Ok "Surya weights present in model_cache\hub — Surya will run offline for scanned PDFs"
} else {
    Write-Warn "Surya weights NOT in model_cache\hub (vikp/surya_det3 + surya_rec2)."
    Write-Warn "Scanned PDFs will FAIL in Surya (offline). Digital PDFs still work via pdfplumber."
    Write-Warn "Fix: run .\Download-VlmWheels.ps1 (step 9/9 downloads the Surya weights)."
}

# ── Offline wheels check ─────────────────────────────────────────────────────
$wheelsOk = (Test-Path "$BASE\vlm-service\wheels\torch") -and `
            (Test-Path "$BASE\vlm-service\wheels\transformers") -and `
            (Test-Path "$BASE\vlm-service\wheels\surya") -and `
            (Test-Path "$BASE\vlm-service\wheels\requirements")
if (-not $wheelsOk) {
    Write-Warn "Offline wheels not found — Docker build will download from internet."
    Write-Warn "Run .\Download-VlmWheels.ps1 once to avoid this."
} else {
    Write-Ok "Offline wheels found — build will not need the internet"
}

Write-Step "Stopping old VLM container..."
docker rm -f vlm-service 2>&1 | Out-Null

Write-Step "Building vlm-service image (Surya + transformers==4.46.3)..."
$vlmDir        = "$BASE\vlm-service"
$vlmDockerfile = "$vlmDir\Dockerfile"
if (-not (Test-Path $vlmDockerfile)) { Write-Fail "vlm-service\Dockerfile not found"; exit 1 }
Write-Step "Using Dockerfile: $vlmDockerfile ($((Get-Item $vlmDockerfile).Length) bytes)"
docker build --no-cache -t vlm-service --file $vlmDockerfile $vlmDir
if ($LASTEXITCODE -ne 0) { Write-Fail "vlm-service Docker build FAILED"; exit 1 }

Write-Step "Starting vlm-service container on port 8300..."
# Client-profile mount is read-WRITE (NO :ro) so the Node process can write
# updated profiles via the clientProfile.upsert tRPC mutation. client_profile.py
# in the container watches the file's mtime and auto-reloads on change.
#
# Port mapping: 8300:8100 — vlm-service/Dockerfile uses `ENV PORT=8100` +
# `CMD ["python", "app.py"]`. app.py reads PORT from env (default 8100) and
# starts uvicorn on that port. Container listens internally on 8100; host
# port 8300 maps to it. DO NOT change this to 8300:8300 unless you also
# change vlm-service/Dockerfile (`ENV PORT=8300`).
docker run -d `
    --name vlm-service `
    --network optimus_ai_net `
    -p 8300:8100 `
    -v "$BASE\model_cache:/models" `
    -v vlm-cache:/root/.cache `
    -v llama-models:/root/.cache/llama `
    -v "${BASE}\data\client_profiles:/app/data/client_profiles" `
    --memory=20g `
    -e LLAMA_N_THREADS=10 `
    -e LLAMA_N_CTX=4096 `
    -e LLAMA_N_BATCH=512 `
    -e SEMANTIC_TIMEOUT=120 `
    -e QWEN_VL_SERVICE_URL=http://optimus_qwen_vl:8400 `
    -e GEMMA_VL_SERVICE_URL=http://optimus_gemma_vl:8500 `
    -e OPTIMUS_CLIENT_PROFILE=/app/data/client_profiles/metro.json `
    -e HF_HOME=/models `
    -e HF_HUB_OFFLINE=1 `
    vlm-service
if ($LASTEXITCODE -ne 0) { Write-Fail "vlm-service Docker run FAILED"; exit 1 }

# Poll vlm-service /health
Write-Step "Waiting for vlm-service to start..."
$maxWait = 300; $interval = 5; $elapsed = 0; $ready = $false
while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds $interval; $elapsed += $interval
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8300/health" -TimeoutSec 3 -ErrorAction Stop
        if ($resp.status -eq "ok") {
            Write-Ok "vlm-service healthy! Loaded: $($resp.loaded_models -join ', ')"
            $ready = $true; break
        }
    } catch {
        Write-Host "  ...waiting for vlm-service ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
    }
}
if (-not $ready) { Write-Fail "vlm-service did not become healthy in ${maxWait}s"; Write-Warn "docker logs vlm-service --tail 50"; exit 1 }

# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 5b: Qwen2.5-VL-3B container (transformers>=4.52)"

# ── Sync qwen_vl files ───────────────────────────────────────────────────────
Write-Step "Syncing Qwen VL files into build context..."
$qwenBuildDir = "$BASE\qwen-vl-service"
if (-not (Test-Path $qwenBuildDir)) { New-Item -ItemType Directory -Force -Path $qwenBuildDir | Out-Null }

Copy-Item -Force "$BASE\server\python\qwen_vl_engine.py"  "$qwenBuildDir\qwen_vl_engine.py"
Copy-Item -Force "$BASE\server\python\qwen_vl_service.py" "$qwenBuildDir\qwen_vl_service.py"
Copy-Item -Force "$BASE\Dockerfile.qwen_vl"                 "$qwenBuildDir\Dockerfile"

# Copy shared wheels (torch + qwen_vl + requirements) into qwen build context
$qwenWheelsDir = "$qwenBuildDir\wheels"
if (-not (Test-Path $qwenWheelsDir)) { New-Item -ItemType Directory -Force -Path $qwenWheelsDir | Out-Null }
if (Test-Path "$BASE\vlm-service\wheels\torch") {
    Copy-Item -Force -Recurse "$BASE\vlm-service\wheels\torch" "$qwenWheelsDir\torch"
}
if (Test-Path "$BASE\vlm-service\wheels\requirements") {
    Copy-Item -Force -Recurse "$BASE\vlm-service\wheels\requirements" "$qwenWheelsDir\requirements"
}
if (Test-Path "$BASE\vlm-service\wheels\qwen_vl") {
    Copy-Item -Force -Recurse "$BASE\vlm-service\wheels\qwen_vl" "$qwenWheelsDir\qwen_vl"
}
if (Test-Path "$BASE\vlm-service\wheels\transformers") {
    Copy-Item -Force -Recurse "$BASE\vlm-service\wheels\transformers" "$qwenWheelsDir\transformers"
}
Write-Ok "Qwen VL build context ready at $qwenBuildDir"

# ── Check model cache ────────────────────────────────────────────────────────
$modelCacheDir = "$BASE\model_cache\hub\models--Qwen--Qwen2.5-VL-3B-Instruct"
if (Test-Path $modelCacheDir) {
    Write-Ok "Qwen2.5-VL-3B model cache found — will load from disk"
} else {
    Write-Warn "Qwen2.5-VL-3B model not cached locally."
    Write-Warn "Run .\Download-VlmWheels.ps1 to pre-download (~7.3 GB)."
    Write-Warn "Without the cache, first request will download from HuggingFace (~30 min)."
}

Write-Step "Stopping old qwen-vl-service container..."
docker rm -f optimus_qwen_vl 2>&1 | Out-Null

Write-Step "Building qwen-vl-service image (Qwen2.5-VL-3B + transformers>=4.52)..."
docker build --no-cache -t qwen-vl-service --file "$qwenBuildDir\Dockerfile" $qwenBuildDir
if ($LASTEXITCODE -ne 0) { Write-Fail "qwen-vl-service Docker build FAILED"; exit 1 }

Write-Step "Starting qwen-vl-service container on port 8400..."
# Ensure model_cache exists for bind mount
New-Item -ItemType Directory -Force -Path "$BASE\model_cache" | Out-Null
docker run -d `
    --name optimus_qwen_vl `
    --network optimus_ai_net `
    -p 8400:8400 `
    -v "$BASE\model_cache:/models" `
    --memory=20g `
    -e QWEN_VL_LOCAL_MODEL=Qwen/Qwen2.5-VL-3B-Instruct `
    -e HF_HOME=/models `
    -e TRANSFORMERS_CACHE=/models `
    -e HF_HUB_OFFLINE=1 `
    -e PORT=8400 `
    -e QWEN_VL_DPI=72 `
    qwen-vl-service
if ($LASTEXITCODE -ne 0) { Write-Fail "qwen-vl-service Docker run FAILED"; exit 1 }

Write-Step "Waiting for qwen-vl-service HTTP to come up..."
$maxWait = 60; $interval = 5; $elapsed = 0; $httpReady = $false
while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds $interval; $elapsed += $interval
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8400/health" -TimeoutSec 3 -ErrorAction Stop
        if ($resp.status -eq "ok") {
            Write-Ok "qwen-vl-service is up (HTTP ready)"
            $httpReady = $true; break
        }
    } catch {
        Write-Host "  ...waiting for qwen-vl-service ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
    }
}
if (-not $httpReady) {
    Write-Warn "qwen-vl-service did not respond. Check: docker logs optimus_qwen_vl --tail 20"
}

# Now wait for Qwen2.5-VL-3B weights to finish loading into memory (~120-150s)
Write-Step "Waiting for Qwen2.5-VL-3B model weights to load into memory (~120s)..."
Write-Host "  You can watch live progress with: docker logs -f optimus_qwen_vl" -ForegroundColor DarkGray
$maxWait = 600; $interval = 10; $elapsed = 0; $modelReady = $false
while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds $interval; $elapsed += $interval
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8400/health" -TimeoutSec 3 -ErrorAction Stop
        if ($resp.ready -eq $true) {
            Write-Host ""
            Write-Host "  ============================================" -ForegroundColor Green
            Write-Host "  Qwen2.5-VL-3B model fully loaded and ready!" -ForegroundColor Green
            Write-Host "  ============================================" -ForegroundColor Green
            Write-Host ""
            $modelReady = $true; break
        } else {
            $loadingStatus = if ($resp.loading) { "loading weights..." } else { "waiting..." }
            Write-Host "  ...Qwen2.5-VL-3B $loadingStatus ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  ...waiting ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
    }
}
if (-not $modelReady) {
    Write-Warn "Qwen2.5-VL-3B model is still loading in background (this is normal on first start)."
    Write-Warn "Monitor with: docker logs -f optimus_qwen_vl"
    Write-Warn "The qwen_vl_local engine will work once loading completes."
}

# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 5c: Gemma 3 4B-it container (llama.cpp/GGUF Q4_K_M) [NEW]"

# Sync gemma_vl files into a dedicated build context
Write-Step "Syncing Gemma VL files into build context..."
$gemmaBuildDir = "$BASE\gemma-vl-service"
if (-not (Test-Path $gemmaBuildDir)) { New-Item -ItemType Directory -Force -Path $gemmaBuildDir | Out-Null }

Copy-Item -Force "$BASE\server\python\gemma_vl_engine.py"  "$gemmaBuildDir\gemma_vl_engine.py"
Copy-Item -Force "$BASE\server\python\gemma_vl_service.py" "$gemmaBuildDir\gemma_vl_service.py"
Copy-Item -Force "$BASE\Dockerfile.gemma_vl"                "$gemmaBuildDir\Dockerfile"
Write-Ok "Gemma VL build context ready at $gemmaBuildDir"

# Hash verify
$srcEngHash = Get-FileHash256 "$BASE\server\python\gemma_vl_engine.py"
$dstEngHash = Get-FileHash256 "$gemmaBuildDir\gemma_vl_engine.py"
if ($srcEngHash -ne $dstEngHash) { Write-Fail "SYNC FAILED: gemma_vl_engine.py hash mismatch"; exit 1 }
Write-Ok "gemma_vl_engine.py verified (SHA256 match)"

# Copy shared wheels into gemma build context (mirror Qwen STEP 5b pattern).
# Gemma uses llama.cpp backend — needs torch/Pillow, llama-cpp-python source,
# and requirements (fastapi/uvicorn/pdf2image/huggingface-hub).
# Gemma also needs wheels/llama (llama-cpp-python source tarball + build deps).
Write-Step "Copying offline wheels into gemma build context..."
$gemmaWheelsDir = "$gemmaBuildDir\wheels"
if (-not (Test-Path $gemmaWheelsDir)) { New-Item -ItemType Directory -Force -Path $gemmaWheelsDir | Out-Null }

$missingWheels = @()
foreach ($w in @("torch", "llama", "requirements")) {
    $src = "$BASE\vlm-service\wheels\$w"
    $dst = "$gemmaWheelsDir\$w"
    if (Test-Path $src) {
        # Re-copy fresh each deploy (idempotent, ~3s)
        if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
        Copy-Item -Force -Recurse $src $dst
    } else {
        $missingWheels += $w
    }
}

if ($missingWheels.Count -gt 0) {
    Write-Fail "Missing wheel folders: $($missingWheels -join ', ')"
    Write-Warn "Run .\Download-VlmWheels.ps1 first to populate vlm-service\wheels\"
    exit 1
}
Write-Ok "Wheels copied: torch + llama + requirements (Gemma uses llama.cpp backend)"

# Verify llama-cpp-python wheel is present (Gemma uses llama.cpp backend).
$llamaWheel = Get-ChildItem "$gemmaWheelsDir\llama" -Filter "llama_cpp_python*" -ErrorAction SilentlyContinue
if (-not $llamaWheel) {
    # Also try the source tarball form
    $llamaWheel = Get-ChildItem "$gemmaWheelsDir\llama" -Filter "llama-cpp-python*" -ErrorAction SilentlyContinue
}
if (-not $llamaWheel) {
    Write-Fail "llama-cpp-python wheel missing from wheels\llama\"
    Write-Warn "Required for Gemma 3 GGUF/llama.cpp backend."
    Write-Warn "Fix: run .\Download-VlmWheels.ps1 (Step 5 downloads llama-cpp-python)."
    exit 1
}
Write-Ok "llama-cpp-python wheel found: $($llamaWheel.Name)"

# Check Gemma 3 GGUF model cache (~3.3 GB — Q4_K_M + mmproj)
$gemmaCacheDir = "$BASE\model_cache\hub\models--ggml-org--gemma-3-4b-it-GGUF"
$gemmaCached = Test-Path $gemmaCacheDir

# Read HF_TOKEN from .env (only needed if cache missing and we want to download at runtime)
$envContentFinal = Get-Content "$BASE\.env" -Raw
$hfToken = ""
$hfTokenMatch = [regex]::Match($envContentFinal, 'HF_TOKEN\s*=\s*(\S+)')
if ($hfTokenMatch.Success) { $hfToken = $hfTokenMatch.Groups[1].Value }

# ── Offline-first decision tree ─────────────────────────────────────────────
# CASE A: cache exists                → strict offline (no HF traffic, no token)
# CASE B: cache missing, HF_TOKEN set → fallback to runtime download
# CASE C: cache missing, no HF_TOKEN  → fail clearly, point to Download-VlmWheels.ps1
if ($gemmaCached) {
    Write-Ok "Gemma 3 GGUF model cache found — running OFFLINE (HF_HUB_OFFLINE=1)"
    $hfOffline = "1"
    $tokenForContainer = ""    # Not needed when offline — container won't make HF calls
} elseif ($hfToken) {
    Write-Warn "Gemma 3 GGUF model NOT cached locally (~3.3 GB)."
    Write-Warn "Container will download at runtime (~10 min). Then it will be cached."
    Write-Warn "For pre-download (recommended): stop here, run .\Download-VlmWheels.ps1, re-run this script."
    $hfOffline = "0"
    $tokenForContainer = $hfToken
} else {
    Write-Fail "Gemma 3 GGUF not cached AND HF_TOKEN missing from .env."
    Write-Warn ""
    Write-Warn "This system is configured to run fully OFFLINE. Required setup:"
    Write-Warn "  1. Accept license:  https://huggingface.co/google/gemma-3-4b-it"
    Write-Warn "  2. Create token:    https://huggingface.co/settings/tokens (Read permission)"
    Write-Warn "  3. Add to .env:     HF_TOKEN=hf_xxxxxxxxxxxxx"
    Write-Warn "  4. Run:             .\Download-VlmWheels.ps1 (downloads ~3.3 GB GGUF once)"
    Write-Warn "  5. Re-run:          .\deploySolutionLocal.ps1"
    Write-Warn ""
    Write-Warn "Alternative: add HF_TOKEN to .env and re-run this script to download at runtime."
    exit 1
}

Write-Step "Stopping old gemma-vl-service container..."
docker rm -f optimus_gemma_vl 2>&1 | Out-Null

Write-Step "Building gemma-vl-service image (Gemma 3 4B-it GGUF Q4_K_M via llama.cpp)..."
docker build --no-cache -t gemma-vl-service --file "$gemmaBuildDir\Dockerfile" $gemmaBuildDir
if ($LASTEXITCODE -ne 0) { Write-Fail "gemma-vl-service Docker build FAILED"; exit 1 }

if ($gemmaCached) {
    Write-Step "Starting gemma-vl-service container on port 8500 (OFFLINE mode)..."
} else {
    Write-Step "Starting gemma-vl-service container on port 8500 (will download at runtime)..."
}
# ── Performance tuning rationale (CPU-only, 12 cores, 64GB RAM) ─────────────
# LLAMA_N_CTX=4096      : context window. Invoice prompt + image tokens +
#                         output can run ~3000 tokens for complex invoices
#                         (10+ line items). 2048 was too tight — caused
#                         JSON truncation on real Fiverr-style PDFs.
# LLAMA_N_THREADS=10    : 10 of 12 physical cores. Leaves 2 for Surya/OS.
# LLAMA_N_BATCH=512     : tokens processed per batch — well-tuned for CPU.
# GEMMA_MAX_NEW_TOKENS=1024 : output cap. Typical invoice JSON is 600-900
#                            tokens but complex multi-line-item invoices
#                            need ~1200. 512 was too tight and truncated
#                            output mid-key.
docker run -d `
    --name optimus_gemma_vl `
    --network optimus_ai_net `
    -p 8500:8500 `
    -v "$BASE\model_cache:/models" `
    --memory=20g `
    -e GEMMA_VL_REPO_ID=ggml-org/gemma-3-4b-it-GGUF `
    -e GEMMA_VL_MODEL_FILE=gemma-3-4b-it-Q4_K_M.gguf `
    -e GEMMA_VL_MMPROJ_FILE=mmproj-model-f16.gguf `
    -e HF_HOME=/models `
    -e TRANSFORMERS_CACHE=/models `
    -e HF_HUB_OFFLINE=$hfOffline `
    -e HF_TOKEN=$tokenForContainer `
    -e PORT=8500 `
    -e LLAMA_N_THREADS=10 `
    -e LLAMA_N_CTX=4096 `
    -e LLAMA_N_BATCH=512 `
    -e GEMMA_MAX_NEW_TOKENS=1024 `
    -e GEMMA_VL_DPI=72 `
    gemma-vl-service
if ($LASTEXITCODE -ne 0) { Write-Fail "gemma-vl-service Docker run FAILED"; exit 1 }

Write-Step "Waiting for gemma-vl-service HTTP to come up..."
$maxWait = 60; $interval = 5; $elapsed = 0; $httpReady = $false
while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds $interval; $elapsed += $interval
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8500/health" -TimeoutSec 3 -ErrorAction Stop
        if ($resp.status -eq "ok") {
            Write-Ok "gemma-vl-service is up (HTTP ready)"
            $httpReady = $true; break
        }
    } catch {
        Write-Host "  ...waiting for gemma-vl-service ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
    }
}
if (-not $httpReady) {
    Write-Warn "gemma-vl-service did not respond. Check: docker logs optimus_gemma_vl --tail 30"
}

Write-Step "Gemma 3 4B-it weights load in background (~90s on warm cache, ~25min on cold cache)..."
Write-Host "  Watch progress with: docker logs -f optimus_gemma_vl" -ForegroundColor DarkGray
$maxWait = 600; $interval = 10; $elapsed = 0; $modelReady = $false
while ($elapsed -lt $maxWait) {
    Start-Sleep -Seconds $interval; $elapsed += $interval
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8500/health" -TimeoutSec 3 -ErrorAction Stop
        if ($resp.ready -eq $true) {
            Write-Host ""
            Write-Host "  ============================================" -ForegroundColor Green
            Write-Host "  Gemma 3 4B-it model fully loaded and ready!" -ForegroundColor Green
            Write-Host "  ============================================" -ForegroundColor Green
            Write-Host ""
            $modelReady = $true; break
        } else {
            $loadingStatus = if ($resp.loading) { "loading weights..." } else { "waiting..." }
            Write-Host "  ...Gemma 3 $loadingStatus ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  ...waiting ($elapsed`s / $maxWait`s)" -ForegroundColor DarkGray
    }
}
if (-not $modelReady) {
    Write-Warn "Gemma 3 model still loading in background (normal on first start with cold cache)."
    Write-Warn "Monitor with: docker logs -f optimus_gemma_vl"
    Write-Warn "The gemma_vl_local engine will work once loading completes."
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5d — Post-build Docker cleanup
# After `docker build --no-cache -t <name>` runs three times above, the
# previous vlm-service / qwen-vl-service / gemma-vl-service images have lost
# their tags and become dangling (<none>:<none>). Each rebuild can leave 3-10
# GB of orphaned layers. Prune them now to keep the disk lean.
#
# SAFE: only removes images with no tag and not used by any running container.
# Tagged base images (mysql:8.0, python:3.11-slim, etc.) and freshly-built
# vlm-service:latest / qwen-vl-service:latest / gemma-vl-service:latest are
# untouched.
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 5d: Post-build Docker cleanup"

$dangling = docker images -f "dangling=true" -q
if ($dangling) {
    $danglingCount = ($dangling | Measure-Object).Count
    Write-Step "Found $danglingCount dangling image(s) created by this deploy — pruning..."
    $pruneOutput = docker image prune -f 2>&1 | Out-String
    $reclaimMatch = [regex]::Match($pruneOutput, 'Total reclaimed space:\s*(\S+)')
    if ($reclaimMatch.Success) {
        Write-Ok "Reclaimed $($reclaimMatch.Groups[1].Value) of disk space"
    } else {
        Write-Ok "Dangling images removed"
    }
} else {
    Write-Ok "No dangling images created — disk usage stable"
}

# ── Final disk usage report ──────────────────────────────────────────────────
# Shows the user where Docker's bytes are going. Pure informational, no failures.
Write-Step "Docker disk usage after deploy:"
$df = docker system df 2>&1 | Out-String
# Print the table with each line indented for readability
foreach ($line in ($df -split "`n")) {
    if ($line.Trim()) { Write-Host "    $line" -ForegroundColor DarkGray }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — Start the app
# ─────────────────────────────────────────────────────────────────────────────
Write-Header "STEP 6: Starting the app"

Set-Location $BASE

# Read the current VLM_ENGINE from .env to show in summary
$envFinal     = Get-Content "$BASE\.env" -Raw
$engineInUse  = [regex]::Match($envFinal, 'VLM_ENGINE\s*=\s*(\S+)').Groups[1].Value
if (-not $engineInUse) { $engineInUse = "surya (default)" }

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  DONE — app starting on http://localhost:3000" -ForegroundColor Green
Write-Host "  MySQL    : localhost:$MYSQL_PORT  (db: $MYSQL_DB)" -ForegroundColor Green
Write-Host "  VLM      : http://localhost:8300/health  (Surya + pdfplumber + dispatcher)" -ForegroundColor Green
Write-Host "  QwenVL   : http://localhost:8400/health  (Qwen2.5-VL-3B vision)" -ForegroundColor Green
Write-Host "  GemmaVL  : http://localhost:8500/health  (Gemma 3 4B-it vision)  [NEW]" -ForegroundColor Green
Write-Host "  Engine   : $engineInUse" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""

pnpm dev