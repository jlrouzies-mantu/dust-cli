/**
 * Per-message model and reasoning-effort overrides.
 *
 * A Dust agent is configured server-side with a model and (in the web app)
 * a reasoning effort. The public API lets a client override both per
 * message via `modelSelection` on the post body - a sibling of
 * `content`/`mentions`/`context`, accepted by both `createConversation`
 * and `postUserMessage`. `/model` and `/effort` drive that.
 *
 * The override is client-side and per-conversation: it changes what this
 * CLI sends, never the agent's saved configuration.
 */

// Mirrors the SDK's providerId union (PublicPostMessagesRequestBodySchema).
// Kept as a local type rather than imported because the SDK only exports it
// inline inside a large generated zod schema.
export type ProviderId =
  | "anthropic"
  | "openai"
  | "google_ai_studio"
  | "mistral"
  | "xai"
  | "deepseek"
  | "fireworks"
  | "auto"
  | "auto_complex"
  | "auto_fast"
  | "noop";

// The API's four levels. Note "light", not "low" - getting this wrong is a
// silent 400 rather than a type error, since modelId widens to string.
export type ReasoningEffort = "high" | "medium" | "light" | "none";

export const REASONING_EFFORTS: {
  id: ReasoningEffort;
  label: string;
  description: string;
}[] = [
  { id: "high", label: "high", description: "Most thinking, slowest" },
  { id: "medium", label: "medium", description: "Balanced" },
  { id: "light", label: "light", description: "Little thinking, faster" },
  { id: "none", label: "none", description: "No reasoning step at all" },
];

export interface ModelChoice {
  modelId: string;
  providerId: ProviderId;
  label: string;
  note?: string;
  /**
   * The model's context window, in tokens.
   *
   * This is **not** something the client gets to choose. Dust stores a
   * hardcoded `contextSize` per model server-side and the context-usage
   * endpoint reports it back from there; `modelSelection` carries only
   * providerId/modelId/reasoningEffort, with no context field of any kind.
   * So the only lever a user has over how much context they get is *which
   * model they pick* - which is exactly why this is surfaced in the picker
   * rather than left to be discovered from the status bar after the fact.
   *
   * Mirrored by hand from `front/types/assistant/models/*.ts` upstream, and
   * therefore as advisory as the rest of MODEL_CATALOG: it can go stale, so
   * it's only ever shown as a hint. The status bar's `n/m context` figure
   * comes from the server and remains the authority. Omitted for the `auto*`
   * meta-selectors, where Dust picks the concrete model per message and
   * there is no single answer.
   */
  contextSize?: number;
}

/**
 * Renders a context window for display: 250000 -> "250k", 1000000 -> "1M",
 * 1050000 -> "1.05M". Switches to millions at 1M so the large-context
 * models - the whole reason this is shown - read as obviously different
 * rather than as one more six-digit number to compare digit by digit.
 */
export function formatContextSize(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number(millions.toFixed(2))}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * Offline fallback for `/model`'s list.
 *
 * **Not the primary source any more.** workspaceModels.ts fetches the
 * workspace's real entitlements - with authoritative context sizes - and
 * everything here is only used when that call fails. Treat this as a
 * best-effort snapshot: it cannot know what a given workspace is entitled
 * to, and on a real workspace 13 of these entries turned out to be models
 * that workspace had no access to at all. That is the cost of a
 * hand-maintained list, and the reason it was demoted.
 *
 * Still deliberately not the SDK's whole KnownModelLLMId union, which
 * carries ~75 entries going back to gpt-3.5-turbo. And still not
 * authoritative in the other direction either: the API's modelId widens to
 * `string`, so `/model <id>` accepts anything, including ids listed in
 * neither this nor the live list (see inferProviderId). The server is the
 * only thing that can actually decide.
 *
 * Context sizes are mirrored by hand from
 * `front/types/assistant/models/*.ts` upstream and can go stale - another
 * reason the live list wins wherever it's available.
 */
