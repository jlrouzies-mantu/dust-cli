# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex CLI, Cursor, etc.)
working in this repository. Humans: see [`README.md`](README.md) for
everything else; this file is specifically about **versioning** and
**staying in sync with upstream**.

## What this repo is

A standalone, Windows-focused fork of upstream `dust-tt/dust`'s
`cli/dust-cli` package (the official Dust CLI). It exists to fix a specific
set of bugs upstream has on legacy Windows consoles (bad paste handling,
unrecoverable crashes, no persistence) plus a set of UX additions - see
README's "Changelog" section for the full feature-level list. The binary is
deliberately renamed `dustm` (not `dust`) so both can be installed side by
side on the same machine.

This repo is **not** a GitHub-native fork and has no shared git history with
`dust-tt/dust` - it contains a flat copy of that repo's `cli/dust-cli/`
subdirectory's contents at its own root (forking the entire `dust-tt/dust`
monorepo just to track one subdirectory would be unnecessarily heavy). That
means there is no `git merge`/`git subtree`/`git rebase` against upstream
available - syncing is a manual diff-and-port process, described below.

## Versioning

`package.json`'s `version` is plain semver (`X.Y.Z`), **independent of
whatever version upstream is on** - do not encode upstream's version into
it. This fork started its own versioning at `0.1.0`; these are its first
releases, so the version should not imply more history than exists.

- Bump `Z` for a routine fix.
- Bump `Y` for a batch of related changes.
- Bump `X` for a major rework, or right after an upstream sync (see below).
- Use `npm --no-git-tag-version version <x.y.z>` so `package.json` and
  `package-lock.json` stay consistent - never hand-edit the version in only
  one of them.
- Pushing a tag `vX.Y.Z` (matching `package.json`'s version, by convention)
  triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
  which builds and publishes the installable Windows/macOS release that
  `scripts/Install-DustCLI.ps1` and `scripts/install-dustcli.sh` (macOS)
  download. That workflow also has a `workflow_dispatch` trigger for a
  manual run from the Actions tab if you need a release without pushing a
  tag - merging to `main` alone does **not** publish a release.

## Syncing with upstream

**Last synced with:** `dust-tt/dust` @ `8f55d2a728815fe861befd10ef7c09e8e6cdb8f1`
(2026-08-05). Confirmed via the GitHub API that no commit has touched
`cli/dust-cli` in the upstream repo since `4e02a5f50573e8c8fff5116a2195a6e0232cf041`
(2026-07-24, "Update mcpsdk to 1.29") - so as of that date this fork was, and
still may be, fully caught up. **Update this line to the new commit SHA and
date every time you complete a sync below**, so the next sync knows exactly
where to start.

An `upstream` git remote (`https://github.com/dust-tt/dust.git`) is also
already configured (`git remote -v`) if you'd rather work with `git log
upstream/main -- cli/dust-cli` / `git show upstream/main:cli/dust-cli/<path>`
locally than hit the GitHub API - either works, just don't do a full
`git fetch upstream` without `--filter=blob:none` or similar, since
`dust-tt/dust` is a large monorepo.

### Procedure

1. Check what's changed upstream since the last-synced commit above:
   ```
   curl -s "https://api.github.com/repos/dust-tt/dust/commits?path=cli/dust-cli&per_page=30" \
     | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>JSON.parse(d).forEach(c=>console.log(c.sha.slice(0,10),c.commit.author.date,c.commit.message.split('\n')[0])))"
   ```
   Stop scrolling once you reach the last-synced SHA above - everything
   above that line in the output is new.
2. If there's nothing new, just update the "Last synced" line to today's
   date (same SHA) and stop.
3. Otherwise, diff this fork's file tree against upstream's tree at the
   latest commit to see exactly what's new/removed at the file level
   (this is how the "Mantu-only files" list below was generated):
   ```
   curl -s "https://api.github.com/repos/dust-tt/dust/git/trees/<latest-sha>?recursive=1" \
     | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p='cli/dust-cli/';JSON.parse(d).tree.filter(e=>e.path.startsWith(p)&&e.type==='blob').forEach(e=>console.log(e.path.slice(p.length)))})"
   ```
   Compare that against `git ls-files` here (excluding this fork's own
   additions: `.github/`, `scripts/`, `img/`, `AGENTS.md`, `README.md`).
4. For every file that exists in **both** trees, fetch upstream's current
   version (`https://raw.githubusercontent.com/dust-tt/dust/<sha>/cli/dust-cli/<path>`)
   and diff it against this fork's copy of the same file. Where upstream
   changed something this fork hasn't touched, port it directly. Where
   upstream changed a line this fork has already patched (e.g. anything
   using the literal string `dust` where this fork uses `dustm`), **reconcile
   by hand** - re-apply this fork's intent on top of upstream's new code,
   don't blindly overwrite the file with upstream's version.
