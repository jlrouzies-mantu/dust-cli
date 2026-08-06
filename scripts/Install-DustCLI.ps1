$ErrorActionPreference = "Stop"

# ============================================================
# Mantu fork of Dust CLI - automated installer
#
# Bootstraps NVM for Windows, installs the required Node.js
# version, then downloads, builds, and links this fork
# (jlrouzies-mantu/dust-cli) so the `dustm` command is available
# globally - deliberately not named `dust`, so it can coexist with
# the official Dust CLI on the same machine if needed. Safe to
# re-run - it re-downloads and rebuilds fresh each time, which is
# also how you pick up updates.
#
# Usage:
#   irm https://raw.githubusercontent.com/jlrouzies-mantu/dust-cli/main/scripts/Install-DustCLI.ps1 | iex
# ============================================================

$NvmZipUrl   = "https://github.com/coreybutler/nvm-windows/releases/download/1.2.2/nvm-noinstall.zip"
$NvmRoot     = "C:\Temp\Nvm"
$NvmZipPath  = Join-Path $NvmRoot "nvm-noinstall.zip"
$NodeVersion = "24.16.0"

$RepoZipUrl   = "https://github.com/jlrouzies-mantu/dust-cli/archive/refs/heads/main.zip"
$InstallRoot  = Join-Path $env:USERPROFILE ".dust-cli-mantu"
$RepoZipPath  = Join-Path $InstallRoot "dust-cli-main.zip"
$RepoExtractDir = Join-Path $InstallRoot "dust-cli-main"
$RepoDir      = Join-Path $InstallRoot "dust-cli"

# Force console output to UTF-8
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

function Write-Banner {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Magenta
    Write-Host "  MANTU  //  Dust CLI Installer" -ForegroundColor Magenta
    Write-Host "  A hardened, restyled build of the Dust CLI for Windows" -ForegroundColor DarkYellow
    Write-Host "============================================================" -ForegroundColor Magenta
    Write-Host ""
}

function Write-Header {
    param([string]$Title)
    Write-Host ""
    Write-Host "-- $Title" -ForegroundColor Magenta
}

function Write-Step {
    param([string]$Message)
    Write-Host "  > $Message" -ForegroundColor DarkYellow
}

