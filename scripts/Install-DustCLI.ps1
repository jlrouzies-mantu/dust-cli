$ErrorActionPreference = "Stop"

# ============================================================
# Mantu fork of Dust CLI - automated installer
#
# Bootstraps NVM for Windows (reusing an existing nvm-windows install and
# its symlink if one is already on this machine, rather than installing a
# second copy or overwriting it), installs the required Node.js version,
# then downloads a prebuilt release of this fork (jlrouzies-mantu/dust-cli,
# built by CI on a matching Windows runner - see .github/workflows/release.yml)
# and links it so the `dustm` command is available globally - deliberately
# not named `dust`, so it can coexist with the official Dust CLI on the
# same machine if needed. Safe to re-run - NVM and Node.js are skipped if
# already installed, and it always re-downloads the latest release, which
# is how you pick up updates. No npm install/build happens on your machine.
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

$ReleaseAsset       = "dustm-windows-x64.zip"
$ReleaseApiUrl      = "https://api.github.com/repos/jlrouzies-mantu/dust-cli/releases/latest"
$ReleaseFallbackUrl = "https://github.com/jlrouzies-mantu/dust-cli/releases/latest/download/$ReleaseAsset"
$InstallRoot        = Join-Path $env:USERPROFILE ".dust-cli-mantu"
$ReleaseCacheDir    = Join-Path $InstallRoot "release-cache"
$RepoDir            = Join-Path $InstallRoot "dust-cli"

# Force console output to UTF-8
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

