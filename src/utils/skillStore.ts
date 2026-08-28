import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  getClaudeProjectSkillsDir,
  getClaudeSkillsDir,
  splitFrontmatter,
} from "./claudeMemory.js";
import { normalizeError } from "./errors.js";

/**
 * Local, client-side "skills" for the Dust CLI: SKILL.md files the user
 * authors on disk, since Dust's own agent skills are server-side and locked
 * to workspace admins. A skill is a reusable instruction package the agent
 * pulls in only when relevant - see the catalogue/read_skill split below,
 * modelled directly on /claude-code-mode's memory catalogue (readMemory.ts,
 * claudeMemory.ts).
 *
 * Every read here is best-effort, exactly like claudeMemory.ts: a malformed
 * or unreadable skill is dropped individually with a warning, never failing
 * the whole load.
 */

export type SkillSource =
  | "dustm-project" // ./.dust/skills/
  | "dustm-user" // ~/.dust-cli/skills/
  | "claude-project" // ./.claude/skills/   (claude-code-mode only)
  | "claude-user"; // ~/.claude/skills/   (claude-code-mode only)

export interface Skill {
  // The directory name - this is the skill's identity (what /skills <name>
  // and read_skill's `names` match against), not the frontmatter `name`,
  // which is only a fallback/consistency check. See loadSkills below.
  name: string;
  description: string | null;
  body: string;
  source: SkillSource;
  filePath: string;
  // Whether the user has this switched on in the /skills picker. Only
  // enabled skills reach the agent (catalogue or read_skill). Defaults to
  // true - see loadDisabledSkillNames for why the persisted file records
  // disables rather than enables.
  enabled: boolean;
  // Real Claude Code plugin skills use this to mark an interactive-only
  // tool the model should not pick on its own (see AGENTS.md). Excluded
  // from the auto-injected catalogue, but still reachable by explicit
  // /skills <name> - the user asking for it by name is exactly the
  // "not model-invoked" case this flag is about, not a violation of it.
  disableModelInvocation: boolean;
}

export interface ShadowedSkill {
  name: string;
  winnerSource: SkillSource;
  loserSource: SkillSource;
  loserPath: string;
}

export interface SkillRootStatus {
  source: SkillSource;
  label: string; // e.g. "./.dust/skills", "~/.claude/skills"
  requiresClaudeMode: boolean;
  exists: boolean;
  found: number;
}

export interface SkillSet {
  skills: Skill[]; // precedence-resolved, one entry per name
  shadowed: ShadowedSkill[];
  warnings: string[];
  roots: SkillRootStatus[];
  claudeSkillsIncluded: boolean;
}

// Precedence order: this CLI's own directories beat ones borrowed from
// Claude Code (a skill the user deliberately put in dustm's own directory
// should never be silently overridden by one they wrote for a different
// tool), and within each, project beats user - the same "most specific
// wins" ordering claudeMemory.ts uses for memories and instruction files.
function getSkillRoots(cwd: string): {
  source: SkillSource;
  dir: string;
  label: string;
  requiresClaudeMode: boolean;
}[] {
  const home = os.homedir();
  const homeRelative = (p: string) =>
    p.startsWith(home) ? `~${p.slice(home.length).replace(/\\/g, "/")}` : p;

  return [
    {
      source: "dustm-project",
      dir: path.join(cwd, ".dust", "skills"),
      label: "./.dust/skills",
      requiresClaudeMode: false,
    },
    {
      source: "dustm-user",
      dir: path.join(home, ".dust-cli", "skills"),
      label: homeRelative(path.join(home, ".dust-cli", "skills")),
      requiresClaudeMode: false,
    },
    {
      source: "claude-project",
      dir: getClaudeProjectSkillsDir(cwd),
      label: "./.claude/skills",
      requiresClaudeMode: true,
    },
    {
      source: "claude-user",
      dir: getClaudeSkillsDir(),
      label: homeRelative(getClaudeSkillsDir()),
      requiresClaudeMode: true,
    },
  ];
}

