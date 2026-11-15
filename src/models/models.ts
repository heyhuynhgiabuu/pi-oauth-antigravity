import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AntigravityRouting } from "../types/types.js";
import { ThinkingEffort } from "../types/enums.js";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";

/**
 * Public selectable model IDs → backend request model IDs by thinking effort.
 *
 * Catalog mirrors `agy models` (Antigravity CLI) and the 2026-11 models doc, which advertises:
 * - Gemini 4 Argon (Low / Medium / High) — CONFIRMED: launched 2026-10-13; wire IDs
 *   `gemini-4-argon-{low,medium,high}` verified against live `fetchAvailableModels`
 *   (opencodex 2026-10-14, codex2api 2026-10-16). Entitlement-gated (Ultra / Enterprise /
 *   paid Pro); requests fall back to Gemini 3.8 Flash when the backend rejects it.
 * - Gemini 4 Carbon (Low / Medium / High) — launched 2026-11-10 (changelog v2.31.0);
 *   CCA wire IDs follow the family pattern but are UNVERIFIED against a live listing,
 *   so requests fall back through Argon to Gemini 3.8 Flash when rejected.
 * - Gemini 4 Hydrogen (Low / Medium / High / xHigh) — launched 2026-11-12; the four
 *   SKUs incl. the new `-xhigh` tier were observed in live discovery (oh-my-pi 7c74c203,
 *   opencodex #8644 2026-11-13). Falls back through Carbon → Argon → 3.8 Flash.
 * - Gemini 3.8 Flash (Low / Medium / High)
 * - Gemini 3.7 Flash (Low / Medium / High) — still served, single `gemini-3.7-flash-tiered`
 *   wire id on newer discovery payloads; Enterprise-only per the 2026-11 models doc.
 * - Gemini 3.6 Flash (Low / Medium / High) — Enterprise-only; effectively absent from CCA
 *   for non-Enterprise accounts since 3.7 shipped, but kept selectable for entitled ones.
 * - Gemini 3.1 Pro (Low / High)
 * - Claude Opus 5.5 (Low / Medium / High)
 * - Claude Sonnet 5.5 (Low / Medium / High)
 *
 * Removed 2026-11-18 per Google's models doc: `claude-opus-4-6-thinking`,
 * `claude-sonnet-4-6`, `gpt-oss-120b-medium`. They are no longer selectable; the stream
 * handler still recognizes their retirement notices, and pinned runtime overrides to the
 * old wire IDs keep working until the backend drops them.
 */
