# winget-pkgs manifest 生成器：从 release-artifacts/（SHA256SUMS.txt + BUILD_INFO.json）
# 生成 microsoft/winget-pkgs 规范的三件 manifest YAML 到 release-artifacts/winget/<版本>/。
# - InstallerType 落盘值为 "nullsoft"（winget schema 对 NSIS 的规范枚举值，不存在 "nsis"；
#   依据官方 installer schema https://aka.ms/winget-manifest.installer.<ManifestVersion>.schema.json 核对）。
# - 安装包 URL 指向 GitHub Releases；SHA256 取自 SHA256SUMS.txt 并与本地安装包文件复核。
# - 默认先跑内置自测（固定假 SHA + 负向用例）再真实生成；-SelfTest 只跑自测。
# 不做任何网络请求，不自动提交 PR（外向动作，见 docs/WINGET_SUBMISSION.md）。
param (
    [string]$ArtifactsDir = "release-artifacts",
    [string]$Version = "",
    [string]$Repo = "CNDDVP/pulse-windows",
    [string]$PackageIdentifier = "CNDDVP.PulseForWindows",
    [string]$ReleaseTag = "",
    [switch]$SelfTest
)
$ErrorActionPreference = "Stop"

# ManifestVersion 基线：winget-pkgs 贡献指南（.github/copilot-instructions.md）推荐 1.12.0
# （1.10.0 亦接受），PR 模板勾选项按 1.12 schema 核对。提交前以仓库当时指南为准。
$script:ManifestVersionValue = "1.12.0"
# 自测专用固定假 SHA（64 位十六进制、明显非真实产物），不代表任何真实文件。
$script:FakeSha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
$script:FakeVersion = "9.9.9"

$Root = (Resolve-Path "$PSScriptRoot\..").Path
if ([System.IO.Path]::IsPathRooted($ArtifactsDir)) { $ArtDir = $ArtifactsDir }
else { $ArtDir = Join-Path $Root $ArtifactsDir }
$ArtDir = [System.IO.Path]::GetFullPath($ArtDir)

# ---------- 极简 YAML 子集解析器（仅覆盖本脚本生成的结构，用于解析回读断言） ----------
# 输出为"点路径 -> 标量"的有序表：顶层键 PackageIdentifier；列表项 Installers[0].Architecture；
# 标量列表项 InstallModes[0]。不支持的语法（tab、块标量等）会显式抛错而不是静默漏检。
function ConvertFrom-Quoted {
    param([string]$Value)
    $v = $Value.Trim()
    if ($v.Length -ge 2) {
        if (($v[0] -eq '"' -and $v[$v.Length - 1] -eq '"') -or ($v[0] -eq "'" -and $v[$v.Length - 1] -eq "'")) {
            return $v.Substring(1, $v.Length - 2)
        }
    }
    return $v
}

function ConvertFrom-SimpleYaml {
    param([Parameter(Mandatory)][string]$Text)
    $result = [ordered]@{}
    $frame = [pscustomobject]@{ Indent = -1; Path = ""; Kind = "root"; NextIndex = 0 }
    $stack = [System.Collections.Generic.List[object]]::new()
    $stack.Add($frame)
    $lineNo = 0
    foreach ($raw in ($Text -split "`r?`n")) {
        $lineNo++
        if ($raw -match '^\s*(#.*)?$') { continue }
        if ($raw -match "`t") { throw "YAML 第 ${lineNo} 行含 tab：本地校验器不支持" }
        $indent = $raw.Length - $raw.TrimStart(' ').Length
        $t = $raw.TrimStart(' ')
        if ($t -match '^([A-Za-z][A-Za-z0-9_.]*):(?:\s(.*))?$') {
            $key = $Matches[1]
            $val = ""
            if ($Matches.Count -gt 2) { $val = $Matches[2] }
            while ($stack[$stack.Count - 1].Indent -ge $indent) { $stack.RemoveAt($stack.Count - 1) }
            $parent = $stack[$stack.Count - 1]
            $path = if ($parent.Path) { $parent.Path + "." + $key } else { $key }
            if ($val -eq "") {
                $stack.Add([pscustomobject]@{ Indent = $indent; Path = $path; Kind = "container"; NextIndex = 0 })
            } else {
                $result[$path] = ConvertFrom-Quoted $val
            }
            continue
        }
        if ($t -match '^-\s+([A-Za-z][A-Za-z0-9_.]*):\s?(.*)$') {
            $key = $Matches[1]; $val = $Matches[2]
            # 列表项挂到最近的可挂容器（弹出更深/同层的 item 帧与更深的容器）。
            while ($stack.Count -gt 1) {
                $top = $stack[$stack.Count - 1]
                if ($top.Indent -gt $indent -or $top.Kind -eq "item") { $stack.RemoveAt($stack.Count - 1); continue }
                break
            }
            $target = $stack[$stack.Count - 1]
            $idx = $target.NextIndex
            $target.NextIndex = $idx + 1
            $itemPath = $target.Path + "[$idx]"
            $stack.Add([pscustomobject]@{ Indent = $indent; Path = $itemPath; Kind = "item"; NextIndex = 0 })
            $result[$itemPath + "." + $key] = ConvertFrom-Quoted $val
            continue
        }
        if ($t -match '^-\s+(.+)$') {
            $val = $Matches[1]
            while ($stack.Count -gt 1) {
                $top = $stack[$stack.Count - 1]
                if ($top.Indent -gt $indent -or $top.Kind -eq "item") { $stack.RemoveAt($stack.Count - 1); continue }
                break
            }
            $target = $stack[$stack.Count - 1]
            $idx = $target.NextIndex
            $target.NextIndex = $idx + 1
            $result[$target.Path + "[$idx]"] = ConvertFrom-Quoted $val
            continue
        }
        throw "YAML 第 ${lineNo} 行无法解析：$raw"
    }
    return $result
}

