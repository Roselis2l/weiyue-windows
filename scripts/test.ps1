#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$NodePath = 'node'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$NodeCommand = Get-Command $NodePath -ErrorAction Stop
$NodeExecutable = $NodeCommand.Source
if (-not $NodeExecutable) { throw 'Cannot resolve the Node.js executable.' }

$NodeVersion = & $NodeExecutable -p 'process.versions.node'
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the Node.js version.' }
if ([int]($NodeVersion.Split('.')[0]) -lt 22) { throw 'Node.js 22 or later is required.' }

$TestFiles = @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'tests') -File -Filter '*.test.cjs' | Sort-Object Name | ForEach-Object { $_.FullName })
if ($TestFiles.Count -eq 0) { throw 'No test files were found. Refusing to report success.' }

Write-Host ('Node.js {0}; running {1} test files.' -f $NodeVersion, $TestFiles.Count)
Push-Location -LiteralPath $ProjectRoot
try {
    & $NodeExecutable --test @TestFiles
    if ($LASTEXITCODE -ne 0) { throw ('Tests failed with exit code {0}.' -f $LASTEXITCODE) }
} finally {
    Pop-Location
}
Write-Host 'Tests passed. Packaged Windows startup and visual checks are separate acceptance steps.'
