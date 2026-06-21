# ============================================================
#  compress-optimusInvoice-lean.ps1
#  Lightweight source-only ZIP of optimusInvoice.
#  Excludes the heavy offenders: .git (~8GB), wheels/ folders,
#  model weights (*.gguf/*.safetensors/*.bin), and all build/cache output.
#  Output: Desktop\optimusInvoice_lean_YYYYMMDD_HHMMSS.zip
# ============================================================

$projectPath = "$env:USERPROFILE\WebstormProjects\optimusInvoice"
$timestamp   = Get-Date -Format "yyyyMMdd_HHmmss"
$outputZip   = "$env:USERPROFILE\Desktop\optimusInvoice_lean_$timestamp.zip"

# -- Folders to exclude (any path segment matching these names) --
$excludeDirs = @(
# version control — the 8GB offender
    ".git",

    # python wheel caches inside *-service folders — large & re-downloadable
    "wheels", "wheelhouse", "pip-wheel-metadata", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "venv", ".venv", "env",

    # node / frontend build + deps
    "node_modules", ".yarn", ".pnp",
    "dist-client", "dist-server", "dist", "build", "out", ".next", ".nuxt",

    # model caches that services mount/populate
    "model_cache", "models", ".cache", "model-cache", "hf_cache", ".huggingface",

    # IDE / tooling
    ".idea", ".vscode", ".vs",
    "drizzle", ".turbo", ".parcel-cache",
    "coverage", ".nyc_output",
    "logs", "tmp", "temp",
    "ResearchPapers"
)

# -- File patterns to exclude (matched against filename only) --
$excludeFilePatterns = @(
# MODEL WEIGHTS — the big binaries (re-downloadable from HuggingFace)
    "*.gguf", "*.safetensors", "*.bin", "*.pt", "*.pth", "*.onnx",
    "*.pkl", "*.h5", "*.ckpt", "*.traineddata", "*.mlmodel",

    # python wheels / archives if loose
    "*.whl", "*.tar.gz", "*.tar", "*.zip", "*.7z", "*.gz",

    # lockfiles (regenerable)
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",

    # OS / editor junk
    "Thumbs.db", "desktop.ini", ".DS_Store",

    # secrets / local env (keep .env.example)
    ".env.local", ".env.production", ".env.development", ".env.test",

    # build artifacts / maps / logs
    "*.tsbuildinfo", "*.js.map", "*.css.map",
    "*.log", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*"
)

# ------------------------------------------------------------
Write-Host ""
Write-Host "optimusInvoice LEAN Source Archiver" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "Project : $projectPath"
Write-Host "Output  : $outputZip"
Write-Host ""

if (-not (Test-Path $projectPath)) {
    Write-Host "ERROR: Project path not found: $projectPath" -ForegroundColor Red
    exit 1
}

Write-Host "Scanning files..." -ForegroundColor Yellow

$allFiles = Get-ChildItem -Path $projectPath -Recurse -File -Force -ErrorAction SilentlyContinue

# Track what we drop, so you can see where the savings came from.
$excludedBytes = [int64]0
$excludedCount = 0

$included = $allFiles | Where-Object {
    $relativePath = $_.FullName.Substring($projectPath.Length).TrimStart('\','/')
    $parts        = $relativePath.Split([IO.Path]::DirectorySeparatorChar)

    # Skip if any directory segment matches exclusion list
    $dirMatch = $false
    for ($i = 0; $i -lt ($parts.Count - 1); $i++) {
        if ($excludeDirs -contains $parts[$i]) { $dirMatch = $true; break }
    }
    if ($dirMatch) { $script:excludedBytes += $_.Length; $script:excludedCount++; return $false }

    # Skip if filename matches any exclusion pattern
    foreach ($pattern in $excludeFilePatterns) {
        if ($_.Name -like $pattern) { $script:excludedBytes += $_.Length; $script:excludedCount++; return $false }
    }

    return $true
}

$totalSizeMB    = [math]::Round(($included | Measure-Object -Property Length -Sum).Sum / 1MB, 2)
$excludedSizeMB = [math]::Round($excludedBytes / 1MB, 2)
Write-Host "Files to archive : $($included.Count)  ($totalSizeMB MB uncompressed)" -ForegroundColor Green
Write-Host "Excluded         : $excludedCount files  ($excludedSizeMB MB skipped)" -ForegroundColor DarkGray
Write-Host ""

# -- Prefer 7-Zip (maximum compression) ---------------------
$sevenZip = @(
    "C:\Program Files\7-Zip\7z.exe",
    "C:\Program Files (x86)\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($sevenZip) {
    Write-Host "Using 7-Zip (-mx=9 maximum compression)..." -ForegroundColor DarkGreen
    $listFile = [System.IO.Path]::GetTempFileName()
    $included.FullName | Set-Content -Path $listFile -Encoding UTF8
    & $sevenZip a -tzip -mx=9 -mmt=on $outputZip "@$listFile" | Out-Null
    Remove-Item $listFile -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "7-Zip not found - using .NET ZipArchive (Optimal)..." -ForegroundColor DarkYellow
    Write-Host "Tip: install 7-Zip from https://www.7-zip.org for ~30% smaller archives" -ForegroundColor DarkYellow
    Write-Host ""
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipFileStream = [System.IO.File]::Open($outputZip, [System.IO.FileMode]::Create)
    $archive       = New-Object System.IO.Compression.ZipArchive($zipFileStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    $compression   = [System.IO.Compression.CompressionLevel]::Optimal
    $counter = 0
    foreach ($file in $included) {
        $counter++
        if ($counter % 50 -eq 0) { Write-Host "  Compressed $counter / $($included.Count)..." -ForegroundColor Gray }
        $entryStream = $null; $fileStream = $null
        try {
            $entryName   = $file.FullName.Substring($projectPath.Length).TrimStart('\','/').Replace('\','/')
            $entry       = $archive.CreateEntry($entryName, $compression)
            $entryStream = $entry.Open()
            $fileStream  = [System.IO.File]::OpenRead($file.FullName)
            $fileStream.CopyTo($entryStream)
        } catch {
            Write-Host "  WARN: Skipped $($file.Name) - $($_.Exception.Message)" -ForegroundColor DarkYellow
        } finally {
            if ($null -ne $fileStream)  { $fileStream.Close() }
            if ($null -ne $entryStream) { $entryStream.Close() }
        }
    }
    $archive.Dispose(); $zipFileStream.Close()
}

# -- Summary -------------------------------------------------
if (Test-Path $outputZip) {
    $zipSizeMB = [math]::Round((Get-Item $outputZip).Length / 1MB, 2)
    $ratio     = if ($totalSizeMB -gt 0) { [math]::Round((1 - $zipSizeMB / $totalSizeMB) * 100, 1) } else { 0 }
    Write-Host ""
    Write-Host "Done!" -ForegroundColor Green
    Write-Host "Archive  : $outputZip"
    Write-Host "Size     : $zipSizeMB MB  (was $totalSizeMB MB source - $ratio% compression)"
    Write-Host "Skipped  : $excludedSizeMB MB of weights/wheels/.git not included"
    Write-Host ""
    Write-Host "Ready to upload to Claude." -ForegroundColor Cyan
} else {
    Write-Host "ERROR: Archive was not created. Check errors above." -ForegroundColor Red
}