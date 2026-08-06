<div align="center">

# ⟡ dust-cli

### The Mantu fork of the Dust CLI

![Mantu Fork](https://img.shields.io/badge/Mantu-Fork-7C2AE8?style=for-the-badge&labelColor=1A0B2E)
![Based on Dust CLI](https://img.shields.io/badge/Base-Dust%20CLI-D4A72C?style=for-the-badge&labelColor=1A0B2E)
![License](https://img.shields.io/badge/License-MIT-FFFFFF?style=for-the-badge&labelColor=7C2AE8)
![Node](https://img.shields.io/badge/Node-%3E%3D24.16-D4A72C?style=for-the-badge&labelColor=1A0B2E)

*A hardened, restyled build of [`@dust-tt/dust-cli`](https://github.com/dust-tt/dust/tree/main/cli/dust-cli) — same agents, same account, a console experience that actually survives legacy Windows terminals.*

</div>

---

## Table of Contents

- [Changelog: Mantu fork vs. upstream Dust CLI](#changelog-mantu-fork-vs-upstream-dust-cli)
- [Screenshots](#screenshots)
- [Installation](#installation)
  - [Quick install (Windows)](#quick-install-windows)
- [Usage](#usage)
  - [Commands](#commands)
  - [Shortcuts](#shortcuts)
  - [Status bar](#status-bar)
  - [In-Chat Commands](#in-chat-commands)
  - [Headless Authentication](#headless-authentication)
- [Development](#development)
  - [Versioning](#versioning)
- [Relationship to Upstream](#relationship-to-upstream)
- [License](#license)

---

## Changelog: Mantu fork vs. upstream Dust CLI

This fork exists to fix a specific, reproducible set of problems the official CLI has on Windows consoles without full VT/Unicode support (legacy `conhost`, PowerShell 5) — bad paste handling, unrecoverable crashes, no persistence — plus a set of UX upgrades. Auth, agent listing, and non-interactive mode are otherwise untouched.

### ✨ Added

| Feature | Notes |
|---|---|
| Crash recovery | Falls back to fetching the conversation from the server instead of showing a fatal error |
| Auto-retry on API errors | Up to 5x with backoff on transient failures; skipped for non-idempotent calls |
| Actionable error messages | Fatal errors include the exact command to resume that conversation |
| Local crash-safe transcripts | Every turn appended to `~/.dust-cli/transcripts/<id>.jsonl` |
| Ctrl+C safety net | Cancels generation if running; otherwise double-press within 2s to exit |
| Markdown rendering | Syntax-highlighted code fences, boxed on their own |
| Transient "Thinking…" status | `◊` icon pulsing between brand colors instead of a permanent scrollback dump |
| Persistent, colorized status bar | Workspace, agent, folder, branch, tokens, credits — see [Status bar](#status-bar) |
| Ctrl+Enter / Shift+Enter | Multi-line input |
| `todo_write` tool | Claude-Code-style task checklist (`--with-tools` only) |
| Dust directive handling | Web-only directives (e.g. `:preview_file{...}`) shown as readable placeholders |
| Clipboard image paste | Attach a screenshot straight from the clipboard via `/attach` (Windows) — see [In-Chat Commands](#in-chat-commands) |
| Paste compaction | Large multi-line pastes collapse to a `[Pasted N lines of text]` placeholder in the input instead of dumping the raw text inline |
| Portable content search | `search_content` (`--with-tools`) no longer shells out to the system `grep` binary, and supports lines of context around each match |

### 🐛 Fixed

| Issue | Root cause |
|---|---|
| Multi-line paste corrupted input / submitted early | No bracketed-paste support — pasted newlines triggered submit |
| No Ctrl+Backspace / Ctrl+Left/Right word-jump | Never implemented upstream |
| Transient stream errors showed a fatal, unrecoverable error | Never checked whether the answer had actually completed server-side |
| Agent list / MCP / user-info fetches failed on one hiccup | No retry logic anywhere |
| `--resume` wiped the terminal scrollback | `clearTerminal()` used the wrong escape sequence |
| UI glyphs rendered as garbage or misaligned boxes | Unicode glyphs unsupported on this console's font |
| Code block borders/backgrounds rendered wrong | Ink/Yoga layout defaults, unpadded background fill |
| Markdown headings/bold never rendered | Confirmed `marked-terminal@7.3.0` bug |
| `npm run build` failed on Windows | Bash-style `NODE_ENV=x` syntax in scripts |
| `search_content` (`--with-tools`) could silently fail | It shelled out to the system `grep` binary, not guaranteed to exist on plain Windows without Git for Windows/WSL |

### 🔧 Changed

- Renamed package/bin from `@dust-tt/dust-cli`/`dust` to **`dust-cli`**/`dust` — installing this fork shadows the official npm package's `dust` command on `PATH` (intentional; this is meant to replace it, not coexist alongside it)
- Build config no longer generates `.d.ts` output (irrelevant for a CLI binary, and was crashing on an unrelated `rollup-plugin-dts` incompatibility)

---

## Screenshots

**Markdown rendering** — headings, lists, task lists, links, inline code, tables, and syntax-highlighted code blocks:

<p align="center">
  <img src="./img/markdown.PNG" alt="Markdown showcase" width="340"/>
</p>

**Status bar** — workspace, agent, folder, branch, conversation ID, context usage, and consumed credits:

![Status bar](./img/credits-context-folder-branch.PNG)

**Clipboard image paste** — `/attach` offers a "Paste image from clipboard" option (Windows), which the agent can then read like any other attachment:

<p align="center">
  <img src="./img/command-attach-picture-from-clipboard.PNG" alt="Paste image from clipboard" width="480"/>
</p>

![Attached clipboard image analyzed by the agent](./img/image-path-attachment.PNG)

---

## Installation

### Quick install (Windows)

One line, no prerequisites — installs NVM for Windows, Node.js, and builds and links this fork:

```powershell
irm https://raw.githubusercontent.com/jlrouzies-mantu/dust-cli/main/scripts/Install-DustCLI.ps1 | iex
```

Re-run the same command any time to update to the latest version. The script lives at [`scripts/Install-DustCLI.ps1`](./scripts/Install-DustCLI.ps1) — read it before running it, as with any install script piped from the internet.

### Manual install

```bash
git clone <this-repo-url>
cd dust-cli
npm install
npm run build:prod
npm link   # optional: makes `dust` available globally
```

### Linux

`dust` depends on [`keytar`](https://www.npmjs.com/package/keytar) for storing credentials. On Linux, `keytar` requires `libsecret`:

- Debian/Ubuntu: `sudo apt-get install libsecret-1-dev`
- Red Hat-based: `sudo yum install libsecret-devel`
- Arch Linux: `sudo pacman -S libsecret`

This fork reads the exact same credentials the official CLI stores — if you've already run `dust login`, it picks up that session automatically. No separate login step needed.

## Usage

```bash
dust [command] [options]
```

When no command is given, `chat` is used by default.

### Commands

- **`login`** — authenticate with your Dust account (`--force` to re-authenticate)
- **`status`** — check your current authentication status
- **`logout`** — log out
- **`skill:init`** — install the dust skill for coding CLIs (Claude Code, Codex)
- **`chat`** — chat with a Dust agent (default)
  - `--agent "<name>"` / `-a` — search for and use an agent by name
  - `--sId <sId>` / `-s` — specify an agent's sId directly
  - `--resume <conversationId>` / `-r` — resume a past conversation
  - `--auto` — automatically accept all file-edit operations without prompting
  - `--message "<text>"` / `-m` — send one message non-interactively and exit
- **`help`** — display help information

### Shortcuts

| Keys | Action |
|---|---|
| `Enter` | Send message |
| `Ctrl+Enter` / `Shift+Enter` | Insert a newline |
| `Ctrl+W` | Delete the previous word (more reliable than Ctrl+Backspace across terminals) |
| `Ctrl+Backspace` | Delete the previous word |
| `Ctrl+Left` / `Ctrl+Right` | Jump to the previous/next word |
| `Esc` | Clear input, or cancel the current generation |
| `Ctrl+C` | Cancel generation if one is running; press twice within 2s to exit while idle |
| `Ctrl+G` | Open the current conversation in the browser |

### Status bar

A persistent, colorized line at the bottom of the chat shows:

```
workspace · @agent · ~/current/folder · git-branch · a1b2c3d4 · 14.5k/272k (5%) context · 1595/52000 (3%) credits used
```

Context-window usage and consumed credits come from endpoints the Dust web dashboard itself calls internally (`/api/w/{workspaceId}/credits/my-usage` and `.../assistant/conversations/{id}/context-usage`) — not the public, documented `/api/v1` API. They work with the same Bearer token this CLI already has, but Dust hasn't committed to supporting them for external clients, so they could change or disappear without notice. If either call fails, that piece of the status bar just silently omits itself rather than erroring.

### In-Chat Commands

- **`/exit`** — exit the chat session
- **`/switch`** — switch to a different agent
- **`/attach`** — open a file selector to attach a file (includes a "Paste image from clipboard" option on Windows)
- **`/clear-files`** — clear any attached files
- **`/auto`** — toggle auto-approval of file edits

### Headless Authentication

For CI/CD and automated workflows, skip interactive login entirely:

```bash
export DUST_API_KEY="sk_your_api_key_here"
export DUST_WORKSPACE_ID="ws_abc123"
dust chat --agent "MyAgent" --message "hello"
```

or via flags: `dust chat --wId ws_abc123 --key sk_your_api_key_here`.

**Note:** this auth path only works for chat/messages — the local filesystem/shell tool-use subsystem (`--with-tools`) requires a full OAuth session (`dust login`), not a workspace API key.

## Development

```bash
npm install
npm run build        # dev build
npm run build:prod    # production build (bakes in the production API domain)
node dist/index.js <command>
```

`npm run dev` watches and rebuilds on change.

### Versioning

`0.4.5-mantu.X.Y.Z` — `0.4.5` is the upstream Dust CLI base version (only changes on a resync, see below); `X.Y.Z` is this fork's own version, bumped on every change so the version shown in the header (`Dust CLI v...`) always tells you whether you're actually running the latest build. Bump `Z` for a routine fix, `Y` for a batch of related changes, `X` for a major rework or an upstream resync.

## Relationship to Upstream

This is a **standalone repository**, not a GitHub-native fork of [`dust-tt/dust`](https://github.com/dust-tt/dust). GitHub can only fork an entire repository, and `dust-tt/dust` is a large monorepo containing Dust's whole platform — forking all of it just to maintain one CLI subdirectory (`cli/dust-cli`) would be unnecessarily heavy and awkward to keep in sync. Instead, this repo contains just that subdirectory's contents at its root.

An `upstream` remote is configured for reference:

```bash
git remote -v
# upstream  https://github.com/dust-tt/dust.git
```

Because this repo's file layout doesn't mirror upstream's `cli/dust-cli/` prefix, native tools like `git subtree` don't cleanly apply here. To pull in new upstream fixes:

1. `git fetch upstream`
2. `git log upstream/main -- cli/dust-cli` to see what's changed since the last sync
3. Review each relevant commit and port it by hand (an AI assistant reviewing the diff and reconciling it against this fork's changes works well here, since several of this fork's changes touch the same files upstream is likely to keep evolving)

Base import: `dust-tt/dust` @ `8f55d2a`.

## License

MIT — see [`LICENSE`](./LICENSE). Original work © Dust; fork initiated by Jean-Laurent (Mantu).
