# Release packaging: NSIS setup + portable ZIP + manifests + SHA256SUMS.
# Builds from the CURRENT working tree; fails loudly on any inconsistency.
param (
    [string]$Version = "",
    [string]$OutputDir = "release-artifacts",
    [switch]$StopRunningInstance
)
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path "$PSScriptRoot\..").Path
Set-Location $Root

# 0. 版本来源唯一：未显式传参时从 package.json 读取，并校验三处一致。
$pkgVersion = (Get-Content "$Root/package.json" -Raw | ConvertFrom-Json).version
$confVersion = (Get-Content "$Root/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json).version
$cargoLine = (Select-String -Path "$Root/src-tauri/Cargo.toml" -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value
if (-not $Version) { $Version = $pkgVersion }
if ($Version -ne $pkgVersion -or $Version -ne $confVersion -or $Version -ne $cargoLine) {
    throw "版本不一致: Version=$Version package.json=$pkgVersion tauri.conf=$confVersion Cargo.toml=$cargoLine。请先统一版本（scripts/bump-version.ps1）。"
}

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Building Pulse for Windows v$Version" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. OutputDir：只允许在构建根目录内，且双向不得命中源码/配置/git 路径。
#    StartsWith 必须带目录分隔符边界：否则 "D:\repo\src-other" 会被 "D:\repo\src" 误判。
#    PS5.1 的 Join-Path 遇绝对路径会返回 null：rooted 输入直接取自身，同样过下面的保护判定。
if ([System.IO.Path]::IsPathRooted($OutputDir)) { $ArtifactsDir = $OutputDir }
else { $ArtifactsDir = Join-Path $Root $OutputDir }
$ArtifactsDir = ([System.IO.Path]::GetFullPath($ArtifactsDir)).TrimEnd('\') + '\'
$allowedRoot = ([System.IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\'
if (-not $ArtifactsDir.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDir 必须位于构建根目录内: $ArtifactsDir"
}
if ($ArtifactsDir -eq $allowedRoot) { throw "OutputDir 不得就是构建根目录本身" }
foreach ($protected in @("$Root\src", "$Root\src-tauri", "$Root\.git", "$Root\docs", "$Root\scripts", "$Root\dist")) {
    # 全新 checkout 常缺 dist 等目录：Resolve-Path 失败时跳过该条，不得对 null 调方法（B16）。
    $presolved = Resolve-Path $protected -ErrorAction SilentlyContinue
    if (-not $presolved) { continue }
    $pp = $presolved.ProviderPath.TrimEnd('\') + '\'
    # 双向检查：受保护目录在 OutputDir 内（会被删），或 OutputDir 在受保护目录内（会在源码里建产物）。
    if ($pp.StartsWith($ArtifactsDir, [System.StringComparison]::OrdinalIgnoreCase) -or
        $ArtifactsDir.StartsWith($pp, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "OutputDir 不得命中受保护路径: $ArtifactsDir 与 $pp 冲突"
    }
}
if (Test-Path $ArtifactsDir) { Remove-Item -Recurse -Force $ArtifactsDir }
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

# 1b. 运行中的实例会锁住链接产物：默认不停止用户程序，报告并要求显式决定。
$proc = Get-Process -Name "pulse-windows" -ErrorAction SilentlyContinue
if ($proc) {
    if (-not $StopRunningInstance) {
        throw "检测到正在运行的 pulse-windows（PID $($proc.Id)）。请先退出应用，或加 -StopRunningInstance 允许自动停止。"
    }
    Write-Host "  -> Stopping running pulse-windows instance (PID $($proc.Id))..." -ForegroundColor Yellow
    Stop-Process -Name "pulse-windows" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# 2. Frontend
Write-Host "`n[1/6] Building frontend assets..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

# 3. Tauri NSIS + release binary
Write-Host "`n[2/6] Building Tauri release bundle (NSIS)..." -ForegroundColor Yellow
npm run tauri:build
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed" }

$NsisDir = Join-Path $Root "src-tauri\target\release\bundle\nsis"
# Tauri 产物名为 <product>_<version>_x64-setup.exe（下划线分隔）；只接受含精确版本段的文件。
$SetupExe = Get-ChildItem -Path $NsisDir -Filter "*_x64-setup.exe" |
    Where-Object { $_.Name -like "*_${Version}_x64-setup.exe" } | Select-Object -First 1
if (-not $SetupExe) {
    throw "未找到版本精确匹配的安装包（*$Version-x64-setup.exe）。不做模糊回退：请确认构建版本与 -Version 一致。"
}
$FinalSetupName = "Pulse-$Version-windows-x64-setup.exe"
$FinalSetupPath = Join-Path $ArtifactsDir $FinalSetupName
Copy-Item $SetupExe.FullName -Destination $FinalSetupPath -Force
Write-Host "  -> Setup installer: $FinalSetupName" -ForegroundColor Green

# 4. Portable ZIP（白名单组装）
Write-Host "`n[3/6] Assembling Portable Edition ZIP..." -ForegroundColor Yellow
$PortableDirName = "Pulse-$Version-windows-x64-portable"
$StagingDir = Join-Path $ArtifactsDir $PortableDirName
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

$ReleaseExe = Join-Path $Root "src-tauri\target\release\pulse-windows.exe"
if (-not (Test-Path $ReleaseExe)) { throw "Release executable not found: $ReleaseExe" }

Copy-Item $ReleaseExe -Destination (Join-Path $StagingDir "Pulse.exe") -Force
New-Item -ItemType File -Force -Path (Join-Path $StagingDir "portable.flag") | Out-Null
Copy-Item (Join-Path $Root "README-portable.zh-CN.md") -Destination (Join-Path $StagingDir "README-portable.zh-CN.md") -Force
Copy-Item (Join-Path $Root "LICENSE") -Destination (Join-Path $StagingDir "LICENSE") -Force
Copy-Item (Join-Path $Root "NOTICE") -Destination (Join-Path $StagingDir "NOTICE") -Force

$FinalZipName = "Pulse-$Version-windows-x64-portable.zip"
$FinalZipPath = Join-Path $ArtifactsDir $FinalZipName
Compress-Archive -Path "$StagingDir\*" -DestinationPath $FinalZipPath -Force
Remove-Item -Recurse -Force $StagingDir
Write-Host "  -> Portable ZIP: $FinalZipName" -ForegroundColor Green

# 5. 结构化依赖与构建信息（不含本机路径）
Write-Host "`n[4/6] Generating manifests..." -ForegroundColor Yellow
$nodeVer = (node --version)
$cargoVer = (cargo --version)
$commit = (git rev-parse HEAD)
$utc = (Get-Date).ToUniversalTime().ToString('u')

# 从 package.json 结构化生成 npm 直依赖清单（名称、版本），不经过带路径的命令输出。
$pkgJson = Get-Content "$Root/package.json" -Raw | ConvertFrom-Json
$depLines = @("=== npm (direct dependencies) ===")
foreach ($p in ($pkgJson.dependencies.PSObject.Properties)) { $depLines += "$($p.Name) $($p.Value)" }
foreach ($p in ($pkgJson.devDependencies.PSObject.Properties)) { $depLines += "dev: $($p.Name) $($p.Value)" }
$depLines += ""
$depLines += "=== cargo (direct dependencies) ==="
foreach ($line in (Get-Content "$Root/src-tauri/Cargo.toml")) {
    if ($line -match '^([a-zA-Z0-9_-]+)\s*=\s*') { $depLines += $Matches[1] }
}
$depLines | Out-File -FilePath (Join-Path $ArtifactsDir "DEPENDENCIES.txt") -Encoding utf8

$buildInfo = @"
product: Pulse for Windows
version: $Version
commit: $commit
built: $utc
target: x86_64-pc-windows-msvc
node: $nodeVer
cargo: $cargoVer
mode: release
signing: unsigned
webview2: system install required (bootstrapped by installer when missing)
"@
$BuildFile = Join-Path $ArtifactsDir "BUILD_INFO.txt"
$buildInfo | Out-File -FilePath $BuildFile -Encoding ascii

# 6. SHA256SUMS：从最终产物重新计算
Write-Host "`n[5/6] Generating SHA256 checksums..." -ForegroundColor Yellow
$ShaFile = Join-Path $ArtifactsDir "SHA256SUMS.txt"
$ItemsToHash = @($FinalSetupPath, $FinalZipPath, (Join-Path $ArtifactsDir "DEPENDENCIES.txt"), $BuildFile)
$HashLines = foreach ($item in $ItemsToHash) {
    $hash = (Get-FileHash -Path $item -Algorithm SHA256).Hash.ToLower()
    "$hash  $([System.IO.Path]::GetFileName($item))"
}
$HashLines | Out-File -FilePath $ShaFile -Encoding ascii
Get-Content $ShaFile | Write-Host -ForegroundColor Cyan

Write-Host "`n[6/6] Build Completed Successfully!" -ForegroundColor Green
Write-Host "Artifacts located in: $ArtifactsDir" -ForegroundColor Green
