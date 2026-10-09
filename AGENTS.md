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

**Last synced with:** `dust-tt/dust` @ `cca35d17fdfa882898840f6ef95b8ef1bb8978bd`
(2026-10-09, upstream `main` at the time). The newest commit touching
`cli/dust-cli` at that point was `adb88346d13a13cfa00d655427fef377d8bb1ba5`
(2026-10-05, "Switch from Biome to oxlint and oxfmt") - start the next sync's
commit list from there. Upstream's CLI `package.json` version was `0.4.6`
(mirrored in `src/utils/version.ts`'s `UPSTREAM_CLI_VERSION`). **Update this
line to the new commit SHA and date every time you complete a sync below**,
so the next sync knows exactly where to start.

The previous version of this line claimed nothing had changed since
2026-07-24 - that went stale silently while five upstream commits landed.
Always re-run step 1 below rather than trusting this line's "caught up" state.

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
- `src/utils/modelSelection.ts` - `/model` and `/effort` (see README's
  "Model and effort"). These send the public API's per-message
  `modelSelection` field, which is a **sibling of `content`/`mentions`/
  `context` on the post body**, not nested inside `context` - easy to get
  wrong, and both send sites (`createConversation` and `postUserMessage` in
  `Chat.tsx`) need it or the override silently applies to only some
  messages. Three things to preserve:
  - `providerId` and `modelId` are **both mandatory** whenever
    `modelSelection` is present, so an effort-only override has to re-send
    the agent's own model alongside it (`buildModelSelection` does this).
    There is no way to send an effort by itself.
  - `MODEL_CATALOG` is the **offline fallback**, not the primary list -
    `workspaceModels.ts` is (see below). It is also not authoritative in
    the other direction: the API's `modelId` widens to `string` and new
    models ship regularly, so keep `/model <id>` accepting ids outside
    *either* list via `inferProviderId`, and don't add validation that
    would reject an unknown-but-valid model - the server is the only thing
    that can actually know. `resolveModel`/`modelCandidates`/
    `resolveCompactionModel` all take the catalogue as a parameter
    defaulting to `MODEL_CATALOG`; call sites pass the live list. Don't
    re-hardcode `MODEL_CATALOG` inside them.
  - `ModelChoice.contextSize` is **display only**. There is no client-side
    way to raise a context window: Dust stores a hardcoded `contextSize`
    per model server-side (`front/types/assistant/models/*.ts`) and
    `PublicModelSelectionSchema` carries only
    `providerId`/`modelId`/`reasoningEffort`. If someone asks for a
    "bigger context" setting, the answer is a different model, not a new
    field. Don't quote a context size for the `auto*` selectors - the
    server reports the pool's maximum there, not what a message gets.
  - The reasoning-effort levels are `high`/`medium`/**`light`**/`none` -
    "light", not "low". A wrong value is a server-side 400, not a type
    error, since these are compared as plain strings.
- `src/utils/compactionService.ts` - `/compact` (see README's "Compacting a
  conversation"). Three things to preserve:
  - It calls **private** endpoints (`POST .../conversations/{cId}/compactions`
    to start, `GET .../conversations/{cId}/messages` to poll), so it uses the
    `AuthService.getValidAccessToken()` + `getApiDomain()` pattern that
    `contextUsage.ts`/`creditsInfo.ts` use, **not** the `DustAPI` client.
    That also means it doesn't work under a headless `DUST_API_KEY`, same as
    those two.
  - **Poll the private `/messages` endpoint, not the conversation.** Verified
    live: the public v1 conversation endpoint does **not** return
    compaction messages at all - a conversation whose compaction had
    succeeded still came back with only `user_message`/`agent_message` in
    `content`. The private `/messages` endpoint does return them, with
    `status` and the summary. This is also why `dustClient.getConversation()`
    is safe to keep everywhere else despite the SDK's `ConversationSchema`
    being a closed union that would reject a `compaction_message`: the
    endpoint it calls never hands it one. If that ever changes, *that* is
    when a tolerant fetch becomes necessary - it isn't yet, and a wrapper
    for it was written and then removed once the live behaviour was
    confirmed. Don't re-add one speculatively.
  - **A compaction makes the conversation busy.** `Chat.tsx` derives
    `isConversationBusy = isProcessingQuestion || isCompacting`, and every
    gate that asks "can a message go out now?" uses it - the Enter handler,
    the queue-drain effect, the post-file-upload send, and the loop's
    busy flag. Gating only on `isProcessingQuestion` is the bug this
    shipped with: a message typed during a compaction bypassed the queue
    and raced the compaction server-side. If a fourth send path is ever
    added, it needs the same flag.
  - Error messages from the server are surfaced **verbatim**. The three 409s
    ("Answer the pending agent message first", "A compaction is already in
    progress", "This conversation was just compacted") each tell the user a
    different thing to do; replacing them with one generic string loses
    that.
- `src/utils/workspaceModels.ts` - the live model list behind `/model`.
  `GET /api/w/{wId}/models` (private, same standing/auth as context-usage
  and credits) returns the workspace's entitled models with authoritative
  `contextSize`, plus `degradedModelIds`. This **supersedes** the old
  "there is no endpoint that lists a workspace's models" assumption, which
  was wrong - there is one, it just isn't public. Cached at module scope
  and deduped in flight; every failure degrades to `MODEL_CATALOG` rather
  than erroring. Two rules: filter out `isSelectable === false` entries,
  and drop `contextSize` for the `auto*` selectors (the endpoint reports
  the pool maximum there, e.g. 1M for an `auto` that actually routes to a
  272k model).
- `src/utils/terminalTitle.ts` - tab title + Windows Terminal taskbar
  progress (see README's "Tab title and progress"). Four rules:
  - **`sanitize()` is a security boundary, not tidying.** The title carries a
    summary of the user's own (typed or pasted) message, so an unstripped
    ESC/BEL would terminate the OSC early and leave the remainder to be
    interpreted as terminal commands. Don't relax it to "just strip
    newlines".
  - The control characters are built with `String.fromCharCode` and a
    `RegExp` from escapes rather than written literally, so the file stays
    ASCII. It previously held literal control bytes, which made `grep`
    report it as binary and made the constants invisible in diffs. Keep it
    that way.
  - These writes are **safe alongside Ink**, unlike `clearTerminal()`'s:
    they emit no printable cells, move no cursor and set no attributes, so
    Ink's render diffing has nothing to get out of step with. Don't copy
    `clearTerminal()`'s `\x1b[0m` guard here thinking it's needed - and
    don't add anything to this module that *does* print.
  - `describeTab()` is deliberately **pure and separate** from the React
    effect that calls it, so the state precedence (blocked-on-user >
    working > error > finished > idle) is unit-testable and stated in one
    place. If a state is added, add it there, not as another `if` in
    `Chat.tsx`.
- `src/utils/liveRegion.ts` - height budgets for Ink's live (non-`<Static>`)
  region. **The rule it exists for: the live region must stay shorter than
  the terminal.** Ink 5 keeps every line ever printed in `fullStaticOutput`,
  and once the live region's height reaches `stdout.rows`, its `onRender`
  writes `clearTerminal + fullStaticOutput + output` on *every* frame - so
  each keystroke and spinner tick costs O(whole conversation). Measured: 195
  bytes/keystroke under the limit vs 455 KB at 5,000 history lines over it.
  That was the "gets more sluggish the longer the session runs" bug. Anything
  added to the live region that can grow with content (a picker, a preview,
  a list) must be bounded through a budget here, relative to `stdout.rows`,
  not a fixed line count - and count *rows*, not logical lines (one long
  paragraph wraps into many). If Ink is upgraded, re-check `onRender` in
  `node_modules/ink/build/ink.js` before assuming this still applies.
- `src/utils/btw.ts` - `/btw` side questions (see README's "Side questions
  (/btw)"). Three rules:
  - It **never posts into the main conversation** - the whole point is that
    the agent's context is untouched. It uses a separate unlisted
    conversation primed with a transcript excerpt instead. Don't
    "simplify" it into a `postUserMessage` on the current conversation.
  - It is **read-only by construction**: `clientSideMCPServerIds: null`
    (no local tools) and every `tool_approve_execution` is rejected. That's
    what lets it skip plan-mode gating, so keep both if this is touched.
  - It does **not** make the conversation busy (`btwStatus` is deliberately
    not part of `isConversationBusy` in `Chat.tsx`) - it's a different
    conversation, so it can't race the main turn server-side, and blocking
    the queue on it would defeat asking mid-turn.
- `src/utils/deviceAuth.ts` - UI-free WorkOS device-code sign-in (start, cancellable
  poll, region from the token's claim, workspace list/select) used by the desktop app.
  It **deliberately duplicates** `src/ui/commands/Auth.tsx` and
  `src/ui/components/WorkspaceSelector.tsx`, which were left untouched so the CLI's
  behaviour could not change. Until `Auth.tsx` is switched over to this module, a
  change to the flow (endpoints, scope, region claim, storage calls) has to be made in
  both places. `DeviceAuthSession.deviceCode` is the secret half and must never be sent
  to a renderer; only `DeviceAuthPublicInfo` may cross.
- `desktop/` - **dustm Desktop (preview)**: Electron + electron-vite + React, its own
  `package.json`, not part of the root build (root `tsconfig.json` only includes
  `src/**/*`, and must keep doing so). Rules a future agent must keep:
  - **Reuse, never copy.** The main process imports the CLI's modules from `../src/...`
    (auth, token storage, dust client, fsServer + its MCP transport, planMode/chatMode,
    taskStore, modelSelection, workspaceModels, usage/credits, sandbox, retry,
    transcriptStore). The renderer may import only *pure* modules (`brand.ts`,
    `chatMode.ts`, `planMode.ts` constants, `formatContextSize`); anything touching
    Node, `keytar` or the network stays in main.
  - **Do not touch `Chat.tsx` for it.** `desktop/src/main/session.ts` is its own
    conversation loop (from `nonInteractive.ts` + Chat.tsx), so it must be kept in step
    by hand: when Chat.tsx's send/stream/approval behaviour changes, port the change.
  - **The module-level singletons are owned by the main process, with named call
    sites**, the same bug class as `taskStore`'s above: `setPlanMode` in `applyMode`
    (and in `doInit`/`teardownSession`, which reset `mode` to `"normal"` in the same
    breath - resetting only the singleton once showed "plan" while writes were
    allowed), `setActiveConversationId` in `setConversation` (new, resume, create,
    sign-out), `configureSandbox({ root })` + `process.chdir` in `setFolder`, and
    `setClaudeSkillsEnabled` in `applyClaudeCodeMode`. A new path that changes mode,
    conversation or folder must go through those, not around them.
  - **Identity changes go through `teardownSession`** (wired from `auth.ts`'s
    signed-out handler, which runs *before* `signOut` clears the tokens so the running
    turn can still be cancelled server-side, and from `resetSession` before a new
    sign-in): it stops the loop, cancels the turn, rejects pending dialogs, clears the
    queue and attachments, and closes the fs MCP server. The fs server is registered
    under one identity, so it is closed and re-registered on a sign-in change - that is
    what `useFileSystemServer`'s optional `onConnected` callback (an additive parameter
    the CLI does not pass) exists for. It is deliberately **not** re-registered on a
    folder switch: every tool resolves paths at call time through the sandbox singleton
    and `process.cwd()`, which `setFolder` updates.
  - **Stale work never writes into the next conversation.** `session.ts` keeps an
    `epoch`, bumped by new chat, opening a conversation and sign-out; a turn, an upload,
    a compaction or a usage refresh that started under an older epoch drops its late
    output. Opening another conversation also stops a running `/loop` (it must not post
    into a different conversation) and resets the skills catalogue / priming state like
    `/new` does. A new long-running operation needs the same check.
  - **Both send sites** (`createConversation` and `postUserMessage` in `runTurn`) carry
    `buildModelSelection`'s result, and the plan preamble/reminder wraps every message
    while in plan mode. Only the user's plan approval (`resolvePlan`) leaves plan mode.
  - **Renderer isolation:** `contextIsolation` on, `nodeIntegration` off, `sandbox` on,
    one preload exposing the typed `DustmApi` (`src/shared/ipc.ts`), strict CSP
    (injected into `index.html` by `electron.vite.config.ts`; relaxed only for the dev
    server), every IPC handler validates its sender frame and arguments (`ipc.ts`).
    Tokens and the device code never cross IPC: the renderer sees only the user code and
    verification URL. Sign-in's "Open browser" opens the URL main holds; `openExternal`
    (markdown links, window.open) does take a renderer-supplied URL, so `openHttps`
    refuses anything that is not `https:` - keep every `shell.openExternal` behind it.
    Agent markdown never renders an `<img>` (`Markdown.tsx` shows images as links): the
    packaged page is `file://`, so the CSP's `img-src 'self'` would admit `file:` URLs,
    and on Windows a UNC one opens an SMB connection. Adding an IPC method means: type
    in `shared/ipc.ts`, handler with validation in `ipc.ts`, one line in `preload`.
  - **Build-time injection mirrors tsup:** `electron.vite.config.ts` defines
    `__CLI_VERSION__` and the repo root's `.env.production` values for the main bundle.
    It uses production env even in `npm run dev` (the CLI's `.env.development` points at
    a local server); `DUSTM_DESKTOP_ENV=development` opts in. If `tsup.config.ts`
    changes what it injects, change this too.
  - **keytar** is N-API, so the prebuilt binary runs under Electron without a rebuild
    (`npmRebuild: false`); it is the only external module and is `asarUnpack`ed. If it
    ever stops being N-API, add `@electron/rebuild`.
  - `--smoke` (with `--smoke-login`, `--smoke-chat`, `--smoke-attach`, `--smoke-btw`, `--smoke-dup`, `--smoke-commands`, `--smoke-escape`, `--smoke-audit`, `--smoke-delete-probe`, `--smoke-profile-load`, `--smoke-shot`, `--smoke-demo`) is
    the verification path: it exercises the real IPC. `--smoke-chat`, `--smoke-btw` and
    `--smoke-login` cost credits / hit WorkOS, and `--smoke-delete-probe` creates and
    deletes one empty conversation, so they are opt-in. `--smoke-audit` (stubbed client;
    self-contained - its own temp folder and fixture, and every case resets state
    first, so neither `--folder` nor case order matters) holds the regression cases for sign-out mid-turn, the upload race
    and empty-conversation cleanup, loop vs. opening a conversation, cancel fallback,
    history parsing, markdown images, the attach bridge and a real OS file drop. Keep
    the smoke output free of tokens and of the user code.
  - **Commands that live in main** (`session.runCommand`: compact, btw, loop, skills,
    claude-code-mode, tasks, clear-files) are ports of the matching Chat.tsx handlers.
    Keep them in step. Rules carried over: `isConversationBusy() = busy || compacting`
    gates **every** send path (`send`, `dispatch`, `drainQueue`, loop ticks) - a new send
    path needs it; `/btw` is never part of it and never posts to the conversation;
    `applyClaudeCodeMode` is the one place `setClaudeSkillsEnabled` is called; the skills
    block / Claude priming / forced skills are committed only after the API accepts the
    message; loop limits stay in `loopController.ts`; a loop tick goes through `dispatch`
    and is skipped, not stacked, while busy. Pure-UI commands (help, switch, resume, model,
    effort, attach, auto, plan, normal, folder, exit, new/clear) are in `Composer.tsx`.
  - **Duplicate sends:** `Composer.submit` clears the input synchronously and holds an
    in-flight ref, ignores `e.repeat`, and `session.send` refuses an identical message
    within 2 s - with an error the composer shows (and the text given back), never
    silently. Queue drains and loop ticks do not pass through that guard. One Enter once
    produced six real turns because the input was only cleared after the IPC call
    returned. `--smoke-dup` and `--smoke-audit` are the regression tests.
  - **Windowed history** (`history.ts`): opening a conversation fetches the newest 30
    messages from the private `/messages` endpoint (same standing as contextUsage /
    compactionService) and pages back with `lastValue=<rank>`. The public full load took
    2-9 s (11 MB) and is only the fallback (also taken straight away under an `sk-` API
    key, which the private endpoints do not accept). Pages are de-duplicated at the
    boundary by rank; content fragments are shown as the next user message's
    attachments; unknown message types are skipped. Do not switch back to the full load
    for speed reasons without re-profiling (`--smoke-profile-load`).
  - **Attachments**: main reads and uploads. The renderer cannot name a path: the
    preload's `attach.files` takes `File` objects and derives paths itself with
    `webUtils.getPathForFile` (a script-built `File` has none), then main re-checks each
    (absolute, regular file, supported type, size). Pasted image bytes are capped at 50 MB
    at the IPC boundary. Upload needs a conversation, so the first attachment creates an
    empty one (as the CLI does) - but unlike the CLI, that conversation is deleted again
    (private `DELETE /api/w/{wId}/assistant/conversations/{cId}`, best effort) if every
    upload fails, the chips are removed, or the user moves on before sending; once a
    message is sent into it, it is never touched.
  - The app icon is generated (`npm run icons`, `scripts/gen-icons.mjs`) from the CLI
    logo's glyphs and colours; if `Conversation.tsx`'s welcome logo or `brand.ts` colours
    change, update `gen-icons.mjs` and `src/renderer/Logo.tsx` together.
  - Still not built: auto-update. If you add a writing tool, the plan-mode rules above
    still apply; the desktop plan side panel reads `PLAN_MODE_ALLOWED_TOOLS` /
    `PLAN_MODE_BLOCKED_TOOLS` so it stays truthful.
  - Node 24.16.0 lockstep: `desktop/.nvmrc` and `desktop/package.json` `engines` belong
    to the "Keeping the Node.js version in lockstep" list below.
  - No release workflow yet; do not wire it into `release.yml` without being asked.
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

`src/utils/sandbox.ts` (upstream's file system scope, ported 2026-10-09) is
one of these. Each Mantu change in it is marked with a `// Mantu:` comment:
both `\` and `/` count as separators in `run_command`'s operand check
(upstream only checks `path.sep`, so `../.env` slipped through on Windows),
`~\` expands like `~/`, and single-segment `/x` switches are skipped on
Windows so `cmd /c` isn't refused. `searchFiles.ts` also refuses absolute or
`..` glob patterns, which upstream doesn't. Two rules:
- **Every tool that takes a path from the agent must call
  `resolveInSandbox`.** Upstream wired it into its five tools; this fork's
  `write_file` needed the same wiring by hand, because upstream doesn't
  have that tool. A new path-taking tool that skips this gets around the
  sandbox without any error. In writing tools, keep the plan-mode refusal
  *before* the sandbox check: while planning, the answer must not depend
  on the path.
- `index.tsx` loads `sandbox.js` through the same deferred `Promise.all`
  import as `App.js` instead of a top-level static import. A static import
  would load `@dust-tt/client` before the startup pulse prints.

### Keeping the Node.js version in lockstep

If upstream bumps its required Node version, update **all** of these
together (currently pinned to `24.16.0` everywhere):

- `package.json` (`engines.node`)
- `.nvmrc`
- `desktop/package.json` (`engines.node`) and `desktop/.nvmrc`
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
