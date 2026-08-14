/**
 * Plan mode: the agent researches read-only and proposes a plan, and touches
 * nothing on disk until the user approves it.
 *
 * This is a module-level singleton rather than React state on purpose. The
 * tools that have to respect it (`write_file`, `edit_file`, `run_command`)
 * execute inside the MCP transport layer, which has no access to the Ink
 * component tree - the same boundary that makes `todoListEmitter` an
 * EventEmitter rather than a callback prop. State flows out of the UI to the
 * tools through this module; observations flow back the other way through
 * emitters.
 */

let active = false;

export function isPlanModeActive(): boolean {
  return active;
}

export function setPlanMode(next: boolean): void {
  active = next;
}

// Tools blocked while planning, and therefore the ones that call
// planModeRefusal below. Exported so the UI can name them accurately when
// the mode is switched on instead of hardcoding a second list that could
// drift out of step.
export const PLAN_MODE_BLOCKED_TOOLS = [
  "write_file",
  "edit_file",
  "run_command",
] as const;

// Still available while planning: everything needed to research an answer.
export const PLAN_MODE_ALLOWED_TOOLS = [
  "read_file",
  "search_files",
  "search_content",
  "read_memory",
  "read_tasks",
  "fetch_url",
] as const;

/**
 * Told to the agent at the start of every turn while plan mode is on.
 *
 * Without this, plan mode is only ever discovered *reactively* - by trying to
 * write something and being refused. That leaves the common case broken: asked
 * to plan something that needs no file writes at all, the agent has no way to
 * know plan mode exists, answers in prose, and never calls present_plan. The
 * blocked tools are the hard guarantee; this is what makes the mode visible
 * before one is reached.
 *
 * Deliberately short, because it rides along with every message: enough to
 * establish the constraint and the way out, and no more. The last paragraph
 * matters as much as the first - a plain question deserves a plain answer, and
 * an agent that thinks it must file a plan before saying anything is worse
 * than one that doesn't know about plan mode at all.
 */
export function planModePreamble(): string {
  return [
    "<plan_mode>",
    "Plan mode is ON. You may read and search freely, but write_file, edit_file",
    "and run_command are blocked - nothing you do can change this machine until",
    "the user approves a plan.",
    "",
    "If carrying out this request would mean editing files or running commands:",
    "research it with the read-only tools first, then call present_plan with what",
    "you intend to do, and wait. Do not write the plan out as your reply and stop",
    "- present_plan is what actually asks the user, and only their approval lifts",
    "the block. Never describe work as done that you have not been able to do.",
    "",
    "If the request is just a question, or asks for advice, a design or an",
    "explanation that involves no changes here, simply answer it. Plan mode",
    "restricts what you may change; it does not require a plan for everything.",
    "</plan_mode>",
  ].join("\n");
}

/**
 * One-line restatement appended *after* the user's message.
 *
 * The preamble above sits before the request, which is the natural place for
 * context but the weakest place for an instruction - the model reads the task
 * last and tends to act on it directly. Repeating the constraint in the final
 * position measurably improves the odds it calls present_plan instead of
 * reaching for write_file first. Kept to one line so the request still clearly
 * dominates.
 *
 * This is guidance, not enforcement: if the agent tries to write anyway, the
 * tool gate refuses it (planModeRefusal) and nothing is changed either way.
 */
export function planModeReminder(): string {
  return "[Plan mode is on: no file may be written and no command run. If this needs changes, call present_plan and wait for approval.]";
}

/**
 * Appended to the description of every tool plan mode blocks.
 *
 * This is the strongest channel available for the instruction, and the reason
 * is placement: a tool's description is in context at the exact moment the
 * agent is choosing that tool, whereas the per-turn preamble was read further
 * back. In testing, an agent that ignored the preamble and reached straight
 * for write_file is precisely the case this addresses.
 *
 * Necessarily phrased conditionally ("if plan mode is on"): descriptions are
 * static, sent once when the MCP server advertises its tools, so this text
 * cannot know the current mode. What tells the agent the mode *is* on is
 * planModePreamble, sent with the message. The two work together - this says
 * what to do about it, the preamble says that it applies right now.
 *
 * It also closes the obvious workaround: every writing tool carries this same
 * notice, so there is no sibling tool to fall back on.
 */