export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
  "gemini-4-hydrogen": {
    off: "gemini-4-hydrogen-low",
    routing: {
      minimal: "gemini-4-hydrogen-low",
      low: "gemini-4-hydrogen-low",
      medium: "gemini-4-hydrogen-medium",
      high: "gemini-4-hydrogen-high",
      xhigh: "gemini-4-hydrogen-xhigh",
    },
    defaultRequestId: "gemini-4-hydrogen-low",
  },
  "gemini-4-carbon": {
    off: "gemini-4-carbon-low",
    routing: {
      minimal: "gemini-4-carbon-low",
      low: "gemini-4-carbon-low",
      medium: "gemini-4-carbon-medium",
      high: "gemini-4-carbon-high",
      xhigh: "gemini-4-carbon-high",
    },
    defaultRequestId: "gemini-4-carbon-low",
  },
  "gemini-4-argon": {
    off: "gemini-4-argon-low",
    routing: {
      minimal: "gemini-4-argon-low",
      low: "gemini-4-argon-low",
      medium: "gemini-4-argon-medium",
      high: "gemini-4-argon-high",
      xhigh: "gemini-4-argon-high",
    },
    defaultRequestId: "gemini-4-argon-low",
  },
  "gemini-3.8-flash": {
    off: "gemini-3.8-flash-low",
    routing: {
      minimal: "gemini-3.8-flash-low",
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
      xhigh: "gemini-3.8-flash-high",
    },
    defaultRequestId: "gemini-3.8-flash-low",
  },
  "claude-opus-4-6": {
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  "claude-opus-5-5-low": {
    routing: { low: "claude-opus-5-5-low" },
    defaultRequestId: "claude-opus-5-5-low",
  },
  "claude-opus-5-5-medium": {
    routing: { medium: "claude-opus-5-5-medium" },
    defaultRequestId: "claude-opus-5-5-medium",
  },
  "claude-opus-5-5-high": {
    routing: { high: "claude-opus-5-5-high" },
    defaultRequestId: "claude-opus-5-5-high",
  },
  "claude-sonnet-5-5-low": {
    routing: { low: "claude-sonnet-5-5-low" },
    defaultRequestId: "claude-sonnet-5-5-low",
  },
  "claude-sonnet-5-5-medium": {
    routing: { medium: "claude-sonnet-5-5-medium" },
    defaultRequestId: "claude-sonnet-5-5-medium",
  },
  "claude-sonnet-5-5-high": {
    routing: { high: "claude-sonnet-5-5-high" },
    defaultRequestId: "claude-sonnet-5-5-high",
  },
  // Live fetchAvailableModels exposes `claude-sonnet-4-6` (display: Thinking), not a separate *-thinking id.
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6",
    routing: {
      minimal: "claude-sonnet-4-6",
      low: "claude-sonnet-4-6",
      medium: "claude-sonnet-4-6",
      high: "claude-sonnet-4-6",
      xhigh: "claude-sonnet-4-6",
    },
    defaultRequestId: "claude-sonnet-4-6",
  },
  "gemini-3.1-pro": {
    // `gemini-3.1-pro-high` is advertised but currently 400s for agent streamGenerateContent;
    // `gemini-pro-agent` is the working High runtime id (same display name in fetchAvailableModels).
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-3.1-pro-low",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-low",
    routing: {
      minimal: "gemini-3.7-flash-low",
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
      xhigh: "gemini-3.7-flash-high",
    },
    defaultRequestId: "gemini-3.7-flash-low",
  },
  "gemini-3.6-flash": {
    // agy models: gemini-3.6-flash-low / -medium / -high
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-low",
  },
  // Removed-from-catalog IDs keep their routing so a pinned frontend override still
  // resolves to the right wire id until the backend drops the model (2026-11-18).
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};

/**
 * Verified maximum output tokens accepted by the Cloud Code Assist backend per model/runtime ID.
 * Requesting more than these limits returns a 400 Bad Request from the API.
 */
export const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number> = {
  // Gemini 4 family: 3.8-tier value as provisional estimate; no verified 4-family limit.
  "gemini-4-carbon": 65536,
  "gemini-4-carbon-low": 65536,
  "gemini-4-carbon-medium": 65536,
  "gemini-4-carbon-high": 65536,
  "gemini-4-hydrogen": 65536,
  "gemini-4-hydrogen-low": 65536,
  "gemini-4-hydrogen-medium": 65536,
  "gemini-4-hydrogen-high": 65536,
  "gemini-4-hydrogen-xhigh": 65536,
  // Provisional: family fallback, not a verified Gemini 4 limit.
  "gemini-4-argon": 65536,
  "gemini-4-argon-low": 65536,
  "gemini-4-argon-medium": 65536,
  "gemini-4-argon-high": 65536,
  "gemini-3.8-flash": 65536,
  "gemini-3.8-flash-tiered": 65536,
  "gemini-3.8-flash-low": 65536,
  "gemini-3.8-flash-medium": 65536,
  "gemini-3.8-flash-high": 65536,
  "gemini-3.7-flash": 65536,
  "gemini-3.7-flash-tiered": 65536,
  // Retain rollout-era IDs for compatibility with pinned runtime overrides.
  "gemini-3.7-flash-low": 65536,
  "gemini-3.7-flash-medium": 65536,
  "gemini-3.7-flash-high": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.6-flash-low": 65536,
  "gemini-3.6-flash-medium": 65536,
  "gemini-3.6-flash-high": 65536,
  "gemini-3.1-pro": 65535,
  "gemini-3.1-pro-low": 65535,
  "gemini-3.1-pro-high": 65535,
  "gemini-pro-agent": 65535,
  "claude-opus-4-6": 64000,
  "claude-opus-4-6-thinking": 64000,
  "claude-sonnet-4-6": 64000,
  "gpt-oss-120b": 32768,
  "gpt-oss-120b-medium": 32768,
};

