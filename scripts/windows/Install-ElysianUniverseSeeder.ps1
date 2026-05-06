param(
    [string]$EveJsPath,
    [switch]$SkipBuild,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$script:Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:BinDir = Join-Path $script:Root "bin"
$script:Exe = Join-Path $script:BinDir "UniverseSiteSeeder.exe"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ("  -> {0}" -f $Message) -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("  [!] {0}" -f $Message) -ForegroundColor Yellow
}

function Resolve-Tool {
    param([string]$Name)
    $resolved = Get-Command $Name -ErrorAction SilentlyContinue
    if ($resolved -and $resolved.Source) {
        return $resolved.Source
    }
    return $null
}

function Resolve-Winget {
    $local = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\winget.exe"
    if (Test-Path -LiteralPath $local -PathType Leaf) {
        return $local
    }
    return (Resolve-Tool -Name "winget.exe")
}

function Resolve-Cargo {
    $preferred = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
    if (Test-Path -LiteralPath $preferred -PathType Leaf) {
        return $preferred
    }
    return (Resolve-Tool -Name "cargo.exe")
}

function Resolve-Rustup {
    $preferred = Join-Path $env:USERPROFILE ".cargo\bin\rustup.exe"
    if (Test-Path -LiteralPath $preferred -PathType Leaf) {
        return $preferred
    }
    return (Resolve-Tool -Name "rustup.exe")
}

function Resolve-Node {
    $node = Resolve-Tool -Name "node.exe"
    if ($node) {
        return $node
    }
    $programFilesNode = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (Test-Path -LiteralPath $programFilesNode -PathType Leaf) {
        return $programFilesNode
    }
    return $null
}

function Ensure-Node {
    $node = Resolve-Node
    if ($node) {
        $version = & $node --version
        Write-Host ("  Node.js {0}" -f $version)
        $major = 0
        if ($version -match "^v(\d+)") {
            $major = [int]$Matches[1]
        }
        if ($major -lt 18) {
            Write-Warn "Node.js 18+ is recommended for current EVE JS builds."
        }
        return $node
    }

    Write-Step "Node.js was not found. Installing Node.js LTS with winget"
    $winget = Resolve-Winget
    if (-not $winget) {
        throw "winget was not found. Install Node.js LTS from https://nodejs.org, then run Install.bat again."
    }

    & $winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget could not install Node.js. Exit code: $LASTEXITCODE"
    }

    $env:PATH = (Join-Path $env:ProgramFiles "nodejs") + ";" + $env:PATH
    $node = Resolve-Node
    if (-not $node) {
        throw "node.exe was not found after installation. Close this window and run Install.bat again."
    }

    $version = & $node --version
    Write-Host ("  Node.js {0}" -f $version)
    return $node
}

function Ensure-Rust {
    $cargo = Resolve-Cargo
    if ($cargo) {
        $cargoVersion = & $cargo --version
        Write-Host ("  {0}" -f $cargoVersion)
        return $cargo
    }

    Write-Step "Rust was not found. Installing Rust stable with winget"
    $winget = Resolve-Winget
    if (-not $winget) {
        throw "winget was not found. Install Rust from https://rustup.rs, then run Install.bat again."
    }

    & $winget install -e --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget could not install Rust. Exit code: $LASTEXITCODE"
    }

    $env:PATH = (Join-Path $env:USERPROFILE ".cargo\bin") + ";" + $env:PATH
    $rustup = Resolve-Rustup
    if (-not $rustup) {
        throw "rustup.exe was not found after installation. Close this window and run Install.bat again."
    }

    & $rustup set profile default
    & $rustup toolchain install stable
    & $rustup default stable

    $cargo = Resolve-Cargo
    if (-not $cargo) {
        throw "cargo.exe was not found after Rust installation."
    }

    $cargoVersion = & $cargo --version
    Write-Host ("  {0}" -f $cargoVersion)
    return $cargo
}

function Test-MsvcTools {
    if (Resolve-Tool -Name "cl.exe") {
        return $true
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -eq 0 -and $install) {
            return $true
        }
    }

    return $false
}

function Ensure-MsvcTools {
    if (Test-MsvcTools) {
        Write-Host "  MSVC build tools detected."
        return
    }

    Write-Step "MSVC build tools were not found. Installing Visual Studio Build Tools"
    $winget = Resolve-Winget
    if (-not $winget) {
        throw "winget was not found. Install Microsoft C++ Build Tools manually, then run Install.bat again."
    }

    $override = "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    & $winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --override $override
    if ($LASTEXITCODE -ne 0) {
        throw "Visual Studio Build Tools install failed. Exit code: $LASTEXITCODE"
    }

    if (-not (Test-MsvcTools)) {
        Write-Warn "Build tools were installed, but the current shell may not see them yet. Reboot or open a fresh terminal if linking fails."
    }
}

function Get-FreeBytesForPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    $driveName = $root.TrimEnd("\").TrimEnd(":")
    $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
    return [int64]$drive.Free
}