export const MODEL_CATALOG: ModelChoice[] = [
  // Meta-selectors: Dust picks the concrete model per message, so there is
  // no single context size to quote.
  { modelId: "auto", providerId: "auto", label: "auto", note: "Dust picks" },
  {
    modelId: "auto_complex",
    providerId: "auto_complex",
    label: "auto_complex",
    note: "Dust picks, favouring capability",
  },
  {
    modelId: "auto_fast",
    providerId: "auto_fast",
    label: "auto_fast",
    note: "Dust picks, favouring speed",
  },

  // Anthropic. 250k is Dust's ceiling for the whole provider - it has not
  // wired up Anthropic's extended-context beta, so there is no Claude model
  // here that goes higher.
  {
    modelId: "claude-opus-5",
    providerId: "anthropic",
    label: "claude-opus-5",
    contextSize: 250_000,
  },
  {
    modelId: "claude-sonnet-5",
    providerId: "anthropic",
    label: "claude-sonnet-5",
    contextSize: 250_000,
  },
  {
    modelId: "claude-fable-5",
    providerId: "anthropic",
    label: "claude-fable-5",
    contextSize: 250_000,
  },
  {
    modelId: "claude-opus-4-8",
    providerId: "anthropic",
    label: "claude-opus-4-8",
    contextSize: 250_000,
  },
  {
    modelId: "claude-sonnet-4-6",
    providerId: "anthropic",
    label: "claude-sonnet-4-6",
    contextSize: 250_000,
  },
  {
    modelId: "claude-haiku-4-5-20251001",
    providerId: "anthropic",
    label: "claude-haiku-4-5",
    contextSize: 180_000,
  },

  // OpenAI
  {
    modelId: "gpt-5.6-terra-long-context",
    providerId: "openai",
    label: "gpt-5.6-terra-long-context",
    contextSize: 1_050_000,
  },
  {
    modelId: "gpt-5.5",
    providerId: "openai",
    label: "gpt-5.5",
    contextSize: 1_000_000,
  },
  {
    modelId: "gpt-5.4",
    providerId: "openai",
    label: "gpt-5.4",
    contextSize: 1_000_000,
  },
  {
    modelId: "gpt-5.4-mini",
    providerId: "openai",
    label: "gpt-5.4-mini",
    contextSize: 400_000,
  },
  {
    modelId: "gpt-5.6-sol",
    providerId: "openai",
    label: "gpt-5.6-sol",
    contextSize: 272_000,
  },
  {
    modelId: "gpt-5.6-terra",
    providerId: "openai",
    label: "gpt-5.6-terra",
    contextSize: 272_000,
  },
  {
    modelId: "gpt-5.6-luna",
    providerId: "openai",
    label: "gpt-5.6-luna",
    contextSize: 272_000,
  },
  { modelId: "o3", providerId: "openai", label: "o3", contextSize: 200_000 },
  {
    modelId: "o4-mini",
    providerId: "openai",
    label: "o4-mini",
    contextSize: 200_000,
  },

  // Google
  {
    modelId: "gemini-3.8-flash",
    providerId: "google_ai_studio",
    label: "gemini-3.8-flash",
    contextSize: 1_048_576,
  },
  {
    modelId: "gemini-3.6-flash",
    providerId: "google_ai_studio",
    label: "gemini-3.6-flash",
    contextSize: 1_000_000,
  },
  {
    modelId: "gemini-3.5-flash",
    providerId: "google_ai_studio",
    label: "gemini-3.5-flash",
    contextSize: 1_000_000,
  },
  {
    modelId: "gemini-3.1-pro-preview",
    providerId: "google_ai_studio",
    label: "gemini-3.1-pro-preview",
    contextSize: 1_000_000,
  },

  // xAI
  {
    modelId: "grok-4-1-fast-reasoning-latest",
    providerId: "xai",
    label: "grok-4-1-fast-reasoning",
    contextSize: 2_000_000,
  },
  {
    modelId: "grok-4.5",
    providerId: "xai",
    label: "grok-4.5",
    contextSize: 500_000,
  },

  // Mistral
  {
    modelId: "mistral-large-latest",
    providerId: "mistral",
    label: "mistral-large-latest",
    contextSize: 256_000,
  },
  {
    modelId: "mistral-medium-3-5",
    providerId: "mistral",
    label: "mistral-medium-3-5",
    contextSize: 256_000,
  },

  // DeepSeek / Fireworks-hosted open models
  {
    modelId: "accounts/fireworks/models/deepseek-v4-pro",
    providerId: "fireworks",
    label: "deepseek-v4-pro",
    contextSize: 1_000_000,
  },
  {
    modelId: "accounts/fireworks/models/glm-5p3",
    providerId: "fireworks",
    label: "glm-5p3",
    contextSize: 1_000_000,
  },
  {
    modelId: "accounts/fireworks/models/kimi-k2p5",
    providerId: "fireworks",
    label: "kimi-k2p5",
    contextSize: 262_100,
  },
  {
    modelId: "accounts/fireworks/models/kimi-k3",
    providerId: "fireworks",
    label: "kimi-k3",
    contextSize: 256_000,
  },
  {
    modelId: "deepseek-chat",
    providerId: "deepseek",
    label: "deepseek-chat",
    contextSize: 64_000,
  },
];