export function getMaxOutputTokens(modelId: string, runtimeModel?: string): number {
  if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel];
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[modelId];
  }
  if (runtimeModel) {
    // Unlisted Claude models use a family fallback, not a verified per-model limit.
    if (runtimeModel.startsWith("claude-")) return 64000;
    if (runtimeModel.startsWith("gpt-oss-")) return 32768;
    if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent")
      return 65535;
    if (runtimeModel.startsWith("gemini-")) return 65536;
  }
  return 8192;
}

const geminiFlashCost = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 };
const geminiProCost = { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 };
const claudeSonnetCost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const claudeOpusCost = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };

// A null entry is intentionally hidden by Pi. Do not collapse levels that happen to
// route to the same runtime ID: the UI must reflect the levels the backend advertises.
const thinkingLevelMaps = {
  lowMediumHigh: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: null,
    max: null,
  },
  lowMediumHighXhigh: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  },
  lowHigh: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  },
  thinking: {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  },
  low: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  },
  medium: {
    off: null,
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
    xhigh: null,
    max: null,
  },
} satisfies Record<string, ThinkingLevelMap>;

type Claude55Family = "opus" | "sonnet";
type Claude55Tier = "low" | "medium" | "high";

const claude55ThinkingLevelMaps: Record<Claude55Tier, ThinkingLevelMap> = {
  low: thinkingLevelMaps.low,
  medium: thinkingLevelMaps.medium,
  high: thinkingLevelMaps.thinking,
};

/**
 * Use existing same-family values as provisional estimates only; 5.5-specific
 * cost, context-window, and output-token metadata has not been verified.
 */
function claude55Models(family: Claude55Family): ProviderModelConfig[] {
  const familyName = family === "opus" ? "Opus" : "Sonnet";
  const cost = family === "opus" ? claudeOpusCost : claudeSonnetCost;
  const contextWindow = family === "opus" ? 250000 : 200000;

  return (["low", "medium", "high"] as const).map((tier) => {
    const tierName = `${tier[0]!.toUpperCase()}${tier.slice(1)}`;
    return {
      id: `claude-${family}-5-5-${tier}`,
      name: `Claude ${familyName} 5.5 (${tierName}) (Antigravity)`,
      reasoning: true,
      thinkingLevelMap: claude55ThinkingLevelMaps[tier],
      input: ["text", "image"],
      cost,
      contextWindow,
      maxTokens: 64000,
    };
  });
}

/** Selectable provider models; effort variants share public IDs where routing supports them. */
export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
  {
    // Wire IDs verified against live discovery (2026-10-14); cost/context are
    // Pro-tier estimates and the output cap is the 3.8-tier value.
    id: "gemini-4-argon",
    name: "Gemini 4 Argon (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiProCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    // Launched 2026-11-10. Carbon-specific cost/context/output are unverified;
    // values reuse the Gemini 4 family estimates.
    id: "gemini-4-carbon",
    name: "Gemini 4 Carbon (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiProCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    // Launched 2026-11-12 with the backend's first -xhigh tier. Hydrogen-specific
    // cost/context/output are unverified; values reuse the Gemini 4 family estimates.
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHighXhigh,
    input: ["text", "image"],
    cost: geminiProCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  ...claude55Models("opus"),
  ...claude55Models("sonnet"),
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Antigravity)",
    reasoning: true,
    thinkingLevelMap: thinkingLevelMaps.lowHigh,
    input: ["text", "image"],
    cost: geminiProCost,
    contextWindow: 1048576,
    maxTokens: 65535,
  },
];

