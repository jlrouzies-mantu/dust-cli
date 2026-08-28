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
- `src/mcp/tools/todoWrite.ts` - `todo_write` tool (`--with-tools` mode); the
  `TodoItem` type here is a re-export of `Task` from `taskStore.ts` (see
  below), kept under this name only so Chat.tsx/Conversation.tsx's existing
  imports didn't need to change
- `src/utils/taskStore.ts`, `src/mcp/tools/readTasks.ts` - persistence,
  dependency validation and `read_tasks` for the task list (see README's
  "Tasks" section). Persisted tasks are keyed by conversation id, read from a
  module-level singleton (`getActiveConversationId`) for the same reason
  `planMode.ts` is one - `todo_write`/`read_tasks` execute inside the MCP
  transport layer with no access to React state. **Two call sites keep that
  singleton current, not one**: `Chat.tsx`'s effect for the interactive path,
  and `chat/nonInteractive.ts`'s `sendNonInteractiveMessage` (right where
  `conversation.sId` becomes known, before streaming starts) for the
  headless/`--loop` path - missing the second one means `todo_write` silently
  stops persisting anything in non-interactive mode, which is exactly the bug
  a live test caught during this feature's own development. If a third
  surface ever calls into these tools, it needs the same wiring. Also: inside
  `todo_write`, `saveTasks` is `await`ed, not fire-and-forget like
  `transcriptStore`'s writes - the task list is what `read_tasks` and a later
  `--resume` actually rely on being current, not a best-effort crash net, so
  "persisted" has to mean persisted by the time the tool call returns.
- `src/utils/chatMode.ts`, `src/utils/planMode.ts`, `src/utils/planStore.ts`,
  `src/mcp/tools/presentPlan.ts` - plan mode and the Shift+Tab mode cycle (see
  README). Two rules to preserve here: the permission mode is **one tri-state**,
  never separate auto/plan booleans (they contradict each other), and
  `planMode.ts` is a module-level singleton **on purpose** - the tools that
  respect it run in the MCP transport layer and cannot read React state, the
  same boundary that makes `todoListEmitter` an emitter. Also: only user
  approval clears plan mode. If you add a **writing** tool, gate it in its
  `execute` and add it to `PLAN_MODE_BLOCKED_TOOLS`, or plan mode silently
  stops being a guarantee - and append `PLAN_MODE_TOOL_NOTICE` to its
  `description` too, or an agent that ignores the per-turn preamble has one
  more tool it wasn't warned away from. If you add a **read-only** tool
  instead, add it to `PLAN_MODE_ALLOWED_TOOLS` so the preamble/refusal text
  actually mentions it - `read_tasks` shipped without this for a full phase
  before it was caught, so this list drifting out of sync is a real, repeated
  failure mode, not a hypothetical one.
- `src/utils/urlFetch.ts`, `src/mcp/tools/fetchUrl.ts` - `fetch_url` tool (see
  README's "Fetching a URL" section). The SSRF guarding in `urlFetch.ts`
  (scheme check, DNS-resolved-address check, re-checked after a redirect) is
  explicitly **defense-in-depth, not a hard guarantee** - it has a
  DNS-rebinding gap that would need hooking into the socket layer to close,
  which is more than this tool's threat model (a locally-run, single-user
  CLI) warrants. Don't strengthen the wording elsewhere to imply it's
  airtight. Read-only, so it's in `PLAN_MODE_ALLOWED_TOOLS`, not
  `PLAN_MODE_BLOCKED_TOOLS`.
- `src/utils/loopController.ts` - `/loop` and `--loop` interval parsing and
  caps (see README). Pure and unit-tested; keep the limits (30s floor, run
  ceiling, unit-required parsing) here rather than inlining them at call
  sites - they exist to stop an unattended loop spending a credit balance.