function Write-Success {
    param([string]$Message)
    Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-Info {
    param([string]$Message)
    Write-Host "  - $Message" -ForegroundColor Gray
}

function Write-ErrorMsg {
    param([string]$Message)
    Write-Host "  [FAILED] $Message" -ForegroundColor Red
}

function Write-DustCliCommand {
    param([string]$Command, [string]$Description)
    Write-Host "  $Command " -ForegroundColor White -NoNewline
    Write-Host "($Description)" -ForegroundColor Gray
}

function Write-DustCliCheatSheet {
    Write-Header "Quick commands"

    Write-Host ""
    Write-Host "Authentication:" -ForegroundColor DarkYellow
    Write-DustCliCommand "dustm login" "Login to your Dust account."
    Write-DustCliCommand "dustm login --force" "Force re-authentication if needed."
    Write-DustCliCommand "dustm status" "Check whether you are authenticated."
    Write-DustCliCommand "dustm logout" "Logout from your Dust account."

    Write-Host ""
    Write-Host "Interactive chat:" -ForegroundColor DarkYellow
    Write-DustCliCommand "dustm" "Start the default interactive chat."
    Write-DustCliCommand "dustm chat --agent `"My Agent`"" "Start a chat with a specific agent by name."
    Write-DustCliCommand "dustm chat --resume <conversationId>" "Resume a past conversation."

    Write-Host ""
    Write-Host "Non-interactive examples:" -ForegroundColor DarkYellow
    Write-DustCliCommand "dustm chat --agent `"My Agent`" --message `"Summarize this folder`"" "Send one message and exit."

    Write-Host ""
    Write-Host "Local coding workflow:" -ForegroundColor DarkYellow
    Write-DustCliCommand "dustm skill:init" "Install the Dust skill for local coding agents."

    Write-Host ""
    Write-Host "Inside interactive chat:" -ForegroundColor DarkYellow
    Write-DustCliCommand "/exit" "Exit the chat session."
    Write-DustCliCommand "/switch" "Switch to a different agent."
    Write-DustCliCommand "/resume" "Resume a previous conversation."
    Write-DustCliCommand "/attach" "Attach a local file (or a clipboard image on Windows)."
    Write-DustCliCommand "/clear-files" "Clear attached files."
    Write-DustCliCommand "/auto" "Toggle auto-approval of file edits."

    Write-Host ""
    Write-Host "Repo: " -ForegroundColor DarkYellow -NoNewline
    Write-Host "https://github.com/jlrouzies-mantu/dust-cli" -ForegroundColor White

    Write-Success "`nRun 'dustm login' to authenticate, then 'dustm' to start chatting."
}

try {

    Write-Banner

    Write-Header "Step 1/7 - Preparing NVM directory"

    Write-Step "Checking NVM directory: $NvmRoot"

    if (-not (Test-Path $NvmRoot)) {
        New-Item -ItemType Directory -Path $NvmRoot -Force | Out-Null
        Write-Success "Created NVM directory."
    }
    else {
        Write-Info "NVM directory already exists."
    }

    Write-Header "Step 2/7 - Installing NVM for Windows"

    Write-Step "Downloading nvm-windows from:"
    Write-Info $NvmZipUrl

    Invoke-WebRequest -Uri $NvmZipUrl -OutFile $NvmZipPath

    Write-Success "Downloaded to: $NvmZipPath"

    Write-Step "Extracting nvm-windows into: $NvmRoot"
    Expand-Archive -Path $NvmZipPath -DestinationPath $NvmRoot -Force
    Write-Success "Extraction complete."

    $NodeJsSymlink = Join-Path $NvmRoot "nodejs"

    Write-Step "Configuring NVM environment variables..."
    Write-Info "NVM_HOME    = $NvmRoot"
    Write-Info "NVM_SYMLINK = $NodeJsSymlink"

    [Environment]::SetEnvironmentVariable("NVM_HOME", $NvmRoot, "User")
    [Environment]::SetEnvironmentVariable("NVM_SYMLINK", $NodeJsSymlink, "User")

    $env:NVM_HOME = $NvmRoot
    $env:NVM_SYMLINK = $NodeJsSymlink

    Write-Step "Updating PATH for the current user..."

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrWhiteSpace($userPath)) {
        $userPath = ""
    }

    foreach ($p in @($NvmRoot, $NodeJsSymlink)) {
        $existingPaths = $userPath -split ";"
        if ($existingPaths -notcontains $p) {
            if ([string]::IsNullOrWhiteSpace($userPath)) {
                $userPath = $p
            }
            else {
                $userPath = [string]::Join(";", @($userPath, $p))
            }
        }
    }

    [Environment]::SetEnvironmentVariable("Path", $userPath, "User")

    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $env:Path = [string]::Join(";", @($userPath, $machinePath))

    Write-Success "PATH updated for user and current session."

    $settingsFile = Join-Path $NvmRoot "settings.txt"
    $settingsContent = @(
        "root: $NvmRoot",
        "path: $NodeJsSymlink",
        "arch: 64",
        "proxy: none",
        "originalpath:",
        "originalversion:"
    )
    $settingsContent | Set-Content -Path $settingsFile -Encoding ASCII

    $nvmExe = Join-Path $NvmRoot "nvm.exe"
    if (-not (Test-Path $nvmExe)) {
        throw "nvm.exe was not found after extraction at $nvmExe"
    }
    Write-Success "NVM ready at: $nvmExe"

    Write-Header "Step 3/7 - Installing Node.js $NodeVersion"

    Write-Step "Installing Node.js $NodeVersion via NVM..."
    & $nvmExe install $NodeVersion

    Write-Step "Selecting Node.js $NodeVersion..."
    & $nvmExe use $NodeVersion

    Write-Success "Node.js $NodeVersion is now active."

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $env:Path = [string]::Join(";", @($env:NVM_HOME, $env:NVM_SYMLINK, $userPath, $machinePath))

    Write-Header "Step 4/7 - Verifying Node.js and npm"

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        $expectedNodePath = Join-Path $env:NVM_SYMLINK "node.exe"
        if (-not (Test-Path $expectedNodePath)) {
            throw "node.exe was not found. Expected it at: $expectedNodePath"
        }
        $nodeCommandPath = $expectedNodePath
    }
    else {
        $nodeCommandPath = $nodeCommand.Source
    }
    Write-Success "node found at: $nodeCommandPath"
    Write-Step "Version:"
    & $nodeCommandPath --version

    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCommand) {
        $expectedNpmPath = Join-Path $env:NVM_SYMLINK "npm.cmd"
        if (-not (Test-Path $expectedNpmPath)) {
            throw "npm was not found. Expected it at: $expectedNpmPath"
        }
        $npmCommandPath = $expectedNpmPath
    }
    else {
        $npmCommandPath = $npmCommand.Source
    }
    Write-Success "npm found at: $npmCommandPath"

    Write-Step "Updating npm to the latest version..."
    & $npmCommandPath install -g npm@latest
    Write-Success "npm is up to date."

    Write-Header "Step 5/7 - Downloading the Mantu fork"

    if (-not (Test-Path $InstallRoot)) {
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    }

    Write-Step "Downloading jlrouzies-mantu/dust-cli@main..."
    Invoke-WebRequest -Uri $RepoZipUrl -OutFile $RepoZipPath
    Write-Success "Downloaded to: $RepoZipPath"

    Write-Step "Extracting..."
    if (Test-Path $RepoExtractDir) {
        Remove-Item -Recurse -Force $RepoExtractDir
    }
    Expand-Archive -Path $RepoZipPath -DestinationPath $InstallRoot -Force
    Remove-Item -Force $RepoZipPath

    if (Test-Path $RepoDir) {
        Remove-Item -Recurse -Force $RepoDir
    }
    Move-Item -Path $RepoExtractDir -Destination $RepoDir
    Write-Success "Ready at: $RepoDir"

    Write-Header "Step 6/7 - Building the CLI"

    Push-Location $RepoDir
    try {
        Write-Step "Installing dependencies (npm install)..."
        & $npmCommandPath install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

        # keytar (secure OS-credential storage) ships a native module that
        # npm install doesn't always manage to build - a corporate
        # ignore-scripts policy, a proxy blocking github.com, or antivirus
        # interference can all silently leave it missing, with npm install
        # still reporting success. Verify it explicitly instead of letting
        # the user hit a cryptic MODULE_NOT_FOUND crash later at `login`.
        Write-Step "Verifying keytar's native module (secure credential storage)..."
        $keytarDir = Join-Path $RepoDir "node_modules\keytar"
        $keytarBinary = Join-Path $keytarDir "build\Release\keytar.node"
        if (-not (Test-Path $keytarBinary)) {
            Write-Info "keytar.node missing after npm install - forcing a direct rebuild..."
            $prebuildInstallBin = Join-Path $RepoDir "node_modules\prebuild-install\bin.js"
            if (Test-Path $prebuildInstallBin) {
                Push-Location $keytarDir
                try {
                    & $nodeCommandPath $prebuildInstallBin --verbose
                }
                finally {
                    Pop-Location
                }
            }
            if (-not (Test-Path $keytarBinary)) {
                throw "keytar's native module (keytar.node) could not be installed. This usually means npm scripts are disabled (check 'npm config get ignore-scripts'), a proxy/firewall is blocking https://github.com, or antivirus is interfering with node_modules. Fix that, then re-run this installer."
            }
            Write-Success "keytar.node installed via direct rebuild."
        }
        else {
            Write-Success "keytar.node present."
        }

        Write-Step "Building production bundle (npm run build:prod)..."
        & $npmCommandPath run build:prod
        if ($LASTEXITCODE -ne 0) { throw "npm run build:prod failed with exit code $LASTEXITCODE" }

        Write-Step "Linking the 'dustm' command globally (npm link)..."
        & $npmCommandPath link
        if ($LASTEXITCODE -ne 0) { throw "npm link failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }

    Write-Success "Build complete."

    Write-Header "Step 7/7 - Verifying the 'dustm' command"

    $dustCommand = Get-Command dustm -ErrorAction SilentlyContinue
    if (-not $dustCommand) {
        Write-Info "dustm was not found immediately in PATH. Refreshing PATH once more."
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $env:Path = [string]::Join(";", @($env:NVM_HOME, $env:NVM_SYMLINK, $userPath, $machinePath))
        $dustCommand = Get-Command dustm -ErrorAction SilentlyContinue
    }

    if (-not $dustCommand) {
        throw "dust-cli was built, but the 'dustm' command was not found in PATH. Open a new terminal and try again."
    }

    Write-Success "dustm found at: $($dustCommand.Source)"

    Write-Header "All done"
    Write-Success "NVM, Node.js, and the Mantu fork of Dust CLI are ready."

    Write-DustCliCheatSheet
}
catch {
    Write-ErrorMsg $_.Exception.Message
    throw
}
