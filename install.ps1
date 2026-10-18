# Install a self-managed GitHub Releases build. Configuration remains in ~/.amira.
[CmdletBinding()]
param(
    [string]$Version = '',
    [ValidateSet('stable', 'next')][string]$Channel = 'stable'
)
$ErrorActionPreference = 'Stop'
function Get-ArchiveHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Enter-RetentionGate([string]$Root) {
    $gatePath = Join-Path $Root 'retention.lock'
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        try { $gate = [IO.File]::Open($gatePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
        catch [IO.IOException] { Start-Sleep -Milliseconds 10; continue }
        try {
            $bytes = [Text.Encoding]::ASCII.GetBytes("$PID`n")
            $gate.Write($bytes, 0, $bytes.Length)
            $gate.Flush()
            return $gate
        } catch { $gate.Dispose(); Remove-Item -LiteralPath $gatePath -Force; throw }
    }
    throw 'Amira version retention is busy; try again'
}
function Exit-RetentionGate($Gate, [string]$Root) {
    if ($null -ne $Gate) {
        $Gate.Dispose()
        Remove-Item -LiteralPath (Join-Path $Root 'retention.lock') -Force
    }
}
$releases = 'https://github.com/CAMB-dev/Amira/releases'
$publicKey = '' # AMIRA_RELEASE_PUBLIC_KEY
$versionPattern = '\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?\z'
$Version = $Version -replace '^v', ''
$Channel = $Channel.ToLowerInvariant()
if ($Version -and $Version -cnotmatch $versionPattern) { throw 'Invalid version' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set' }
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'Windows x64 is the only supported Windows architecture'
}
$target = 'bun-windows-x64-baseline'
$root = Join-Path $env:LOCALAPPDATA 'Amira'
$versions = Join-Path $root 'versions'
$binDirectory = Join-Path $root 'bin'
$bin = Join-Path $binDirectory 'amira.exe'
New-Item -ItemType Directory -Force -Path $versions, $binDirectory | Out-Null
$lockPath = Join-Path $root 'update.lock'
try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
catch { throw 'Another Amira installation or update is in progress' }
$staging = Join-Path $root ('.staging.' + [guid]::NewGuid().ToString('N'))
$retention = $null
try {
    $lockBytes = [Text.Encoding]::ASCII.GetBytes("$PID`n")
    $lock.Write($lockBytes, 0, $lockBytes.Length)
    $lock.Flush()
    New-Item -ItemType Directory -Path $staging | Out-Null
    $base = "$releases/latest/download"
    if ($Channel -eq 'next') { $base = 'https://raw.githubusercontent.com/CAMB-dev/Amira/update-channels/next' }
    if ($Version) { $base = "$releases/download/v$Version" }
    $manifestPath = Join-Path $staging 'manifest.json'
    Invoke-WebRequest -UseBasicParsing -Uri "$base/manifest.json" -OutFile $manifestPath
    if ($publicKey) {
        $openssl = Get-Command openssl -ErrorAction SilentlyContinue
        $canVerify = $false
        if ($openssl) {
            $opensslVersion = & openssl version
            # OpenSSL 3 provides pkeyutl -rawin for Ed25519. LibreSSL/older versions do not.
            $canVerify = $LASTEXITCODE -eq 0 -and $opensslVersion -match '^OpenSSL ([3-9]|[1-9][0-9]+)\.'
        }
        if ($canVerify) {
            $signaturePath = Join-Path $staging 'signature'
            $signatureText = Join-Path $staging 'signature.base64'
            $keyPath = Join-Path $staging 'public.pem'
            Invoke-WebRequest -UseBasicParsing -Uri "$base/manifest.json.sig" -OutFile $signatureText
            [IO.File]::WriteAllText($keyPath, $publicKey, [Text.Encoding]::ASCII)
            $encoded = [IO.File]::ReadAllText($signatureText).Trim()
            if ($encoded -notmatch '^[A-Za-z0-9+/]{86}==$') { throw 'Invalid manifest signature' }
            [IO.File]::WriteAllBytes($signaturePath, [Convert]::FromBase64String($encoded))
            & openssl pkeyutl -verify -pubin -inkey $keyPath -rawin -in $manifestPath -sigfile $signaturePath
            if ($LASTEXITCODE -ne 0) { throw 'Manifest signature verification failed' }
        } else {
            Write-Warning 'OpenSSL Ed25519 verification is unavailable; checking SHA-256 only, not the manifest signature.'
        }
    } else {
        Write-Warning 'No release public key is configured; checking SHA-256 only. Self-updates will be disabled.'
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.version -isnot [string] -or $manifest.version -cnotmatch $versionPattern) { throw 'Invalid manifest version' }
    if ($Version -and $manifest.version -ne $Version) { throw 'Manifest version mismatch' }
    if ($manifest.channel -cne $Channel) { throw 'Manifest channel mismatch' }
    $Version = $manifest.version
    if ($Channel -eq 'stable' -and $Version.Contains('-')) { throw 'Stable manifest contains a prerelease version' }
    $archiveName = "amira-$target.zip"
    $entries = @($manifest.artifacts | Where-Object { $_.target -ceq $target })
    if ($entries.Count -ne 1 -or $entries[0].file -cne $archiveName -or $entries[0].sha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'No valid manifest entry for this platform' }
    $size = $entries[0].size
    if (($size -isnot [int] -and $size -isnot [long]) -or $size -le 0 -or $size -gt 536870912) { throw 'Invalid archive size in manifest' }
    $archive = Join-Path $staging 'archive.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "$releases/download/v$Version/$archiveName" -OutFile $archive
    if ((Get-Item -LiteralPath $archive).Length -ne $size) { throw 'Archive size mismatch' }
    if ((Get-ArchiveHash $archive) -ne $entries[0].sha256) { throw 'Archive SHA-256 mismatch' }
    $versionDirectory = Join-Path $staging 'version'
    New-Item -ItemType Directory -Path $versionDirectory | Out-Null
    # Only extract the expected executable; never unpack arbitrary paths from an archive.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entry = $zip.GetEntry('amira.exe')
        if (-not $entry -or $zip.Entries.Count -ne 1) { throw 'Archive must contain only the executable' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $versionDirectory 'amira.exe'))
    } finally { $zip.Dispose() }
    $candidate = Join-Path $versionDirectory 'amira.exe'
    $probed = & $candidate --version
    if ($LASTEXITCODE -ne 0 -or ($probed -join "`n").Split(' ')[0] -ne $Version) { throw 'Executable version mismatch' }
    # No networking under the short gate shared with session lease registration and pruning.
    $retention = Enter-RetentionGate $root
    $destination = Join-Path $versions $Version
    if (Test-Path -LiteralPath $destination) {
        if ((Get-ArchiveHash $candidate) -ne (Get-ArchiveHash (Join-Path $destination 'amira.exe'))) {
            throw 'Existing version differs; refusing to overwrite it'
        }
    } else { Move-Item -LiteralPath $versionDirectory -Destination $destination }
    $marker = Join-Path $staging 'install.json'
    $markerJson = @{ kind = 'single-file'; version = $Version; channel = $Channel; target = $target; bin = $bin } | ConvertTo-Json
    [IO.File]::WriteAllText($marker, $markerJson, (New-Object Text.UTF8Encoding $false))
    $old = "$bin.old.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).$PID"
    $renamed = $false
    $copyStarted = $false
    if ([IO.Directory]::Exists((Join-Path $root 'install.json'))) { throw 'The install marker path is a directory' }
    try {
        if (Test-Path -LiteralPath $bin) { Move-Item -LiteralPath $bin -Destination $old; $renamed = $true }
        $copyStarted = $true
        Copy-Item -LiteralPath (Join-Path $destination 'amira.exe') -Destination $bin
        Move-Item -LiteralPath $marker -Destination (Join-Path $root 'install.json') -Force
    } catch {
        if ($copyStarted) { Remove-Item -LiteralPath $bin -Force -ErrorAction SilentlyContinue }
        if ($renamed) { Move-Item -LiteralPath $old -Destination $bin }
        throw
    }
    Get-ChildItem -LiteralPath $binDirectory -Filter 'amira.exe.old.*' | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
    # Shared leases/<version>/<unique>.lease records protect older live sessions too.
    function Test-VersionInUse([string]$LeaseVersion) {
        $leaseRoot = Join-Path $root 'leases'
        try {
            try { $leaseRootInfo = Get-Item -LiteralPath $leaseRoot -Force -ErrorAction Stop }
            catch [System.Management.Automation.ItemNotFoundException] { return $false }
            if (-not $leaseRootInfo.PSIsContainer -or ($leaseRootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $true }
            $leaseDirectories = @(Get-ChildItem -LiteralPath $leaseRoot -Force -ErrorAction Stop)
            foreach ($leaseDirectory in $leaseDirectories) {
                if (-not $leaseDirectory.PSIsContainer -or $leaseDirectory.Name -cnotmatch $versionPattern -or ($leaseDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $true }
            }
            $leaseDirectory = Join-Path $leaseRoot $LeaseVersion
            if (-not @($leaseDirectories | Where-Object Name -CEQ $LeaseVersion).Count) { return $false }
            foreach ($leaseFile in @(Get-ChildItem -LiteralPath $leaseDirectory -Force -ErrorAction Stop)) {
                if ($leaseFile.PSIsContainer -or $leaseFile.Extension -cne '.lease' -or ($leaseFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $true }
                $lines = [IO.File]::ReadAllText($leaseFile.FullName).Split("`n")
                $leasePid = 0
                if ($lines.Count -ne 5 -or $lines[0] -cne 'amira-version-lease-v1' -or
                    $lines[1] -cne [Environment]::MachineName.ToLowerInvariant() -or
                    $lines[2] -cnotmatch '\A[1-9][0-9]*\z' -or -not [int]::TryParse($lines[2], [ref]$leasePid) -or
                    $lines[3] -cne $LeaseVersion -or $lines[4] -cne '') { return $true }
                try {
                    $owner = [Diagnostics.Process]::GetProcessById($leasePid)
                    $owner.Dispose()
                    return $true
                } catch [ArgumentException] {
                    # A proven dead local owner may be retired; every other error retains it.
                    Remove-Item -LiteralPath $leaseFile.FullName -Force -ErrorAction Stop
                }
            }
            return $false
        } catch { return $true }
    }
    Get-ChildItem -LiteralPath $versions -Directory | Where-Object { $_.Name -cne $Version -and $_.Name -cmatch $versionPattern -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 2 | ForEach-Object {
            if (-not (Test-VersionInUse $_.Name)) {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    Exit-RetentionGate $retention $root
    $retention = $null
    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if ($binDirectory -notin ($userPath -split ';')) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDirectory).TrimStart(';'), 'User')
    }
    Write-Output "Installed Amira $Version ($Channel). Open a new terminal to use amira."
} finally {
    try {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    } finally {
        try { Exit-RetentionGate $retention $root }
        finally {
            $lock.Dispose()
            Remove-Item -LiteralPath $lockPath -Force
        }
    }
}
