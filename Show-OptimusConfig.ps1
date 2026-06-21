# ─────────────────────────────────────────────────────────────────────────────
#  Show-OptimusConfig.ps1
#  Dumps the complete OptimusInvoice configuration:
#  .env file + database settingsJson + VLM container health
# ─────────────────────────────────────────────────────────────────────────────

$BASE = Split-Path -Parent $MyInvocation.MyCommand.Path
$ENV_FILE = "$BASE\.env"

function Write-Header($text) {
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host "  ========================================" -ForegroundColor Cyan
}
function Write-Ok($text)   { Write-Host "  [OK]  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!!]  $text" -ForegroundColor Yellow }
function Write-Val($k, $v) { Write-Host ("  {0,-30} {1}" -f $k, $v) }

# ── 1. .env file ──────────────────────────────────────────────────────────────
Write-Header "1/4  .env file"
if (Test-Path $ENV_FILE) {
    Get-Content $ENV_FILE | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        # Mask secrets
        if ($line -match "^(JWT_SECRET|PASSWORD|SECRET)") {
            $key = $line.Split("=")[0]
            Write-Val $key "***masked***"
        } else {
            Write-Host "  $line"
        }
    }
} else {
    Write-Warn ".env not found at $ENV_FILE"
}

# ── 2. Database configuration row ─────────────────────────────────────────────
Write-Header "2/4  Database configuration (settingsJson)"
$sql = "SELECT userId, softoneApiUrl, softoneUsername, softoneCompany, softoneBranch, softoneModule, erpType, settingsJson, updatedAt FROM configuration LIMIT 5;"
$rows = $sql | docker exec -i optimus-mysql mysql -uroot -poptimus123 invoice_automation --table 2>&1
if ($LASTEXITCODE -eq 0) {
    $rows | ForEach-Object { Write-Host "  $_" }

    # Pretty-print settingsJson separately
    $jsonSql = "SELECT settingsJson FROM configuration WHERE userId=1 LIMIT 1;"
    $jsonRaw = $jsonSql | docker exec -i optimus-mysql mysql -uroot -poptimus123 invoice_automation --skip-column-names 2>&1
    if ($jsonRaw -and $jsonRaw -notmatch "ERROR") {
        Write-Host ""
        Write-Host "  settingsJson (parsed):" -ForegroundColor Cyan
        try {
            $parsed = $jsonRaw | ConvertFrom-Json
            $parsed.PSObject.Properties | ForEach-Object {
                Write-Val "    $($_.Name)" $_.Value
            }
        } catch {
            Write-Host "  $jsonRaw"
        }
    }
} else {
    Write-Warn "Could not query database — is optimus-mysql running?"
}

# ── 3. VLM container health ───────────────────────────────────────────────────
Write-Header "3/4  VLM container health"
$health = Invoke-RestMethod "http://localhost:8300/health" -ErrorAction SilentlyContinue
if ($health) {
    Write-Val "status"           $health.status
    Write-Val "surya"            $health.surya
    Write-Val "semantic"         $health.semantic
    Write-Val "semantic_model"   $health.semantic_model
    Write-Val "device"           $health.device
    Write-Val "uptime_s"         $health.uptime_s
} else {
    Write-Warn "VLM service not reachable on http://localhost:8300"
}

# ── 4. Docker containers ──────────────────────────────────────────────────────
Write-Header "4/4  Docker containers"
docker ps --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}" | ForEach-Object {
    Write-Host "  $_"
}

Write-Host ""