# Suppress Write-Progress rendering - Invoke-WebRequest's and (especially)
# Expand-Archive's default progress bars add massive overhead on Windows,
# to the point Expand-Archive can take minutes on a zip with thousands of
# small files (a release's node_modules). Expand-Archive calls below are
# also replaced with .NET's ZipFile.ExtractToDirectory directly (benchmarked
# ~3x faster on top of that, independent of progress rendering) - inlined at
# each call site rather than a shared function, since Start-Job's background
# jobs below don't inherit functions defined in this scope, only variables
# passed via $using:.
$ProgressPreference = "SilentlyContinue"

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

    # NOTE: deliberately NOT setting $ErrorActionPreference = "Stop" here.
    # Windows PowerShell treats any stderr output from a native command
    # (git, npm, nvm.exe, node) as a non-terminating error by default - under
    # "Stop" that becomes fatal, so a routine warning like npm's own "npm warn
    # using --force" aborts the job before $LASTEXITCODE is even checked.
    # Every native-command step below already does its own
    # `if ($LASTEXITCODE -ne 0) { throw ... }` check, which is the correct
    # way to detect failure for these. Load System.IO.Compression.FileSystem
    # here instead: in Windows PowerShell 5.1 (unlike pwsh 7),
    # [System.IO.Compression.ZipFile] isn't a resolvable type until this
    # assembly is loaded, and that has to happen in every job's own session
    # since Start-Job doesn't inherit Add-Type calls from the caller.
    $job = Start-Job -InitializationScript {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
    } -ScriptBlock $ScriptBlock
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

    # Don't assume this machine has no NVM yet - a user reported already
    # having nvm-windows installed at their own location (e.g.
    # %LOCALAPPDATA%\nvm), and this script used to only ever check its own
    # hardcoded $NvmRoot, so it would silently bootstrap a second copy and
    # overwrite NVM_HOME/NVM_SYMLINK/PATH to point at it - hijacking the
    # existing install's symlink out from under it. Check PATH, a
    # persisted NVM_HOME, and nvm-windows' own installer default location
    # (in that order) before deciding there's nothing to reuse.
    function Find-ExistingNvmHome {
        $onPath = Get-Command nvm.exe -ErrorAction SilentlyContinue
        if ($onPath) { return Split-Path $onPath.Source -Parent }

        foreach ($scope in @("User", "Machine")) {
            $candidateHome = [Environment]::GetEnvironmentVariable("NVM_HOME", $scope)
            if ($candidateHome -and (Test-Path (Join-Path $candidateHome "nvm.exe"))) { return $candidateHome }
        }

        $defaultHome = Join-Path $env:LOCALAPPDATA "nvm"
        if (Test-Path (Join-Path $defaultHome "nvm.exe")) { return $defaultHome }

        return $null
    }

    $existingNvmHome = Find-ExistingNvmHome
    $UseExistingNvm = [bool]$existingNvmHome

    if ($UseExistingNvm) {
        $NvmRoot = $existingNvmHome
        Write-Info "Found an existing nvm-windows install at $NvmRoot - reusing it instead of installing a separate copy."
    }
    else {
        Write-Step "Checking NVM directory: $NvmRoot"

        if (-not (Test-Path $NvmRoot)) {
            New-Item -ItemType Directory -Path $NvmRoot -Force | Out-Null
            Write-Success "Created NVM directory."
        }
        else {
            Write-Info "NVM directory already exists."
        }
    }

    Write-Header "Step 2/7 - Installing NVM for Windows"

    $nvmExe = Join-Path $NvmRoot "nvm.exe"

    if ($UseExistingNvm) {
        Write-Info "Using existing nvm.exe at $nvmExe - skipping download."
    }
    elseif (Test-Path $nvmExe) {
        Write-Info "nvm-windows already installed at $nvmExe - skipping download."
    }
    else {
        Invoke-CollapsedStep -Title "Downloading nvm-windows" -ScriptBlock {
            Invoke-WebRequest -Uri $using:NvmZipUrl -OutFile $using:NvmZipPath
        } | Out-Null

        Invoke-CollapsedStep -Title "Extracting nvm-windows into $NvmRoot" -ScriptBlock {
            # No overwrite:bool overload exists on Windows PowerShell 5.1's
            # System.IO.Compression.FileSystem (only .NET Core/5+ has it) -
            # this only runs when nvm.exe is missing, i.e. a fresh $NvmRoot,
            # so there's nothing to overwrite.
            [System.IO.Compression.ZipFile]::ExtractToDirectory($using:NvmZipPath, $using:NvmRoot)
        } | Out-Null
    }

    if ($UseExistingNvm) {
        # Respect whatever symlink location the existing install already
        # uses - overwriting NVM_SYMLINK to our own path would silently
        # redirect where an existing nvm-windows setup (and anything
        # relying on it) points 'node'/'npm' globally.
        $NodeJsSymlink = $null
        foreach ($scope in @("User", "Machine")) {
            $sym = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", $scope)
            if ($sym) { $NodeJsSymlink = $sym; break }
        }
        if (-not $NodeJsSymlink) {
            $settingsFile = Join-Path $NvmRoot "settings.txt"
            if (Test-Path $settingsFile) {
                $pathLine = Get-Content $settingsFile | Where-Object { $_ -match '^\s*path:\s*(.+)$' } | Select-Object -First 1
                if ($pathLine -and ($pathLine -match '^\s*path:\s*(.+)$')) {
                    $NodeJsSymlink = $Matches[1].Trim()
                }
            }
        }
        if (-not $NodeJsSymlink) {
            $NodeJsSymlink = "C:\Program Files\nodejs" # nvm-windows' own installer default
        }
        Write-Info "Using existing NVM_SYMLINK: $NodeJsSymlink"
    }
    else {
        $NodeJsSymlink = Join-Path $NvmRoot "nodejs"
    }

    # SetEnvironmentVariable(...,"User") is idempotent, but re-running it
    # (plus rewriting settings.txt) every time this script runs is pure
    # noise once it's already correct. Skip the persisted writes when
    # nothing needs to change - the in-session $env: assignments below
    # still have to run every time, since a fresh process doesn't pick up
    # a User-scope PATH/env-var change made by an earlier run of this
    # script until a new terminal is opened.
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrWhiteSpace($userPath)) {
        $userPath = ""
    }
    $userPathEntries = $userPath -split ";"
    $pathAlreadyConfigured = ($userPathEntries -contains $NvmRoot) -and ($userPathEntries -contains $NodeJsSymlink)
    $envVarsAlreadyConfigured = ([Environment]::GetEnvironmentVariable("NVM_HOME", "User") -eq $NvmRoot) -and
                                ([Environment]::GetEnvironmentVariable("NVM_SYMLINK", "User") -eq $NodeJsSymlink)

    if ($UseExistingNvm) {
        # Nothing to persist - we're pointing at the user's pre-existing
        # nvm-windows install, so NVM_HOME/NVM_SYMLINK/PATH are already
        # however they set them up. Touching them here would be the exact
        # hijack this reuse path exists to avoid.
        Write-Info "Reusing existing NVM_HOME/NVM_SYMLINK/PATH configuration - not modifying it."
    }
    elseif ($pathAlreadyConfigured -and $envVarsAlreadyConfigured) {
        Write-Info "NVM environment variables and PATH already configured - skipping."
    }
    else {
        Write-Step "Configuring NVM environment variables..."
        Write-Info "NVM_HOME    = $NvmRoot"
        Write-Info "NVM_SYMLINK = $NodeJsSymlink"

        [Environment]::SetEnvironmentVariable("NVM_HOME", $NvmRoot, "User")
        [Environment]::SetEnvironmentVariable("NVM_SYMLINK", $NodeJsSymlink, "User")

        Write-Step "Updating PATH for the current user..."

        foreach ($p in @($NvmRoot, $NodeJsSymlink)) {
            if ($userPathEntries -notcontains $p) {
                $userPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $p } else { [string]::Join(";", @($userPath, $p)) }
            }
        }

        [Environment]::SetEnvironmentVariable("Path", $userPath, "User")

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
    }

    $env:NVM_HOME = $NvmRoot
    $env:NVM_SYMLINK = $NodeJsSymlink
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $env:Path = [string]::Join(";", @($userPath, $machinePath))

    if (-not (Test-Path $nvmExe)) {
        throw "nvm.exe was not found after extraction at $nvmExe"
    }
    Write-Success "NVM ready at: $nvmExe"

    Write-Header "Step 3/7 - Installing Node.js $NodeVersion"

    $nodeVersionDir = Join-Path $NvmRoot "v$NodeVersion"

    if (Test-Path $nodeVersionDir) {
        Write-Info "Node.js $NodeVersion is already installed via NVM - skipping."
    }
    else {
        Invoke-CollapsedStep -Title "Installing Node.js $NodeVersion via NVM" -ScriptBlock {
            & $using:nvmExe install $using:NodeVersion
            if ($LASTEXITCODE -ne 0) { throw "nvm install failed with exit code $LASTEXITCODE" }
        } | Out-Null
    }

    # `nvm use` (re)points the nodejs symlink even when it's already
    # pointing at this exact version, and re-pointing it is what can
    # trigger nvm-windows' elevate.vbs -> UAC prompt fallback on machines
    # without symlink-creation privilege. Skip it entirely when nothing
    # would actually change.
    $expectedNodeExe = Join-Path $NodeJsSymlink "node.exe"
    $activeVersion = ((& $nvmExe current 2>$null) | Out-String).Trim().TrimStart('v')
    if ($activeVersion -eq $NodeVersion -and (Test-Path $expectedNodeExe)) {
        Write-Info "Node.js $NodeVersion is already the active NVM version - skipping 'nvm use' (avoids an unnecessary symlink update, which can trigger a UAC prompt)."
    }
    else {
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
    }

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

    $currentNpmVersion = (& $npmCommandPath --version).Trim()
    $latestNpmVersion = $null
    try {
        $latestNpmVersion = ((& $npmCommandPath view npm version 2>$null) | Out-String).Trim()
    }
    catch {
        $latestNpmVersion = $null
    }

    if ($latestNpmVersion -and ($currentNpmVersion -eq $latestNpmVersion)) {
        Write-Info "npm is already the latest version ($currentNpmVersion) - skipping update."
    }
    else {
        Invoke-CollapsedStep -Title "Updating npm to the latest version" -ScriptBlock {
            & $using:npmCommandPath install -g npm@latest
            if ($LASTEXITCODE -ne 0) { throw "npm install -g npm@latest failed with exit code $LASTEXITCODE" }
        } | Out-Null
        Write-Success "npm is up to date."
    }

    Write-Header "Step 5/7 - Downloading the prebuilt Mantu fork release"

    if (-not (Test-Path $InstallRoot)) {
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    }
    if (-not (Test-Path $ReleaseCacheDir)) {
        New-Item -ItemType Directory -Path $ReleaseCacheDir -Force | Out-Null
    }

    # Ask GitHub's API for the latest release's version and this asset's
    # published sha256 digest, so we can: show the version being installed,
    # cache the zip by version instead of re-downloading ~20MB on every run,
    # and actually verify a cache hit against the real checksum rather than
    # just trusting a same-named file on disk. Falls back to the old
    # always-download, no-cache behavior if the API is unreachable (e.g. a
    # proxy that allows github.com release downloads but blocks
    # api.github.com).
    $releaseVersion = $null
    $releaseDownloadUrl = $null
    $releaseDigest = $null
    try {
        $releaseInfo = Invoke-RestMethod -Uri $ReleaseApiUrl -Headers @{ "User-Agent" = "dust-cli-installer" }
        $releaseVersion = $releaseInfo.tag_name
        $asset = $releaseInfo.assets | Where-Object { $_.name -eq $ReleaseAsset } | Select-Object -First 1
        if ($asset) {
            $releaseDownloadUrl = $asset.browser_download_url
            $releaseDigest = $asset.digest
        }
    }
    catch {
        Write-Info "Could not reach the GitHub releases API ($($_.Exception.Message)) - falling back to a plain download with no version caching."
    }

    if (-not $releaseDownloadUrl) {
        $releaseDownloadUrl = $ReleaseFallbackUrl
    }

    if ($releaseVersion) {
        Write-Success "Latest release: $releaseVersion"
        $releaseZipPath = Join-Path $ReleaseCacheDir "dustm-windows-x64-$releaseVersion.zip"
    }
    else {
        # Version unknown (API unreachable) - nothing meaningful to key a
        # cache off of, so use a throwaway path and always re-download, same
        # as before this feature existed.
        $releaseZipPath = Join-Path $InstallRoot $ReleaseAsset
    }

    function Test-ReleaseZipHash($Path, $Digest) {
        if (-not $Digest) { return $true }
        $expected = ($Digest -split ':')[-1]
        $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash
        return $actual -eq $expected
    }

    $needsDownload = $true
    if ($releaseVersion -and (Test-Path $releaseZipPath)) {
        if (Test-ReleaseZipHash -Path $releaseZipPath -Digest $releaseDigest) {
            $needsDownload = $false
            $verifiedNote = if ($releaseDigest) { " (sha256 verified)" } else { " (no published checksum to verify against)" }
            Write-Info "Using cached $ReleaseAsset $releaseVersion$verifiedNote - skipping download."
        }
        else {
            Write-Info "Cached $ReleaseAsset $releaseVersion failed sha256 verification - re-downloading."
            Remove-Item -Force $releaseZipPath -ErrorAction SilentlyContinue
        }
    }

    if ($needsDownload) {
        $downloadTitle = if ($releaseVersion) { "Downloading $ReleaseAsset $releaseVersion (latest release)" } else { "Downloading $ReleaseAsset (latest release)" }
        Invoke-CollapsedStep -Title $downloadTitle -ScriptBlock {
            Invoke-WebRequest -Uri $using:releaseDownloadUrl -OutFile $using:releaseZipPath
        } | Out-Null

        if ($releaseDigest -and -not (Test-ReleaseZipHash -Path $releaseZipPath -Digest $releaseDigest)) {
            Remove-Item -Force $releaseZipPath -ErrorAction SilentlyContinue
            throw "Downloaded $ReleaseAsset failed sha256 verification against GitHub's published digest. The file was removed - re-run the installer."
        }
        if ($releaseDigest) {
            Write-Success "sha256 verified."
        }
    }

    # Prune cached zips for other versions so the cache doesn't grow
    # unbounded - only the current version is worth keeping around.
    if ($releaseVersion) {
        Get-ChildItem -Path $ReleaseCacheDir -Filter "dustm-windows-x64-*.zip" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -ne $releaseZipPath } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    Invoke-CollapsedStep -Title "Extracting the release" -ScriptBlock {
        $repoDir = $using:RepoDir
        if (Test-Path $repoDir) {
            Remove-Item -Recurse -Force $repoDir
        }
        # No overwrite:bool overload exists on Windows PowerShell 5.1's
        # System.IO.Compression.FileSystem (only .NET Core/5+ has it) -
        # $repoDir was just removed above, so there's nothing to overwrite.
        [System.IO.Compression.ZipFile]::ExtractToDirectory($using:releaseZipPath, $repoDir)

        # As with the nvm symlink above, a directory this job just created
        # doesn't always show up to Test-Path in the parent process the
        # instant this job returns - poll briefly instead of letting
        # Push-Location fail with a confusing "path does not exist" right
        # after this step reported success.
        $found = $false
        for ($i = 0; $i -lt 10; $i++) {
            if (Test-Path (Join-Path $repoDir "package.json")) { $found = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $found) {
            throw "Extraction reported success but $repoDir (or its package.json) was not found (waited 5s)."
        }
    } | Out-Null
    Write-Success "Ready at: $RepoDir"

    Write-Header "Step 6/7 - Installing the CLI"

    Push-Location $RepoDir
    try {
        # keytar (secure OS-credential storage) ships a native module.
        # CI already built and verified it for windows-x64 as part of this
        # release (see .github/workflows/release.yml) - this is just a
        # sanity check, with the same direct-rebuild fallback as before, in
        # case the zip transfer itself ever corrupts it.
        Invoke-CollapsedStep -Title "Verifying keytar's native module (secure credential storage)" -ScriptBlock {
            $keytarDir = Join-Path $using:RepoDir "node_modules\keytar"
            $keytarBinary = Join-Path $keytarDir "build\Release\keytar.node"
            if (-not (Test-Path $keytarBinary)) {
                Write-Output "keytar.node missing from the release - forcing a direct rebuild..."
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
                    throw "keytar's native module (keytar.node) could not be installed. This usually means a proxy/firewall is blocking https://github.com, or antivirus is interfering with node_modules. Fix that, then re-run this installer."
                }
                Write-Output "keytar.node installed via direct rebuild."
            }
            else {
                Write-Output "keytar.node present."
            }
        } | Out-Null

        Invoke-CollapsedStep -Title "Linking the 'dustm' command globally (npm link)" -ScriptBlock {
            Set-Location $using:RepoDir
            # This script always wipes and recreates $RepoDir, so an old
            # 'dustm' shim from the previous run's (now-deleted) directory
            # is still sitting in npm's global bin - npm won't overwrite a
            # file it doesn't recognize as its own without --force.
            & $using:npmCommandPath link --force
            if ($LASTEXITCODE -ne 0) { throw "npm link failed with exit code $LASTEXITCODE" }
        } | Out-Null
    }
    finally {
        Pop-Location
    }

    Write-Success "Install complete."

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
