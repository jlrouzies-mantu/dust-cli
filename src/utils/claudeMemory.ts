import fs from "fs/promises";
import { glob } from "glob";
import os from "os";
import path from "path";

import { normalizeError } from "./errors.js";

/**
 * Reads Claude Code's on-disk memory and instruction files so a Dust agent
 * can be primed with the same durable context Claude Code itself carries
 * (see /claude-code-mode in Chat.tsx).
 *
 * Nothing here is part of a documented, stable contract: these paths and the
 * memory file format are Claude Code's own internal layout, and could change
 * without notice. Every read is therefore best-effort - a missing directory,
 * an unparseable frontmatter block, or an unreadable file degrades that one
 * source to "absent" rather than failing the whole load.
 */

// Claude Code encodes the project's working directory into a single flat
// directory name under ~/.claude/projects by replacing every character that
// isn't alphanumeric with a dash. Verified against this machine's own dirs:
//   C:\Users\jrouzies_amaris.com\source\repos\dust-cli
//     -> C--Users-jrouzies-amaris-com-source-repos-dust-cli
// (drive colon, backslashes, underscore and dot all collapse to dashes,
// while the existing dash in "dust-cli" survives unchanged). The encoding is
// lossy, but we only ever use it in the same direction Claude Code does -
// encode a known cwd, then look for that directory - so ambiguity never
// needs to be resolved backwards.
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function getClaudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

export function getClaudeProjectDir(cwd: string = process.cwd()): string {
  return path.join(getClaudeHome(), "projects", encodeProjectPath(cwd));
}

export function getProjectMemoryDir(cwd: string = process.cwd()): string {
  return path.join(getClaudeProjectDir(cwd), "memory");
}

export function getGlobalMemoryDir(): string {
  return path.join(getClaudeHome(), "memory");
}

// Claude Code's hand-authored skill layout: <skillsDir>/<name>/SKILL.md.
// Read by src/utils/skillStore.ts, gated on /claude-code-mode - see that
// file for why (and for what this deliberately does NOT read: Claude
// Code's plugin-marketplace skills live under a different tree entirely,
// ~/.claude/plugins/marketplaces/.../skills/, and are out of scope here).
export function getClaudeSkillsDir(): string {
  return path.join(getClaudeHome(), "skills");
}

export function getClaudeProjectSkillsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".claude", "skills");
}

// Where a memory can be written. "project" scopes it to the current working
// directory's Claude Code project; "global" is user-level, carried across
// every project.
export type MemoryScope = "project" | "global";

export function getMemoryDirForScope(
  scope: MemoryScope,
  cwd: string = process.cwd()
): string {
  return scope === "global" ? getGlobalMemoryDir() : getProjectMemoryDir(cwd);
}

// The four types Claude Code's own memory frontmatter uses. Kept as a plain
// string in ParsedMemory below, since a file written by a future version
// could carry a type this fork doesn't know about and should still be
// surfaced rather than dropped.
export const MEMORY_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface ParsedMemory {
  // Slug from frontmatter `name:`, falling back to the filename stem.
  name: string;
  description: string | null;
  type: string | null;
  body: string;
  filePath: string;
  scope: MemoryScope;
}

export interface InstructionFile {
  // Display label, e.g. "AGENTS.md" or "~/.claude/CLAUDE.md".
  label: string;
  filePath: string;
  content: string;
  // Set when the file was longer than PER_FILE_CHAR_LIMIT and got cut.
  truncatedFrom?: number;
  // A `.claude/rules/` file's `paths:` frontmatter glob, when it has one:
  // the rule only applies to files matching it. See loadRuleFiles for why
  // these are surfaced rather than resolved.
  appliesToPaths?: string | null;
}

export interface ClaudeContext {
  projectDir: string;
  // False when ~/.claude/projects/<encoded-cwd> doesn't exist at all, i.e.
  // Claude Code has never run in this directory.
  projectDirExists: boolean;
  memories: ParsedMemory[];
  // Claude Code keeps a one-line-per-memory index; shown to the agent as-is
  // when present, since its hooks summarise each memory's purpose.
  memoryIndex: InstructionFile | null;
  instructions: InstructionFile[];
  // Whether the priming block carries each memory's full body, or only a
  // catalogue of names + one-line descriptions for the agent to read from
  // on demand with read_memory. See MEMORY_INLINE_CHAR_BUDGET.
  memoryBodiesInlined: boolean;
  // Non-fatal problems worth telling the user about (unreadable file,
  // malformed frontmatter, ...). Never thrown - the load always returns.
  warnings: string[];
  // Sources that were found but dropped entirely to stay inside
  // TOTAL_CHAR_BUDGET, so the UI can say so instead of silently omitting.
  skipped: string[];
}

