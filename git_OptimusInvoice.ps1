# ============================================================
#  Upload-OptimusInvoice.ps1
#  Uploads the latest OptimusInvoice code to GitHub
#  Rules:
#    - vlm-service/wheels/ is NEVER committed (~1.2 GB)
#    - models/*.gguf are NEVER committed
#    - node_modules/ is NEVER committed
#  Usage: .\Upload-OptimusInvoice.ps1 [-Message "your commit msg"]
# ============================================================

param(
    [string]$Message = "",
    [switch]$Force    = $false
)

# ── Helpers ─────────────────────────────────────────────────
function Write-Header ($text) {
    Write-Host ""
    Write-Host "  ══════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "   $text" -ForegroundColor Cyan
    Write-Host "  ══════════════════════════════════════════" -ForegroundColor Cyan
}
function Write-Step ($text)  { Write-Host "  ▶ $text" -ForegroundColor Yellow }
function Write-Ok   ($text)  { Write-Host "  ✔ $text" -ForegroundColor Green }
function Write-Warn ($text)  { Write-Host "  ⚠ $text" -ForegroundColor DarkYellow }
function Write-Fail ($text)  { Write-Host "  ✘ $text" -ForegroundColor Red }
function Abort      ($text)  { Write-Fail $text; Write-Host ""; exit 1 }

# ── Config ──────────────────────────────────────────────────
$BASE          = $PSScriptRoot
$REMOTE_URL    = "https://github.com/georgeGeorgakakos/optimusInvoice.git"
$BRANCH        = "main"
$GITIGNORE     = "$BASE\.gitignore"

# Paths that must NEVER be committed
$PROTECTED = @(
    "vlm-service/wheels",
    "model_cache",          # ← ADD THIS (your actual model folder)
    "qwen-vl-service/wheels",
    "gemma-vl-service/wheels",
    "*.gguf",
    "*.safetensors",        # ← ADD THIS
    "node_modules",
    ".env",
    "*.log",
    "dist",
    "dist-server",          # ← ADD THIS
    ".next"
)

# ── Banner ──────────────────────────────────────────────────
Write-Header "OptimusInvoice — GitHub Upload"
Write-Host "  Repo  : $REMOTE_URL" -ForegroundColor Gray
Write-Host "  Branch: $BRANCH"     -ForegroundColor Gray
Write-Host "  Dir   : $BASE"       -ForegroundColor Gray

# ── Pre-flight: must be inside the project folder ────────────
Write-Step "Checking project directory..."
$hasServer  = Test-Path "$BASE\server"
$hasVlm     = Test-Path "$BASE\vlm-service"
$hasPackage = Test-Path "$BASE\package.json"

if (-not ($hasServer -or $hasVlm -or $hasPackage)) {
    Abort "This doesn't look like the OptimusInvoice root folder. Run from C:\Users\georg\WebstormProjects\optimusInvoice"
}
Write-Ok "Project folder confirmed"

# ── Pre-flight: git available ────────────────────────────────
Write-Step "Checking git..."
$gitVersion = git --version 2>&1
if ($LASTEXITCODE -ne 0) { Abort "git not found. Install Git for Windows." }
Write-Ok $gitVersion

