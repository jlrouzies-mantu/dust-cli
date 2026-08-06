#!/usr/bin/env bash
# Sandbox for the "collapsed step" install UX (Claude Code / Kimi Code
# style): each step runs as a single line that refreshes in place with a
# pulsing icon, and only expands into full output if that step actually
# fails. Nothing here touches install-dustcli.sh - this is purely to
# validate the pattern before wiring it into the real installer.
#
# Usage:
#   bash scripts/preview-collapsed-steps.sh

set -euo pipefail

RESET=$'\033[0m'
CLEAR_LINE=$'\033[K'
FG_WHITE=$'\033[38;2;255;255;255m'
FG_GRAY=$'\033[38;2;150;150;150m'
FG_RED=$'\033[38;2;255;90;90m'
FG_GREEN=$'\033[38;2;120;220;120m'

# Same 12-frame purple<->gold pulse and diamond glyph as
# src/ui/components/ThinkingIcon.tsx in the main app - reused here for the
# collapsed step's spinner instead of a shape-cycling animation.
PULSE_ICON=$'\xe2\x97\x86' # UTF-8 bytes for U+25C6, "♦"
PULSE_STEPS=12
PULSE_INTERVAL="0.12"
PULSE_FROM=(183 100 255) # brand purple, #b764ff
PULSE_TO=(248 240 96)    # gold, #f8f060

pulse_color() {
  local frame=$1
  local half=$(( PULSE_STEPS / 2 ))
  local t_num t_den
  if [ "$frame" -lt "$half" ]; then
    t_num=$frame
  else
    t_num=$(( PULSE_STEPS - frame ))
  fi
  t_den=$half
  local r=$(( PULSE_FROM[0] + (PULSE_TO[0] - PULSE_FROM[0]) * t_num / t_den ))
  local g=$(( PULSE_FROM[1] + (PULSE_TO[1] - PULSE_FROM[1]) * t_num / t_den ))
  local b=$(( PULSE_FROM[2] + (PULSE_TO[2] - PULSE_FROM[2]) * t_num / t_den ))
  printf '\033[38;2;%d;%d;%dm' "$r" "$g" "$b"
}

# invoke_collapsed_step <title> <duration_ms> <fail: 0|1> [fake output lines...]
invoke_collapsed_step() {
  local title="$1"
  local duration_ms="$2"
  local fail="$3"
  shift 3
  local fake_lines=("$@")

  local elapsed=0
  local frame=0
  local color
  while [ "$elapsed" -lt "$duration_ms" ]; do
    color=$(pulse_color "$frame")
    printf '\r%s%s%s%s  Installing - %s...' "$CLEAR_LINE" "$color" "$PULSE_ICON" "$RESET" "$title"
    sleep "$PULSE_INTERVAL"
    elapsed=$(( elapsed + 120 ))
    frame=$(( (frame + 1) % PULSE_STEPS ))
  done

  if [ "$fail" = "1" ]; then
    printf '\r%s%s[FAILED]%s  %s\n' "$CLEAR_LINE" "$FG_RED" "$RESET" "$title"
    echo -e "${FG_RED}  --- output ---${RESET}"
    for line in "${fake_lines[@]}"; do
      echo -e "${FG_GRAY}    $line${RESET}"
    done
    echo -e "${FG_RED}  --------------${RESET}"
  else
    printf '\r%s%s[OK]%s      %s\n' "$CLEAR_LINE" "$FG_GREEN" "$RESET" "$title"
  fi
}

echo ""
echo -e "${FG_WHITE}  Collapsed-step preview - each step runs as one refreshing line,${RESET}"
echo -e "${FG_WHITE}  full output only appears if that step actually fails.${RESET}"
echo ""

invoke_collapsed_step "[1/7] Preparing NVM directory" 1000 0
invoke_collapsed_step "[2/7] Installing NVM for Windows" 1500 0
invoke_collapsed_step "[3/7] Installing Node.js 24.16.0" 1200 0
invoke_collapsed_step "[4/7] Verifying Node.js and npm" 800 0
invoke_collapsed_step "[5/7] Downloading the Mantu fork" 1200 1 \
  "Downloading jlrouzies-mantu/dust-cli@main..." \
  "curl: (28) Failed to connect: Connection timed out" \
  "curl: (6) Could not resolve host: github.com"
invoke_collapsed_step "[6/7] Building the CLI" 1500 0
invoke_collapsed_step "[7/7] Verifying the 'dustm' command" 800 0

echo ""