/**
 * Best-effort provider for a model id that isn't in MODEL_CATALOG, so
 * `/model <id>` works for models released after this list was written.
 *
 * Prefix-based, because that's the only signal an id carries. Returns null
 * rather than guessing a default when nothing matches - sending the wrong
 * providerId produces a confusing server-side error, so it's better to
 * refuse and say why.
 */
export function inferProviderId(modelId: string): ProviderId | null {
  const id = modelId.toLowerCase();
  if (id === "auto") return "auto";
  if (id === "auto_complex") return "auto_complex";
  if (id === "auto_fast") return "auto_fast";
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gpt-") || /^o\d/.test(id)) return "openai";
  if (id.startsWith("gemini-")) return "google_ai_studio";
  if (id.startsWith("grok-")) return "xai";
  if (id.startsWith("mistral-") || id.startsWith("codestral")) return "mistral";
  if (id.startsWith("deepseek-")) return "deepseek";
  if (id.startsWith("accounts/fireworks/")) return "fireworks";
  return null;
}

/**
 * Resolves what the user typed after `/model` to a concrete choice.
 * Catalogue first (exact id, then label, then unique prefix/substring), and
 * failing that, treats the input as a raw model id if a provider can be
 * inferred from it.
 */
export function resolveModel(
  query: string,
  catalogue: ModelChoice[] = MODEL_CATALOG
): ModelChoice | null {
  const q = query.trim();
  if (!q) {
    return null;
  }
  const lower = q.toLowerCase();

  const exact = catalogue.find(
    (m) => m.modelId.toLowerCase() === lower || m.label.toLowerCase() === lower
  );
  if (exact) {
    return exact;
  }

  const partial = catalogue.filter(
    (m) =>
      m.modelId.toLowerCase().includes(lower) ||
      m.label.toLowerCase().includes(lower)
  );
  if (partial.length === 1) {
    return partial[0];
  }
  if (partial.length > 1) {
    // Ambiguous - the caller lists the candidates rather than guessing.
    return null;
  }

  const inferred = inferProviderId(q);
  return inferred
    ? { modelId: q, providerId: inferred, label: q, note: "not in catalogue" }
    : null;
}

export function modelCandidates(
  query: string,
  catalogue: ModelChoice[] = MODEL_CATALOG
): ModelChoice[] {
  const lower = query.trim().toLowerCase();
  if (!lower) {
    return [];
  }
  return catalogue.filter(
    (m) =>
      m.modelId.toLowerCase().includes(lower) ||
      m.label.toLowerCase().includes(lower)
  );
}

export interface ModelOverride {
  modelId: string;
  providerId: ProviderId;
  label: string;
  // Carried through from MODEL_CATALOG so /model can say what window the
  // model you just picked has. Absent for ids typed in that aren't in the
  // catalogue - there is no endpoint to look one up from.
  contextSize?: number;
}

/**
 * The agent's own server-side model, as returned by
 * getAgentConfigurations. Note it carries no reasoning effort - that isn't
 * exposed on the public agent config - so the agent's *default* effort is
 * unknowable here. An effort override therefore has to be sent alongside a
 * model, which is why this falls back to the agent's model rather than
 * sending effort on its own.
 */
export interface AgentDefaultModel {
  modelId: string;
  providerId: ProviderId;
}

