# bump-version.ps1 — 结构化版本升级（替代文本替换）
# 用法: .\scripts\bump-version.ps1 0.3.8
#
# 设计要点（对应两次 Cargo.lock 损坏事故 dtoa-short / field-offset 的根因修复）：
#   1. JSON 文件（package.json / package-lock.json / tauri.conf.json）走结构化解析回写，绝不做字符串替换。
#   2. Cargo.toml 仅锚定行首唯一的 package version 行。
#   3. Cargo.lock 完全不手工编辑 —— 由 `cargo update -w` 从 Cargo.toml 重新解析生成。
#   4. 前后快照对比 lock 的全部 (name, version)：除 pulse-windows 外任何条目变化都立即回滚并中止。
#      （这正是文本替换事故的检测器：dtoa-short 0.3.5→0.3.6、field-offset 0.3.6→0.3.7 都会被拦下。）
#   5. 结束时校验四处（package.json / package-lock.json / tauri.conf.json / Cargo.lock）一致。

#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$NewVersion
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if ($NewVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "版本号必须是 x.y.z 形式，收到: $NewVersion"
}

function Get-LockSnapshot([string]$Path) {
    # Cargo.lock [[package]] 块 -> "name@version" 列表
    $out = @(); $name = $null
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^name = "(.+)"') { $name = $Matches[1] }
        elseif ($line -match '^version = "(.+)"') {
            if ($name) { $out += "$name@$($Matches[1])"; $name = $null }
        }
    }
    return $out
}
function Get-JsonVersion([string]$Path) {
    # PS 5.1 的 ConvertFrom-Json 无法解析 package-lock v3 的空键 "packages": { "": ... }，
    # 统一走 node 的 JSON 引擎（结构化解析，与文件格式无关）。
    $v = node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version))" $Path
    if ($LASTEXITCODE -ne 0) { throw "读取 $Path 的 version 失败" }
    return $v
}

Write-Host "== bump-version: $($MyInvocation.MyCommand.Name) -> $NewVersion ==" -ForegroundColor Cyan

# ---- 0) 升级前快照 ----
$lockPath = "$Root/src-tauri/Cargo.lock"
$before = Get-LockSnapshot $lockPath
$oldVersion = Get-JsonVersion "$Root/package.json"
if ($oldVersion -eq $NewVersion) {
    Write-Host "版本已是 $NewVersion，仅做一致性校验。" -ForegroundColor Yellow
}

# ---- 1) package.json + package-lock.json: npm 原生结构化 ----
Push-Location $Root
npm version $NewVersion --no-git-tag-version --allow-same-version | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm version 失败" }
Pop-Location

# ---- 2) tauri.conf.json: JSON 解析回写（node，保持 2 空格缩进与无 BOM） ----
$confPath = "$Root/src-tauri/tauri.conf.json"
node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=process.argv[2];fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');" $confPath $NewVersion
if ($LASTEXITCODE -ne 0) { throw "tauri.conf.json 回写失败" }

# ---- 3) Cargo.toml: 锚定唯一的行首 package version ----
$cargoPath = "$Root/src-tauri/Cargo.toml"
$cargo = [System.IO.File]::ReadAllText($cargoPath)
$pattern = '(?m)^version = "\d+\.\d+\.\d+"'
$hits = [regex]::Matches($cargo, $pattern)
if ($hits.Count -ne 1) {
    throw "Cargo.toml 行首 version 应有且仅有 1 处，实际 $($hits.Count) 处，中止（未写入任何文件）"
}
$cargo = [regex]::Replace($cargo, $pattern, "version = `"$NewVersion`"")
[System.IO.File]::WriteAllText($cargoPath, $cargo, (New-Object System.Text.UTF8Encoding($false)))

# ---- 4) Cargo.lock: 重新解析（绝不文本替换） ----
Push-Location "$Root/src-tauri"
cargo update -w
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "cargo update -w 失败" }
Pop-Location

# ---- 5) 附带损伤检测：lock 中除 pulse-windows 外不得有任何 (name,version) 变化 ----
$after = Get-LockSnapshot $lockPath
$drift = Compare-Object ($before | Sort-Object) ($after | Sort-Object)
$unexpected = @($drift | Where-Object { $_.InputObject -notmatch '^pulse-windows@' })
if ($unexpected.Count -gt 0) {
    Write-Host "检测到 pulse-windows 之外的 lock 条目变化，自动回滚 Cargo.lock：" -ForegroundColor Red
    $unexpected | ForEach-Object { Write-Host "  $($_.SideIndicator) $($_.InputObject)" -ForegroundColor Red }
    Push-Location $Root
    git checkout -- src-tauri/Cargo.lock
    Pop-Location
    throw "lock 附带损伤，已回滚；请勿用文本替换修改 Cargo.lock"
}

# ---- 6) 四处一致性终检 ----
$vPkg  = Get-JsonVersion "$Root/package.json"
$vLock = Get-JsonVersion "$Root/package-lock.json"
$vConf = Get-JsonVersion $confPath
$vToml = ([regex]::Match([System.IO.File]::ReadAllText($cargoPath), '(?m)^version = "(.+?)"')).Groups[1].Value
# Cargo.lock 中 pulse-windows 条目
$vCargoLock = $null; $name = $null
foreach ($line in [System.IO.File]::ReadAllLines($lockPath)) {
    if ($line -match '^name = "(.+)"') { $name = $Matches[1] }
    elseif ($line -match '^version = "(.+)"' -and $name -eq 'pulse-windows') { $vCargoLock = $Matches[1]; break }
}
$all = @(
    @{ n = 'package.json';        v = $vPkg },
    @{ n = 'package-lock.json';   v = $vLock },
    @{ n = 'tauri.conf.json';     v = $vConf },
    @{ n = 'Cargo.toml';          v = $vToml },
    @{ n = 'Cargo.lock (自身)';    v = $vCargoLock }
)
$bad = @($all | Where-Object { $_.v -ne $NewVersion })
if ($bad.Count -gt 0) {
    $bad | ForEach-Object { Write-Host "  不一致: $($_.n) = $($_.v)" -ForegroundColor Red }
    throw "版本一致性校验失败"
}
$all | ForEach-Object { Write-Host ("  [OK] {0} = {1}" -f $_.n, $_.v) -ForegroundColor Green }
Write-Host "== 版本已结构化升级到 $NewVersion（lock 无附带损伤）==" -ForegroundColor Green
