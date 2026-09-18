param (
    [string]$Version = "0.3.1",
    [string]$OutputDir = "release-artifacts"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path "$PSScriptRoot\.."
Set-Location $Root

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Building Pulse for Windows v$Version" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Clean & Prepare Output Directory
$ArtifactsDir = Join-Path $Root $OutputDir
if (Test-Path $ArtifactsDir) {
    Remove-Item -Recurse -Force $ArtifactsDir
}
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

# 2. Build Frontend
Write-Host "`n[1/5] Building frontend assets..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

# 3. Build Tauri NSIS Setup & Release Binary
Write-Host "`n[2/5] Building Tauri release bundle (NSIS)..." -ForegroundColor Yellow
npm run tauri:build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed" }

# Locate NSIS Setup output
$NsisDir = Join-Path $Root "src-tauri\target\release\bundle\nsis"
$SetupExe = Get-ChildItem -Path $NsisDir -Filter "*$Version*setup.exe" | Select-Object -First 1
if (-not $SetupExe) {
    $SetupExe = Get-ChildItem -Path $NsisDir -Filter "*setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (-not $SetupExe) {
    throw "NSIS setup executable not found in $NsisDir"
}

$FinalSetupName = "Pulse-$Version-windows-x64-setup.exe"
$FinalSetupPath = Join-Path $ArtifactsDir $FinalSetupName
Copy-Item $SetupExe.FullName -Destination $FinalSetupPath -Force
Write-Host "  -> Setup installer created: $FinalSetupName" -ForegroundColor Green

# 4. Assemble Portable Edition
Write-Host "`n[3/5] Assembling Portable Edition ZIP..." -ForegroundColor Yellow
$PortableDirName = "Pulse-$Version-windows-x64-portable"
$StagingDir = Join-Path $ArtifactsDir $PortableDirName
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

$ReleaseExe = Join-Path $Root "src-tauri\target\release\pulse-windows.exe"
if (-not (Test-Path $ReleaseExe)) {
    throw "Release executable not found: $ReleaseExe"
}

# Copy files according to strict whitelist
Copy-Item $ReleaseExe -Destination (Join-Path $StagingDir "Pulse.exe") -Force
New-Item -ItemType File -Force -Path (Join-Path $StagingDir "portable.flag") | Out-Null
Copy-Item (Join-Path $Root "README-portable.zh-CN.md") -Destination (Join-Path $StagingDir "README-portable.zh-CN.md") -Force
Copy-Item (Join-Path $Root "LICENSE") -Destination (Join-Path $StagingDir "LICENSE") -Force
Copy-Item (Join-Path $Root "NOTICE") -Destination (Join-Path $StagingDir "NOTICE") -Force

# Create Portable ZIP
$FinalZipName = "Pulse-$Version-windows-x64-portable.zip"
$FinalZipPath = Join-Path $ArtifactsDir $FinalZipName
Compress-Archive -Path "$StagingDir\*" -DestinationPath $FinalZipPath -Force
Remove-Item -Recurse -Force $StagingDir
Write-Host "  -> Portable ZIP created: $FinalZipName" -ForegroundColor Green

# 5. Generate SHA256SUMS.txt
Write-Host "`n[4/5] Generating SHA256 checksums..." -ForegroundColor Yellow
$ShaFile = Join-Path $ArtifactsDir "SHA256SUMS.txt"
$ItemsToHash = @($FinalSetupPath, $FinalZipPath)
$HashLines = foreach ($item in $ItemsToHash) {
    $hash = (Get-FileHash -Path $item -Algorithm SHA256).Hash.ToLower()
    $name = [System.IO.Path]::GetFileName($item)
    "$hash  $name"
}
$HashLines | Out-File -FilePath $ShaFile -Encoding ascii
Get-Content $ShaFile | Write-Host -ForegroundColor Cyan

Write-Host "`n[5/5] Build Completed Successfully!" -ForegroundColor Green
Write-Host "Artifacts located in: $ArtifactsDir" -ForegroundColor Green
