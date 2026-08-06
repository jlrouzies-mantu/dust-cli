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
#   irm "https://raw.githubusercontent.com/jlrouzies-mantu/dust-cli/main/scripts/Install-DustCLI.ps1?nocache=$((Get-Date).Ticks)" | iex
#
# The ?nocache=... query string works around raw.githubusercontent.com's
# CDN, which caches by full URL for a few minutes and can otherwise serve a
# stale copy right after a fresh push.
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

# Mantu brand palette (sampled from img/mantutheme.bmp) as true 24-bit ANSI
# colors. Windows 10/Server 2019+ conhost and PowerShell 7/Windows Terminal
# all render ANSI escapes by default, and this fork already relies on the
# same in the main app, so it's used here too rather than being limited to
# PowerShell's fixed 16-color palette. Also used for the collapsed-step
# spinner below, which pulses the same diamond glyph through the same
# 12-frame purple<->gold gradient as src/ui/components/ThinkingIcon.tsx.
function Ansi($code) { "$([char]27)[${code}m" }
$AnsiReset        = Ansi "0"
$AnsiBgPurple     = Ansi "48;2;69;4;112"    # darkest sampled purple, #450470
$AnsiBgPurpleDark = Ansi "48;2;35;2;56"     # darker still, for the installer title box
$AnsiFgBorder     = Ansi "38;2;226;193;255" # lilac, #e2c1ff - bright, reads clearly against the dark bar
$AnsiFgPurple     = Ansi "38;2;183;100;255" # brand purple, #b764ff
$AnsiFgWhite      = Ansi "38;2;255;255;255"
$AnsiFgGold       = Ansi "38;2;248;240;96"  # #f8f060
$AnsiFgGreen      = Ansi "38;2;120;220;120"
$AnsiFgRed        = Ansi "38;2;255;90;90"
$AnsiFgGray       = Ansi "38;2;150;150;150"
$ClearLine        = "$([char]27)[K"
$BannerWidth = 76

$PulseFrom = @(183, 100, 255) # brand purple, #b764ff
$PulseTo   = @(248, 240, 96)  # gold, #f8f060
$PulseSteps = 12
$PulseIntervalMs = 120
$PulseIcon = [char]0x25C6 # same glyph as ThinkingIcon.tsx

function Get-PulseColor {
    param([int]$Frame)
    $half = $PulseSteps / 2
    $t = if ($Frame -lt $half) { $Frame / $half } else { ($PulseSteps - $Frame) / $half }
    $r = [Math]::Round($PulseFrom[0] + ($PulseTo[0] - $PulseFrom[0]) * $t)
    $g = [Math]::Round($PulseFrom[1] + ($PulseTo[1] - $PulseFrom[1]) * $t)
    $b = [Math]::Round($PulseFrom[2] + ($PulseTo[2] - $PulseFrom[2]) * $t)
    return Ansi "38;2;$r;$g;$b"
}

function Invoke-CollapsedStep {
    <#
        Runs $ScriptBlock as a background job while showing one refreshing
        status line (pulsing icon) instead of letting the command's real
        output stream straight to the console. On success, collapses to a
        single [OK] line. On failure, expands to show everything the
        command actually printed, for diagnosis.

        $ScriptBlock must throw on failure (e.g. after checking
        $LASTEXITCODE for an external command) - a non-zero exit code
        alone does not fail a job. Reference outer variables via $using:
        (e.g. $using:npmCommandPath), since the job runs in a separate
        process with its own session state.
    #>
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][scriptblock]$ScriptBlock
    )

    $job = Start-Job -ScriptBlock $ScriptBlock
    $frame = 0
    while ($job.State -eq "Running" -or $job.State -eq "NotStarted") {
        $color = Get-PulseColor -Frame $frame
        Write-Host -NoNewline "`r$ClearLine$color$PulseIcon$AnsiReset  Installing - $Title..."
        Start-Sleep -Milliseconds $PulseIntervalMs
        $frame = ($frame + 1) % $PulseSteps
    }

    # Single Receive-Job call, since it drains the job's output buffer -
    # calling it twice (e.g. once to try, once in a catch block) can silently
    # lose output. 2>&1 merges error records into the same stream so a
    # failure's captured output (printed before it threw) isn't lost either.
    $output = Receive-Job -Job $job -ErrorAction SilentlyContinue 2>&1
    $succeeded = $job.State -eq "Completed"
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

    if ($succeeded) {
        Write-Host "`r$ClearLine$AnsiFgGreen[OK]$AnsiReset      $Title"
        return $output
    }
    else {
        Write-Host "`r$ClearLine$AnsiFgRed[FAILED]$AnsiReset  $Title"
        Write-Host "$AnsiFgRed  --- output ---$AnsiReset"
        $lastErrorMessage = "unknown error"
        $output | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $lastErrorMessage = $_.Exception.Message
            }
            Write-Host "$AnsiFgGray    $_$AnsiReset"
        }
        Write-Host "$AnsiFgRed  --------------$AnsiReset"
        throw "$Title failed: $lastErrorMessage"
    }
}

