# Start-Optimus.ps1
# Usage:
#   .\Start-Optimus.ps1              - App + VLM (Surya/Marker) via Docker
#   .\Start-Optimus.ps1 -WithVllm   - Also start vLLM (olmOCR + Qwen2.5-VL)
#   .\Start-Optimus.ps1 -InstallDeps - Install Python deps then start (no-Docker fallback)

param(
    [switch]$WithVllm,
    [switch]$InstallDeps,
    [string]$ProjectRoot = "C:\Users\georg\WebstormProjects\optimusInvoice"
)

$ErrorActionPreference = "Stop"

function Write-Header { param($m) Write-Host "" ; Write-Host "  $m" -ForegroundColor Cyan }
function Write-Ok     { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Write-Warn   { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Write-Step   { param($m) Write-Host "  -->   $m" -ForegroundColor White }
function Write-Fatal  { param($m) Write-Host "  [ERR] $m" -ForegroundColor Red ; exit 1 }

$PythonDir  = Join-Path $ProjectRoot "server\python"
$LogDir     = Join-Path $ProjectRoot "logs"
$AppLog     = Join-Path $LogDir "app.log"
$VlmLog     = Join-Path $LogDir "vlm_service.log"
$ModelCache = Join-Path $ProjectRoot "model_cache"
$AppPort    = 3000
$VlmPort    = 8300

if (-not (Test-Path $LogDir))     { New-Item -ItemType Directory -Path $LogDir     | Out-Null }
if (-not (Test-Path $ModelCache)) { New-Item -ItemType Directory -Path $ModelCache | Out-Null }

Write-Host ""
Write-Host "  +---------------------------------------+" -ForegroundColor DarkCyan
Write-Host "  |      Optimus -- Service Launcher      |" -ForegroundColor DarkCyan
Write-Host "  +---------------------------------------+" -ForegroundColor DarkCyan


Write-Host "# Normal daily start (uses existing Docker image — fast):" -ForegroundColor DarkCyan
Write-Host ".\OptimusInvoice.ps1" -ForegroundColor DarkCyan

Write-Host "# After changing Dockerfile.vlm or vlm_service.py (rebuilds image):" -ForegroundColor DarkCyan
Write-Host ".\OptimusInvoice.ps1 -Rebuild" -ForegroundColor DarkCyan

Write-Host "# Start with vLLM too (olmOCR + Qwen2.5-VL):" -ForegroundColor DarkCyan
Write-Host ".\OptimusInvoice.ps1 -WithVllm" -ForegroundColor DarkCyan

# ============================================================
#  STEP 0 - Preflight checks
# ============================================================
Write-Header "Preflight checks"

if (-not (Test-Path $ProjectRoot)) {
    Write-Fatal "Project root not found: $ProjectRoot"
}

# Find Python
$PythonCmd = $null
foreach ($cmd in @("python", "py", "python3")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python") {
            $PythonCmd = $cmd
            break
        }
    } catch { }
}
if ($null -eq $PythonCmd) {
    Write-Fatal "Python not found. Install from python.org and add to PATH."
}
Write-Ok "Python: $PythonCmd"

# Find Node
try { $null = node --version } catch { Write-Fatal "Node.js not found." }

# Find pnpm or npm
$Pkg = "pnpm"
try { $null = pnpm --version } catch {
    $Pkg = "npm"
    Write-Warn "pnpm not found, falling back to npm"
}
Write-Ok "Package manager: $Pkg"

# Check Docker
$UseDocker = $false
try {
    $null = docker info 2>&1
    $UseDocker = $true
    Write-Ok "Docker Desktop: running"
} catch {
    Write-Warn "Docker Desktop not running. VLM will run as a Python process."
}