// SkillInit.tsx (the `dustm skill:init` command) installs a SKILL.md under
// this name whose body instructs an agent to run
// `dustm chat -a <agent> -m "<message>"`. With claude-code-mode on,
// discovering it here would hand a Dust agent - which has run_command -
// literal instructions to invoke itself. Excluded by exact path, not by
// name match, so a user's own skill happening to be named "dustm" in a
// dustm-owned directory is unaffected. SkillInit.tsx imports this constant
// rather than the two ever drifting apart.
export const DUSTM_OUTBOUND_SKILL_NAME = "dustm";

export function getDustmOutboundSkillDir(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "skills",
    DUSTM_OUTBOUND_SKILL_NAME
  );
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && name.length <= 80;
}

/**
 * Which skills the user has switched **off** in the /skills picker.
 *
 * Deliberately stores the disabled set rather than the enabled one: a skill
 * newly dropped into a skills directory is then on by default, which is
 * what someone who just authored it expects. Storing enables instead would
 * mean every new skill silently does nothing until it's found in a picker
 * nobody knew to open.
 *
 * Keyed by skill name, not path, so it's global across projects - the same
 * flattening the name-based precedence rules already assume.
 */
const SKILL_STATE_FILE = path.join(
  os.homedir(),
  ".dust-cli",
  "skills-state.json"
);

export async function loadDisabledSkillNames(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(SKILL_STATE_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { disabled?: unknown }).disabled)
    ) {
      return new Set();
    }
    return new Set(
      (parsed as { disabled: unknown[] }).disabled.filter(
        (n): n is string => typeof n === "string"
      )
    );
  } catch {
    // Missing or corrupt state means "nothing disabled" - never a reason to
    // fail a send or hide every skill.
    return new Set();
  }
}

/**
 * Persists the disabled set. Unlike taskStore's best-effort writes, the
 * caller is told whether this succeeded: the user just made an explicit
 * choice in a picker, and silently not saving it would have them make the
 * same choice again next session with no idea why it didn't stick.
 */
export async function saveDisabledSkillNames(
  disabled: Set<string>
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fs.mkdir(path.dirname(SKILL_STATE_FILE), { recursive: true });
    await fs.writeFile(
      SKILL_STATE_FILE,
      JSON.stringify({ disabled: [...disabled].sort() }, null, 2),
      "utf-8"
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: normalizeError(error).message };
  }
}

async function readIfPresent(
  filePath: string,
  warnings: string[]
): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(
        `Could not read ${filePath}: ${normalizeError(error).message}`
      );
    }
    return null;
  }
}

// A single skill or forced body longer than this is truncated - matches
// claudeMemory.ts's PER_FILE_CHAR_LIMIT for the same reason (a body this
// large is the exception, not the design).
export const SKILL_BODY_CHAR_LIMIT = 24_000;

// One catalogue line's description is capped independently of the body -
// a skill author who pastes a paragraph into `description:` shouldn't blow
// the catalogue for every other skill.
export const DESCRIPTION_CHAR_LIMIT = 500;

// Ceiling on the rendered catalogue itself (name + description lines only -
// bodies are never in here). ~8k chars is a few hundred skills; past that,
// skills are dropped in precedence order and the block says so rather than
// silently truncating mid-list.
export const CATALOGUE_CHAR_BUDGET = 8_000;

// Ceiling on how much /skills <name>-forced body text can ride on one
// message. Two full-size skills, roughly - forcing more than that is very
// likely a mistake, not a deliberate choice.
export const FORCED_INLINE_CHAR_BUDGET = 48_000;

// Guard against a pathological directory stalling a send.
export const MAX_SKILLS_PER_ROOT = 200;

function truncateBody(body: string): { body: string; truncatedFrom?: number } {
  if (body.length <= SKILL_BODY_CHAR_LIMIT) {
    return { body };
  }
  return {
    body: `${body.slice(0, SKILL_BODY_CHAR_LIMIT)}\n\n[truncated - showing ${SKILL_BODY_CHAR_LIMIT} of ${body.length} characters]`,
    truncatedFrom: body.length,
  };
}