function Assert-Field {
    param($Map, [string]$Path, [string]$Expected, [string]$ManifestName)
    if (-not $Map.Contains($Path)) { throw "[$ManifestName] 解析回读缺少字段 $Path" }
    $actual = [string]$Map[$Path]
    if (-not [string]::Equals($actual, $Expected, [System.StringComparison]::Ordinal)) {
        throw "[$ManifestName] 字段 $Path = '$actual'，期望 '$Expected'"
    }
}

# ---------- manifest 组装（真实生成与自测共用此唯一路径） ----------
function New-ManifestFiles {
    param(
        [Parameter(Mandatory)][string]$OutputDir,
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+([+-][A-Za-z0-9.]+)?$')][string]$Ver,
        [Parameter(Mandatory)][string]$RepoSlug,
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')][string]$Tag,
        [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$Sha256,
        [Parameter(Mandatory)][string]$InstallerFileName,
        [string]$ReleaseDate = ""
    )
    if ($Sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw "SHA256 格式非法：$Sha256" }
    $publisher = "Pulse Windows Contributors"
    $productName = "Pulse for Windows"
    $shortDescription = "Windows AI coding allowance monitor"
    $repoUrl = "https://github.com/$RepoSlug"
    $installerUrl = "$repoUrl/releases/download/$Tag/$InstallerFileName"
    if ($installerUrl -notmatch '^https://github\.com/.+/releases/download/.+') {
        throw "InstallerUrl 非 GitHub Releases 形态：$installerUrl"
    }
    # NSIS（Tauri currentUser 安装）对 winget 的表达：InstallerType nullsoft、Scope user、/S 静默。
    $schemaInstaller = "https://aka.ms/winget-manifest.installer.$($script:ManifestVersionValue).schema.json"
    $schemaLocale = "https://aka.ms/winget-manifest.defaultLocale.$($script:ManifestVersionValue).schema.json"
    $schemaVersion = "https://aka.ms/winget-manifest.version.$($script:ManifestVersionValue).schema.json"
    $installer = @(
        "# yaml-language-server: `$schema=$schemaInstaller"
        "PackageIdentifier: $Id"
        "PackageVersion: $Ver"
        "Platform:"
        "- Windows.Desktop"
        "MinimumOSVersion: 10.0.17763.0"
        "InstallerType: nullsoft"
        "Scope: user"
        "InstallModes:"
        "- interactive"
        "- silent"
        "- silentWithProgress"
        "InstallerSwitches:"
        "  Silent: /S"
        "  SilentWithProgress: /S"
        "UpgradeBehavior: install"
        "Dependencies:"
        "  PackageDependencies:"
        "  - PackageIdentifier: Microsoft.EdgeWebView2Runtime"
    )
    if ($ReleaseDate) {
        if ($ReleaseDate -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "ReleaseDate 须为 yyyy-MM-dd：$ReleaseDate" }
        $installer += "ReleaseDate: $ReleaseDate"
    }
    $installer += @(
        "Installers:"
        "- Architecture: x64"
        "  InstallerUrl: $installerUrl"
        "  InstallerSha256: $Sha256"
        "  AppsAndFeaturesEntries:"
        "  - DisplayName: Pulse"
        "    DisplayVersion: $Ver"
        "    Publisher: $publisher"
        "ManifestType: installer"
        "ManifestVersion: $($script:ManifestVersionValue)"
    )
    $locale = @(
        "# yaml-language-server: `$schema=$schemaLocale"
        "PackageIdentifier: $Id"
        "PackageVersion: $Ver"
        "PackageLocale: en-US"
        "Publisher: $publisher"
        "PublisherUrl: $repoUrl"
        "PublisherSupportUrl: $repoUrl/issues"
        "PackageName: $productName"
        "PackageUrl: $repoUrl"
        "License: Apache-2.0"
        "LicenseUrl: $repoUrl/blob/$Tag/LICENSE"
        "Copyright: Copyright $((Get-Date).Year) Pulse Windows Contributors"
        "ShortDescription: $shortDescription"
        "Description: Lightweight and elegant screen-edge monitor for AI coding allowance on Windows. Pulse shows remaining quota and rate limits for 18+ AI coding providers including Claude Code, Codex, Cursor, Antigravity, Kimi Code and StepFun in real time, and provides local token usage auditing with cost estimation. Fully local-first with no telemetry; credentials are stored encrypted in Windows Credential Manager. Built with Tauri 2, Rust and React."
        "Tags:"
        "- ai"
        "- coding"
        "- quota"
        "- monitor"
        "- usage"
        "- tauri"
        "- developer-tools"
        "InstallationNotes: Runs fully locally with no telemetry; credentials are stored encrypted in Windows Credential Manager."
        "ReleaseNotesUrl: $repoUrl/releases/tag/$Tag"
        "ManifestType: defaultLocale"
        "ManifestVersion: $($script:ManifestVersionValue)"
    )
    $version = @(
        "# yaml-language-server: `$schema=$schemaVersion"
        "PackageIdentifier: $Id"
        "PackageVersion: $Ver"
        "DefaultLocale: en-US"
        "ManifestType: version"
        "ManifestVersion: $($script:ManifestVersionValue)"
    )

    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $files = [ordered]@{
        "$Id.yaml"                  = $version
        "$Id.installer.yaml"        = $installer
        "$Id.locale.en-US.yaml"     = $locale
    }
    $written = @()
    foreach ($name in $files.Keys) {
        $full = Join-Path $OutputDir $name
        # CRLF 落盘：winget-pkgs 的 .editorconfig 要求 [*] end_of_line = crlf（贡献者工作区规范；
        # 仓库 .gitattributes 的 "*.yaml text=auto" 会在提交时把内容规范化为 LF，两者不冲突）。
        [System.IO.File]::WriteAllText($full, (($files[$name] -join "`r`n") + "`r`n"), $utf8NoBom)
        $written += $full
    }
    return , $written
}

# 解析回读断言：对生成的三件 manifest 逐字段比对（winget 关键字段）。
function Assert-GeneratedManifests {
    param(
        [Parameter(Mandatory)][string]$OutputDir,
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Ver,
        [Parameter(Mandatory)][string]$RepoSlug,
        [Parameter(Mandatory)][string]$Tag,
        [Parameter(Mandatory)][string]$Sha256,
        [Parameter(Mandatory)][string]$InstallerFileName
    )
    $vMap = ConvertFrom-SimpleYaml -Text ([System.IO.File]::ReadAllText((Join-Path $OutputDir "$Id.yaml")))
    Assert-Field $vMap "PackageIdentifier" $Id "version"
    Assert-Field $vMap "PackageVersion" $Ver "version"
    Assert-Field $vMap "DefaultLocale" "en-US" "version"
    Assert-Field $vMap "ManifestType" "version" "version"
    Assert-Field $vMap "ManifestVersion" $script:ManifestVersionValue "version"

    $iMap = ConvertFrom-SimpleYaml -Text ([System.IO.File]::ReadAllText((Join-Path $OutputDir "$Id.installer.yaml")))
    Assert-Field $iMap "PackageIdentifier" $Id "installer"
    Assert-Field $iMap "PackageVersion" $Ver "installer"
    Assert-Field $iMap "InstallerType" "nullsoft" "installer"
    Assert-Field $iMap "Scope" "user" "installer"
    Assert-Field $iMap "UpgradeBehavior" "install" "installer"
    Assert-Field $iMap "InstallerSwitches.Silent" "/S" "installer"
    Assert-Field $iMap "Dependencies.PackageDependencies[0].PackageIdentifier" "Microsoft.EdgeWebView2Runtime" "installer"
    Assert-Field $iMap "Installers[0].Architecture" "x64" "installer"
    Assert-Field $iMap "Installers[0].InstallerUrl" "https://github.com/$RepoSlug/releases/download/$Tag/$InstallerFileName" "installer"
    Assert-Field $iMap "Installers[0].InstallerSha256" $Sha256 "installer"
    Assert-Field $iMap "ManifestType" "installer" "installer"
    Assert-Field $iMap "ManifestVersion" $script:ManifestVersionValue "installer"

    $lMap = ConvertFrom-SimpleYaml -Text ([System.IO.File]::ReadAllText((Join-Path $OutputDir "$Id.locale.en-US.yaml")))
    Assert-Field $lMap "PackageIdentifier" $Id "locale"
    Assert-Field $lMap "PackageVersion" $Ver "locale"
    Assert-Field $lMap "PackageLocale" "en-US" "locale"
    Assert-Field $lMap "PackageName" "Pulse for Windows" "locale"
    Assert-Field $lMap "License" "Apache-2.0" "locale"
    Assert-Field $lMap "ShortDescription" "Windows AI coding allowance monitor" "locale"
    Assert-Field $lMap "ReleaseNotesUrl" "https://github.com/$RepoSlug/releases/tag/$Tag" "locale"
    Assert-Field $lMap "ManifestType" "defaultLocale" "locale"
    Assert-Field $lMap "ManifestVersion" $script:ManifestVersionValue "locale"
}

# ---------- 从 SHA256SUMS.txt 解析安装包校验和（精确文件名、恰好一行、64 位十六进制） ----------
function Get-InstallerChecksum {
    param([Parameter(Mandatory)][string]$SumsPath, [Parameter(Mandatory)][string]$InstallerName)
    if (-not (Test-Path -LiteralPath $SumsPath)) { throw "未找到 SHA256SUMS.txt：$SumsPath" }
    # 兼容可能存在的 UTF-8 BOM：先整体读入再剥离，避免首行被 BOM 破坏锚定匹配。
    $raw = [System.IO.File]::ReadAllText($SumsPath)
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    $rows = @($raw -split "`r?`n" | Where-Object {
        $_ -match ('^([A-Fa-f0-9]{64})\s+\*?' + [regex]::Escape($InstallerName) + '\s*$')
    })
    if ($rows.Count -eq 0) { throw "SHA256SUMS.txt 中没有 $InstallerName 的条目" }
    if ($rows.Count -gt 1) { throw "SHA256SUMS.txt 中 $InstallerName 出现 $($rows.Count) 次，拒绝歧义" }
    return $rows[0].Substring(0, 64)
}

# ---------- 本地文件级复核：安装包实际哈希必须与 SUMS 条目一致，不一致即拒绝生成 ----------
# 抽成函数供主流程与自测共用：自测负向用例直接执行本拒绝分支（try/catch 断言必须 throw）。
function Assert-InstallerHashMatchesSums {
    param([Parameter(Mandatory)][string]$InstallerPath, [Parameter(Mandatory)][string]$ExpectedSha)
    $actual = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha) { throw "本地安装包哈希($actual)与 SHA256SUMS.txt($ExpectedSha)不一致，拒绝生成 manifest" }
    return $actual
}

