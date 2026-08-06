# Sandbox for the "collapsed step" install UX (Claude Code / Kimi Code
# style): each step runs as a single line that refreshes in place with a
# pulsing icon, and only expands into full output if that step actually
# fails. Nothing here touches Install-DustCLI.ps1 - this is purely to
# validate the pattern before wiring it into the real installer.
#
# Usage:
#   .\scripts\Preview-CollapsedSteps.ps1

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

function Ansi($code) { "$([char]27)[${code}m" }
$AnsiReset   = Ansi "0"
$AnsiFgWhite = Ansi "38;2;255;255;255"
$AnsiFgGray  = Ansi "38;2;150;150;150"
$AnsiFgRed   = Ansi "38;2;255;90;90"
$AnsiFgGreen = Ansi "38;2;120;220;120"
$ClearLine   = "$([char]27)[K"

# Same 12-frame purple<->gold pulse and diamond glyph as
# src/ui/components/ThinkingIcon.tsx in the main app - reused here for the
# collapsed step's spinner instead of a shape-cycling animation.
$PulseFrom = @(183, 100, 255) # brand purple, #b764ff
$PulseTo   = @(248, 240, 96)  # gold, #f8f060
$PulseSteps = 12
$PulseIntervalMs = 120
$PulseIcon = [char]0x25C6 # ♦

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
        Simulates a step that collapses to one refreshing line while
        "in progress", then finalizes to a single clean [OK]/[FAILED] line.
        On failure, the full captured output is dumped below it - on the
        happy path, none of that per-line noise ever reaches the console.
    #>
    param(
        [Parameter(Mandatory)][string]$Title,
        [string[]]$FakeOutputLines = @(),
        [int]$DurationMs = 1200,
        [switch]$Fail
    )

    $frame = 0
    $elapsed = 0
    while ($elapsed -lt $DurationMs) {
        $color = Get-PulseColor -Frame $frame
        Write-Host -NoNewline "`r$ClearLine$color$PulseIcon$AnsiReset  Installing - $Title..."
        Start-Sleep -Milliseconds $PulseIntervalMs
        $elapsed += $PulseIntervalMs
        $frame = ($frame + 1) % $PulseSteps
    }

    if ($Fail) {
        Write-Host "`r$ClearLine$AnsiFgRed[FAILED]$AnsiReset  $Title"
        Write-Host "$AnsiFgRed  --- output ---$AnsiReset"
        foreach ($line in $FakeOutputLines) {
            Write-Host "$AnsiFgGray    $line$AnsiReset"
        }
        Write-Host "$AnsiFgRed  --------------$AnsiReset"
    }
    else {
        Write-Host "`r$ClearLine$AnsiFgGreen[OK]$AnsiReset      $Title"
    }
}

Write-Host ""
Write-Host "$AnsiFgWhite  Collapsed-step preview - each step runs as one refreshing line,$AnsiReset"
Write-Host "$AnsiFgWhite  full output only appears if that step actually fails.$AnsiReset"
Write-Host ""

Invoke-CollapsedStep -Title "[1/7] Preparing NVM directory" -DurationMs 1000
Invoke-CollapsedStep -Title "[2/7] Installing NVM for Windows" -DurationMs 1500
Invoke-CollapsedStep -Title "[3/7] Installing Node.js 24.16.0" -DurationMs 1200
Invoke-CollapsedStep -Title "[4/7] Verifying Node.js and npm" -DurationMs 800
Invoke-CollapsedStep -Title "[5/7] Downloading the Mantu fork" -DurationMs 1200 -Fail -FakeOutputLines @(
    "Downloading jlrouzies-mantu/dust-cli@main...",
    "Invoke-WebRequest : Unable to connect to the remote server",
    "At line:1 char:1",
    "The operation has timed out."
)
Invoke-CollapsedStep -Title "[6/7] Building the CLI" -DurationMs 1500
Invoke-CollapsedStep -Title "[7/7] Verifying the 'dustm' command" -DurationMs 800

Write-Host ""