function Check-DiskSpace {
    param([Parameter(Mandatory = $true)][string]$Path)

    $freeBytes = Get-FreeBytesForPath -Path $Path
    $freeGb = [math]::Round($freeBytes / 1GB, 1)
    Write-Host ("  Free space at {0}: {1} GB" -f $Path, $freeGb)

    if ($freeGb -lt 2) {
        throw "Less than 2GB free. Free space before installing Elysian Universe Site Seeder."
    }

    if ($freeGb -lt 10) {
        Write-Warn "Full universe site state can be chunky. 10GB+ free is a comfortable target."
    }
}

function Select-Folder {
    param([string]$Description)

    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = $Description
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            return $dialog.SelectedPath
        }
    } catch {
        Write-Warn "Folder picker was unavailable: $($_.Exception.Message)"
    }

    return (Read-Host "  Paste the EVE JS folder path")
}

function Test-EveJsRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    $required = @(
        "server\src\newDatabase\data\dungeonAuthority\data.json",
        "server\src\newDatabase\data\dungeonRuntimeState\data.json",
        "server\src\newDatabase\data\miningRuntimeState\data.json",
        "server\src\config\index.js",
        "server\src\space\worldData.js",
        "server\src\services\dungeon\dungeonAuthority.js",
        "server\src\services\dungeon\dungeonRuntime.js",
        "server\src\services\dungeon\dungeonRuntimeState.js",
        "server\src\services\dungeon\dungeonUniverseRuntime.js",
        "server\src\services\mining\miningResourceSiteService.js"
    )

    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $relative) -PathType Leaf)) {
            Write-Warn ("Missing {0}" -f $relative)
            return $false
        }
    }

    return $true
}

function Resolve-EveJsRoot {
    if ($EveJsPath) {
        $candidate = [System.IO.Path]::GetFullPath($EveJsPath)
    } else {
        $candidate = Select-Folder -Description "Select your EVE JS folder"
    }

    if (-not $candidate) {
        throw "No EVE JS folder was selected."
    }

    $candidate = [System.IO.Path]::GetFullPath($candidate)
    if (-not (Test-EveJsRoot -Path $candidate)) {
        throw "The selected folder does not look like an EVE JS checkout with universe-site runtime support."
    }

    return $candidate
}

function Ensure-Binary {
    if (Test-Path -LiteralPath $script:Exe -PathType Leaf) {
        Write-Host ("  Binary already exists: {0}" -f $script:Exe)
        return
    }

    if ($SkipBuild) {
        throw "UniverseSiteSeeder.exe is missing and -SkipBuild was used."
    }

    if (-not (Test-Path -LiteralPath (Join-Path $script:Root "Cargo.toml") -PathType Leaf)) {
        throw "Source files are missing. Download the source checkout or use a release package with a bundled binary."
    }

    $cargo = Ensure-Rust
    Ensure-MsvcTools

    Write-Step "Building release binary"
    Push-Location $script:Root
    try {
        & $cargo build --release --locked
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Force -Path $script:BinDir | Out-Null
    $builtExe = Join-Path $script:Root "target\release\universe-site-seed.exe"
    if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) {
        throw "Rust build finished but target\release\universe-site-seed.exe was not found."
    }
    Copy-Item -LiteralPath $builtExe -Destination $script:Exe -Force
}

function Write-LocalConfig {
    param([Parameter(Mandatory = $true)][string]$SelectedEveJsRoot)
    $configDir = Join-Path $script:Root "config"
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    Set-Content -LiteralPath (Join-Path $configDir "evejs.path") -Value $SelectedEveJsRoot -Encoding ASCII
    Write-Host ("  Saved EVE JS path: {0}" -f $SelectedEveJsRoot)
}

function Run-HealthCheck {
    param([Parameter(Mandatory = $true)][string]$SelectedEveJsRoot)

    Write-Step "Running read-only health check"
    $oldEveJsRoot = $env:EVEJS_REPO_ROOT
    $env:EVEJS_REPO_ROOT = $SelectedEveJsRoot
    Push-Location $script:Root
    try {
        & $script:Exe --health-check
        if ($LASTEXITCODE -ne 0) {
            throw "Health check failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
        $env:EVEJS_REPO_ROOT = $oldEveJsRoot
    }
}

function Launch-App {
    param([Parameter(Mandatory = $true)][string]$SelectedEveJsRoot)

    $answer = Read-Host "  Launch the app now? [Y/n]"
    if ($answer -match "^(n|no)$") {
        return
    }

    $oldEveJsRoot = $env:EVEJS_REPO_ROOT
    $env:EVEJS_REPO_ROOT = $SelectedEveJsRoot
    try {
        Start-Process -FilePath $script:Exe -WorkingDirectory $script:Root
    } finally {
        $env:EVEJS_REPO_ROOT = $oldEveJsRoot
    }
}

Write-Step "Elysian Universe Site Seeder setup"
Check-DiskSpace -Path $script:Root
Ensure-Node | Out-Null
$selectedEveJsRoot = Resolve-EveJsRoot
Check-DiskSpace -Path $selectedEveJsRoot
Ensure-Binary
Write-LocalConfig -SelectedEveJsRoot $selectedEveJsRoot
Run-HealthCheck -SelectedEveJsRoot $selectedEveJsRoot

Write-Step "Ready"
Write-Host "  Start it any time with StartUniverseSeeder.bat"

if (-not $NoLaunch) {
    Launch-App -SelectedEveJsRoot $selectedEveJsRoot
}
