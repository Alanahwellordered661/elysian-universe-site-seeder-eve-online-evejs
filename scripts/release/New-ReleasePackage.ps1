param(
    [string]$PackageName = "Elysian-Universe-Site-Seeder",
    [switch]$SkipBuild,
    [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$script:Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:DistRoot = Join-Path $script:Root "release"
$script:PackageRoot = Join-Path $script:DistRoot $PackageName

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $full = Resolve-FullPath -Path $Path
    $parentFull = (Resolve-FullPath -Path $Parent).TrimEnd("\")
    if ($full -eq $parentFull) {
        return $full
    }

    $expectedPrefix = "$parentFull\"
    if (-not $full.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to operate outside the release workspace: $full"
    }

    return $full
}

function Copy-AllowlistedFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $source = Join-Path $script:Root $RelativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing required release file: $RelativePath"
    }

    $destination = Join-Path $script:PackageRoot $RelativePath
    $destinationParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Ensure-ReleaseBinary {
    $exe = Join-Path $script:Root "bin\UniverseSiteSeeder.exe"
    if ($SkipBuild) {
        if (Test-Path -LiteralPath $exe -PathType Leaf) {
            return
        }

        throw "Release binary is missing from bin. Run Install.bat or rerun this script without -SkipBuild."
    }

    $cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
    if (-not $cargo) {
        throw "cargo.exe was not found. Run Install.bat first so Rust and MSVC tools are checked."
    }

    Push-Location $script:Root
    try {
        & $cargo.Source build --release --locked
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $script:Root "bin") | Out-Null
    Copy-Item -LiteralPath (Join-Path $script:Root "target\release\universe-site-seed.exe") -Destination $exe -Force
}

Ensure-ReleaseBinary

$releaseFull = Assert-ChildPath -Path $script:DistRoot -Parent $script:Root
$packageFull = Assert-ChildPath -Path $script:PackageRoot -Parent $releaseFull

if (Test-Path -LiteralPath $packageFull) {
    Remove-Item -LiteralPath $packageFull -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $packageFull | Out-Null

$releaseFiles = @(
    "Install.bat",
    "StartUniverseSeeder.bat",
    "README.md",
    "NOTICE",
    "LICENSE",
    "AUTHORS.md",
    "assets\readme\hero-universe-site-seeder-v1.svg",
    "assets\readme\universe-scale-v1.svg",
    "assets\readme\install-one-click-v1.svg",
    "assets\readme\evejs-site-flow-v1.svg",
    "assets\readme\unix-quickstart-v1.svg",
    "assets\readme\checks-v1.svg",
    "assets\screenshots\universe-site-seeder-app.png",
    "scripts\windows\Install-ElysianUniverseSeeder.ps1",
    "scripts\windows\StartUniverseSeeder.ps1",
    "bin\UniverseSiteSeeder.exe"
)

foreach ($file in $releaseFiles) {
    Copy-AllowlistedFile -RelativePath $file
}

if (-not $NoZip) {
    $zipPath = Join-Path $script:DistRoot "$PackageName.zip"
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $packagePrefix = $packageFull.TrimEnd("\")
        $files = Get-ChildItem -LiteralPath $packageFull -Recurse -File -Force
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($packagePrefix.Length + 1).Replace("\", "/")
            $entryName = "$PackageName/$relative"
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip,
                $file.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally {
        $zip.Dispose()
    }

    Write-Host "Release zip created: $zipPath" -ForegroundColor Green
}

Write-Host "Release folder created: $packageFull" -ForegroundColor Green