- `src/utils/claudeMemory.ts`, `src/mcp/tools/readMemory.ts`,
  `src/mcp/tools/writeMemory.ts` - `/claude-code-mode` (see README). These
  read and write `~/.claude`, whose directory layout and memory file format
  are **Claude Code's own internals, not a documented contract**. If that
  layout changes, `claudeMemory.ts` is the only place that needs updating -
  every read there is best-effort and degrades to "absent" rather than
  throwing, so a layout change downgrades the feature instead of breaking
  the CLI. Don't spread `~/.claude` path knowledge into other files.
  Note the two different confidence levels in there: the per-project memory
  path (`projects/<encoded-cwd>/memory/`) is reverse-engineered, while
  `CLAUDE.md` and `.claude/rules/` are documented Claude Code features. Treat
  the former as liable to move without notice.
- `src/utils/skillStore.ts`, `src/mcp/tools/readSkill.ts` - local
  `SKILL.md` skills (see README's "Skills" section), the client-side
  alternative to Dust's admin-locked server-side agent skills. Several rules
  here, each with a real incident or design reason behind it:
  - `read_skill({ names })` must never build a filesystem path from an
    agent-supplied name - `resolveSkill` only looks names up against an
    already-loaded in-memory list, so traversal is impossible by
    construction rather than by validating a slug pattern. Don't "simplify"
    this into a `path.join(dir, agentInput)` for consistency with another
    tool; that would reintroduce exactly what this avoids.
  - `getDustmOutboundSkillDir()` (the exact path `skill:init` installs
    into, `~/.claude/skills/dustm/`) must stay excluded from discovery,
    unconditionally. That installed skill's body is instructions to run
    `dustm chat -a <agent> -m "<message>"` - discovering it with
    `/claude-code-mode` on would hand a Dust agent (which has
    `run_command`) literal instructions to invoke itself. `SkillInit.tsx`
    imports `DUSTM_OUTBOUND_SKILL_NAME` from `skillStore.ts` rather than
    each defining its own copy, so the two can't drift apart.
  - `areClaudeSkillsEnabled()` is a module-level singleton for the same
    reason `planMode.ts` is one: `read_skill` executes in the MCP transport
    layer with no access to React state. It's set from exactly one place,
    `Chat.tsx`'s existing `claudeCodeMode` effect - non-interactive (`-m`)
    mode has no `/claude-code-mode` toggle to sync from, so it correctly
    stays `false` there by construction. If skills ever need injecting in
    non-interactive mode too (deliberately out of scope for now - see the
    plan this was built from), that's a **second** call site the singleton
    needs wiring at, the same shape of bug `taskStore.ts`'s
    `setActiveConversationId` shipped with once (see above).
  - `read_skill` is read-only and belongs in `planMode.ts`'s
    `PLAN_MODE_ALLOWED_TOOLS` - keep it there if that list is ever touched;
    `read_tasks` shipping without this for a full phase is the reason this
    is called out explicitly (see the plan-mode bullet above).
  - The `/skills` picker's on/off state persists to
    `~/.dust-cli/skills-state.json`, which records the **disabled** set, not
    the enabled one - so a newly authored skill is on by default instead of
    silently doing nothing until someone opens a picker they didn't know
    about. Keep that polarity if the file is ever extended. A disabled
    skill is out of scope *everywhere*: excluded from the catalogue and
    refused by `read_skill`. Don't "helpfully" let the agent load one by
    name - that turns a user's explicit choice into a display filter. This
    is also the one place skills state is written deliberately rather than
    best-effort: `saveDisabledSkillNames` returns a result the caller
    surfaces, because silently failing to persist a choice the user just
    made in a picker is worse than saying so.
  - Skill bodies are **never** auto-inlined into the injected block
    regardless of size, unlike `claudeMemory.ts`'s small-memory-set inline
    path. This is deliberate, not a missing optimization: a memory is
    background fact that's almost always relevant, but a skill is a
    conditional procedure whose `description` says *when* to use it -
    inlining a body unconditionally defeats that. Only the catalogue
    (names + descriptions) is auto-injected; a body reaches the agent only
    via `read_skill` or an explicit `/skills <name>`.
  - This only discovers hand-authored `~/.claude/skills/<name>/SKILL.md`
    files. Claude Code's plugin-installed skills live under a completely
    different tree (`~/.claude/plugins/marketplaces/.../skills/`) and are
    **not** read - globbing that tree would advertise skills from plugins
    the user may never have enabled. Documented as a known limitation, not
    a bug to fix reflexively.
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
