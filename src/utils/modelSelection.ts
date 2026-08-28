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
}

/**
 * A curated subset of the SDK's KnownModelLLMId union.
 *
 * Deliberately not the whole union: it carries ~75 entries going back to
 * gpt-3.5-turbo, which makes for a useless picker. It is also deliberately
 * not authoritative - the API's modelId widens to `string`, there is no
 * endpoint that lists the models a workspace can actually use, and new
 * ones ship regularly. So this list is a convenience for the picker, and
 * `/model <id>` accepts anything, including ids not listed here (see
 * inferProviderId). A model the workspace isn't entitled to is rejected by
 * the server, which is the only place that can actually know.
 */
export const MODEL_CATALOG: ModelChoice[] = [
  // Meta-selectors: Dust picks the concrete model per message.
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

  // Anthropic
  { modelId: "claude-opus-5", providerId: "anthropic", label: "claude-opus-5" },
  {
    modelId: "claude-sonnet-5",
    providerId: "anthropic",
    label: "claude-sonnet-5",
  },
  { modelId: "claude-fable-5", providerId: "anthropic", label: "claude-fable-5" },
  {
    modelId: "claude-opus-4-8",
    providerId: "anthropic",
    label: "claude-opus-4-8",
  },
  {
    modelId: "claude-sonnet-4-6",
    providerId: "anthropic",
    label: "claude-sonnet-4-6",
  },
  {
    modelId: "claude-haiku-4-5-20251001",
    providerId: "anthropic",
    label: "claude-haiku-4-5",
  },

  // OpenAI
  { modelId: "gpt-5.6-sol", providerId: "openai", label: "gpt-5.6-sol" },
  { modelId: "gpt-5.6-terra", providerId: "openai", label: "gpt-5.6-terra" },
  { modelId: "gpt-5.6-luna", providerId: "openai", label: "gpt-5.6-luna" },
  { modelId: "gpt-5.5", providerId: "openai", label: "gpt-5.5" },
  { modelId: "gpt-5.4", providerId: "openai", label: "gpt-5.4" },
  { modelId: "gpt-5.4-mini", providerId: "openai", label: "gpt-5.4-mini" },
  { modelId: "o3", providerId: "openai", label: "o3" },
  { modelId: "o4-mini", providerId: "openai", label: "o4-mini" },

  // Google
  {
    modelId: "gemini-3.6-flash",
    providerId: "google_ai_studio",
    label: "gemini-3.6-flash",
  },
  {
    modelId: "gemini-3.1-pro-preview",
    providerId: "google_ai_studio",
    label: "gemini-3.1-pro-preview",
  },
  {
    modelId: "gemini-3.5-flash",
    providerId: "google_ai_studio",
    label: "gemini-3.5-flash",
  },

  // xAI
  { modelId: "grok-4.5", providerId: "xai", label: "grok-4.5" },
  {
    modelId: "grok-4-1-fast-reasoning-latest",
    providerId: "xai",
    label: "grok-4-1-fast-reasoning",
  },

  // Mistral
  {
    modelId: "mistral-medium-3-5",
    providerId: "mistral",
    label: "mistral-medium-3-5",
  },
  {
    modelId: "mistral-large-latest",
    providerId: "mistral",
    label: "mistral-large-latest",
  },

  // DeepSeek / Fireworks-hosted open models
  { modelId: "deepseek-chat", providerId: "deepseek", label: "deepseek-chat" },
  {
    modelId: "accounts/fireworks/models/kimi-k3",
    providerId: "fireworks",
    label: "kimi-k3",
  },
  {
    modelId: "accounts/fireworks/models/glm-5p2",
    providerId: "fireworks",
    label: "glm-5p2",
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
export function resolveModel(query: string): ModelChoice | null {
  const q = query.trim();
  if (!q) {
    return null;
  }
  const lower = q.toLowerCase();

  const exact = MODEL_CATALOG.find(
    (m) => m.modelId.toLowerCase() === lower || m.label.toLowerCase() === lower
  );
  if (exact) {
    return exact;
  }

  const partial = MODEL_CATALOG.filter(
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

export function modelCandidates(query: string): ModelChoice[] {
  const lower = query.trim().toLowerCase();
  if (!lower) {
    return [];
  }
  return MODEL_CATALOG.filter(
    (m) =>
      m.modelId.toLowerCase().includes(lower) ||
      m.label.toLowerCase().includes(lower)
  );
}

export interface ModelOverride {
  modelId: string;
  providerId: ProviderId;
  label: string;
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
