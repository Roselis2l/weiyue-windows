#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$ElectronVersion = '44.9.0',
    [ValidatePattern('^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$')]
    [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DistributionRoot = Join-Path $ProjectRoot $OutputDirectory
$PortableName = 'WeiYue-Windows-x64'
$PortableRoot = Join-Path $DistributionRoot $PortableName
$PortableZip = Join-Path $DistributionRoot ($PortableName + '.zip')
$SourceZip = Join-Path $DistributionRoot 'WeiYue-Source.zip'
$ArchiveName = 'electron-v' + $ElectronVersion + '-win32-x64.zip'
$ArchivePath = Join-Path $ProjectRoot ('vendor\' + $ArchiveName)
$ChecksumsPath = Join-Path $ProjectRoot 'vendor\SHASUMS256.txt'
$SourceWhitelist = @('app', 'tests', 'scripts', 'docs', 'package.json', 'README.md', 'LICENSE', 'CONTRACT.md')

function Assert-SafeSourceTree([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    $Items = @($Item)
    if ($Item.PSIsContainer) { $Items += @(Get-ChildItem -LiteralPath $Path -Recurse -Force) }
    foreach ($Entry in $Items) {
        if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ('Packaging does not follow reparse points: ' + $Entry.FullName)
        }
        if ($Entry.Name -match '^(data|\.local-data|credentials|node_modules|vendor|\.git|artifacts|dist)$' -or
            $Entry.Name -match '^\.env(?:\.|$)' -or
            $Entry.Name -match '^(cookies?|tokens?|credentials)\.json$' -or
            $Entry.Name -match '^account-[a-f0-9]{64}\.json$' -or
            $Entry.Extension -match '^\.(pem|key|pfx|p12)$') {
            throw ('Private or generated content is not allowed in source inputs: ' + $Entry.FullName)
        }
    }
}

foreach ($Relative in $SourceWhitelist) {
    $Source = Join-Path $ProjectRoot $Relative
    if (-not (Test-Path -LiteralPath $Source)) { throw ('Required source input is missing: ' + $Relative) }
    Assert-SafeSourceTree $Source
}
foreach ($Relative in @('app\main.cjs', 'app\preload.cjs', 'app\renderer\index.html', 'app\renderer\app.js', 'app\renderer\style.css', 'docs\REFERENCE-LICENSE.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $Relative) -PathType Leaf)) { throw ('Required application file is missing: ' + $Relative) }
}
# Edition identity is part of the reviewed source tree, not a CLI/runtime flag.
# This common packager never discovers or copies private modules or overlays.
$EditionJson = & node (Join-Path $PSScriptRoot 'lib\build-edition.cjs') (Join-Path $ProjectRoot 'app\edition.json')
if ($LASTEXITCODE -ne 0) { throw 'Edition metadata validation failed. No application was packaged.' }
$Edition = ($EditionJson -join [Environment]::NewLine) | ConvertFrom-Json
foreach ($Existing in @($PortableRoot, $PortableZip, $SourceZip, (Join-Path $DistributionRoot 'SHA256SUMS.txt'))) {
    if (Test-Path -LiteralPath $Existing) { throw ('Output already exists; preserve it and choose a clean build workspace before retrying: ' + $Existing) }
}
if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw ('Official Electron archive is missing: ' + $ArchivePath) }
if (-not (Test-Path -LiteralPath $ChecksumsPath -PathType Leaf)) { throw 'vendor/SHASUMS256.txt is missing.' }

$ChecksumLines = @(Get-Content -LiteralPath $ChecksumsPath -Encoding UTF8 | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [Regex]::Escape($ArchiveName) + '$') })
if ($ChecksumLines.Count -ne 1) { throw ('Expected exactly one checksum entry for ' + $ArchiveName) }
$ExpectedHash = ($ChecksumLines[0] -split '\s+')[0].ToLowerInvariant()
$ActualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualHash -ne $ExpectedHash) { throw 'Electron SHA256 verification failed. No application was packaged.' }
Write-Host ('Verified official Electron archive: ' + $ArchiveName)

if (-not (Test-Path -LiteralPath $DistributionRoot)) { New-Item -ItemType Directory -Path $DistributionRoot | Out-Null }
if ((Get-Item -LiteralPath $DistributionRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The dist directory must not be a reparse point.' }
New-Item -ItemType Directory -Path $PortableRoot | Out-Null
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $PortableRoot

$ElectronExe = Join-Path $PortableRoot 'electron.exe'
if (-not (Test-Path -LiteralPath $ElectronExe -PathType Leaf)) { throw 'The verified archive does not contain electron.exe.' }
Rename-Item -LiteralPath $ElectronExe -NewName 'WeiYue.exe'
$AppRoot = Join-Path $PortableRoot 'resources\app'
New-Item -ItemType Directory -Path $AppRoot | Out-Null
foreach ($Relative in @('package.json', 'app', 'docs', 'README.md', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $Relative) -Destination $AppRoot -Recurse
}
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'docs') -Destination $PortableRoot -Recurse
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'README.md') -Destination $PortableRoot
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'LICENSE') -Destination (Join-Path $PortableRoot 'LICENSE-WeiYue.txt')
# Preserve the upstream Electron LICENSE and LICENSES.chromium.html untouched.
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'docs\REFERENCE-LICENSE.txt') -Destination (Join-Path $PortableRoot 'LICENSE-Reference-WeiYue.txt')
$BuildInfo = [ordered]@{
    application = 'WeiYue Windows'
    applicationVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    edition = $Edition.id
    editionLabel = $Edition.label
    editionMetadataSha256 = $Edition.sha256
    electronVersion = $ElectronVersion
    electronArchive = $ArchiveName
    electronSha256 = $ActualHash
    referenceCommit = '7b6c7203490b9110f3b109e53b0e24b4aad1ccac'
    platform = 'win32-x64'
    packagedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$BuildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PortableRoot 'BUILD-INFO.json') -Encoding UTF8

Compress-Archive -LiteralPath $PortableRoot -DestinationPath $PortableZip -CompressionLevel Optimal
$SourceInputs = @($SourceWhitelist | ForEach-Object { Join-Path $ProjectRoot $_ })
Compress-Archive -LiteralPath $SourceInputs -DestinationPath $SourceZip -CompressionLevel Optimal
$Hashes = foreach ($Item in @($PortableZip, $SourceZip)) {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $Item -Algorithm SHA256).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($Item)
}
$Hashes | Set-Content -LiteralPath (Join-Path $DistributionRoot 'SHA256SUMS.txt') -Encoding ASCII
Write-Host ('Portable folder: ' + $PortableRoot)
Write-Host ('Portable ZIP:    ' + $PortableZip)
Write-Host ('Source ZIP:      ' + $SourceZip)
Write-Host 'Build complete. Run WeiYue.exe and complete the Windows UI acceptance checks before release.'