async function loadSkillFile(
  filePath: string,
  dirName: string,
  source: SkillSource,
  warnings: string[]
): Promise<Skill | null> {
  const raw = await readIfPresent(filePath, warnings);
  if (raw === null) {
    return null;
  }

  const { body, scalar } = splitFrontmatter(raw);
  const trimmedBody = body.trim();

  if (trimmedBody.length === 0) {
    warnings.push(`${filePath}: empty body, skipped`);
    return null;
  }

  const description = scalar("description");
  if (!description) {
    warnings.push(
      `${filePath}: no "description:" in frontmatter - the agent cannot judge relevance, so this skill is dropped. Add one and it will be picked up.`
    );
    return null;
  }

  const frontmatterName = scalar("name");
  if (frontmatterName && frontmatterName !== dirName) {
    warnings.push(
      `${filePath}: frontmatter name "${frontmatterName}" doesn't match its directory "${dirName}" - using "${dirName}" (the directory name is what /skills <name> and read_skill match against).`
    );
  }

  if (!isValidSkillName(dirName)) {
    warnings.push(
      `${filePath}: directory name "${dirName}" isn't a valid skill name (lowercase letters, digits, dashes only) - skipped.`
    );
    return null;
  }

  const disableModelInvocation =
    (scalar("disable-model-invocation") ?? "").toLowerCase() === "true";

  const { body: truncatedBody } = truncateBody(trimmedBody);

  return {
    name: dirName,
    description:
      description.length > DESCRIPTION_CHAR_LIMIT
        ? `${description.slice(0, DESCRIPTION_CHAR_LIMIT)}…`
        : description,
    body: truncatedBody,
    source,
    filePath,
    disableModelInvocation,
    // Filled in by loadSkills once the persisted disabled set is known -
    // this function parses one file and has no view of user state.
    enabled: true,
  };
}

async function loadSkillsFromRoot(
  dir: string,
  source: SkillSource,
  outboundSkillDir: string,
  warnings: string[]
): Promise<{ skills: Skill[]; exists: boolean }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(`Could not list ${dir}: ${normalizeError(error).message}`);
    }
    return { skills: [], exists: false };
  }

  const skills: Skill[] = [];
  // Sorted so the load is byte-stable between runs (matters for the
  // catalogue's freshness comparison in Chat.tsx - an unstable order would
  // look like a change and re-inject on every message for no reason).
  for (const entry of entries.sort()) {
    if (skills.length >= MAX_SKILLS_PER_ROOT) {
      warnings.push(
        `${dir}: more than ${MAX_SKILLS_PER_ROOT} entries - stopped scanning.`
      );
      break;
    }

    const entryPath = path.join(dir, entry);
    if (path.resolve(entryPath) === path.resolve(outboundSkillDir)) {
      continue; // see getDustmOutboundSkillDir
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(entryPath);
    } catch (error) {
      warnings.push(
        `Could not read ${entryPath}: ${normalizeError(error).message}`
      );
      continue;
    }

    if (!stat.isDirectory()) {
      continue; // a stray file alongside skill dirs - not a skill, ignore
    }

    const skillFilePath = path.join(entryPath, "SKILL.md");
    const skill = await loadSkillFile(skillFilePath, entry, source, warnings);
    if (skill) {
      skills.push(skill);
    }
  }

  return { skills, exists: true };
}

/**
 * Discovers and parses every local skill, resolving name collisions by
 * precedence (dustm beats claude, project beats user - see getSkillRoots)
 * and reporting shadowed/dropped/malformed entries rather than silently
 * hiding them.
 */
