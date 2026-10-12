#!/usr/bin/env bash
# ============================================================
# Mantu fork of Dust CLI - automated installer (macOS/Linux)
#
# Bootstraps nvm, installs the required Node.js version, then
# fetches this fork (jlrouzies-mantu/dust-cli) and links it so the
# `dustm` command is available globally - deliberately not named
# `dust`, so it can coexist with the official Dust CLI on the same
# machine if needed. Safe to re-run - it re-fetches fresh each time,
# which is also how you pick up updates.
#
# On macOS, this downloads a prebuilt release (built by CI on a
# matching macOS runner/arch - see .github/workflows/release.yml),
# so no npm install/build happens on your machine. Linux has no
# prebuilt CLI release yet, so it still builds from source there.
#
# At the start it asks what to install: the CLI, dustm Desktop (a
# prebuilt Electron app, no Node.js needed: .app on macOS, AppImage on
# Linux x64) or both. Under `curl | bash` the answer is read from /dev/tty.
#
# Usage:
#   curl -fsSL "https://raw.githubusercontent.com/jlrouzies-mantu/dust-cli/main/scripts/install-dustcli.sh?nocache=$(date +%s)" | bash
#
# The ?nocache=... query string works around raw.githubusercontent.com's
# CDN, which caches by full URL for a few minutes and can otherwise serve a
# stale copy right after a fresh push.
# ============================================================

set -euo pipefail

NODE_VERSION="24.16.0"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
REPO_ZIP_URL="https://github.com/jlrouzies-mantu/dust-cli/archive/refs/heads/main.zip"
RELEASE_BASE_URL="https://github.com/jlrouzies-mantu/dust-cli/releases/latest/download"
INSTALL_ROOT="$HOME/.dust-cli-mantu"
REPO_ZIP_PATH="$INSTALL_ROOT/dust-cli-main.zip"
REPO_EXTRACT_DIR="$INSTALL_ROOT/dust-cli-main"
REPO_DIR="$INSTALL_ROOT/dust-cli"

# macOS ships a prebuilt release per-arch (Apple Silicon vs Intel); Linux
# still builds from source until a Linux release artifact exists too.
USE_PREBUILT_RELEASE=0
RELEASE_ASSET=""
case "$(uname -s)" in
  Darwin)
    USE_PREBUILT_RELEASE=1
    case "$(uname -m)" in
      arm64)  RELEASE_ASSET="dustm-macos-arm64.zip" ;;
      x86_64) RELEASE_ASSET="dustm-macos-x64.zip" ;;
      *)
        echo "Unsupported macOS architecture: $(uname -m)" >&2
        exit 1
        ;;
    esac
    ;;
  Linux)
    USE_PREBUILT_RELEASE=0
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac
RELEASE_ZIP_PATH="$INSTALL_ROOT/$RELEASE_ASSET"

YELLOW=$'\033[33m'
GREEN=$'\033[32m'
GRAY=$'\033[90m'
RED=$'\033[31m'
RESET=$'\033[0m'

# Mantu brand palette (sampled from img/mantutheme.bmp) as true 24-bit ANSI
# colors - safe on real macOS/Linux terminals. Also used for the
# collapsed-step spinner below, which pulses the same diamond glyph through
# the same 12-frame purple<->gold gradient as
# src/ui/components/ThinkingIcon.tsx in the main app.
BANNER_BG_PURPLE=$'\033[48;2;69;4;112m'      # darkest sampled purple, #450470
BANNER_BG_PURPLE_DARK=$'\033[48;2;35;2;56m'  # darker still, for the installer title box
BANNER_FG_BORDER=$'\033[38;2;226;193;255m'   # lilac, #e2c1ff - bright, reads clearly against the dark bar
BANNER_FG_WHITE=$'\033[38;2;255;255;255m'
BANNER_FG_YELLOW=$'\033[38;2;248;240;96m'    # #f8f060
BANNER_WIDTH=76
CLEAR_LINE=$'\033[K'

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
  echo -e "${BANNER_FG_WHITE}https://github.com/jlrouzies-mantu/dust-cli${RESET}"

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

