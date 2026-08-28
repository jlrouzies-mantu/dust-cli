import { z } from "zod";

import { normalizeError } from "../../utils/errors.js";
import {
  SKILLS_MODEL,
  loadSkills,
  resolveSkill,
} from "../../utils/skillStore.js";
import type { McpTool } from "../types/tools.js";

/**
 * Lets the agent look up the user's local skills on demand - the
 * progressive-disclosure half of the skills feature (see skillStore.ts and
 * the <local_skills> catalogue injected in Chat.tsx). Modelled directly on
 * ReadMemoryTool: catalogue-first, full bodies only for names given.
 *
 * Always registered (see fsServer.ts's comment on unconditional
 * registration) and always re-reads disk on every call, so it's
 * authoritative and current regardless of what an earlier catalogue in this
 * conversation said - a skill added, edited or gated by /claude-code-mode
 * since then is reflected immediately, with no staleness to reason about.
 */
export class ReadSkillTool implements McpTool {
  name = "read_skill";

  description =
    "Looks up the user's local skills - reusable instruction packages they authored on their own machine " +
    "for recurring tasks.\n\n" +
    `${SKILLS_MODEL}\n\n` +
    "Usage:\n" +
    "- No arguments: lists every skill currently in scope as one line each (name, source, description). " +
    "Cheap - start here, or trust the catalogue already given in the message if one was.\n" +
    "- `names`: returns the full contents of just the skills you name, exactly as listed in the catalogue. " +
    "This is how you actually load one to follow it.\n\n" +
    "A name not in the current catalogue does not exist - do not guess one. The set of available skills " +
    "can change between turns (the user may enable/disable /claude-code-mode, or add/edit a skill file), " +
    "so call this again rather than relying on an earlier turn's list if you're unsure.";

  inputSchema = z.object({
    names: z
      .array(z.string())
      .optional()
      .describe(
        "Names of the skills to load in full, exactly as listed in the catalogue. Load only the ones whose description plausibly matches the task at hand."
      ),
  });

  async execute({ names }: z.infer<typeof this.inputSchema>) {
    try {
      const loaded = await loadSkills();
      // A skill the user switched off in the /skills picker is out of scope
      // entirely - not merely absent from the catalogue. Letting it still be
      // fetched by name would make the toggle meaningless.
      const set = {
        ...loaded,
        skills: loaded.skills.filter((s) => s.enabled),
      };

      if (set.skills.length === 0) {
        const searched = set.roots
          .filter((r) => !r.requiresClaudeMode || set.claudeSkillsIncluded)
          .map((r) => r.label)
          .join(", ");
        const gated = set.roots
          .filter((r) => r.requiresClaudeMode && !set.claudeSkillsIncluded)
          .map((r) => r.label)
          .join(", ");
        // Distinguish "nothing on disk" from "all switched off in the
        // /skills picker" - they call for completely different follow-ups,
        // and reporting the second as the first would have the agent tell
        // the user to go author skills they already have.
        const allDisabled = loaded.skills.length > 0;
        return {
          content: [
            {
              type: "text" as const,
              text: allDisabled
                ? `No skills are currently enabled. ${loaded.skills.length} exist on disk but the user has switched them off in the /skills picker. Do not use or mention their contents.`
                : `No skills found. Searched ${searched}.` +
                  (gated
                    ? ` Not searched (needs /claude-code-mode): ${gated}.`
                    : ""),
            },
          ],
        };
      }

      const render = (skill: (typeof set.skills)[number]) =>
        [
          `## ${skill.name} (${skill.source})`,
          `Summary: ${skill.description ?? "(no description)"}`,
          `File: ${skill.filePath}`,
          "",
          skill.body,
        ].join("\n");

      if (names && names.length > 0) {
        const sections: string[] = [];
        const missing: string[] = [];

        for (const requested of names) {
          const lookup = resolveSkill(set, requested);
          if (lookup.kind === "found") {
            sections.push(render(lookup.skill));
          } else if (lookup.kind === "ambiguous") {
            sections.push(
              `"${requested}" matches more than one skill: ${lookup.candidates
                .map((c) => c.name)
                .join(", ")}. Be more specific.`
            );
          } else {
            missing.push(requested);
          }
        }

        if (missing.length > 0) {
          sections.push(
            `No skill named: ${missing.join(", ")}. The catalogue may have changed since it was listed - ` +
              "call read_skill with no arguments for the current list."
          );
        }

        return {
          content: [{ type: "text" as const, text: sections.join("\n\n") }],
        };
      }

      // Default: the catalogue, including skills marked
      // disable-model-invocation - those are only excluded from the
      // *auto-injected* block (see buildSkillCatalogue), not from an
      // explicit lookup like this one.
      const catalogue = set.skills
        .map((skill) => `- ${skill.name} (${skill.source}): ${skill.description}`)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${set.skills.length} skill(s). These are summaries, not the skills themselves - ` +
              `call read_skill again with names: [...] to load the ones you need.\n\n${catalogue}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading skills: ${normalizeError(error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
}