export async function loadSkills(options?: {
  cwd?: string;
  includeClaudeSkills?: boolean;
}): Promise<SkillSet> {
  const cwd = options?.cwd ?? process.cwd();
  const includeClaudeSkills =
    options?.includeClaudeSkills ?? areClaudeSkillsEnabled();
  const outboundSkillDir = getDustmOutboundSkillDir();

  const warnings: string[] = [];
  const roots: SkillRootStatus[] = [];
  const byName = new Map<string, Skill>();
  const shadowed: ShadowedSkill[] = [];
  const disabled = await loadDisabledSkillNames();

  for (const root of getSkillRoots(cwd)) {
    if (root.requiresClaudeMode && !includeClaudeSkills) {
      roots.push({
        source: root.source,
        label: root.label,
        requiresClaudeMode: true,
        exists: false,
        found: 0,
      });
      continue;
    }

    const { skills, exists } = await loadSkillsFromRoot(
      root.dir,
      root.source,
      outboundSkillDir,
      warnings
    );

    for (const skill of skills) {
      const existing = byName.get(skill.name);
      if (existing) {
        shadowed.push({
          name: skill.name,
          winnerSource: existing.source,
          loserSource: skill.source,
          loserPath: skill.filePath,
        });
      } else {
        byName.set(skill.name, {
          ...skill,
          enabled: !disabled.has(skill.name),
        });
      }
    }

    roots.push({
      source: root.source,
      label: root.label,
      requiresClaudeMode: root.requiresClaudeMode,
      exists,
      found: skills.length,
    });
  }

  return {
    skills: [...byName.values()],
    shadowed,
    warnings,
    roots,
    claudeSkillsIncluded: includeClaudeSkills,
  };
}

export type SkillLookup =
  | { kind: "found"; skill: Skill }
  | { kind: "ambiguous"; candidates: Skill[] }
  | { kind: "not-found" };

/**
 * Resolves a user- or agent-supplied name against an already-loaded
 * SkillSet - never touches the filesystem with the supplied name, so
 * traversal is impossible by construction rather than by validating a
 * pattern. Exact match first, then a unique prefix, then a unique
 * substring; more than one candidate at any stage is reported as
 * ambiguous rather than guessing.
 */
export function resolveSkill(set: SkillSet, query: string): SkillLookup {
  const q = query.trim().toLowerCase();
  if (!q) {
    return { kind: "not-found" };
  }

  const exact = set.skills.find((s) => s.name.toLowerCase() === q);
  if (exact) {
    return { kind: "found", skill: exact };
  }

  const prefixMatches = set.skills.filter((s) =>
    s.name.toLowerCase().startsWith(q)
  );
  if (prefixMatches.length === 1) {
    return { kind: "found", skill: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return { kind: "ambiguous", candidates: prefixMatches };
  }

  const substringMatches = set.skills.filter((s) =>
    s.name.toLowerCase().includes(q)
  );
  if (substringMatches.length === 1) {
    return { kind: "found", skill: substringMatches[0] };
  }
  if (substringMatches.length > 1) {
    return { kind: "ambiguous", candidates: substringMatches };
  }

  return { kind: "not-found" };
}

// Shared verbatim between the injected catalogue block and read_skill's
// description, so tool text and priming text can't drift - same pattern as
// claudeMemory.ts's MEMORY_STORAGE_MODEL / readMemory.ts.
export const SKILLS_MODEL = [
  "How local skills work: a skill is a SKILL.md file the user authored on their own machine - a reusable",
  "set of instructions for a recurring task. These are the user's client-side skills, separate from any",
  "skills configured on this Dust agent itself on the server side.",
  "The message you're replying to lists the skills currently in scope, as a catalogue of names and",
  "one-line descriptions - if it carries no skills, there are none right now. A description is a title,",
  "not the skill itself: load a skill's full body with read_skill before following it, and only load the",
  "ones whose description plausibly matches the task at hand.",
].join("\n");

/**
 * The catalogue payload - name/scope/source/description lines only, no
 * revision header. Kept separate from buildSkillsBlock's wrapping so
 * Chat.tsx can compare this exact string against the last one it sent to
 * decide whether anything actually changed (see the freshness comparison
 * in Chat.tsx, next to pendingClaudePrimingRef).
 */
export function buildSkillCatalogue(set: SkillSet): string | null {
  // `enabled` is the user's explicit choice in the /skills picker, so it
  // gates everything the agent can see. `disableModelInvocation` is the
  // skill author's own "don't pick this on your own" flag - it hides the
  // skill from the catalogue but leaves it reachable by explicit request.
  const visible = set.skills.filter(
    (s) => s.enabled && !s.disableModelInvocation
  );
  if (visible.length === 0) {
    return null;
  }

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const skill of visible) {
    const line = `- ${skill.name} (${skill.source}): ${skill.description}`;
    if (used + line.length > CATALOGUE_CHAR_BUDGET) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length;
  }

  if (dropped > 0) {
    lines.push(
      `(${dropped} more skill(s) omitted for size - call read_skill with no arguments for the complete list.)`
    );
  }

  return lines.join("\n");
}

