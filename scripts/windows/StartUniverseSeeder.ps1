param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AppArgs
)

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$exe = Join-Path $root "bin\UniverseSiteSeeder.exe"
$config = Join-Path $root "config\evejs.path"
$installer = Join-Path $root "scripts\windows\Install-ElysianUniverseSeeder.ps1"

if ((-not (Test-Path -LiteralPath $exe -PathType Leaf)) -or (-not (Test-Path -LiteralPath $config -PathType Leaf))) {
    & $installer -NoLaunch
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$eveJsRoot = (Get-Content -LiteralPath $config -TotalCount 1).Trim()
if (-not $eveJsRoot -or -not (Test-Path -LiteralPath $eveJsRoot -PathType Container)) {
    & $installer -NoLaunch
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    $eveJsRoot = (Get-Content -LiteralPath $config -TotalCount 1).Trim()
}

$oldEveJsRoot = $env:EVEJS_REPO_ROOT
$env:EVEJS_REPO_ROOT = $eveJsRoot
Push-Location $root
try {
    & $exe @AppArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
    $env:EVEJS_REPO_ROOT = $oldEveJsRoot
}
