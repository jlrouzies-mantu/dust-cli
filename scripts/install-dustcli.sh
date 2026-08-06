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

MAGENTA='\033[35m'
YELLOW='\033[33m'
GREEN='\033[32m'
GRAY='\033[90m'
RED='\033[31m'
WHITE='\033[97m'
RESET='\033[0m'

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

banner

header "Step 1/6 - Installing nvm"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  info "nvm already installed at $NVM_DIR"
else
  step "Downloading and running the official nvm install script..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  success "nvm installed."
fi

# shellcheck disable=SC1091
\. "$NVM_DIR/nvm.sh"

header "Step 2/6 - Installing Node.js $NODE_VERSION"

step "Installing Node.js $NODE_VERSION via nvm..."
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
success "Node.js $NODE_VERSION is now active."

step "Version:"
node --version

header "Step 3/6 - Verifying npm"

npm install -g npm@latest >/dev/null
success "npm is up to date ($(npm --version))."

header "Step 4/6 - Downloading the Mantu fork"

mkdir -p "$INSTALL_ROOT"

step "Downloading jlrouzies-mantu/dust-cli@main..."
curl -fsSL "$REPO_ZIP_URL" -o "$REPO_ZIP_PATH"
success "Downloaded to: $REPO_ZIP_PATH"

step "Extracting..."
rm -rf "$REPO_EXTRACT_DIR"
unzip -q -o "$REPO_ZIP_PATH" -d "$INSTALL_ROOT"
rm -f "$REPO_ZIP_PATH"

rm -rf "$REPO_DIR"
mv "$REPO_EXTRACT_DIR" "$REPO_DIR"
success "Ready at: $REPO_DIR"

header "Step 5/6 - Building the CLI"

(
  cd "$REPO_DIR"
  step "Installing dependencies (npm install)..."
  npm install

  step "Building production bundle (npm run build:prod)..."
  npm run build:prod

  step "Linking the 'dustm' command globally (npm link)..."
  npm link
)

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
