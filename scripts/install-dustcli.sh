#!/usr/bin/env bash
# ============================================================
# Mantu fork of Dust CLI - automated installer (macOS/Linux)
#
# Bootstraps nvm, installs the required Node.js version, then
# downloads, builds, and links this fork (jlrouzies-mantu/dust-cli)
# so the `dustm` command is available globally - deliberately not
# named `dust`, so it can coexist with the official Dust CLI on the
# same machine if needed. Safe to re-run - it re-downloads and
# rebuilds fresh each time, which is also how you pick up updates.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jlrouzies-mantu/dust-cli/main/scripts/install-dustcli.sh | bash
# ============================================================

set -euo pipefail

NODE_VERSION="24.16.0"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
REPO_ZIP_URL="https://github.com/jlrouzies-mantu/dust-cli/archive/refs/heads/main.zip"
INSTALL_ROOT="$HOME/.dust-cli-mantu"
REPO_ZIP_PATH="$INSTALL_ROOT/dust-cli-main.zip"
REPO_EXTRACT_DIR="$INSTALL_ROOT/dust-cli-main"
REPO_DIR="$INSTALL_ROOT/dust-cli"

MAGENTA=$'\033[35m'
YELLOW=$'\033[33m'
GREEN=$'\033[32m'
GRAY=$'\033[90m'
RED=$'\033[31m'
WHITE=$'\033[97m'
RESET=$'\033[0m'
CLEAR_LINE=$'\033[K'

# Collapsed-step spinner: pulses the same diamond glyph through the same
# 12-frame purple<->gold gradient as src/ui/components/ThinkingIcon.tsx in
# the main app. Each long-running command collapses to one refreshing line
# while it runs; only expands into full captured output if it fails.
PULSE_ICON=$'\xe2\x97\x86' # UTF-8 bytes for U+25C6, "♦"
PULSE_STEPS=12
PULSE_INTERVAL="0.12"
PULSE_FROM=(183 100 255) # brand purple, #b764ff
PULSE_TO=(248 240 96)    # gold, #f8f060

pulse_color() {
  local frame=$1
  local half=$(( PULSE_STEPS / 2 ))
  local t_num
  if [ "$frame" -lt "$half" ]; then
    t_num=$frame
  else
    t_num=$(( PULSE_STEPS - frame ))
  fi
  local r=$(( PULSE_FROM[0] + (PULSE_TO[0] - PULSE_FROM[0]) * t_num / half ))
  local g=$(( PULSE_FROM[1] + (PULSE_TO[1] - PULSE_FROM[1]) * t_num / half ))
  local b=$(( PULSE_FROM[2] + (PULSE_TO[2] - PULSE_FROM[2]) * t_num / half ))
  printf '\033[38;2;%d;%d;%dm' "$r" "$g" "$b"
}

# invoke_collapsed_step <title> <command> [args...]
#
# Runs the command as a background subshell while showing one refreshing
# status line (pulsing icon) instead of letting its real output stream
# straight to the console. On success, collapses to a single [OK] line.
# On failure, expands to show everything the command actually printed.
#
# The subshell forces its own `set -eo pipefail` regardless of the
# caller's current shell-option state - inheriting the caller's state
# as-is would mean a caller that (reasonably) disables -e around this
# call to avoid killing the whole script on failure would also silently
# disable failure detection *inside* the command being run.
invoke_collapsed_step() {
  local title="$1"
  shift
  local logfile
  logfile=$(mktemp)

  (set -eo pipefail; "$@") > "$logfile" 2>&1 &
  local pid=$!

  local frame=0
  local color
  while kill -0 "$pid" 2>/dev/null; do
    color=$(pulse_color "$frame")
    printf '\r%s%s%s%s  Installing - %s...' "$CLEAR_LINE" "$color" "$PULSE_ICON" "$RESET" "$title"
    sleep "$PULSE_INTERVAL"
    frame=$(( (frame + 1) % PULSE_STEPS ))
  done

  local exit_code=0
  wait "$pid" || exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    printf '\r%s%s[OK]%s      %s\n' "$CLEAR_LINE" "$GREEN" "$RESET" "$title"
  else
    printf '\r%s%s[FAILED]%s  %s\n' "$CLEAR_LINE" "$RED" "$RESET" "$title"
    echo -e "${RED}  --- output ---${RESET}"
    while IFS= read -r line; do
      echo -e "${GRAY}    $line${RESET}"
    done < "$logfile"
    echo -e "${RED}  --------------${RESET}"
  fi
  rm -f "$logfile"
  return "$exit_code"
}

banner() {
  echo ""
  echo -e "${MAGENTA}============================================================${RESET}"
  echo -e "${MAGENTA}  MANTU  //  Dust CLI Installer${RESET}"
  echo -e "${YELLOW}  A hardened, restyled build of the Dust CLI for Windows, macOS, and Linux${RESET}"
  echo -e "${MAGENTA}============================================================${RESET}"
  echo ""
}

