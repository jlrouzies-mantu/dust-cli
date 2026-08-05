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
- [Installation](#installation)
- [Usage](#usage)
  - [Commands](#commands)
  - [Shortcuts](#shortcuts)
  - [Status bar](#status-bar)
  - [In-Chat Commands](#in-chat-commands)
  - [Headless Authentication](#headless-authentication)
- [Development](#development)
- [Relationship to Upstream](#relationship-to-upstream)
- [License](#license)

---

## Changelog: Mantu fork vs. upstream Dust CLI

This fork exists to fix a specific, reproducible set of problems the official CLI has on Windows consoles without full VT/Unicode support (legacy `conhost`, PowerShell 5) — bad paste handling, unrecoverable crashes, no persistence — plus a set of UX upgrades. Auth, agent listing, and non-interactive mode are otherwise untouched.

### 🐛 Fixed

| Issue | Root cause |
|---|---|
| Multi-line paste corrupted the input / submitted early | Pasted text arrives as individual keystrokes (not one batched event) on terminals without bracketed-paste support; each embedded newline was hitting the same code path as a real Enter press |
| Ctrl+Backspace did nothing; no Ctrl+Left/Right word-jump | Ctrl+Backspace was simply never implemented upstream. Word-jump only existed via `Meta+B`/`Meta+F` (the Mac convention) — Windows/Linux users had no working shortcut at all |
| Any transient stream error showed a fatal, unrecoverable "Agent error" | The stream consumer never checked whether the answer had actually completed server-side before giving up |
| Agent list / MCP registration / user-info fetches failed permanently on a single transient hiccup | No retry logic anywhere — the first error (even a passing gateway blip) went straight to the user |
| `--resume` wiped the user's entire terminal scrollback | `clearTerminal()` sent `\x1b[3J`, which erases the terminal's *scrollback buffer* — not just the visible screen |
| Several UI glyphs rendered as garbage or misaligned boxes | `↵`, `…`, `↑`/`↓`, `→`, and every `borderStyle="round"` box border are Unicode code points this console's font doesn't cover |
| Code blocks rendered with a border stretching across the whole terminal, and a patchy background | Ink/Yoga's default column-flex stretches boxes to the parent's full width unless `alignSelf` is set; `Text`'s `backgroundColor` only paints behind actual characters, so shorter lines need explicit padding |
| Markdown headings (`# Title`) were never rendered — the `#` stayed literal | Confirmed upstream bug in `marked-terminal@7.3.0`'s heading renderer, reproducible with their own README example verbatim |
| `npm run build` failed out of the box on Windows | The build scripts use bash-style `NODE_ENV=x cmd` syntax |
| The app crashed on startup | The update-checker queried the npm registry for a package (`dustw`) that isn't published there |

### ✨ Added

| Feature | Notes |
|---|---|
| Crash recovery | On a stream error, falls back to fetching the conversation from the server before surfacing a fatal error (works around a known `@dust-tt/client` SSE bug where a non-JSON `done` sentinel exhausts the reconnect budget even though the answer already landed) |
| Auto-retry on transient API errors | Agent list, user info, MCP registration, and the answer stream retry up to 5x with backoff before giving up. Deliberately *not* applied to conversation-creation/message-posting — those aren't idempotent, so retrying one that actually succeeded server-side risks a duplicate message |
| Actionable error messages | Any fatal error prints the exact command to resume that conversation, not just a bare ID |
| Local crash-safe transcripts | Every turn is appended to `~/.dust-cli/transcripts/<conversationId>.jsonl` as a durability backstop |
| Ctrl+C safety net | Cancels the current generation if one is running; otherwise requires a second press within 2s to exit, with a visible warning in between |
| Markdown rendering | Code fences are syntax-highlighted and boxed on their own (gray border, black background); surrounding prose stays plain, not boxed |
| Chain-of-thought as a transient status | Shown as a live "Thinking…" line instead of permanently dumped into scrollback, with a custom plain-ASCII pulse icon (`[ ]`/`[o]`/`[O]`/`[o]`) — safe on PowerShell 5, unlike braille/Unicode spinners |
| Persistent, colorized status bar | Workspace, active agent, working directory, git branch, conversation ID, context-window usage, and consumed credits — see [Status bar](#status-bar) |
| Ctrl+Enter / Shift+Enter | Multi-line input, in addition to the existing shortcuts |
| Mantu-branded header | Full-width separator, "MANTU FORK" + "Initiated by: Jean-Laurent" in brand colors |

### 🔧 Changed

- Renamed package/bin from `@dust-tt/dust-cli`/`dust` to **`dust-cli`**/`dust` — installing this fork shadows the official npm package's `dust` command on `PATH` (intentional; this is meant to replace it, not coexist alongside it)
- Build config no longer generates `.d.ts` output (irrelevant for a CLI binary, and was crashing on an unrelated `rollup-plugin-dts` incompatibility)

---

## Installation

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
workspace · @agent · ~/current/folder · git-branch · a1b2c3d4 · 14.5k/272k tokens · 1595 credits used
```

Context-window usage and consumed credits come from endpoints the Dust web dashboard itself calls internally (`/api/w/{workspaceId}/credits/my-usage` and `.../assistant/conversations/{id}/context-usage`) — not the public, documented `/api/v1` API. They work with the same Bearer token this CLI already has, but Dust hasn't committed to supporting them for external clients, so they could change or disappear without notice. If either call fails, that piece of the status bar just silently omits itself rather than erroring.

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