/** Resolve public model id + thinking effort to Antigravity runtime model id. */
export function getAntigravityRequestModelId(modelId: string, effort: string | undefined): string {
  const r = ANTIGRAVITY_ROUTING[modelId];
  if (!r) return modelId;

  if (effort === undefined || effort === "off") {
    return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
  }

  const effortKey = effort as ThinkingEffort;
  if (effortKey === ThinkingEffort.Xhigh) {
    return (
      r.routing?.xhigh ??
      r.routing?.high ??
      r.routing?.low ??
      r.routing?.minimal ??
      r.off ??
      r.defaultRequestId ??
      modelId
    );
  }

  return (
    r.routing?.[effortKey] ??
    r.routing?.low ??
    r.routing?.minimal ??
    r.off ??
    r.defaultRequestId ??
    modelId
  );
}

/**
 * If a next-gen model (e.g. Gemini 3.7 Flash) is not yet available on the backend,
 * provide a fallback runtime model ID (e.g. Gemini 3.6 Flash) to maintain availability.
 */
export function getFallbackRuntimeModel(runtimeModel: string, effort?: string): string | undefined {
  // Only Hydrogen advertises an -xhigh wire id; Carbon and Argon top out at -high,
  // so a Hydrogen xHigh fallback must downgrade the tier when it crosses families.
  const carbonTarget = runtimeModel.startsWith("gemini-4-hydrogen-")
    ? runtimeModel.replace("gemini-4-hydrogen-", "gemini-4-carbon-").replace(/-xhigh$/, "-high")
    : undefined;
  if (runtimeModel === "gemini-4-hydrogen") {
    return "gemini-4-carbon-low";
  }
  if (carbonTarget) return carbonTarget;
  if (runtimeModel === "gemini-4-carbon") {
    return "gemini-4-argon-low";
  }
  if (runtimeModel.startsWith("gemini-4-carbon-")) {
    return runtimeModel.replace("gemini-4-carbon-", "gemini-4-argon-").replace(/-xhigh$/, "-high");
  }
  if (runtimeModel === "gemini-4-argon") {
    return "gemini-3.8-flash-low";
  }
  if (runtimeModel.startsWith("gemini-4-argon-")) {
    return runtimeModel.replace("gemini-4-argon-", "gemini-3.8-flash-");
  }
  if (runtimeModel === "gemini-3.8-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.7-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.8-flash-")) {
    return runtimeModel.replace("gemini-3.8-flash-", "gemini-3.7-flash-");
  }
  if (runtimeModel === "gemini-3.8-flash") {
    return "gemini-3.7-flash-low";
  }
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.6-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.7-flash-")) {
    return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
  }
  if (runtimeModel === "gemini-3.7-flash") {
    return "gemini-3.6-flash-low";
  }
  return undefined;
}

export type GeminiThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export type ThinkingWire = {
  includeThoughts: boolean;
  thinkingLevel?: GeminiThinkingLevel;
  thinkingBudget?: number;
};

export const ANTIGRAVITY_MODEL_ENUM: Record<string, string> = {
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
};

function googleLevel(effort: string | undefined): GeminiThinkingLevel {
  if (effort === "high" || effort === "xhigh") return "HIGH";
  if (effort === "medium") return "MEDIUM";
  return "LOW";
}

export function getThinkingConfig(
  modelId: string,
  effort: string | undefined,
): ThinkingWire | undefined {
  if (
    modelId === "gemini-4-argon" ||
    modelId === "gemini-3.7-flash" ||
    modelId === "gemini-3.6-flash" ||
    modelId === "gemini-3.8-flash"
  ) {
    return { includeThoughts: true, thinkingLevel: googleLevel(effort) };
  }
  if (modelId === "gemini-3.1-pro") {
    if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
    return {
      includeThoughts: true,
      thinkingBudget: effort === "high" || effort === "xhigh" ? 10_001 : 1_001,
    };
  }
  return undefined;
}