header() {
  echo ""
  echo -e "${MAGENTA}-- $1${RESET}"
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

cmd() {
  printf "  %-55s" "$1"
  echo -e "${GRAY}($2)${RESET}"
}

cheat_sheet() {
  header "Quick commands"

  echo ""
  echo -e "${YELLOW}Authentication:${RESET}"
  cmd "dustm login" "Login to your Dust account."
  cmd "dustm login --force" "Force re-authentication if needed."
  cmd "dustm status" "Check whether you are authenticated."
  cmd "dustm logout" "Logout from your Dust account."

  echo ""
  echo -e "${YELLOW}Interactive chat:${RESET}"
  cmd "dustm" "Start the default interactive chat."
  cmd 'dustm chat --agent "My Agent"' "Start a chat with a specific agent by name."
  cmd "dustm chat --resume <conversationId>" "Resume a past conversation."

  echo ""
  echo -e "${YELLOW}Non-interactive examples:${RESET}"
  cmd 'dustm chat --agent "My Agent" --message "Summarize this folder"' "Send one message and exit."

  echo ""
  echo -e "${YELLOW}Local coding workflow:${RESET}"
  cmd "dustm skill:init" "Install the Dust skill for local coding agents."

  echo ""
  echo -e "${YELLOW}Inside interactive chat:${RESET}"
  cmd "/exit" "Exit the chat session."
  cmd "/switch" "Switch to a different agent."
  cmd "/resume" "Resume a previous conversation."
  cmd "/attach" "Attach a local file (or a clipboard image on macOS - untested)."
  cmd "/clear-files" "Clear attached files."
  cmd "/auto" "Toggle auto-approval of file edits."

  echo ""
  echo -ne "${YELLOW}Repo: ${RESET}"
  echo -e "${WHITE}https://github.com/jlrouzies-mantu/dust-cli${RESET}"

  echo ""
  success "Run 'dustm login' to authenticate, then 'dustm' to start chatting."
}

on_error() {
  fail "Install failed. See the error above."
  exit 1
}
trap on_error ERR

install_nvm_step() {
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
}

extract_mantu_fork_step() {
  rm -rf "$REPO_EXTRACT_DIR"
  unzip -q -o "$REPO_ZIP_PATH" -d "$INSTALL_ROOT"
  rm -f "$REPO_ZIP_PATH"
  rm -rf "$REPO_DIR"
  mv "$REPO_EXTRACT_DIR" "$REPO_DIR"
}

npm_install_step() {
  cd "$REPO_DIR"
  npm install
}

# keytar (secure OS-credential storage) ships a native module that npm
# install doesn't always manage to build - a corporate ignore-scripts
# policy, a proxy blocking github.com, or missing build tools can all
# silently leave it missing, with npm install still reporting success.
# Verify it explicitly instead of letting the user hit a cryptic
# MODULE_NOT_FOUND crash later at `login`.
verify_keytar_step() {
  cd "$REPO_DIR"
  local keytar_binary="$REPO_DIR/node_modules/keytar/build/Release/keytar.node"
  if [ ! -f "$keytar_binary" ]; then
    echo "keytar.node missing after npm install - forcing a direct rebuild..."
    local prebuild_install_bin="$REPO_DIR/node_modules/prebuild-install/bin.js"
    if [ -f "$prebuild_install_bin" ]; then
      (cd "$REPO_DIR/node_modules/keytar" && node "$prebuild_install_bin" --verbose)
    fi
    if [ ! -f "$keytar_binary" ]; then
      echo "keytar's native module (keytar.node) could not be installed."
      echo "This usually means npm scripts are disabled (check 'npm config get ignore-scripts'),"
      echo "a proxy/firewall is blocking https://github.com, or Xcode Command Line Tools /"
      echo "build-essential aren't installed for a local compile fallback."
      return 1
    fi
    echo "keytar.node installed via direct rebuild."
  else
    echo "keytar.node present."
  fi
}

npm_build_step() {
  cd "$REPO_DIR"
  npm run build:prod
}

npm_link_step() {
  cd "$REPO_DIR"
  npm link
}

banner

header "Step 1/6 - Installing nvm"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  info "nvm already installed at $NVM_DIR"
else
  invoke_collapsed_step "Downloading and installing nvm" install_nvm_step
fi

# shellcheck disable=SC1091
\. "$NVM_DIR/nvm.sh"

header "Step 2/6 - Installing Node.js $NODE_VERSION"

invoke_collapsed_step "Installing Node.js $NODE_VERSION via nvm" nvm install "$NODE_VERSION"
invoke_collapsed_step "Selecting Node.js $NODE_VERSION" nvm use "$NODE_VERSION"
success "Node.js $NODE_VERSION is now active."

step "Version:"
node --version

header "Step 3/6 - Verifying npm"

invoke_collapsed_step "Updating npm to the latest version" npm install -g npm@latest
success "npm is up to date ($(npm --version))."

header "Step 4/6 - Downloading the Mantu fork"

mkdir -p "$INSTALL_ROOT"

invoke_collapsed_step "Downloading jlrouzies-mantu/dust-cli@main" \
  curl -fsSL "$REPO_ZIP_URL" -o "$REPO_ZIP_PATH"
invoke_collapsed_step "Extracting the Mantu fork" extract_mantu_fork_step
success "Ready at: $REPO_DIR"

header "Step 5/6 - Building the CLI"

invoke_collapsed_step "Installing dependencies (npm install)" npm_install_step
invoke_collapsed_step "Verifying keytar's native module (secure credential storage)" verify_keytar_step
invoke_collapsed_step "Building production bundle (npm run build:prod)" npm_build_step
invoke_collapsed_step "Linking the 'dustm' command globally (npm link)" npm_link_step

success "Build complete."

header "Step 6/6 - Verifying the 'dustm' command"

if ! command -v dustm >/dev/null 2>&1; then
  fail "dust-cli was built, but the 'dustm' command was not found in PATH."
  echo "  Open a new terminal (so PATH and nvm are freshly loaded) and try again."
  exit 1
fi

success "dustm found at: $(command -v dustm)"

header "All done"
success "nvm, Node.js, and the Mantu fork of Dust CLI are ready."

cheat_sheet
