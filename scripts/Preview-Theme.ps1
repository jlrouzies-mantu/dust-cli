# Sandbox for iterating on the installer's visual style (banner, headers,
# step/status lines) without touching Install-DustCLI.ps1 at all. This is
# intentionally self-contained/duplicated, not extracted from the real
# install script - nothing here is synced into Install-DustCLI.ps1 until
# the theme is settled.
#
# Usage:
#   .\scripts\Preview-Theme.ps1

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

# Mantu brand palette (sampled from img/mantutheme.bmp) as true 24-bit ANSI
# colors. Windows 10/Server 2019+ conhost and PowerShell 7/Windows Terminal
# all render ANSI escapes by default, and this fork already relies on the
# same in the main app, so it's used here too rather than being limited to
# PowerShell's fixed 16-color palette.
function Ansi($code) { "$([char]27)[${code}m" }
$AnsiReset        = Ansi "0"
$AnsiBgPurple     = Ansi "48;2;69;4;112"    # darkest sampled purple, #450470
$AnsiBgPurpleDark = Ansi "48;2;35;2;56"     # darker still, for the installer title box
$AnsiFgBorder     = Ansi "38;2;226;193;255" # lilac, #e2c1ff - bright, reads clearly against the dark bar
$AnsiFgPurple     = Ansi "38;2;183;100;255" # brand purple, #b764ff
$AnsiFgWhite      = Ansi "38;2;255;255;255"
$AnsiFgGold       = Ansi "38;2;248;240;96"  # #f8f060
$BannerWidth = 76

function Write-BannerBorder {
    Write-Host "$AnsiFgBorder+$("-" * $BannerWidth)+$AnsiReset"
}

function Write-BannerBar {
    param(
        [string]$Text = "",
        [string]$FgColor = $AnsiFgWhite,
        [string]$BgColor = $AnsiBgPurple,
        [switch]$Left
    )
    $padTotal = [Math]::Max(0, $BannerWidth - $Text.Length)
    if ($Left) {
        $padLeft = 2
        $padRight = [Math]::Max(0, $padTotal - $padLeft)
    }
    else {
        $padLeft = [Math]::Floor($padTotal / 2)
        $padRight = $padTotal - $padLeft
    }
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

# ------------------------------------------------------------------
# Fake sample steps below - purely for previewing the style, none of
# this actually installs anything.
# ------------------------------------------------------------------

Write-Banner

Write-Header "Step 1/7 - Preparing NVM directory"
Write-Step "Checking NVM directory: C:\Temp\Nvm"
Write-Info "NVM directory already exists."

Write-Header "Step 2/7 - Installing NVM for Windows"
Write-Step "Downloading nvm-windows from:"
Write-Info "https://github.com/coreybutler/nvm-windows/releases/download/1.2.2/nvm-noinstall.zip"
Write-Success "Downloaded to: C:\Temp\Nvm\nvm-noinstall.zip"
Write-Step "Extracting nvm-windows into: C:\Temp\Nvm"
Write-Success "Extraction complete."

Write-Header "Step 5/7 - Downloading the Mantu fork"
Write-Step "Downloading jlrouzies-mantu/dust-cli@main..."
Write-ErrorMsg "Simulated failure - just here to preview the error style."

Write-Host ""
Write-Success "This is what Write-Success looks like on its own."
Write-Info "This is what Write-Info looks like on its own."