# ============================================================
#  STEP 1 - Install Python deps (only when not using Docker)
# ============================================================
if ($InstallDeps -and (-not $UseDocker)) {
    Write-Header "Installing Python dependencies"
    & $PythonCmd -m pip install --upgrade pip --quiet
    & $PythonCmd -m pip install `
        fastapi `
        "uvicorn[standard]" `
        httpx `
        python-multipart `
        Pillow `
        torch `
        "transformers==4.46.3" `
        surya-ocr `
        marker-pdf `
        pdf2image `
        accelerate `
        safetensors `
        --quiet
    Write-Ok "Python deps installed"
}


# ============================================================
#  STEP 2 - Free up ports
# ============================================================
Write-Header "Clearing ports $VlmPort and $AppPort"

function Stop-Port {
    param([int]$Port)
    $lines = netstat -ano 2>$null | Select-String ":$Port\s"
    foreach ($line in $lines) {
        $parts = ($line.ToString() -split "\s+") | Where-Object { $_ -match "^\d+$" }
        foreach ($p in $parts) {
            try { Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}

Stop-Port $VlmPort
Stop-Port $AppPort
Start-Sleep -Milliseconds 800
Write-Ok "Ports cleared"


# ============================================================
#  STEP 3 - Start VLM stack
# ============================================================
Write-Header "Starting VLM service"

$vlmProcess = $null

if ($UseDocker) {

    # Tear down leftovers (suppress all output - docker writes to stderr even on success)
    Push-Location $ProjectRoot
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    docker compose -f docker-compose.vlm.yml down --remove-orphans 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    Pop-Location

    # Decide which services to start
    if ($WithVllm) {
        Write-Step "Starting vlm_service + vllm containers"
        Push-Location $ProjectRoot
        if ($Rebuild) { docker compose -f docker-compose.vlm.yml build --no-cache vlm_service }
        docker compose -f docker-compose.vlm.yml up -d vlm_service vllm
        Pop-Location
        Write-Warn "vLLM: olmOCR and Qwen2.5-VL are public models, no token needed."
        Write-Warn "First run downloads ~15 GB. Check progress: docker logs -f optimus_vllm"
    } else {
        Write-Step "Starting vlm_service container only"
        Push-Location $ProjectRoot
        if ($Rebuild) { docker compose -f docker-compose.vlm.yml build --no-cache vlm_service }
        docker compose -f docker-compose.vlm.yml up -d vlm_service
        Pop-Location
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Fatal "docker compose failed. Make sure Docker Desktop is running and docker-compose.vlm.yml exists."
    }

    Write-Ok "Docker container(s) started"

} else {

    # No Docker: run vlm_service.py directly
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $PythonCmd
    $psi.Arguments              = "-m uvicorn vlm_service:app --host 0.0.0.0 --port $VlmPort"
    $psi.WorkingDirectory       = $PythonDir
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8"
    $psi.EnvironmentVariables["VLLM_BASE_URL"]    = "http://localhost:8200"

    $vlmProcess = [System.Diagnostics.Process]::Start($psi)
    $vlmProcess.BeginOutputReadLine()
    $vlmProcess.BeginErrorReadLine()

    $null = Register-ObjectEvent -InputObject $vlmProcess -EventName OutputDataReceived -Action {
        if ($EventArgs.Data) {
            Add-Content -Path $using:VlmLog -Value ("[" + (Get-Date -f "HH:mm:ss") + "] " + $EventArgs.Data)
        }
    }
    $null = Register-ObjectEvent -InputObject $vlmProcess -EventName ErrorDataReceived -Action {
        if ($EventArgs.Data) {
            Add-Content -Path $using:VlmLog -Value ("[" + (Get-Date -f "HH:mm:ss") + "] " + $EventArgs.Data)
        }
    }

    Write-Ok "VLM process started (PID $($vlmProcess.Id)) -- log: logs\vlm_service.log"
}


# ============================================================
#  STEP 4 - Wait for VLM /health
# ============================================================
Write-Header "Waiting for VLM service at http://localhost:$VlmPort/health"

$vlmReady  = $false
$vlmHealth = $null

for ($i = 1; $i -le 90; $i++) {
    Start-Sleep -Seconds 2
    try {
        $vlmHealth = Invoke-RestMethod -Uri "http://localhost:$VlmPort/health" -TimeoutSec 3 -ErrorAction Stop
        if ($vlmHealth.status -eq "ok") {
            $vlmReady = $true
            break
        }
    } catch { }
    if (($i % 5) -eq 0) {
        Write-Host "  [$($i * 2)s] Still loading models..." -ForegroundColor DarkGray
    }
}

if ($vlmReady) {
    $device  = $vlmHealth.device.ToUpper()
    $models  = $vlmHealth.loaded_models -join ", "
    Write-Ok "VLM ready! Device: $device | Loaded: $models"
} else {
    Write-Warn "VLM did not respond in time. It may still be loading in the background."
    if ($UseDocker) {
        Write-Warn "Check: docker logs optimus_vlm"
    } else {
        Write-Warn "Check: $VlmLog"
    }
}


# ============================================================
#  STEP 5 - Start Node.js app
# ============================================================
Write-Header "Starting Optimus app on port $AppPort"

# Load .env
$envFile = Join-Path $ProjectRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^\s*([^#=\s]+)\s*=\s*(.*)$") {
            $k = $Matches[1].Trim()
            $v = $Matches[2].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
}

# Always override VLM settings so they point to our running service
$env:VLM_SERVICE_URL = "http://localhost:$VlmPort"
$env:VLM_ENGINE      = "auto"
$env:VLM_ENABLED     = "true"
$env:VLLM_URL        = "http://localhost:8200"

$appExe = if ($Pkg -eq "pnpm") { "pnpm.cmd" } else { "npm.cmd" }

$appPsi = New-Object System.Diagnostics.ProcessStartInfo
$appPsi.FileName               = $appExe
$appPsi.Arguments              = "dev"
$appPsi.WorkingDirectory       = $ProjectRoot
$appPsi.RedirectStandardOutput = $true
$appPsi.RedirectStandardError  = $true
$appPsi.UseShellExecute        = $false
$appPsi.CreateNoWindow         = $true

$appProcess = [System.Diagnostics.Process]::Start($appPsi)
$appProcess.BeginOutputReadLine()
$appProcess.BeginErrorReadLine()

$null = Register-ObjectEvent -InputObject $appProcess -EventName OutputDataReceived -Action {
    if ($EventArgs.Data) {
        Add-Content -Path $using:AppLog -Value ("[" + (Get-Date -f "HH:mm:ss") + "] " + $EventArgs.Data)
    }
}
$null = Register-ObjectEvent -InputObject $appProcess -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data) {
        Add-Content -Path $using:AppLog -Value ("[" + (Get-Date -f "HH:mm:ss") + "] " + $EventArgs.Data)
    }
}

Write-Ok "App started (PID $($appProcess.Id)) -- log: logs\app.log"


# ============================================================
#  STEP 6 - Wait for app then open browser
# ============================================================
Write-Header "Waiting for app..."

for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:$AppPort" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        break
    } catch { }
}

Write-Ok "App ready at http://localhost:$AppPort"
Start-Process "http://localhost:$AppPort"


# ============================================================
#  Status banner
# ============================================================
Write-Host ""
Write-Host "  +--------------------------------------------------------+" -ForegroundColor DarkCyan
Write-Host "  |  All services running. Press Ctrl+C to stop all.       |" -ForegroundColor DarkCyan
Write-Host "  |                                                         |" -ForegroundColor DarkCyan
Write-Host "  |  App     -> http://localhost:$AppPort                       |" -ForegroundColor DarkCyan
Write-Host "  |  VLM API -> http://localhost:$VlmPort/health                |" -ForegroundColor DarkCyan
if ($WithVllm) {
    Write-Host "  |  vLLM    -> http://localhost:8200/v1/models             |" -ForegroundColor DarkCyan
}
Write-Host "  |                                                         |" -ForegroundColor DarkCyan
Write-Host "  |  Logs folder: $LogDir" -ForegroundColor DarkCyan
Write-Host "  +--------------------------------------------------------+" -ForegroundColor DarkCyan
Write-Host ""

if ($UseDocker) {
    Write-Host "  VLM log : docker logs -f optimus_vlm" -ForegroundColor DarkGray
} else {
    Write-Host "  VLM log : $VlmLog" -ForegroundColor DarkGray
}
Write-Host "  App log : $AppLog" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Tailing app log (Ctrl+C stops everything)..." -ForegroundColor DarkGray
Write-Host ""


# ============================================================
#  Live log tail
# ============================================================
try {
    Get-Content -Path $AppLog -Wait -Tail 0 | ForEach-Object {
        $line = $_
        if ($line -match "ERROR|error|failed|Traceback") {
            Write-Host $line -ForegroundColor Red
        } elseif ($line -match "\[VLM\]|Surya|Marker|olmOCR") {
            Write-Host $line -ForegroundColor Cyan
        } elseif ($line -match "warn|WARN") {
            Write-Host $line -ForegroundColor Yellow
        } elseif ($line -match "ready|started|running|OK") {
            Write-Host $line -ForegroundColor Green
        } else {
            Write-Host $line -ForegroundColor DarkGray
        }
    }
} finally {
    Write-Host ""
    Write-Host "  Stopping services..." -ForegroundColor Yellow

    try { $appProcess.Kill() } catch { }

    if ($null -ne $vlmProcess) {
        try { $vlmProcess.Kill() } catch { }
    }

    if ($UseDocker) {
        Push-Location $ProjectRoot
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        docker compose -f docker-compose.vlm.yml down 2>&1 | Out-Null
        $ErrorActionPreference = $prev
        Pop-Location
    }

    Get-EventSubscriber | Unregister-Event -Force -ErrorAction SilentlyContinue
    Write-Ok "All stopped."
}