function Write-BannerBorder {
    Write-Host "$AnsiFgBorder+$("-" * $BannerWidth)+$AnsiReset"
}

function Write-BannerBar {
    param(
        [string]$Text = "",
        [string]$FgColor = $AnsiFgWhite,
        [string]$BgColor = $AnsiBgPurple
    )
    $padTotal = [Math]::Max(0, $BannerWidth - $Text.Length)
    $padLeft = [Math]::Floor($padTotal / 2)
    $padRight = $padTotal - $padLeft
    $line = "$AnsiFgBorder|$BgColor" + (" " * $padLeft) + "$FgColor$Text$BgColor" + (" " * $padRight) + "$AnsiReset$AnsiFgBorder|$AnsiReset"
    Write-Host $line
}

function Write-Banner {
    Write-Host ""
    Write-BannerBorder
    Write-BannerBar
    Write-BannerBar -Text "M A N T U" -FgColor $AnsiFgWhite
    Write-BannerBar -Text "Audacious ideas, delivered beyond." -FgColor $AnsiFgGold
    Write-BannerBar
    Write-BannerBorder
    Write-Host ""
    Write-BannerBorder
    Write-BannerBar -Text "Dust CLI - Mantu fork Installer" -FgColor $AnsiFgWhite -BgColor $AnsiBgPurpleDark
    Write-BannerBar -Text "A hardened, restyled build of the Dust CLI for Windows, macOS, and Linux" -FgColor $AnsiFgGold -BgColor $AnsiBgPurpleDark
    Write-BannerBorder
    Write-Host ""
}