interface SkillBlockArgs {
  catalogue: string | null;
  inlined: Skill[]; // /skills <name> forced bodies
  revision: number; // 1 = first time this conversation, >1 = replaces an earlier one
}

/**
 * Wraps the catalogue (and any explicitly forced bodies) in the
 * <local_skills> block sent as part of the outgoing message. Forced bodies
 * live in the same block as the catalogue rather than getting their own
 * position, so the agent sees a forced skill as one of the listed ones
 * instead of an unrelated instruction dump.
 */
export function buildSkillsBlock(args: SkillBlockArgs): string | null {
  const { catalogue, inlined, revision } = args;
  if (!catalogue && inlined.length === 0) {
    return null;
  }

  const parts: string[] = ["<local_skills>", SKILLS_MODEL, ""];

  if (revision > 1) {
    parts.push(
      "This replaces the skill catalogue given earlier in this conversation - that list is out of date. Use only the names below.",
      ""
    );
  }

  if (inlined.length > 0) {
    let budget = FORCED_INLINE_CHAR_BUDGET;
    for (const skill of inlined) {
      const rendered = `<skill name="${skill.name}" source="${skill.source}" loaded="explicit">\nFile: ${skill.filePath}\n\n${skill.body}\n</skill>`;
      if (rendered.length > budget) {
        parts.push(
          `(Skill "${skill.name}" was requested but is over the per-message budget - call read_skill with names: ["${skill.name}"] instead.)`
        );
        continue;
      }
      parts.push(rendered);
      budget -= rendered.length;
    }
    parts.push("");
  }

  if (catalogue) {
    parts.push(
      `<skill_catalogue count="${catalogue.split("\n").length}">`,
      catalogue,
      "</skill_catalogue>",
      ""
    );
  }

  parts.push("</local_skills>");
  return parts.join("\n");
}

/**
 * Human-readable listing for the /skills command - what's on disk, what's
 * shadowed, and what was skipped, so a skill that isn't taking effect is
 * diagnosable rather than a mystery.
 */
export function summarizeSkills(set: SkillSet): string[] {
  const lines: string[] = [];

  if (set.skills.length === 0) {
    lines.push("No local skills found.");
  } else {
    for (const skill of set.skills) {
      const flags = [
        skill.enabled ? null : "off",
        skill.disableModelInvocation ? "explicit only" : null,
      ].filter(Boolean);
      const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      lines.push(
        `${skill.enabled ? "[x]" : "[ ]"} ${skill.name} (${skill.source}): ${skill.description}${suffix}`
      );
    }
  }

  for (const shadow of set.shadowed) {
    lines.push(
      `  shadowed: ${shadow.loserPath} (${shadow.loserSource}) - overridden by the ${shadow.winnerSource} copy`
    );
  }

  for (const root of set.roots) {
    if (root.requiresClaudeMode && !set.claudeSkillsIncluded) {
      lines.push(`  ${root.label}: not searched (enable /claude-code-mode)`);
    } else if (!root.exists) {
      lines.push(`  ${root.label}: not found`);
    } else {
      lines.push(`  ${root.label}: ${root.found} skill(s)`);
    }
  }

  for (const warning of set.warnings) {
    lines.push(`  warning: ${warning}`);
  }

  return lines;
}

// Module-level singleton bridging React state -> the MCP transport layer,
// where read_skill executes and has no access to it. Same pattern and same
// justification as planMode.ts / taskStore.ts's getActiveConversationId.
// Synced from Chat.tsx's existing claudeCodeMode effect; left `false` (its
// default) in non-interactive mode, where there is no /claude-code-mode
// toggle to sync from.
let claudeSkillsEnabled = false;

export function setClaudeSkillsEnabled(enabled: boolean): void {
  claudeSkillsEnabled = enabled;
}

export function areClaudeSkillsEnabled(): boolean {
  return claudeSkillsEnabled;
}