export interface ModelSelectionPayload {
  providerId: ProviderId;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Builds the `modelSelection` field for an outgoing message, or undefined
 * when nothing is overridden (in which case the server applies the agent's
 * own configuration, which is the desired default).
 *
 * `providerId` and `modelId` are both required by the API whenever
 * modelSelection is present, so an effort-only override still has to name a
 * model: the agent's own is used, which reproduces its current behaviour
 * apart from the effort.
 */
export function buildModelSelection(
  modelOverride: ModelOverride | null,
  effortOverride: ReasoningEffort | null,
  agentDefault: AgentDefaultModel | null
): ModelSelectionPayload | undefined {
  if (!modelOverride && !effortOverride) {
    return undefined;
  }

  const base = modelOverride ?? agentDefault;
  if (!base) {
    // Effort override with no model to attach it to and no known agent
    // default - sending providerId/modelId is mandatory, so there is
    // nothing valid to send.
    return undefined;
  }

  return {
    providerId: base.providerId,
    modelId: base.modelId,
    ...(effortOverride ? { reasoningEffort: effortOverride } : {}),
  };
}

// The three meta-selectors. They resolve to a different concrete model per
// message, so anywhere an API wants a real provider/model pair up front
// (compaction does) they are not an answer.
function isAutoSelector(providerId: string): boolean {
  return (
    providerId === "auto" ||
    providerId === "auto_complex" ||
    providerId === "auto_fast"
  );
}

/**
 * Picks the model `/compact` summarizes with.
 *
 * Unlike a message, compaction takes the model as an explicit argument and
 * validates it against the server's concrete model list, so an `auto`
 * selector can't be passed through. That's not an edge case - agents
 * configured with `auto` are common - so rather than refusing, this falls
 * back to the model the conversation has *actually* been running on, which
 * the context-usage endpoint reports from the last completed run.
 *
 * In order: an explicit `/compact <model-id>`, then a `/model` override,
 * then the conversation's real current model, then the agent's own
 * configuration. Null only when every one of those is absent or `auto` -
 * which in practice means a conversation that hasn't had a turn yet.
 */
export function resolveCompactionModel({
  query,
  override,
  conversationModel,
  agentModel,
  catalogue = MODEL_CATALOG,
}: {
  query?: string;
  override: ModelOverride | null;
  conversationModel: { modelId: string | null; providerId: string | null } | null;
  agentModel: { modelId: string; providerId: string } | null;
  catalogue?: ModelChoice[];
}): ModelOverride | null {
  if (query) {
    const resolved = resolveModel(query, catalogue);
    // An explicitly named auto selector is refused rather than quietly
    // swapped for something else: the user named it, and silently
    // substituting a model they'd be billed for is worse than not acting.
    if (resolved && !isAutoSelector(resolved.providerId)) {
      return resolved;
    }
    return null;
  }

  if (override && !isAutoSelector(override.providerId)) {
    return override;
  }

  if (
    conversationModel?.modelId &&
    conversationModel.providerId &&
    !isAutoSelector(conversationModel.providerId)
  ) {
    const providerId = conversationModel.providerId as ProviderId;
    return {
      modelId: conversationModel.modelId,
      providerId,
      label: conversationModel.modelId,
      contextSize: catalogue.find(
        (m) => m.modelId === conversationModel.modelId
      )?.contextSize,
    };
  }

  if (agentModel && !isAutoSelector(agentModel.providerId)) {
    return {
      modelId: agentModel.modelId,
      providerId: agentModel.providerId as ProviderId,
      label: agentModel.modelId,
      contextSize: catalogue.find((m) => m.modelId === agentModel.modelId)
        ?.contextSize,
    };
  }

  return null;
}

export interface ModelStatus {
  text: string;
  // True when the user has overridden something with /model or /effort, so
  // the status bar can colour it as a deviation rather than as the plain
  // fact of which model the agent uses.
  overridden: boolean;
}

/**
 * Status-bar text for the model in use, e.g. "claude-opus-5" or
 * "claude-opus-5 · high".
 *
 * Falls back to the agent's own model when nothing is overridden, so the
 * bar always answers "what model is this?" - the agent's configured model
 * is a plain fact the API does report, and not showing it just moved the
 * question to the web app.
 *
 * Effort is only ever shown when *overridden*: the public agent config
 * carries no reasoning effort, so there is no default to display and
 * inventing one would be worse than silence.
 */
export function describeModelStatus(
  modelOverride: ModelOverride | null,
  effortOverride: ReasoningEffort | null,
  agentDefault: AgentDefaultModel | null
): ModelStatus | null {
  const modelLabel = modelOverride?.label ?? agentDefault?.modelId ?? null;
  const parts: string[] = [];
  if (modelLabel) {
    parts.push(modelLabel);
  }
  if (effortOverride) {
    parts.push(modelLabel ? effortOverride : `effort ${effortOverride}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return {
    text: parts.join(" · "),
    overridden: modelOverride !== null || effortOverride !== null,
  };
}
