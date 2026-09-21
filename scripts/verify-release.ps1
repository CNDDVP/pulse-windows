param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
$dir = (Resolve-Path -LiteralPath $Directory).Path
$required = @("Pulse-$Version-windows-x64-setup.exe", "Pulse-$Version-windows-x64-portable.zip", 'BUILD_INFO.txt', 'DEPENDENCIES.txt')
$lines = Get-Content -LiteralPath (Join-Path $dir 'SHA256SUMS.txt')
foreach ($name in $required) {
    $matchesForFile = @($lines | Where-Object { $_ -match ('^[A-Fa-f0-9]{64}\s+\*?' + [regex]::Escape($name) + '$') })
    if ($matchesForFile.Count -ne 1) { throw "Missing/duplicate checksum: $name" }
    $file = Join-Path $dir $name
    if ((Get-Item -LiteralPath $file).Length -le 0) { throw "Empty asset: $name" }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $matchesForFile[0].Substring(0,64)) { throw "SHA256 mismatch: $name" }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $dir "Pulse-$Version-windows-x64-portable.zip"))
try {
    $allow = @('Pulse.exe','portable.flag','README-portable.zh-CN.md','LICENSE','NOTICE','BUILD_INFO.json','BUILD_INFO.txt')
    if ($zip.Entries.Count -ne $allow.Count) { throw 'Portable file count mismatch' }
    foreach ($name in $allow) { if (@($zip.Entries | Where-Object FullName -CEQ $name).Count -ne 1) { throw "Missing/duplicate portable file: $name" } }
    $reader = [IO.StreamReader]::new($zip.GetEntry('BUILD_INFO.json').Open())
    try { $info = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($info.version -ne $Version -or $info.product -ne 'Pulse for Windows' -or $info.target -ne 'x86_64-pc-windows-msvc') { throw 'Portable build metadata mismatch' }
    $stream = $zip.GetEntry('Pulse.exe').Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
    if ($hash -ne $info.exe_sha256) { throw 'Portable EXE hash mismatch' }
} finally { $zip.Dispose() }
Write-Host "Verified release v${Version}: asset hashes, portable whitelist and build identity."