// A single memory or instruction file longer than this is truncated. Claude
// Code's own memories are deliberately one-fact-per-file and tiny; a repo's
// CLAUDE.md/AGENTS.md is the realistic reason this ever trips (this repo's
// AGENTS.md is ~8.5 KB).
const PER_FILE_CHAR_LIMIT = 24_000;

// Ceiling on everything the priming block carries, across all sources.
// ~80k characters is roughly 20k tokens - a meaningful slice of a 272k
// context window, but nowhere near enough to crowd out the actual
// conversation. Sources are added in priority order (see loadClaudeContext)
// and anything that no longer fits is reported in `skipped` rather than
// dropped silently.
const TOTAL_CHAR_BUDGET = 80_000;

/**
 * How many characters of memory *bodies* the priming block will carry
 * inline before it switches to a catalogue instead.
 *
 * Claude Code's own model is the reason this exists: it loads the one-line
 * MEMORY.md index every session and pulls individual memory files in only
 * when they look relevant. Memories are written one-fact-per-file precisely
 * so that stays cheap. A handful of them is far cheaper to inline than to
 * fetch over a tool round trip, so below this threshold everything goes in
 * verbatim; above it, only names and descriptions do, and the agent uses
 * read_memory for the bodies it actually needs. Without that switch, a user
 * with a few hundred accumulated memories would spend most of a priming
 * block on facts irrelevant to the question they just asked.
 */
const MEMORY_INLINE_CHAR_BUDGET = 12_000;

function memoryBodyChars(memories: ParsedMemory[]): number {
  return memories.reduce(
    (total, memory) =>
      total + memory.body.length + (memory.description?.length ?? 0),
    0
  );
}

// One catalogue line per memory: what the agent sees when bodies are left
// out. Enough to judge relevance and name the memory in a read_memory call,
// and nothing more.
function catalogueLine(memory: ParsedMemory): string {
  const type = memory.type ? `, ${memory.type}` : "";
  return `- ${memory.name} (${memory.scope}${type}): ${
    memory.description ?? "(no description)"
  }`;
}

/**
 * How Claude Code decides which memories belong to which project. Shared
 * verbatim between the priming block and both memory tools' descriptions,
 * because an agent that doesn't know this model reasons badly about the
 * memories it has been handed - and writes new ones into the wrong scope.
 *
 * The cwd-keyed (rather than repository-keyed) part is not a guess: this
 * machine has a project directory for `...\Ashield\src\aShield`, which is a
 * subdirectory of the `Ashield` git repository and has no `.git` of its own.
 */
export const MEMORY_STORAGE_MODEL = [
  "How these memories are stored (Claude Code's model, worth understanding before you rely on or write one):",
  "- Scope is per *working directory*, not per repository and not per git branch. Claude Code keys a",
  "  project's memories on the exact absolute path it was started in, so a subdirectory of a repo, a",
  "  second checkout of the same repo, and a clone at a different path each get their own separate set.",
  "- Branches share everything. Switching git branches does not change which memories are visible, so a",
  "  memory must not describe state that is only true on one branch.",
  "- Sessions share everything too. Memories persist across sessions - that is their whole purpose - so",
  "  anything that only matters until the end of this conversation does not belong in one.",
  "- There is a second, user-level scope shared by every project. Facts about the user themselves belong",
  "  there; facts about this codebase belong in the project scope.",
].join("\n");

function truncate(content: string): {
  content: string;
  truncatedFrom?: number;
} {
  if (content.length <= PER_FILE_CHAR_LIMIT) {
    return { content };
  }
  return {
    content: content.slice(0, PER_FILE_CHAR_LIMIT),
    truncatedFrom: content.length,
  };
}