extract_prebuilt_release_step() {
  rm -rf "$REPO_DIR"
  mkdir -p "$REPO_DIR"
  unzip -q -o "$RELEASE_ZIP_PATH" -d "$REPO_DIR"
  rm -f "$RELEASE_ZIP_PATH"
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
    echo "keytar.node missing - forcing a direct rebuild..."
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

# ---- Install-target choice, step numbering and dustm Desktop ----

STEP_NO=0
STEP_TOTAL=0
step_header() {
  STEP_NO=$(( STEP_NO + 1 ))
  header "Step $STEP_NO/$STEP_TOTAL - $1"
}

# Sets INSTALL_CLI / INSTALL_DESKTOP. Reads from /dev/tty so it still works
# under `curl | bash` (stdin is the script itself then); with no terminal at
# all, or an empty answer, it defaults to the CLI.
ask_install_choice() {
  echo -e "  What would you like to install?"
  echo -e "${GRAY}    [1] dustm CLI        (default)${RESET}"
  echo -e "${GRAY}    [2] dustm Desktop${RESET}"
  echo -e "${GRAY}    [3] Both${RESET}"
  local answer=""
  while true; do
    answer=""
    printf '  Choice [1-3, Enter = 1]: '
    { read -r answer < /dev/tty; } 2>/dev/null || { answer=""; echo ""; }
    case "$answer" in
      ""|1) INSTALL_CLI=1; INSTALL_DESKTOP=0; return ;;
      2)    INSTALL_CLI=0; INSTALL_DESKTOP=1; return ;;
      3)    INSTALL_CLI=1; INSTALL_DESKTOP=1; return ;;
      *)    info "Please answer 1, 2 or 3." ;;
    esac
    # No terminal to ask on: don't loop forever.
    [ -r /dev/tty ] || { INSTALL_CLI=1; INSTALL_DESKTOP=0; return; }
  done
}

DESKTOP_ASSET=""
case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64)  DESKTOP_ASSET="dustm-desktop-macos-arm64.zip" ;;
      x86_64) DESKTOP_ASSET="dustm-desktop-macos-x64.zip" ;;
    esac
    ;;
  Linux)
    [ "$(uname -m)" = "x86_64" ] && DESKTOP_ASSET="dustm-desktop-linux-x64.AppImage"
    ;;
esac
DESKTOP_DL_PATH="$INSTALL_ROOT/$DESKTOP_ASSET"

# Desktop has its own releases (tags desktop-X.Y.Z, from
# .github/workflows/release-desktop.yml) that are never "latest" - that stays
# the CLI's - so find the newest desktop-* release that has our asset.
resolve_desktop_url() {
  curl -fsSL -H "User-Agent: dust-cli-installer" \
    "https://api.github.com/repos/jlrouzies-mantu/dust-cli/releases?per_page=50" \
    | grep -o "\"browser_download_url\": *\"[^\"]*/download/desktop-v\?[0-9.]*/$DESKTOP_ASSET\"" \
    | head -n 1 | sed 's/.*"\(https[^"]*\)"$/\1/'
}

download_desktop_step() {
  local url
  url=$(resolve_desktop_url)
  if [ -z "$url" ]; then
    echo "No dustm Desktop release with $DESKTOP_ASSET was found (no desktop-* release has been published yet)." >&2
    return 1
  fi
  curl -fsSL "$url" -o "$DESKTOP_DL_PATH"
}

install_desktop_macos_step() {
  local app_root="/Applications"
  [ -w "$app_root" ] || app_root="$HOME/Applications"
  mkdir -p "$app_root"
  local dest="$app_root/dustm Desktop.app"
  local tmp
  tmp=$(mktemp -d)
  ditto -x -k "$DESKTOP_DL_PATH" "$tmp"
  local app
  app=$(find "$tmp" -maxdepth 2 -name '*.app' -type d | head -n 1)
  [ -n "$app" ] || { echo "No .app bundle found in $DESKTOP_ASSET"; rm -rf "$tmp"; return 1; }
  rm -rf "$dest"
  mv "$app" "$dest"
  rm -rf "$tmp" "$DESKTOP_DL_PATH"
  # Unsigned build: drop the quarantine flag so Gatekeeper doesn't refuse it.
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  echo "$dest" > "$INSTALL_ROOT/.desktop-path"
}

install_desktop_linux_step() {
  local dest_dir="$HOME/Applications"
  mkdir -p "$dest_dir" "$HOME/.local/share/applications"
  local dest="$dest_dir/dustm-desktop.AppImage"
  mv -f "$DESKTOP_DL_PATH" "$dest"
  chmod +x "$dest"
  cat > "$HOME/.local/share/applications/dustm-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=dustm Desktop
Comment=Desktop app for the Mantu fork of Dust
Exec="$dest" %U
Terminal=false
Categories=Development;
EOF
  echo "$dest" > "$INSTALL_ROOT/.desktop-path"
}