function Write-Header {
    param([string]$Title)
    $rule = "-" * $BannerWidth
    Write-Host ""
    Write-Host "$AnsiFgBorder$rule$AnsiReset"
    Write-Host "$AnsiFgGold  $Title$AnsiReset"
    Write-Host "$AnsiFgBorder$rule$AnsiReset"
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

    Invoke-CollapsedStep -Title "Downloading nvm-windows" -ScriptBlock {
        Invoke-WebRequest -Uri $using:NvmZipUrl -OutFile $using:NvmZipPath
    } | Out-Null

    Invoke-CollapsedStep -Title "Extracting nvm-windows into $NvmRoot" -ScriptBlock {
        Expand-Archive -Path $using:NvmZipPath -DestinationPath $using:NvmRoot -Force
    } | Out-Null

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

    Invoke-CollapsedStep -Title "Installing Node.js $NodeVersion via NVM" -ScriptBlock {
        & $using:nvmExe install $using:NodeVersion
        if ($LASTEXITCODE -ne 0) { throw "nvm install failed with exit code $LASTEXITCODE" }
    } | Out-Null

    Invoke-CollapsedStep -Title "Selecting Node.js $NodeVersion" -ScriptBlock {
        & $using:nvmExe use $using:NodeVersion
        if ($LASTEXITCODE -ne 0) { throw "nvm use failed with exit code $LASTEXITCODE" }

        # Right after nvm (re)points the nodejs symlink, the filesystem can
        # take a brief moment before Test-Path/Get-Item reflect it - poll
        # briefly instead of trusting the very first check (or re-running
        # nvm use, which doesn't help and just duplicates its output).
        $expectedNodeExe = Join-Path $using:NodeJsSymlink "node.exe"
        $found = $false
        for ($i = 0; $i -lt 10; $i++) {
            if (Test-Path $expectedNodeExe) { $found = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $found) {
            throw "nvm use reported success but node.exe was not found at: $expectedNodeExe (waited 5s)"
        }
    } | Out-Null

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

    Invoke-CollapsedStep -Title "Updating npm to the latest version" -ScriptBlock {
        & $using:npmCommandPath install -g npm@latest
        if ($LASTEXITCODE -ne 0) { throw "npm install -g npm@latest failed with exit code $LASTEXITCODE" }
    } | Out-Null
    Write-Success "npm is up to date."

    Write-Header "Step 5/7 - Downloading the Mantu fork"

    if (-not (Test-Path $InstallRoot)) {
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    }

    Invoke-CollapsedStep -Title "Downloading jlrouzies-mantu/dust-cli@main" -ScriptBlock {
        Invoke-WebRequest -Uri $using:RepoZipUrl -OutFile $using:RepoZipPath
    } | Out-Null

    Invoke-CollapsedStep -Title "Extracting the Mantu fork" -ScriptBlock {
        if (Test-Path $using:RepoExtractDir) {
            Remove-Item -Recurse -Force $using:RepoExtractDir
        }
        Expand-Archive -Path $using:RepoZipPath -DestinationPath $using:InstallRoot -Force
        Remove-Item -Force $using:RepoZipPath

        if (Test-Path $using:RepoDir) {
            Remove-Item -Recurse -Force $using:RepoDir
        }
        Move-Item -Path $using:RepoExtractDir -Destination $using:RepoDir
    } | Out-Null
    Write-Success "Ready at: $RepoDir"

    Write-Header "Step 6/7 - Building the CLI"

    Push-Location $RepoDir
    try {
        Invoke-CollapsedStep -Title "Installing dependencies (npm install)" -ScriptBlock {
            # Start-Job's child process does NOT inherit the caller's
            # Push-Location - it starts in its own default directory. Set
            # it explicitly or npm runs against the wrong (or no) project.
            Set-Location $using:RepoDir
            & $using:npmCommandPath install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
        } | Out-Null

        # keytar (secure OS-credential storage) ships a native module that
        # npm install doesn't always manage to build - a corporate
        # ignore-scripts policy, a proxy blocking github.com, or antivirus
        # interference can all silently leave it missing, with npm install
        # still reporting success. Verify it explicitly instead of letting
        # the user hit a cryptic MODULE_NOT_FOUND crash later at `login`.
        Invoke-CollapsedStep -Title "Verifying keytar's native module (secure credential storage)" -ScriptBlock {
            $keytarDir = Join-Path $using:RepoDir "node_modules\keytar"
            $keytarBinary = Join-Path $keytarDir "build\Release\keytar.node"
            if (-not (Test-Path $keytarBinary)) {
                Write-Output "keytar.node missing after npm install - forcing a direct rebuild..."
                $prebuildInstallBin = Join-Path $using:RepoDir "node_modules\prebuild-install\bin.js"
                if (Test-Path $prebuildInstallBin) {
                    Push-Location $keytarDir
                    try {
                        & $using:nodeCommandPath $prebuildInstallBin --verbose
                    }
                    finally {
                        Pop-Location
                    }
                }
                if (-not (Test-Path $keytarBinary)) {
                    throw "keytar's native module (keytar.node) could not be installed. This usually means npm scripts are disabled (check 'npm config get ignore-scripts'), a proxy/firewall is blocking https://github.com, or antivirus is interfering with node_modules. Fix that, then re-run this installer."
                }
                Write-Output "keytar.node installed via direct rebuild."
            }
            else {
                Write-Output "keytar.node present."
            }
        } | Out-Null

        Invoke-CollapsedStep -Title "Building production bundle (npm run build:prod)" -ScriptBlock {
            Set-Location $using:RepoDir
            & $using:npmCommandPath run build:prod
            if ($LASTEXITCODE -ne 0) { throw "npm run build:prod failed with exit code $LASTEXITCODE" }
        } | Out-Null

        Invoke-CollapsedStep -Title "Linking the 'dustm' command globally (npm link)" -ScriptBlock {
            Set-Location $using:RepoDir
            & $using:npmCommandPath link
            if ($LASTEXITCODE -ne 0) { throw "npm link failed with exit code $LASTEXITCODE" }
        } | Out-Null
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
