# ============================================================
#  compress-optimusInvoice.ps1
#  Creates a best-compressed ZIP of the optimusInvoice source
#  Excludes all generated, cached, and redundant files/folders
#  Output: Desktop\optimusInvoice_YYYYMMDD_HHMMSS.zip
# ============================================================

$projectPath = "$env:USERPROFILE\WebstormProjects\optimusInvoice"
$timestamp   = Get-Date -Format "yyyyMMdd_HHmmss"
$outputZip   = "$env:USERPROFILE\Desktop\optimusInvoice_$timestamp.zip"

# -- Folders to exclude (any path segment matching these names) --
$excludeDirs = @(
    "node_modules", ".yarn", ".pnp",
    "dist-client", "dist-server", "dist", "build", "out", ".next", ".nuxt",
    ".idea", ".vscode", ".vs",
    "model_cache", "drizzle", ".turbo", ".parcel-cache", ".cache",
    "coverage", ".nyc_output",
    "logs", "tmp", "temp",
    "ResearchPapers"
)

# -- File patterns to exclude (matched against filename only) --
$excludeFilePatterns = @(
    "*.traineddata", "*.onnx", "*.pt", "*.pkl",
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
    "Thumbs.db", "desktop.ini", ".DS_Store",
    ".env.local", ".env.production", ".env.development", ".env.test",
    "*.tsbuildinfo", "*.js.map", "*.css.map",
    "*.log", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*"
)

# ------------------------------------------------------------
Write-Host ""
Write-Host "optimusInvoice Source Archiver" -ForegroundColor Cyan
Write-Host "==============================" -ForegroundColor Cyan
Write-Host "Project : $projectPath"
Write-Host "Output  : $outputZip"
Write-Host ""

if (-not (Test-Path $projectPath)) {
    Write-Host "ERROR: Project path not found: $projectPath" -ForegroundColor Red
    exit 1
}

Write-Host "Scanning files..." -ForegroundColor Yellow

$allFiles = Get-ChildItem -Path $projectPath -Recurse -File -Force -ErrorAction SilentlyContinue

$included = $allFiles | Where-Object {
    $relativePath = $_.FullName.Substring($projectPath.Length).TrimStart('\','/')
    $parts        = $relativePath.Split([IO.Path]::DirectorySeparatorChar)

    # Skip if any directory segment matches exclusion list
    $dirMatch = $false
    for ($i = 0; $i -lt ($parts.Count - 1); $i++) {
        if ($excludeDirs -contains $parts[$i]) { $dirMatch = $true; break }
    }
    if ($dirMatch) { return $false }

    # Skip if filename matches any exclusion pattern
    foreach ($pattern in $excludeFilePatterns) {
        if ($_.Name -like $pattern) { return $false }
    }

    return $true
}

$totalSizeMB = [math]::Round(($included | Measure-Object -Property Length -Sum).Sum / 1MB, 2)
Write-Host "Files to archive : $($included.Count)  ($totalSizeMB MB uncompressed)" -ForegroundColor Green
Write-Host ""

# -- Prefer 7-Zip (maximum compression) ---------------------
$sevenZip = @(
    "C:\Program Files\7-Zip\7z.exe",
    "C:\Program Files (x86)\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($sevenZip) {
    Write-Host "Using 7-Zip (-mx=9 maximum compression)..." -ForegroundColor DarkGreen

    # Write file list to temp file to avoid command-line length limits
    $listFile = [System.IO.Path]::GetTempFileName()
    $included.FullName | Set-Content -Path $listFile -Encoding UTF8

    & $sevenZip a -tzip -mx=9 -mmt=on $outputZip "@$listFile" | Out-Null

    Remove-Item $listFile -Force -ErrorAction SilentlyContinue

} else {
    Write-Host "7-Zip not found - using .NET ZipArchive (Optimal compression)..." -ForegroundColor DarkYellow
    Write-Host "Tip: install 7-Zip from https://www.7-zip.org for ~30% smaller archives" -ForegroundColor DarkYellow
    Write-Host ""

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $fsMode      = [System.IO.FileMode]::Create
    $zipMode     = [System.IO.Compression.ZipArchiveMode]::Create
    $compression = [System.IO.Compression.CompressionLevel]::Optimal

    $zipFileStream = [System.IO.File]::Open($outputZip, $fsMode)
    $archive       = New-Object System.IO.Compression.ZipArchive($zipFileStream, $zipMode, $false)

    $counter = 0
    foreach ($file in $included) {
        $counter++
        if ($counter % 50 -eq 0) {
            Write-Host "  Compressed $counter / $($included.Count) files..." -ForegroundColor Gray
        }

        $entryStream = $null
        $fileStream  = $null
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

    $archive.Dispose()
    $zipFileStream.Close()
}

# -- Summary -------------------------------------------------
if (Test-Path $outputZip) {
    $zipSizeMB = [math]::Round((Get-Item $outputZip).Length / 1MB, 2)
    $ratio     = if ($totalSizeMB -gt 0) { [math]::Round((1 - $zipSizeMB / $totalSizeMB) * 100, 1) } else { 0 }
    Write-Host ""
    Write-Host "Done!" -ForegroundColor Green
    Write-Host "Archive : $outputZip"
    Write-Host "Size    : $zipSizeMB MB  (was $totalSizeMB MB - $ratio% reduction)"
    Write-Host ""
    Write-Host "Ready to upload to Claude." -ForegroundColor Cyan
} else {
    Write-Host "ERROR: Archive was not created. Check errors above." -ForegroundColor Red
}