/**
 * Splits a markdown file into its YAML frontmatter block and its body, and
 * hands back a reader for the frontmatter's scalar fields.
 *
 * Deliberately not a general YAML parser: everything this fork reads out of
 * frontmatter is a handful of known scalars (a memory's `name`,
 * `description` and nested `metadata.type`; a rule's `paths`; a skill's
 * `name`, `description` and `disable-model-invocation` - see
 * skillStore.ts), and pulling in a YAML dependency for that isn't worth it.
 * Anything else in the block is ignored, and a file with no frontmatter at
 * all still parses - it just reports an empty block and keeps its whole
 * content as the body.
 *
 * `scalar()` matches `key: value` at any indentation (needed for
 * `metadata.type`'s nested form), so a caller reading a top-level-only key
 * from a file that could plausibly nest the same key name under something
 * else should be aware a nested match would win. None of this fork's
 * current callers have that shape.
 */
export function splitFrontmatter(raw: string): {
  body: string;
  scalar: (key: string) => string | null;
  hasFrontmatter: boolean;
} {
  // Frontmatter must be the very first thing in the file, delimited by ---.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const frontmatter = match ? match[1] : "";
  const body = match ? match[2] : raw;

  return {
    body: body.trim(),
    hasFrontmatter: match !== null,
    scalar: (key: string): string | null => {
      if (!frontmatter) {
        return null;
      }
      // Matches `key: value` at any indentation, so a nested field like
      // `metadata.type`'s `  type: project` is found by the same expression
      // as a top-level key.
      const found = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(
        frontmatter
      );
      if (!found) {
        return null;
      }
      // Strip optional surrounding quotes.
      return found[1].replace(/^["']|["']$/g, "").trim() || null;
    },
  };
}

/**
 * Pulls the fields this fork cares about out of a memory file's frontmatter,
 * falling back to the filename for the name when there is none.
 */
export function parseMemoryFile(
  raw: string,
  filePath: string,
  scope: MemoryScope
): ParsedMemory {
  const fallbackName = path.basename(filePath).replace(/\.md$/i, "");
  const { body, scalar } = splitFrontmatter(raw);

  return {
    name: scalar("name") ?? fallbackName,
    description: scalar("description"),
    type: scalar("type"),
    body,
    filePath,
    scope,
  };
}

/**
 * Serialises a memory back into the same frontmatter format Claude Code
 * writes, so files this CLI creates are indistinguishable from ones Claude
 * Code created and are picked up by both.
 */
export function serializeMemoryFile({
  name,
  description,
  type,
  body,
}: {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "metadata:",
    `  type: ${type}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

// Memory file names double as [[wiki-link]] targets and as filenames, so
// they're restricted to a kebab-case slug - which also means a name coming
// from the agent can never traverse out of the memory directory.
const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidMemoryName(name: string): boolean {
  return MEMORY_NAME_PATTERN.test(name) && name.length <= 80;
}

async function readIfPresent(
  filePath: string,
  warnings: string[]
): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A file that simply isn't there is the normal case, not a warning.
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(
        `Could not read ${filePath}: ${normalizeError(error).message}`
      );
    }
    return null;
  }
}

async function loadMemoriesFromDir(
  dir: string,
  scope: MemoryScope,
  warnings: string[]
): Promise<{ memories: ParsedMemory[]; index: InstructionFile | null }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(
        `Could not list ${dir}: ${normalizeError(error).message}`
      );
    }
    return { memories: [], index: null };
  }

  const memories: ParsedMemory[] = [];
  let index: InstructionFile | null = null;

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith(".md")) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const raw = await readIfPresent(filePath, warnings);
    if (raw === null) {
      continue;
    }

    // MEMORY.md is the index over the other files, not a memory itself.
    if (entry.toUpperCase() === "MEMORY.MD") {
      const { content, truncatedFrom } = truncate(raw.trim());
      index = {
        label: scope === "global" ? "~/.claude/memory/MEMORY.md" : "MEMORY.md",
        filePath,
        content,
        truncatedFrom,
      };
      continue;
    }

    const parsed = parseMemoryFile(raw, filePath, scope);
    if (!parsed.body) {
      warnings.push(`Skipped empty memory ${filePath}`);
      continue;
    }
    memories.push(parsed);
  }

  return { memories, index };
}

function homeRelative(filePath: string): string {
  const home = os.homedir();
  return filePath.startsWith(home)
    ? `~${filePath.slice(home.length).replace(/\\/g, "/")}`
    : filePath;
}

/**
 * Loads `.claude/rules/**\/*.md` for one root.
 *
 * Rules are the documented way to keep CLAUDE.md small: instructions split
 * into their own files, each optionally carrying a `paths:` frontmatter glob
 * that limits it to matching files. Claude Code loads a path-scoped rule
 * only when it touches a file that matches.
 *
 * A Dust chat has no "currently open file", so that condition can't be
 * evaluated here. Rather than guess - dropping them would hide real
 * instructions, applying them silently would present conditional rules as
 * universal - scoped rules are included with their glob recorded, and the
 * priming block labels them so the agent can judge for itself whether a rule
 * applies to what it's being asked about.
 */
async function loadRuleFiles(
  root: string,
  labelPrefix: string,
  warnings: string[]
): Promise<InstructionFile[]> {
  const rulesDir = path.join(root, ".claude", "rules");

  let matches: string[];
  try {
    matches = await glob("**/*.md", {
      cwd: rulesDir,
      nodir: true,
      // POSIX separators regardless of platform, so the labels below read
      // the same on Windows as anywhere else.
      posix: true,
      dot: false,
    });
  } catch (error) {
    warnings.push(
      `Could not list ${rulesDir}: ${normalizeError(error).message}`
    );
    return [];
  }

  const found: InstructionFile[] = [];
  // Sorted so the priming block is stable between runs - glob's order isn't
  // guaranteed, and an unstable block would defeat prompt caching.
  for (const relative of matches.sort()) {
    const filePath = path.join(rulesDir, relative);
    const raw = await readIfPresent(filePath, warnings);
    if (raw === null || !raw.trim()) {
      continue;
    }

    const { body, scalar } = splitFrontmatter(raw);
    if (!body) {
      continue;
    }

    const paths = scalar("paths");
    const { content, truncatedFrom } = truncate(body);
    found.push({
      label: `${labelPrefix}.claude/rules/${relative}`,
      filePath,
      content,
      truncatedFrom,
      appliesToPaths: paths,
    });
  }

  return found;
}

/**
 * Repo- and user-level instruction files, in the order an agent should read
 * them: user-level first (broadest), then the repo's own, most specific
 * last. CLAUDE.local.md is a developer's uncommitted personal overrides;
 * AGENTS.md is the cross-tool convention this repo itself uses; and
 * `.claude/rules/` holds instructions split out of CLAUDE.md (see
 * loadRuleFiles).
 */
async function loadInstructionFiles(
  cwd: string,
  warnings: string[]
): Promise<InstructionFile[]> {
  const candidates: { label: string; filePath: string }[] = [
    {
      label: "~/.claude/CLAUDE.md (user-level)",
      filePath: path.join(getClaudeHome(), "CLAUDE.md"),
    },
    { label: "CLAUDE.md", filePath: path.join(cwd, "CLAUDE.md") },
    {
      label: "CLAUDE.local.md",
      filePath: path.join(cwd, "CLAUDE.local.md"),
    },
    {
      label: ".claude/CLAUDE.md",
      filePath: path.join(cwd, ".claude", "CLAUDE.md"),
    },
    { label: "AGENTS.md", filePath: path.join(cwd, "AGENTS.md") },
  ];

  const found: InstructionFile[] = [];

  // User-level rules first, matching the broadest-first ordering above.
  found.push(
    ...(await loadRuleFiles(os.homedir(), "~/", warnings))
  );

  for (const candidate of candidates) {
    const raw = await readIfPresent(candidate.filePath, warnings);
    if (raw === null || !raw.trim()) {
      continue;
    }
    const { content, truncatedFrom } = truncate(raw.trim());
    found.push({ ...candidate, content, truncatedFrom });
  }

  // The repo's own rules last - most specific, same reason AGENTS.md sits
  // at the end of the candidate list.
  found.push(...(await loadRuleFiles(cwd, "", warnings)));

  return found;
}

export async function loadClaudeContext(
  cwd: string = process.cwd()
): Promise<ClaudeContext> {
  const warnings: string[] = [];
  const projectDir = getClaudeProjectDir(cwd);

  let projectDirExists = true;
  try {
    await fs.stat(projectDir);
  } catch {
    projectDirExists = false;
  }

  const [project, global, instructions] = await Promise.all([
    loadMemoriesFromDir(getProjectMemoryDir(cwd), "project", warnings),
    loadMemoriesFromDir(getGlobalMemoryDir(), "global", warnings),
    loadInstructionFiles(cwd, warnings),
  ]);

  // Claude Code also accepts MEMORY.md at the project root rather than
  // inside memory/ - check there too when the memory dir had none.
  let memoryIndex = project.index ?? global.index;
  if (!memoryIndex) {
    const rootIndexPath = path.join(projectDir, "MEMORY.md");
    const raw = await readIfPresent(rootIndexPath, warnings);
    if (raw?.trim()) {
      const { content, truncatedFrom } = truncate(raw.trim());
      memoryIndex = {
        label: "MEMORY.md",
        filePath: rootIndexPath,
        content,
        truncatedFrom,
      };
    }
  }

  // Project memories before global ones: the more specific context is the
  // more valuable if the budget runs out below.
  const memories = [...project.memories, ...global.memories];

  // Past this much accumulated memory text, the priming block lists the
  // memories instead of quoting them (see MEMORY_INLINE_CHAR_BUDGET). The
  // decision is made here, before budgeting, because it changes what each
  // memory actually costs the block: a catalogued memory costs one line
  // whatever its body's length.
  const memoryBodiesInlined =
    memoryBodyChars(memories) <= MEMORY_INLINE_CHAR_BUDGET;

  // Enforce the overall budget in priority order. Memories are the point of
  // the feature, so they get first claim on the budget; instruction files
  // (which are much larger) fill whatever is left.
  const skipped: string[] = [];
  let spent = memoryIndex ? memoryIndex.content.length : 0;
  const keptMemories: ParsedMemory[] = [];
  for (const memory of memories) {
    const cost = memoryBodiesInlined
      ? memory.body.length + (memory.description?.length ?? 0)
      : catalogueLine(memory).length;
    if (spent + cost > TOTAL_CHAR_BUDGET) {
      skipped.push(`memory "${memory.name}"`);
      continue;
    }
    spent += cost;
    keptMemories.push(memory);
  }

  const keptInstructions: InstructionFile[] = [];
  for (const file of instructions) {
    if (spent + file.content.length > TOTAL_CHAR_BUDGET) {
      skipped.push(file.label);
      continue;
    }
    spent += file.content.length;
    keptInstructions.push(file);
  }

  return {
    projectDir,
    projectDirExists,
    memories: keptMemories,
    memoryIndex,
    instructions: keptInstructions,
    memoryBodiesInlined,
    warnings,
    skipped,
  };
}

export function hasAnyContext(context: ClaudeContext): boolean {
  return (
    context.memories.length > 0 ||
    context.memoryIndex !== null ||
    context.instructions.length > 0
  );
}

/**
 * The block prepended (once) to the next outgoing message when the mode is
 * enabled. Framed explicitly as background context that the user hasn't
 * said out loud, so the agent doesn't mistake it for the actual request or
 * start by summarising it back.
 */
export function buildPrimingBlock(context: ClaudeContext): string {
  const parts: string[] = [];

  parts.push(
    "<claude_code_context>",
    "The user works in this directory with Claude Code, a coding CLI that keeps",
    "durable notes about them and this project on disk. Those notes are copied",
    "below so you have the same background it does.",
    "",
    "Treat this as background context, not as the user's request - the request",
    "is the message that follows this block. Do not summarise, acknowledge, or",
    "quote this block back; just let it inform your answer. It reflects what was",
    "true when it was written, so verify anything you are about to rely on that",
    "may have changed (a named file, function, or flag) before recommending it.",
    "",
    `Working directory: ${process.cwd()}`,
    `Memory store: ${homeRelative(context.projectDir)}/memory (this directory's own),`,
    `              ${homeRelative(getGlobalMemoryDir())} (shared by every project)`,
    "",
    MEMORY_STORAGE_MODEL,
    ""
  );

  if (context.memoryIndex) {
    parts.push(
      `<memory_index source="${homeRelative(context.memoryIndex.filePath)}">`,
      context.memoryIndex.content,
      "</memory_index>",
      ""
    );
  }

  if (context.memories.length > 0 && context.memoryBodiesInlined) {
    parts.push(
      `<memories count="${context.memories.length}" complete="true">`,
      "Every memory in both scopes, in full - you do not need read_memory to see these."
    );
    for (const memory of context.memories) {
      const attrs = [
        `name="${memory.name}"`,
        memory.type ? `type="${memory.type}"` : null,
        `scope="${memory.scope}"`,
      ]
        .filter(Boolean)
        .join(" ");
      parts.push(`<memory ${attrs}>`);
      if (memory.description) {
        parts.push(`Summary: ${memory.description}`, "");
      }
      parts.push(memory.body, "</memory>");
    }
    parts.push("</memories>", "");
  } else if (context.memories.length > 0) {
    // Too much accumulated memory text to quote (see
    // MEMORY_INLINE_CHAR_BUDGET) - hand over the catalogue instead, and be
    // explicit that these are titles rather than content, so the agent
    // doesn't answer from a one-line description as though it had read the
    // memory.
    parts.push(
      `<memory_catalogue count="${context.memories.length}" complete="false">`,
      "There are too many memories to quote in full here, so this is a catalogue:",
      "one line per memory, listing its name, scope and a summary of what it says.",
      "These summaries are NOT the memories themselves. Before relying on any of",
      "them, read it with read_memory (pass the name exactly as listed). Read only",
      "the ones plausibly relevant to the task - reading all of them defeats the",
      "point of this list."
    );
    for (const memory of context.memories) {
      parts.push(catalogueLine(memory));
    }
    parts.push("</memory_catalogue>", "");
  }

  for (const file of context.instructions) {
    // A path-scoped rule is announced as conditional rather than presented
    // as a standing instruction - the agent has to decide whether the glob
    // covers what it's working on, because this CLI can't (see
    // loadRuleFiles).
    if (file.appliesToPaths) {
      parts.push(
        `<instructions source="${homeRelative(file.filePath)}" applies_to="${
          file.appliesToPaths
        }">`,
        `This rule is scoped to files matching \`${file.appliesToPaths}\`. Apply it only if the`,
        "work at hand involves such files; otherwise disregard it."
      );
    } else {
      parts.push(`<instructions source="${homeRelative(file.filePath)}">`);
    }
    parts.push(file.content);
    if (file.truncatedFrom) {
      parts.push(
        `[truncated - showing ${PER_FILE_CHAR_LIMIT} of ${file.truncatedFrom} characters]`
      );
    }
    parts.push("</instructions>", "");
  }

  parts.push(
    "You can also create or update these notes yourself with the write_memory",
    "tool. Write one when you learn a durable fact about the user, this project,",
    "or how they want you to work - and pick the scope deliberately, per the",
    "storage model above: a fact about this codebase goes in the project scope, a",
    "fact about the user goes in the global one. Do not write anything that only",
    "matters to this conversation, or that the repository already records.",
    "</claude_code_context>"
  );

  return parts.join("\n");
}

/**
 * One-line-per-source summary shown in the terminal when the mode is
 * toggled on, so the user can see exactly what got picked up (and what
 * didn't) rather than trusting an opaque "mode enabled".
 */
export function summarizeContext(context: ClaudeContext): string[] {
  const lines: string[] = [];

  if (!context.projectDirExists) {
    lines.push(
      `No Claude Code project directory at ${homeRelative(context.projectDir)}`,
      "(Claude Code has never run in this folder - nothing project-specific to load)"
    );
  }

  const projectCount = context.memories.filter(
    (m) => m.scope === "project"
  ).length;
  const globalCount = context.memories.filter(
    (m) => m.scope === "global"
  ).length;

  if (projectCount > 0) {
    lines.push(`${projectCount} project memor${projectCount === 1 ? "y" : "ies"}`);
  }
  if (globalCount > 0) {
    lines.push(`${globalCount} global memor${globalCount === 1 ? "y" : "ies"}`);
  }
  if (projectCount === 0 && globalCount === 0) {
    lines.push("No memory files found (memory/*.md is empty or absent)");
  } else if (!context.memoryBodiesInlined) {
    // The user should know the agent got a list rather than the contents -
    // it changes what the agent can answer without a tool call.
    lines.push(
      `listed by name only (over ${(MEMORY_INLINE_CHAR_BUDGET / 1000).toFixed(0)}k chars) - the agent reads the ones it needs`
    );
  }
  if (context.memoryIndex) {
    lines.push(`${context.memoryIndex.label} (index)`);
  }
  for (const file of context.instructions) {
    const size = `${(file.content.length / 1024).toFixed(1)} KB`;
    const notes = [
      size,
      file.truncatedFrom ? "truncated" : null,
      // Worth showing: a scoped rule is handed over as conditional, so it
      // may end up not applying at all.
      file.appliesToPaths ? `scoped to ${file.appliesToPaths}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`${file.label} (${notes})`);
  }

  for (const skipped of context.skipped) {
    lines.push(`Skipped ${skipped} - context budget exhausted`);
  }
  for (const warning of context.warnings) {
    lines.push(`Warning: ${warning}`);
  }

  return lines;
}
