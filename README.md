<div align="center">

# ⟡ dust-cli (dustm)

### The Mantu fork of the Dust CLI

![Mantu Fork](https://img.shields.io/badge/Mantu-Fork-7C2AE8?style=for-the-badge&labelColor=1A0B2E)
![Based on Dust CLI](https://img.shields.io/badge/Base-Dust%20CLI-D4A72C?style=for-the-badge&labelColor=1A0B2E)
![License](https://img.shields.io/badge/License-MIT-FFFFFF?style=for-the-badge&labelColor=7C2AE8)
![Node](https://img.shields.io/badge/Node-%3E%3D24.16-D4A72C?style=for-the-badge&labelColor=1A0B2E)

*A hardened, restyled build of [`@dust-tt/dust-cli`](https://github.com/dust-tt/dust/tree/main/cli/dust-cli) — same agents, same account, but a more consistent console experience.*

</div>

---

## Table of Contents

- [Changelog: Mantu fork vs. upstream Dust CLI](#changelog-mantu-fork-vs-upstream-dust-cli)
- [Screenshots](#screenshots)
- [Installation](#installation)
  - [Quick install (Windows)](#quick-install-windows)
  - [Quick install (macOS / Linux)](#quick-install-macos--linux)
- [Usage](#usage)
  - [Commands](#commands)
  - [Shortcuts](#shortcuts)
  - [Steering](#steering)
  - [Status bar](#status-bar)
  - [In-Chat Commands](#in-chat-commands)
  - [Headless Authentication](#headless-authentication)
- [Development](#development)
  - [Versioning](#versioning)
- [Relationship to Upstream](#relationship-to-upstream)
- [License](#license)

---

## Changelog: Mantu fork vs. upstream Dust CLI

### ✨ Added

| Feature | Notes |
|---|---|
| Crash recovery | Falls back to fetching the conversation from the server instead of showing a fatal error |
| Auto-retry on API errors | Up to 5x with backoff on transient failures; skipped for non-idempotent calls |
| Actionable error messages | Fatal errors include the exact command to resume that conversation |
| Local crash-safe transcripts | Every turn appended to `~/.dust-cli/transcripts/<id>.jsonl` |
| Ctrl+C safety net | Genuinely cancels generation server-side (via `cancelMessageGeneration`) if running, not just a client-side disconnect; otherwise double-press within 2s to exit |
| `/clear` command | Alias for `/new` — the more familiar name from other chat UIs |
| LaTeX math rendering | `$...$` / `$$...$$` spans (Greek letters, `\frac`, `\sqrt`, accents, sub/superscripts) converted to readable Unicode before markdown ever sees them, since a terminal can't typeset real math |
| Markdown rendering | Syntax-highlighted code fences, boxed on their own |
| Transient "Thinking…" status | `◊` icon pulsing between brand colors instead of a permanent scrollback dump |
| Persistent, colorized status bar | Workspace, agent, folder, branch, tokens, credits — see [Status bar](#status-bar) |
| Ctrl+Enter / Shift+Enter | Multi-line input |
| `todo_write` tool | Claude-Code-style task checklist (`--with-tools` only) |
| Dust directive handling | Web-only directives (e.g. `:preview_file{...}`) shown as readable placeholders; citation refs (`:cite[...]`), which the web app turns into clickable footnotes but carry no information without that link data, are stripped instead of leaking mid-sentence |
| Clipboard image paste | Attach a screenshot straight from the clipboard via Ctrl+V or `/attach` — Windows tested, macOS untested — see [In-Chat Commands](#in-chat-commands) |
| Paste compaction | Large multi-line pastes collapse to a `[Pasted N lines of text]` placeholder while composing, instead of dumping the raw text inline; the full content is what's shown in the transcript and sent once you hit Enter - the placeholder never lands in permanent scrollback |
| Portable content search | `search_content` (`--with-tools`) no longer shells out to the system `grep` binary, and supports lines of context around each match |
| `write_file` tool | Local file creation/overwrite (`--with-tools`), so "create a file" lands on disk in the current folder instead of Dust's hosted, web-only file preview |
| Message queuing | Type and send while the agent is still working — queued messages show in a bordered box below the input and auto-send in order once the current turn ends; recall the last one with Up-arrow/Backspace to edit or cancel it |
| Real steering (`Ctrl+S`) | Genuinely interrupts the current turn server-side (via `cancelMessageGeneration`, not just a client-side disconnect) and sends your message as a redirect — see [Steering](#steering) for how it works and its limits |
| Shell-history recall (Up/Down) | When there's nothing queued, Up-arrow steps backward through this conversation's own previously sent messages (Down steps forward again) |
| Persistent file-change previews | Approved `write_file`/`edit_file` previews stay in scrollback after the turn finishes, instead of disappearing once the approval prompt closes |
| Immediate startup feedback | Prints "Starting dustm..." right away, before the (larger) UI dependency graph finishes loading, so the CLI doesn't look stuck on a slow/cold start |
| Visible retry indicator | API/MCP call retries now show a spinner + `[attempt/max] Retrying ... — <error>` line instead of only ever showing up in `~/.dust-cli/logs/` - previously indistinguishable from "it didn't retry at all" |

### 🐛 Fixed

| Issue | Root cause |
|---|---|
| Multi-line paste corrupted input / submitted early | No bracketed-paste support — pasted newlines triggered submit |
| No Ctrl+Backspace / Ctrl+Left/Right word-jump | Never implemented upstream |
| Transient stream errors showed a fatal, unrecoverable error | Never checked whether the answer had actually completed server-side |
| Agent list / MCP / user-info fetches failed on one hiccup | No retry logic anywhere |
| Re-rendering the view (resume, terminal resize) wiped the terminal scrollback | `clearTerminal()` used the wrong escape sequence — these cases now only clear the visible screen. A *deliberate* full wipe (screen + scrollback) still happens where a blank slate is the whole point: launching the chat, `/new`, and `/clear` |
| UI glyphs rendered as garbage or misaligned boxes | Unicode glyphs unsupported on this console's font |
| Code block borders/backgrounds rendered wrong | Ink/Yoga layout defaults, unpadded background fill |
| Markdown headings/bold never rendered | Confirmed `marked-terminal@7.3.0` bug |
| `npm run build` failed on Windows | Bash-style `NODE_ENV=x` syntax in scripts |
| `search_content` (`--with-tools`) could silently fail | It shelled out to the system `grep` binary, not guaranteed to exist on plain Windows without Git for Windows/WSL |
| Agent sometimes tried to run commands/create files in an unrelated sandbox | `run_command`'s description didn't distinguish it from Dust's own hosted, sandboxed code-interpreter tool — clarified to state it runs on the user's real local machine and current folder |
| Ctrl+Delete deleted the previous word instead of the next one | It shared the same "delete previous word" branch as Ctrl+Backspace/Ctrl+W instead of deleting forward |
| Delete key deleted backward like Backspace | Ink normalizes both keys to the same flag with no way to tell them apart from its public API; now disambiguated by reading the raw key sequence directly |
| Terminal flickered, and fought manual scrolling, on long agent answers | The live streaming preview re-rendered the *entire* accumulated answer every second with no height limit — each redraw is new output, so the terminal auto-scrolled to reveal it, overriding any manual scroll-up; now capped to a small, constant-size tail (same footprint as the "Thinking" spinner) regardless of answer length |
| `/new` (and `/clear`) left the old status bar/input box visible above the fresh one instead of replacing it | `clearTerminal()` writes raw ANSI codes directly to stdout, bypassing Ink's own render bookkeeping — the next render doesn't know the screen was wiped, so it doesn't correctly replace the previous frame. Same class of artifact already worked around for terminal *resizes*; now the same fix (forcing a full remount) applies here too |

---

## Screenshots

**Markdown rendering** — headings, lists, task lists, links, inline code, tables, and syntax-highlighted code blocks:

<p align="center">
  <img src="./img/markdown.PNG" alt="Markdown showcase" width="340"/>
</p>

**Status bar** — workspace, agent, folder, branch, conversation ID, context usage, and consumed credits:

![Status bar](./img/credits-context-folder-branch.PNG)

**Clipboard image paste** — Ctrl+V or `/attach`'s "Paste image from clipboard" option, which the agent can then read like any other attachment. Verified on Windows; the macOS path uses the same approach via AppleScript but hasn't been tested on a real Mac yet:

<p align="center">
  <img src="./img/command-attach-picture-from-clipboard.PNG" alt="Paste image from clipboard" width="336"/>
</p>

<p align="center">
  <img src="./img/image-path-attachment.PNG" alt="Attached clipboard image analyzed by the agent" width="382"/>
</p>

---

## Installation

### Quick install (Windows)

One line, no prerequisites — installs NVM for Windows, Node.js, and builds and links this fork:

```powershell
irm "https://raw.githubusercontent.com/jlrouzies-mantu/dust-cli/main/scripts/Install-DustCLI.ps1?nocache=$((Get-Date).Ticks)" | iex
```

### Quick install (macOS / Linux)

Same idea, via `nvm` instead of NVM for Windows — untested on a real Mac/Linux box, please report back if it doesn't work:

```bash
curl -fsSL "https://raw.githubusercontent.com/jlrouzies-mantu/dust-cli/main/scripts/install-dustcli.sh?nocache=$(date +%s)" | bash
```

### Manual install

```bash
git clone <this-repo-url>
cd dust-cli
npm install
npm run build:prod
npm link   # optional: makes `dustm` available globally
```

### Linux

`dustm` depends on [`keytar`](https://www.npmjs.com/package/keytar) for storing credentials. On Linux, `keytar` requires `libsecret`:

- Debian/Ubuntu: `sudo apt-get install libsecret-1-dev`
- Red Hat-based: `sudo yum install libsecret-devel`
- Arch Linux: `sudo pacman -S libsecret`

This fork reads the exact same credentials the official CLI stores — if you've already run `dust login`, it picks up that session automatically. No separate login step needed.

## Usage

```bash
dustm [command] [options]
```

When no command is given, `chat` is used by default.

### Commands

| Command | Description |
|---|---|
| `login` | Authenticate with your Dust account (`--force` to re-authenticate) |
| `status` | Check your current authentication status |
| `logout` | Log out |
| `skill:init` | Install the dustm skill for coding CLIs (Claude Code, Codex) |
| `chat` | Chat with a Dust agent (default command) |
| &nbsp;&nbsp;`--agent "<name>"` / `-a` | Search for and use an agent by name |
| &nbsp;&nbsp;`--sId <sId>` / `-s` | Specify an agent's sId directly |
| &nbsp;&nbsp;`--resume <conversationId>` / `-r` | Resume a past conversation |
| &nbsp;&nbsp;`--auto` | Automatically accept all file-edit operations without prompting |
| &nbsp;&nbsp;`--message "<text>"` / `-m` | Send one message non-interactively and exit |
| `help` | Display help information |

### Shortcuts

| Keys | Action |
|---|---|
| `Enter` | Send message |
| `Ctrl+Enter` / `Shift+Enter` | Insert a newline |
| `Ctrl+W` | Delete the previous word (more reliable than Ctrl+Backspace across terminals) |
| `Ctrl+Backspace` | Delete the previous word (best-effort — not every terminal reports it distinctly from plain Backspace) |
| `Ctrl+Delete` | Delete the next word |
| `Ctrl+Left` / `Ctrl+Right` | Jump to the previous/next word |
| `Esc` | Clear input if there's a draft, otherwise cancel the current generation (genuinely, server-side - see [Steering](#steering)) |
| Enter (while the agent is working) | Queue the message — sent automatically once the current turn ends |
| `Ctrl+S` (while the agent is working) | Steer — see [Steering](#steering) |
| Up-arrow / Backspace on an empty input | Recall the last queued message for editing — clear it with `Esc` to cancel, or just send it. With nothing queued, Up/Down instead step through this conversation's own message history (shell-style) |
| `Ctrl+C` | Cancel generation if one is running (same as Esc); press twice within 2s to exit while idle |
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
- **`/new`** / **`/clear`** — start a new conversation on a fully blank terminal (screen *and* scrollback cleared, same as launching `dustm`). Both do the same thing — `/clear` is just the more familiar name from other chat UIs
- **`/attach`** — open a file selector to attach a file (includes a "Paste image from clipboard" option — also bound to Ctrl+V directly; Windows tested, macOS untested)
- **`/clear-files`** — clear any attached files
- **`/auto`** — toggle auto-approval of file edits

### Headless Authentication

For CI/CD and automated workflows, skip interactive login entirely:

```bash
export DUST_API_KEY="sk_your_api_key_here"
export DUST_WORKSPACE_ID="ws_abc123"
dustm chat --agent "MyAgent" --message "hello"
```

or via flags: `dustm chat --wId ws_abc123 --key sk_your_api_key_here`.

**Note:** this auth path only works for chat/messages — the local filesystem/shell tool-use subsystem (`--with-tools`) requires a full OAuth session (`dustm login`), not a workspace API key.

## Development

```bash
npm install
npm run build        # dev build - points at http://localhost:3000, NOT the real API
npm run build:prod    # production build (bakes in the production API domain)
node dist/index.js <command>
```

**If `dustm` (or `node dist/index.js`) fails with `fetch failed` / `ECONNREFUSED` against `localhost:3000`**, that's this: the last build was a dev build, which intentionally points at a local Dust server (for engineers developing against a local `dust-tt/dust` checkout) that isn't running on your machine. Run `npm run build:prod` and try again - this isn't a network or retry bug.

`npm run dev` watches and rebuilds on change.

### Versioning

Plain semver (`X.Y.Z`), independent of whatever version upstream `dust-tt/dust` is on — these are this fork's first releases, so it starts at `0.1.0` rather than pretending to be further along. Bump `Z` for a routine fix, `Y` for a batch of related changes, `X` for a major rework or an upstream resync. Pushing a tag `vX.Y.Z` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds and publishes the Windows/macOS installable release.

## Relationship to Upstream

This is a **standalone repository**, not a GitHub-native fork of [`dust-tt/dust`](https://github.com/dust-tt/dust). GitHub can only fork an entire repository, and `dust-tt/dust` is a large monorepo containing Dust's whole platform — forking all of it just to maintain one CLI subdirectory (`cli/dust-cli`) would be unnecessarily heavy and awkward to keep in sync. Instead, this repo contains just that subdirectory's contents at its root.

### Keeping this fork up to date

To pull in upstream fixes/features, just ask your coding agent (Claude Code, Codex CLI, etc.):

> Follow [`AGENTS.md`](AGENTS.md) and sync any new upstream changes from `dust-tt/dust` into this fork.

[`AGENTS.md`](AGENTS.md) tracks exactly which upstream commit this fork was last synced against, lists the Mantu-specific changes that a sync must not blindly overwrite, and has the step-by-step procedure for diffing and porting upstream's `cli/dust-cli` changes by hand (there's no shared git history to `git merge`/`git subtree` against, since this repo only contains that one subdirectory's contents).

## License

MIT — see [`LICENSE`](./LICENSE). Original work © Dust; fork initiated by Jean-Laurent (Mantu).