install_desktop() {
  if [ -z "$DESKTOP_ASSET" ]; then
    fail "dustm Desktop has no prebuilt build for $(uname -s) $(uname -m) (macOS arm64/x64 and Linux x64 only)."
    exit 1
  fi
  mkdir -p "$INSTALL_ROOT"

  step_header "Downloading dustm Desktop"
  # Don't replace a running app; ask the user to close it instead.
  if [ "$(uname -s)" = "Darwin" ]; then
    if pgrep -f "dustm Desktop.app/Contents/MacOS" >/dev/null 2>&1; then
      fail "dustm Desktop is running. Quit it and re-run this installer."
      exit 1
    fi
  elif pgrep -f "dustm-desktop.AppImage" >/dev/null 2>&1; then
    fail "dustm Desktop is running. Close it and re-run this installer."
    exit 1
  fi
  invoke_collapsed_step "Downloading $DESKTOP_ASSET (latest release)" download_desktop_step

  step_header "Installing dustm Desktop"
  if [ "$(uname -s)" = "Darwin" ]; then
    invoke_collapsed_step "Installing dustm Desktop.app" install_desktop_macos_step
  else
    invoke_collapsed_step "Installing the dustm Desktop AppImage" install_desktop_linux_step
  fi
  local where
  where=$(cat "$INSTALL_ROOT/.desktop-path" 2>/dev/null || true)

  header "dustm Desktop installed"
  success "dustm Desktop is ready${where:+ at $where}."
  if [ "$(uname -s)" = "Darwin" ]; then
    info "Open it from Launchpad/Spotlight. It shares sign-in and settings with the CLI (no CLI install needed)."
  else
    info "Launch it from your application menu or run the AppImage directly. It shares sign-in and settings with the CLI."
    info "Credential storage needs libsecret (e.g. apt install libsecret-1-0 / dnf install libsecret) and a keyring such as gnome-keyring."
    info "AppImages need FUSE 2 (libfuse2) on most distributions."
  fi
}

install_cli() {

step_header "Installing nvm"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  info "nvm already installed at $NVM_DIR"
else
  invoke_collapsed_step "Downloading and installing nvm" install_nvm_step
fi

# shellcheck disable=SC1091
\. "$NVM_DIR/nvm.sh"

step_header "Installing Node.js $NODE_VERSION"

if [ -d "$NVM_DIR/versions/node/v$NODE_VERSION" ]; then
  info "Node.js $NODE_VERSION is already installed via nvm - skipping."
else
  invoke_collapsed_step "Installing Node.js $NODE_VERSION via nvm" nvm install "$NODE_VERSION"
fi
invoke_collapsed_step "Selecting Node.js $NODE_VERSION" nvm use "$NODE_VERSION"
success "Node.js $NODE_VERSION is now active."

step "Version:"
node --version

step_header "Verifying npm"

invoke_collapsed_step "Updating npm to the latest version" npm install -g npm@latest
success "npm is up to date ($(npm --version))."

mkdir -p "$INSTALL_ROOT"

if [ "$USE_PREBUILT_RELEASE" -eq 1 ]; then
  step_header "Downloading the prebuilt Mantu fork release"

  invoke_collapsed_step "Downloading $RELEASE_ASSET (latest release)" \
    curl -fsSL "$RELEASE_BASE_URL/$RELEASE_ASSET" -o "$RELEASE_ZIP_PATH"
  invoke_collapsed_step "Extracting the release" extract_prebuilt_release_step
  success "Ready at: $REPO_DIR"

  step_header "Installing the CLI"

  invoke_collapsed_step "Verifying keytar's native module (secure credential storage)" verify_keytar_step
  invoke_collapsed_step "Linking the 'dustm' command globally (npm link)" npm_link_step

  success "Install complete."
else
  step_header "Downloading the Mantu fork"

  invoke_collapsed_step "Downloading jlrouzies-mantu/dust-cli@main" \
    curl -fsSL "$REPO_ZIP_URL" -o "$REPO_ZIP_PATH"
  invoke_collapsed_step "Extracting the Mantu fork" extract_mantu_fork_step
  success "Ready at: $REPO_DIR"

  step_header "Building the CLI"

  invoke_collapsed_step "Installing dependencies (npm install)" npm_install_step
  invoke_collapsed_step "Verifying keytar's native module (secure credential storage)" verify_keytar_step
  invoke_collapsed_step "Building production bundle (npm run build:prod)" npm_build_step
  invoke_collapsed_step "Linking the 'dustm' command globally (npm link)" npm_link_step

  success "Build complete."
fi

step_header "Verifying the 'dustm' command"

if ! command -v dustm >/dev/null 2>&1; then
  fail "dust-cli was built, but the 'dustm' command was not found in PATH."
  echo "  Open a new terminal (so PATH and nvm are freshly loaded) and try again."
  exit 1
fi

success "dustm found at: $(command -v dustm)"

header "All done"
success "nvm, Node.js, and the Mantu fork of Dust CLI are ready."

cheat_sheet
}

banner

header "What to install"
INSTALL_CLI=1
INSTALL_DESKTOP=0
ask_install_choice
STEP_TOTAL=$(( INSTALL_CLI * 6 + INSTALL_DESKTOP * 2 ))

if [ "$INSTALL_CLI" -eq 1 ]; then install_cli; fi
if [ "$INSTALL_DESKTOP" -eq 1 ]; then install_desktop; fi
