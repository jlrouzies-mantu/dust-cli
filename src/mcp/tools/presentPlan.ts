import { z } from "zod";

import { normalizeError } from "../../utils/errors.js";
import type { PlanDecision } from "../../utils/planMode.js";
import { isPlanModeActive, planDecisionResult } from "../../utils/planMode.js";
import type { McpTool } from "../types/tools.js";

/**
 * The way out of plan mode: the agent submits what it intends to do, the user
 * approves or rejects it.
 *
 * Approval is what switches plan mode off, and it is granted by the user
 * through the terminal - never by this tool on its own. The agent cannot
 * escape plan mode by calling this and assuming success; it has to wait for
 * the result, which says plainly whether it may now proceed.
 */
export class PresentPlanTool implements McpTool {
  name = "present_plan";

  private planApprovalCallback?: (plan: string) => Promise<PlanDecision>;

  description =
    "Presents your implementation plan to the user for approval. Only meaningful in plan mode, " +
    "where every writing tool (write_file, edit_file, run_command) is blocked until a plan is approved.\n\n" +
    "Call this once you have finished researching and know what you intend to do. Write the plan as " +
    "markdown for a human reader: what you will change, in which files, and why - concrete enough to " +
    "judge, without pasting the whole diff. State any assumption you had to make, and call out anything " +
    "risky or irreversible.\n\n" +
    "The user then picks one of four answers, and this tool tells you which:\n" +
    "- Approved, implement now: plan mode is off, edits auto-apply, carry the plan out.\n" +
    "- Approved, wait: plan mode is off, but stop and wait for their further instructions.\n" +
    "- Rejected with a comment: still in plan mode; revise per their feedback and call this again.\n" +
    "- Rejected: still in plan mode; rethink the approach and call this again.\n\n" +
    "Read the result before doing anything else - two of the four outcomes mean you must not " +
    "start, and one means you must not even continue. Do not attempt the work after a rejection, " +
    "and never report work as done that you were blocked from doing.\n\n" +
    "Do not call this to ask a question or to narrate progress - it is specifically a request for " +
    "permission to start writing.";

  inputSchema = z.object({
    plan: z
      .string()
      .min(1)
      .describe(
        "The plan, as markdown. What you will do, where, and why - written to be read by the user, not as a summary for yourself."
      ),
  });

  setPlanApprovalCallback(callback: (plan: string) => Promise<PlanDecision>) {
    this.planApprovalCallback = callback;
  }

  async execute({ plan }: z.infer<typeof this.inputSchema>) {
    try {
      if (!isPlanModeActive()) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Plan mode is not on, so there is nothing to approve and no restriction to lift. " +
                "If you were about to make changes, just make them with the normal tools. If you want " +
                "the user to weigh in first, ask them in your reply instead.",
            },
          ],
        };
      }

      if (!this.planApprovalCallback) {
        // Non-interactive runs have no one to approve anything. Failing
        // loudly is right: silently switching plan mode off would hand the
        // agent write access the user explicitly withheld.
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Cannot ask for approval: this session has no interactive prompt (plan mode needs the " +
                "interactive chat). Plan mode stays on. Reply with the plan as text so the user can read it.",
            },
          ],
          isError: true,
        };
      }

      const decision = await this.planApprovalCallback(plan);

      return {
        content: [
          { type: "text" as const, text: planDecisionResult(decision) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error presenting plan: ${normalizeError(error).message}. Plan mode is unchanged.`,
          },
        ],
        isError: true,
      };
    }
  }
}