# ── Safety: verify wheels are NOT staged ────────────────────
Write-Step "Verifying wheels folder is excluded..."
$wheelsPath = "$BASE\vlm-service\wheels"
if (Test-Path $wheelsPath) {
    $wheelFiles = Get-ChildItem $wheelsPath -Recurse -File | Measure-Object
    $wheelMB    = [math]::Round((Get-ChildItem $wheelsPath -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB)
    Write-Warn "Wheels folder exists (~${wheelMB} MB, $($wheelFiles.Count) files) — will be excluded from commit"
} else {
    Write-Ok "No wheels folder present"
}

# ── Ensure .gitignore is correct ────────────────────────────
Write-Step "Ensuring .gitignore covers large files..."

$requiredEntries = @(
    "# OptimusInvoice — auto-managed entries",
    "vlm-service/wheels/",
    "qwen-vl-service/wheels/",
    "gemma-vl-service/wheels/",
    "model_cache/",         # ← ADD THIS
    "*.gguf",
    "*.safetensors",        # ← ADD THIS
    "node_modules/",
    ".env",
    "*.log",
    "dist/",
    "dist-server/",         # ← ADD THIS
    ".next/"
)

$currentIgnore = ""
if (Test-Path $GITIGNORE) {
    $currentIgnore = Get-Content $GITIGNORE -Raw
}

$missing = @()
foreach ($entry in $requiredEntries) {
    if ($entry.StartsWith("#")) { continue }
    $bare = $entry.TrimEnd("/")
    if ($currentIgnore -notmatch [regex]::Escape($bare)) {
        $missing += $entry
    }
}

if ($missing.Count -gt 0) {
    Write-Warn "Adding $($missing.Count) missing entries to .gitignore..."
    Add-Content -Path $GITIGNORE -Value "`n# === Added by Upload-OptimusInvoice.ps1 ==="
    foreach ($e in $missing) {
        Add-Content -Path $GITIGNORE -Value $e
        Write-Host "    + $e" -ForegroundColor DarkGray
    }
    Write-Ok ".gitignore updated"
} else {
    Write-Ok ".gitignore is correctly configured"
}

# ── Init git if not present ──────────────────────────────────
Write-Step "Checking git repository..."
$gitDir = "$BASE\.git"
if (-not (Test-Path $gitDir)) {
    Write-Warn "No .git found — initialising repository..."
    Set-Location $BASE
    git init
    git branch -M $BRANCH
    Write-Ok "Git repository initialised"
} else {
    Set-Location $BASE
    Write-Ok "Git repository exists"
}

# ── Configure remote ─────────────────────────────────────────
Write-Step "Configuring remote origin..."
$existingRemote = git remote get-url origin 2>&1
if ($LASTEXITCODE -ne 0) {
    git remote add origin $REMOTE_URL
    Write-Ok "Remote added: $REMOTE_URL"
} elseif ($existingRemote.Trim() -ne $REMOTE_URL) {
    Write-Warn "Remote URL differs: $existingRemote"
    Write-Warn "Expected        : $REMOTE_URL"
    $confirm = Read-Host "  Update remote URL? (y/N)"
    if ($confirm -eq "y") {
        git remote set-url origin $REMOTE_URL
        Write-Ok "Remote updated"
    }
} else {
    Write-Ok "Remote: $existingRemote"
}

# ── Show what changed ────────────────────────────────────────
Write-Step "Staging all changes..."
git add -A

$statusOutput = git status --short
if ([string]::IsNullOrWhiteSpace($statusOutput)) {
    Write-Host ""
    Write-Ok "Nothing to commit — working tree is clean."
    Write-Host ""
    exit 0
}

Write-Host ""
Write-Host "  Changes to be committed:" -ForegroundColor White
$statusOutput -split "`n" | ForEach-Object {
    if ($_ -match "^\s*$") { return }
    $color = switch -Regex ($_) {
        "^A "  { "Green" }
        "^M "  { "Yellow" }
        "^D "  { "Red" }
        "^\?\?" { "DarkGray" }
        default  { "White" }
    }
    Write-Host "    $_" -ForegroundColor $color
}
Write-Host ""

# ── Double-check no wheels sneaked in ───────────────────────
#$stagedWheels = git diff --cached --name-only | Where-Object { $_ -match "wheels/" -or $_ -match "\.gguf$" }
$stagedWheels = git diff --cached --name-only | Where-Object { $_ -match "wheels/" -or $_ -match "\.gguf$" -or $_ -match "\.safetensors$" -or $_ -match "^model_cache/" }

if ($stagedWheels) {
    Write-Host ""
    Write-Fail "BLOCKED: Large files detected in staged area:"
    $stagedWheels | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Write-Host ""
    Write-Warn "Running: git rm --cached <files>"
    $stagedWheels | ForEach-Object { git rm --cached $_ 2>&1 | Out-Null }
    Write-Ok "Large files removed from staging"
    git add -A
}

# ── Commit message ───────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($Message)) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    $fileCount = ($statusOutput -split "`n" | Where-Object { $_ -notmatch "^\s*$" }).Count
    $Message   = "feat: update OptimusInvoice code [$timestamp] ($fileCount files)"
}

Write-Step "Committing: `"$Message`""
git commit -m $Message
if ($LASTEXITCODE -ne 0) { Abort "Commit failed" }
Write-Ok "Committed successfully"

# ── Push ─────────────────────────────────────────────────────
Write-Step "Pushing to GitHub ($BRANCH)..."

if ($Force) {
    Write-Warn "Force push mode enabled"
    git push -u origin $BRANCH --force
} else {
    git push -u origin $BRANCH
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Warn "Push failed — remote may have diverged."
        Write-Warn "Options:"
        Write-Host "   1) Pull first  : git pull origin $BRANCH --rebase" -ForegroundColor White
        Write-Host "   2) Force push  : .\Upload-OptimusInvoice.ps1 -Force" -ForegroundColor White
        Write-Host "   3) Check auth  : git remote -v && git config user.name" -ForegroundColor White
        Write-Host ""
        exit 1
    }
}

# ── Summary ──────────────────────────────────────────────────
Write-Header "Upload Complete ✔"
Write-Host ""
Write-Host "  Message : $Message"    -ForegroundColor White
Write-Host "  Branch  : $BRANCH"     -ForegroundColor White
Write-Host "  Remote  : $REMOTE_URL" -ForegroundColor White
Write-Host ""

$lastCommit = git log --oneline -1
Write-Host "  Last commit: $lastCommit" -ForegroundColor Cyan
Write-Host ""
Write-Host "  View on GitHub:" -ForegroundColor DarkGray
Write-Host "  https://github.com/georgeGeorgakakos/optimusInvoice" -ForegroundColor DarkCyan
Write-Host ""