5. For files that exist upstream but not in this fork - new upstream files -
   copy them in as-is unless they conflict with a Mantu-only file below.
6. Rebuild and smoke-test before committing: `npm run build:prod`, then
   actually run `node dist/index.js status` / a short chat locally. This
   fork has a history of subtle terminal/native-module regressions slipping
   through a clean build.
7. Bump the version (`X` per the versioning section above) and update the
   "Last synced" line at the top of this section to the new commit SHA and
   today's date.

### Files that are Mantu-only (never exist upstream - safe to leave untouched by a sync)

Verified by diffing this fork's tracked files against upstream's tree at the
last-synced commit (procedure step 3 above):

- `src/utils/brand.ts` - Mantu ANSI color palette
- `src/utils/clipboardImage.ts` - clipboard image paste (Windows/macOS)
- `src/utils/transcriptStore.ts` - local crash-safe conversation transcripts
- `src/utils/retry.ts` - auto-retry wrapper for transient API errors
- `src/utils/markdown.ts` - markdown rendering fixes
- `src/utils/gitInfo.ts`, `src/utils/creditsInfo.ts`, `src/utils/contextUsage.ts` - status bar data sources
- `src/ui/components/ThinkingIcon.tsx` - transient pulsing "Thinking" indicator
- `src/mcp/tools/todoWrite.ts` - `todo_write` tool (`--with-tools` mode)
- `src/types/marked-terminal.d.ts` - type shim
- Everything under `.github/`, `scripts/`, `img/`, plus `AGENTS.md` and
  `README.md` themselves

### Files that exist upstream too, but carry Mantu patches (review line-by-line during a sync, don't overwrite wholesale)

Everything else under `src/` (notably `src/ui/App.tsx`, `src/ui/commands/*`,
`src/utils/hooks/*`, `src/mcp/servers/fsServer.ts`, `src/mcp/tools/*`,
`src/utils/grep.ts`) plus `package.json`, `tsconfig.json`, `tsup.config.ts`,
`.nvmrc`, `.env.development`, `.env.production`. In particular, grep for the
literal string `dustm` before touching any of these - every occurrence is a
deliberate rename from upstream's `dust` that a sync must preserve.

### Keeping the Node.js version in lockstep

If upstream bumps its required Node version, update **all** of these
together (currently pinned to `24.16.0` everywhere):

- `package.json` (`engines.node`)
- `.nvmrc`
- `.github/workflows/ci.yml` and `.github/workflows/release.yml` (`node-version`)
- `scripts/Install-DustCLI.ps1` and `scripts/Install-LocalMode.ps1` (`$NodeVersion`)
- `scripts/install-dustcli.sh` (`NODE_VERSION`)

## Other durable rules for this repo

- Never rename the `dustm` binary back to `dust` - it's deliberate, so this
  fork can coexist with the official Dust CLI on the same machine.
- Keep the Mantu ANSI color palette (sampled from `img/mantutheme.bmp`, also
  defined inline in each install script) and the collapsed-step spinner
  pattern in `scripts/Install-DustCLI.ps1` / `scripts/install-dustcli.sh`
  when touching them - don't reintroduce plain/unstyled output.
- `scripts/Install-LocalMode.ps1` is a dev-only installer that builds
  in-place from whatever's checked out locally (no clone, no release
  download) - it exists so branch/local changes can be tested without
  merging to `main` first. Don't add a release-download path to it.