# ---------- 内置自测：固定假 SHA 生成 + 逐字段断言 + 负向用例 ----------
function Invoke-SelfTest {
    Write-Host "[自测] 固定假 SHA 自测开始（fake sha = $($script:FakeSha)）..." -ForegroundColor Yellow
    $base = Join-Path ([System.IO.Path]::GetTempPath()) ("winget-selftest-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $failures = 0
    try {
        # 1) 正向：固定假 SHA 生成三件 manifest 并逐字段断言。
        $outDir = Join-Path $base "winget"
        $installerName = "Pulse-$($script:FakeVersion)-windows-x64-setup.exe"
        [System.IO.File]::WriteAllText((Join-Path $base "SHA256SUMS.txt"), "$($script:FakeSha)  $installerName`n")
        $sha = Get-InstallerChecksum -SumsPath (Join-Path $base "SHA256SUMS.txt") -InstallerName $installerName
        if ($sha -ne $script:FakeSha) { throw "自测失败：checksum 解析结果与固定假 SHA 不一致" }
        $written = New-ManifestFiles -OutputDir $outDir -Id "CNDDVP.PulseForWindows" -Ver $script:FakeVersion `
            -RepoSlug "CNDDVP/pulse-windows" -Tag "v$($script:FakeVersion)" -Sha256 $sha `
            -InstallerFileName $installerName -ReleaseDate "2020-01-01"
        $expectedNames = @("CNDDVP.PulseForWindows.yaml", "CNDDVP.PulseForWindows.installer.yaml", "CNDDVP.PulseForWindows.locale.en-US.yaml")
        foreach ($name in $expectedNames) {
            if (-not (Test-Path (Join-Path $outDir $name))) { throw "自测失败：未生成 $name" }
        }
        if ($written.Count -ne 3) { throw "自测失败：生成文件数 $($written.Count) != 3" }
        Assert-GeneratedManifests -OutputDir $outDir -Id "CNDDVP.PulseForWindows" -Ver $script:FakeVersion `
            -RepoSlug "CNDDVP/pulse-windows" -Tag "v$($script:FakeVersion)" -Sha256 $script:FakeSha `
            -InstallerFileName $installerName
        # 可选字段分支：ReleaseDate 传入时必须落盘为期望日期。
        $iMapTest = ConvertFrom-SimpleYaml -Text ([System.IO.File]::ReadAllText((Join-Path $outDir "CNDDVP.PulseForWindows.installer.yaml")))
        Assert-Field $iMapTest "ReleaseDate" "2020-01-01" "installer(自测)"
        # 与期望内容精确回读：安装包 URL 必须逐字等于 GitHub Releases 形态。
        $installerText = [System.IO.File]::ReadAllText((Join-Path $outDir "CNDDVP.PulseForWindows.installer.yaml"))
        if ($installerText -notmatch [regex]::Escape("InstallerUrl: https://github.com/CNDDVP/pulse-windows/releases/download/v$($script:FakeVersion)/$installerName")) {
            throw "自测失败：InstallerUrl 不符合期望的 GitHub Releases 形态"
        }
        Write-Host "[自测] 正向用例通过：三件 manifest 生成 + 解析回读逐字段一致" -ForegroundColor Green

        # 2) 负向：63 位假 SHA 必须被拒绝。
        $badSha = $script:FakeSha.Substring(0, 63)
        [System.IO.File]::WriteAllText((Join-Path $base "SHA256SUMS.txt"), "$badSha  $installerName`n")
        try {
            Get-InstallerChecksum -SumsPath (Join-Path $base "SHA256SUMS.txt") -InstallerName $installerName | Out-Null
            throw "自测失败：63 位假 SHA 未被拒绝"
        } catch {
            if ($_.Exception.Message -like "自测失败*") { throw }
            Write-Host "[自测] 负向用例通过：畸形 SHA 被拒绝（$($_.Exception.Message)）" -ForegroundColor Green
        }
        # 3) 负向：SUMS 与本地安装包实际哈希不一致时，主流程的拒绝分支必须 throw
        #    （直接调用主流程共用的 Assert-InstallerHashMatchesSums，钉死「会拒绝」而非仅「可检出」）。
        [System.IO.File]::WriteAllText((Join-Path $base "SHA256SUMS.txt"), "$($script:FakeSha)  $installerName`n")
        [System.IO.File]::WriteAllText((Join-Path $base $installerName), "not the real installer")
        try {
            Assert-InstallerHashMatchesSums -InstallerPath (Join-Path $base $installerName) -ExpectedSha $script:FakeSha | Out-Null
            throw "自测失败：哈希不一致未被拒绝"
        } catch {
            if ($_.Exception.Message -like "自测失败*") { throw }
            Write-Host "[自测] 负向用例通过：SUMS 与本地文件哈希不一致被拒绝（$($_.Exception.Message)）" -ForegroundColor Green
        }
        # 4) 负向：SUMS 缺失安装包条目必须被拒绝。
        [System.IO.File]::WriteAllText((Join-Path $base "SHA256SUMS.txt"), "$($script:FakeSha)  some-other-file.exe`n")
        try {
            Get-InstallerChecksum -SumsPath (Join-Path $base "SHA256SUMS.txt") -InstallerName $installerName | Out-Null
            throw "自测失败：缺失条目未被拒绝"
        } catch {
            if ($_.Exception.Message -like "自测失败*") { throw }
            Write-Host "[自测] 负向用例通过：缺失条目被拒绝（$($_.Exception.Message)）" -ForegroundColor Green
        }
    } catch {
        $failures++
        throw
    } finally {
        if ($failures -eq 0) { Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue }
    }
    Write-Host "[自测] 全部通过" -ForegroundColor Green
}

# ---------- 主流程 ----------
if ($SelfTest) {
    Invoke-SelfTest
    Write-Host "SelfTest-only 模式结束：未生成真实 manifest。" -ForegroundColor Cyan
    return
}

Invoke-SelfTest

# 版本来源唯一：显式参数 > BUILD_INFO.json；两者都有时必须一致。
$buildInfoPath = Join-Path $ArtDir "BUILD_INFO.json"
if (-not $Version) {
    if (-not (Test-Path $buildInfoPath)) { throw "未传 -Version 且找不到 $buildInfoPath" }
    $Version = [string]((Get-Content $buildInfoPath -Raw | ConvertFrom-Json).version)
} elseif (Test-Path $buildInfoPath) {
    $buildVersion = [string]((Get-Content $buildInfoPath -Raw | ConvertFrom-Json).version)
    if ($buildVersion -ne $Version) { throw "-Version=$Version 与 BUILD_INFO.json version=$buildVersion 不一致" }
}
if (-not $ReleaseTag) { $ReleaseTag = "v$Version" }

$installerName = "Pulse-$Version-windows-x64-setup.exe"
$sumsPath = Join-Path $ArtDir "SHA256SUMS.txt"
$sha = Get-InstallerChecksum -SumsPath $sumsPath -InstallerName $installerName
Write-Host "安装包：$installerName" -ForegroundColor Cyan
Write-Host "SHA256（来自 SHA256SUMS.txt）：$sha" -ForegroundColor Cyan

# 本地复核：若安装包文件在本机，实际哈希必须与 SUMS 条目一致。
$localInstaller = Join-Path $ArtDir $installerName
if (Test-Path -LiteralPath $localInstaller) {
    Assert-InstallerHashMatchesSums -InstallerPath $localInstaller -ExpectedSha $sha | Out-Null
    Write-Host "本地安装包哈希复核一致" -ForegroundColor Green
} else {
    Write-Warning "本机不存在 $installerName，跳过文件级复核（仅信任 SHA256SUMS.txt）"
}

# ReleaseDate 取自 BUILD_INFO.json built（UTC 日期），缺省时省略该可选字段。
$releaseDate = ""
if (Test-Path $buildInfoPath) {
    $built = [string]((Get-Content $buildInfoPath -Raw | ConvertFrom-Json).built)
    if ($built -match '^(\d{4}-\d{2}-\d{2})') { $releaseDate = $Matches[1] }
}

$outDir = Join-Path $ArtDir (Join-Path "winget" $Version)
$written = New-ManifestFiles -OutputDir $outDir -Id $PackageIdentifier -Ver $Version `
    -RepoSlug $Repo -Tag $ReleaseTag -Sha256 $sha -InstallerFileName $installerName -ReleaseDate $releaseDate
Assert-GeneratedManifests -OutputDir $outDir -Id $PackageIdentifier -Ver $Version `
    -RepoSlug $Repo -Tag $ReleaseTag -Sha256 $sha -InstallerFileName $installerName

# 外部校验（若本机装有 winget CLI）：对产物目录整体跑官方校验。
# 注意 winget validate 必须传目录——传单文件时官方 CLI 只加载该文件（winget-cli
# YamlParser CreateFromPath 仅对目录做枚举），会误报 "multi file manifest is incomplete"。
$wingetCli = Get-Command winget -ErrorAction SilentlyContinue
if ($wingetCli) {
    Write-Host ""
    Write-Host "运行 winget validate（官方 CLI，目录模式）..." -ForegroundColor Yellow
    & winget validate $outDir
    if ($LASTEXITCODE -ne 0) { throw "winget validate 失败（exit=$LASTEXITCODE）：$outDir" }
    Write-Host "winget validate 通过" -ForegroundColor Green
} else {
    Write-Warning "本机无 winget CLI，跳过官方校验（提交前请在装有 winget 的机器执行: winget validate $outDir）"
}

Write-Host ""
Write-Host "生成完成（解析回读断言通过）：" -ForegroundColor Green
foreach ($f in $written) { Write-Host "  $f" -ForegroundColor Green }
Write-Host ""
Write-Host "后续人工提交步骤见 docs/WINGET_SUBMISSION.md（fork microsoft/winget-pkgs → 放入 manifests/c/CNDDVP/PulseForWindows/$Version/ → PR）。" -ForegroundColor Cyan