export const PLAN_MODE_TOOL_NOTICE = [
  "",
  "PLAN MODE: if plan mode is on for this turn - the message will say so - do NOT",
  "call this tool. It will refuse, change nothing, and waste a turn. Call",
  "present_plan instead, describing what you intend to do, then wait: only the",
  "user's approval lifts the restriction. Every writing tool (write_file,",
  "edit_file, run_command) refuses the same way, so there is no alternative tool",
  "to reach for.",
].join("\n");

/**
 * The user's answer to a presented plan.
 *
 * Richer than a boolean because approval has two genuinely different meanings:
 * "go ahead now" and "yes, but wait - I have more to say first". Collapsing
 * them would leave the agent guessing, and guessing wrong in the second case
 * means it starts editing while the user is still typing.
 */
export type PlanDecision =
  | { kind: "approve"; then: "auto" | "wait" }
  | { kind: "reject"; comment?: string };

/**
 * What present_plan reports back for each decision.
 *
 * Kept here beside the rest of the plan-mode wording rather than in the tool,
 * so every string the agent is steered by lives in one place and is covered by
 * one set of tests.
 */
export function planDecisionResult(decision: PlanDecision): string {
  if (decision.kind === "approve") {
    if (decision.then === "auto") {
      return [
        "The user APPROVED the plan and asked you to implement it now.",
        "",
        "Plan mode is off and auto-accept edits is on, so write_file, edit_file and",
        "run_command all work and your file edits apply without further prompting.",
        "Carry out the plan you proposed. If you discover it has to change",
        "materially, stop and say so rather than quietly doing something else -",
        "the user is no longer being asked to confirm each edit.",
      ].join("\n");
    }
    return [
      "The user APPROVED the plan but does NOT want you to start yet.",
      "",
      "Plan mode is off, so the writing tools work when you do begin. But the user",
      "has further instructions to give first. Acknowledge the approval briefly and",
      "stop - do not start implementing, and do not call more tools. Wait for their",
      "next message.",
    ].join("\n");
  }

  const feedback = decision.comment?.trim();
  return [
    "The user REJECTED the plan. You are STILL in plan mode and write_file,",
    "edit_file and run_command all remain blocked.",
    "",
    ...(feedback
      ? ["Their feedback:", feedback, ""]
      : [
          "They gave no specific reason. Reconsider the approach rather than",
          "resubmitting the same plan with small edits - if you genuinely don't know",
          "what to change, ask them instead of guessing.",
          "",
        ]),
    "Revise the plan and call present_plan again. Do not attempt the work, and do",
    "not describe it as done.",
  ].join("\n");
}

/**
 * What a blocked tool returns instead of doing its work.
 *
 * Written to redirect rather than just refuse: an agent told only "no" tends
 * to retry the same call or give up, whereas naming `present_plan` and the
 * tools that still work turns the refusal into the next step. The user's
 * approval is described as required so the agent doesn't claim to have made
 * changes it hasn't.
 */
export function planModeRefusal(toolName: string): string {
  return [
    `Blocked: plan mode is on, so ${toolName} cannot run and nothing has been changed.`,
    "",
    "The user wants to review your approach before you touch anything. Finish",
    "researching with the read-only tools that are still available",
    `(${PLAN_MODE_ALLOWED_TOOLS.join(", ")}), then call present_plan with what`,
    "you intend to do.",
    "",
    "The user approves or rejects that plan. On approval, plan mode switches off",
    "and you may carry it out with the normal tools. On rejection you stay in",
    "plan mode - revise based on their feedback and call present_plan again.",
    "",
    "Do not describe the work as done, and do not try to route around this with",
    "another tool: every writing tool is blocked the same way.",
  ].join("\n");
}
