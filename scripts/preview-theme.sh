#!/usr/bin/env bash
# Sandbox for iterating on the installer's visual style (banner, headers,
# step/status lines) without touching install-dustcli.sh at all. This is
# intentionally self-contained/duplicated, not extracted from the real
# install script - nothing here is synced into install-dustcli.sh until
# the theme is settled.
#
# Usage:
#   bash scripts/preview-theme.sh

set -euo pipefail

YELLOW=$'\033[33m'
GREEN=$'\033[32m'
GRAY=$'\033[90m'
RED=$'\033[31m'
RESET=$'\033[0m'

# Mantu brand palette (sampled from img/mantutheme.bmp) as true 24-bit ANSI
# colors - safe on real macOS/Linux terminals, unlike the 16-color mapping
# the PowerShell preview uses for legacy Windows conhost compatibility.
BANNER_BG_PURPLE=$'\033[48;2;69;4;112m'      # darkest sampled purple, #450470
BANNER_BG_PURPLE_DARK=$'\033[48;2;35;2;56m'  # darker still, for the installer title box
BANNER_FG_BORDER=$'\033[38;2;226;193;255m'   # lilac, #e2c1ff - bright, reads clearly against the dark bar
BANNER_FG_WHITE=$'\033[38;2;255;255;255m'
BANNER_FG_YELLOW=$'\033[38;2;248;240;96m'    # #f8f060
BANNER_WIDTH=76

banner_border() {
  printf '%s+%s+%s\n' "$BANNER_FG_BORDER" "$(printf -- '-%.0s' $(seq 1 "$BANNER_WIDTH"))" "$RESET"
}

banner_bar() {
  local text="${1:-}"
  local fg="${2:-$BANNER_FG_WHITE}"
  local bg="${3:-$BANNER_BG_PURPLE}"
  local text_len=${#text}
  local pad_total=$(( BANNER_WIDTH - text_len ))
  local pad_left=$(( pad_total / 2 ))
  local pad_right=$(( pad_total - pad_left ))
  printf '%s|%s%*s%s%s%s%*s%s|%s\n' \
    "$BANNER_FG_BORDER" "$bg" "$pad_left" "" \
    "$fg" "$text" "$bg" "$pad_right" "" \
    "$RESET$BANNER_FG_BORDER" "$RESET"
}

banner() {
  echo ""
  banner_border
  banner_bar ""
  banner_bar "M A N T U" "$BANNER_FG_WHITE"
  banner_bar "Audacious ideas, delivered beyond." "$BANNER_FG_YELLOW"
  banner_bar ""
  banner_border
  echo ""
  banner_border
  banner_bar "Dust CLI - Mantu fork Installer" "$BANNER_FG_WHITE" "$BANNER_BG_PURPLE_DARK"
  banner_bar "A hardened, restyled build of the Dust CLI for Windows, macOS, and Linux" "$BANNER_FG_YELLOW" "$BANNER_BG_PURPLE_DARK"
  banner_border
  echo ""
}

header() {
  local rule
  rule=$(printf -- '-%.0s' $(seq 1 "$BANNER_WIDTH"))
  echo ""
  echo -e "${BANNER_FG_BORDER}${rule}${RESET}"
  echo -e "${BANNER_FG_YELLOW}  $1${RESET}"
  echo -e "${BANNER_FG_BORDER}${rule}${RESET}"
}

step() {
  echo -e "${YELLOW}  > $1${RESET}"
}

success() {
  echo -e "${GREEN}  [OK] $1${RESET}"
}

info() {
  echo -e "${GRAY}  - $1${RESET}"
}

fail() {
  echo -e "${RED}  [FAILED] $1${RESET}"
}

# ------------------------------------------------------------------
# Fake sample steps below - purely for previewing the style, none of
# this actually installs anything.
# ------------------------------------------------------------------

banner

header "Step 1/6 - Installing nvm"
step "Checking for an existing nvm install..."
info "nvm already installed at \$HOME/.nvm"

header "Step 2/6 - Installing Node.js 24.16.0"
step "Installing Node.js 24.16.0 via nvm..."
success "Node.js 24.16.0 is now active."

header "Step 4/6 - Downloading the Mantu fork"
step "Downloading jlrouzies-mantu/dust-cli@main..."
fail "Simulated failure - just here to preview the error style."

echo ""
success "This is what 'success' looks like on its own."
info "This is what 'info' looks like on its own."
