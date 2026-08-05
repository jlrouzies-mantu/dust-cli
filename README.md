<div align="center">

# ⟡ dustw

### The Mantu fork of the Dust CLI

![Mantu Fork](https://img.shields.io/badge/Mantu-Fork-7C2AE8?style=for-the-badge&labelColor=1A0B2E)
![Based on Dust CLI](https://img.shields.io/badge/Base-Dust%20CLI-D4A72C?style=for-the-badge&labelColor=1A0B2E)
![License](https://img.shields.io/badge/License-MIT-FFFFFF?style=for-the-badge&labelColor=7C2AE8)
![Node](https://img.shields.io/badge/Node-%3E%3D24.16-D4A72C?style=for-the-badge&labelColor=1A0B2E)

*A hardened, restyled build of [`@dust-tt/dust-cli`](https://github.com/dust-tt/dust/tree/main/cli/dust-cli) — same agents, same account, a console experience that actually survives legacy Windows terminals.*

</div>

---

## Table of Contents

- [Changelog: dustw vs. upstream Dust CLI](#changelog-dustw-vs-upstream-dust-cli)
- [Installation](#installation)
- [Usage](#usage)
  - [Commands](#commands)
  - [Shortcuts](#shortcuts)
  - [In-Chat Commands](#in-chat-commands)
  - [Headless Authentication](#headless-authentication)
- [Development](#development)
- [Relationship to Upstream](#relationship-to-upstream)
- [License](#license)

---

## Changelog: dustw vs. upstream Dust CLI

This fork exists to fix a specific, reproducible set of problems the official CLI has on Windows consoles without full VT/Unicode support (legacy `conhost`, PowerShell 5) — bad paste handling, unrecoverable crashes, no persistence — plus a handful of UX upgrades. Everything else (auth, agent listing, MCP tool-use, non-interactive mode) is untouched.

### 🐛 Fixed

| Issue | Root cause |
|---|---|
| Multi-line paste corrupted the input / submitted early | Pasted text arrives as individual keystrokes (not one batched event) on terminals without bracketed-paste support; each embedded newline was hitting the same code path as a real Enter press |
| Ctrl+Backspace did nothing | Simply never implemented upstream |
| Any transient stream error showed a fatal, unrecoverable "Agent error" | The stream consumer never checked whether the answer had actually completed server-side before giving up |
| `--resume` wiped the user's entire terminal scrollback | `clearTerminal()` sent `\x1b[3J`, which erases the terminal's *scrollback buffer* — not just the visible screen |
| Several UI glyphs rendered as garbage or misaligned boxes | `↵`, `…`, `↑`/`↓`, `→`, and every `borderStyle="round"` box border are Unicode code points this console's font doesn't cover |
| `npm run build` failed out of the box on Windows | The build scripts use bash-style `NODE_ENV=x cmd` syntax |
| The app crashed on startup | The update-checker queries the npm registry for a package (`dustw`) that isn't published there |

### ✨ Added

- **Crash recovery** — on a stream error, falls back to fetching the conversation from the server before surfacing a fatal error (works around a known `@dust-tt/client` SSE bug where a non-JSON `done` sentinel exhausts the reconnect budget even though the answer already landed)
- **Actionable error messages** — any fatal error now prints the exact command to resume that conversation, not just a bare ID
- **Local crash-safe transcripts** — every turn is appended to `~/.dust-cli/transcripts/<conversationId>.jsonl` as a durability backstop
- **Ctrl+C safety net** — cancels the current generation if one is running; otherwise requires a second press within 2s to exit, with a visible warning in between
- **Markdown rendering** — code fences are syntax-highlighted and boxed (gray border, black background); prose renders as styled text instead of raw `**bold**`/```` ``` ```` syntax
- **Chain-of-thought as a transient status** — shown as a live "Thinking…" line instead of permanently dumped into scrollback
- **Persistent status bar** — workspace, active agent, working directory, git branch, and conversation ID, always visible
- **Ctrl+Enter / Shift+Enter** for multi-line input
- **Mantu-branded header**

### 🔧 Changed

- Renamed package/bin from `dust` to **`dustw`** so it can be installed alongside the official CLI without colliding
- Build config no longer generates `.d.ts` output (irrelevant for a CLI binary, and was crashing on an unrelated `rollup-plugin-dts` incompatibility)

---

## Installation

```bash
git clone <this-repo-url>
cd dustw
npm install
npm run build:prod
npm link   # optional: makes `dustw` available globally
```

### Linux

`dustw` depends on [`keytar`](https://www.npmjs.com/package/keytar) for storing credentials. On Linux, `keytar` requires `libsecret`:

- Debian/Ubuntu: `sudo apt-get install libsecret-1-dev`
- Red Hat-based: `sudo yum install libsecret-devel`
- Arch Linux: `sudo pacman -S libsecret`

`dustw` reads the exact same credentials the official `dust` CLI stores — if you've already run `dust login`, `dustw` picks up that session automatically. No separate login step needed.

## Usage

```bash
dustw [command] [options]
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
| `Ctrl+W` | Delete the previous word |
| `Esc` | Clear input, or cancel the current generation |
| `Ctrl+C` | Cancel generation if one is running; press twice within 2s to exit while idle |
| `Ctrl+G` | Open the current conversation in the browser |

### In-Chat Commands

- **`/exit`** — exit the chat session
- **`/switch`** — switch to a different agent
- **`/attach`** — open a file selector to attach a file
- **`/clear-files`** — clear any attached files
- **`/auto`** — toggle auto-approval of file edits

### Headless Authentication

For CI/CD and automated workflows, skip interactive login entirely:

```bash
export DUST_API_KEY="sk_your_api_key_here"
export DUST_WORKSPACE_ID="ws_abc123"
dustw chat --agent "MyAgent" --message "hello"
```

or via flags: `dustw chat --wId ws_abc123 --key sk_your_api_key_here`.

**Note:** this auth path only works for chat/messages — the local filesystem/shell tool-use subsystem (`--with-tools`) requires a full OAuth session (`dustw login`), not a workspace API key.

## Development

```bash
npm install
npm run build        # dev build
npm run build:prod    # production build (bakes in the production API domain)
node dist/index.js <command>
```

`npm run dev` watches and rebuilds on change.

## Relationship to Upstream

This is a **standalone repository**, not a GitHub-native fork of [`dust-tt/dust`](https://github.com/dust-tt/dust). GitHub can only fork an entire repository, and `dust-tt/dust` is a large monorepo containing Dust's whole platform — forking all of it just to maintain one CLI subdirectory (`cli/dust-cli`) would be unnecessarily heavy and awkward to keep in sync. Instead, this repo contains just that subdirectory's contents at its root, with the original history's latest relevant commit noted below.

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
