import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AccountStatus,
  GlobalUsageBridge,
  QuotaPeriod,
  UsageAccount,
  UsageMetric,
  UsageModelPool,
  UsageProviderAdapter,
  UsageQuotaBucket,
} from "pi-usage-core";
import { PROVIDER_ID } from "../models/models.js";
import { runWithDetachedDiagnostics } from "../diagnostics/diagnostics.js";
import { maskEmail } from "../utils/security.js";
import { fetchAccountUsage, resolveApiKeyFromContext } from "./usage.js";
import type { AccountUsage } from "../types/types.js";

declare global {
  var __PI_USAGE__: GlobalUsageBridge | undefined;
}

/**
 * Map a quota bucket's window onto a footer period. `window` is authoritative when present;
 * the label is consulted only when `window` is missing or unrecognized, because a label can
 * describe a rolling detail ("Weekly (rolling 5h)") that must not override the real window.
 * Unrecognized input stays undefined so the footer falls back to the bucket label.
 */
const PERIOD_PATTERNS: ReadonlyArray<readonly [RegExp, QuotaPeriod]> = [
  // "FIVE_HOURS", "SESSION_5H", "WINDOW_5H", "ROLLING_5_HOURS", "5-hour session".
  // The lookbehind rejects decimals so "2.5h" is not read as a 5-hour window.
  [/\bfive\b|(?<![\d.])5\s*(?:hours?|hrs?|h)\b/, "5h"],
  [/\b(?:daily|per\s+day)\b/, "daily"],
  [/\b(?:weekly|per\s+week)\b/, "weekly"],
  [/\b(?:monthly|per\s+month)\b/, "monthly"],
];

function matchPeriod(raw: string | undefined): QuotaPeriod | undefined {
  if (!raw) return undefined;
  // `_` counts as a word character, so "ROLLING_5_HOURS" would defeat `\b`; split it out.
  const normalized = raw.toLowerCase().replace(/[_-]+/g, " ");
  for (const [pattern, period] of PERIOD_PATTERNS) {
    if (pattern.test(normalized)) return period;
  }
  return undefined;
}

function toQuotaPeriod(
  bucket: AccountUsage["groups"][number]["buckets"][number],
): QuotaPeriod | undefined {
  return matchPeriod(bucket.window) ?? matchPeriod(bucket.displayName);
}

function uniquePoolId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  const id = `${base}-${n}`;
  taken.add(id);
  return id;
}

export function convertUsageToAccount(usage: AccountUsage): UsageAccount {
  const pools: UsageModelPool[] = [];
  const takenPoolIds = new Set<string>();

  for (const group of usage.groups) {
    const isGemini = /gemini/i.test(group.displayName);
    const isClaude = /claude|gpt/i.test(group.displayName);

    let poolId = group.displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    let modelKeys = [group.displayName.toLowerCase()];

    if (isGemini) {
      poolId = "gemini";
      modelKeys = ["gemini"];
    } else if (isClaude) {
      poolId = "claude-gpt";
      modelKeys = ["claude", "gpt"];
    }

    const buckets: UsageQuotaBucket[] = group.buckets.map((b) => {
      const remFraction = typeof b.remainingFraction === "number" ? b.remainingFraction : 1.0;
      const remaining = Math.round(remFraction * 100);
      const used = Math.max(0, 100 - remaining);
      const period = toQuotaPeriod(b);

      let resetsAt: number | undefined;
      if (b.resetTime) {
        const ts = Date.parse(b.resetTime);
        if (Number.isFinite(ts)) resetsAt = ts;
      }

      return {
        id: b.bucketId || b.displayName,
        label: b.displayName,
        period,
        used,
        remaining,
        unit: "percent",
        resetsAt,
        isPrimary: period === "5h",
      };
    });

    // parseQuotaSummary keeps a named group even when every bucket was filtered out. Such a
    // group carries no usage data, so drop it before it consumes a pool id.
    if (buckets.length === 0) continue;

    const firstBucket = buckets[0];
    if (firstBucket && !buckets.some((b) => b.isPrimary)) {
      firstBucket.isPrimary = true;
    }

    pools.push({
      id: uniquePoolId(poolId, takenPoolIds),
      name: group.displayName,
      description: group.description,
      modelKeys,
      buckets,
    });
  }

  // Fallback: the quota summary is subscription-gated, so free-tier accounts get no groups at
  // all. Derive pools from the per-model catalog instead when nothing usable came back.
  if (pools.length === 0 && usage.models.length > 0) {
    const geminiModels = usage.models.filter(
      (m) => m.modelId.startsWith("gemini") && m.remainingFraction !== undefined,
    );
    const claudeGptModels = usage.models.filter(
      (m) =>
        (m.modelId.startsWith("claude") || m.modelId.startsWith("gpt")) &&
        m.remainingFraction !== undefined,
    );

    const refGemini = geminiModels[0];
    if (refGemini) {
      const remFraction = refGemini.remainingFraction ?? 1.0;
      const remaining = Math.round(remFraction * 100);
      const used = Math.max(0, 100 - remaining);
      let resetsAt: number | undefined;
      if (refGemini.resetTime) {
        const ts = Date.parse(refGemini.resetTime);
        if (Number.isFinite(ts)) resetsAt = ts;
      }
      pools.push({
        id: "gemini",
        name: "Gemini Models",
        modelKeys: ["gemini"],
        buckets: [
          {
            id: "gemini-shared",
            label: "Gemini Pool",
            // Per-model quotaInfo carries a remaining fraction and the next reset, not a
            // window, so do not claim a 5h session the backend never reported.
            period: "total",
            used,
            remaining,
            unit: "percent",
            resetsAt,
            isPrimary: true,
          },
        ],
      });
    }

    const refClaudeGpt = claudeGptModels[0];
    if (refClaudeGpt) {
      const remFraction = refClaudeGpt.remainingFraction ?? 1.0;
      const remaining = Math.round(remFraction * 100);
      const used = Math.max(0, 100 - remaining);
      let resetsAt: number | undefined;
      if (refClaudeGpt.resetTime) {
        const ts = Date.parse(refClaudeGpt.resetTime);
        if (Number.isFinite(ts)) resetsAt = ts;
      }
      pools.push({
        id: "claude-gpt",
        name: "Claude & GPT Models",
        modelKeys: ["claude", "gpt"],
        buckets: [
          {
            id: "claude-gpt-shared",
            label: "Claude & GPT Pool",
            period: "total",
            used,
            remaining,
            unit: "percent",
            resetsAt,
            isPrimary: true,
          },
        ],
      });
    }
  }

  const metrics: UsageMetric[] = [];
  const planLabel = usage.planLabel || usage.paidTier?.name || usage.productTier?.name;
  if (planLabel) {
    metrics.push({
      id: "plan-tier",
      label: "Plan",
      value: planLabel,
    });
  }
  if (usage.defaultAgentModelId) {
    metrics.push({
      id: "default-model",
      label: "Default Model",
      value: usage.defaultAgentModelId,
    });
  }

  // Report a quota failure rather than a "ready" account that renders nothing.
  const hasBuckets = pools.some((p) => p.buckets.length > 0);
  const isError = !hasBuckets && Boolean(usage.quotaSummaryError);
  const status: AccountStatus = isError ? "error" : "ready";
  const errorMessage = isError ? usage.quotaSummaryError : undefined;

  return {
    id: usage.projectId || "antigravity-active",
    name: "Account",
    // Masked: the dashboard renders this verbatim, and this repo already masks account
    // emails on other surfaces (maskEmail in utils/security.ts).
    email: maskEmail(usage.email),
    status,
    errorMessage,
    isActive: true,
    lastUpdated: usage.fetchedAt || Date.now(),
    pools,
    metrics,
  };
}

export function createAntigravityUsageAdapter(): UsageProviderAdapter {
  async function getAccounts(ctx: ExtensionContext): Promise<UsageAccount[]> {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      return [
        {
          id: "antigravity-default",
          name: "Google Antigravity",
          status: "auth-required",
          errorMessage: "No usable Antigravity credentials. Run /login antigravity to sign in again.",
          pools: [],
          lastUpdated: Date.now(),
        },
      ];
    }

    try {
      // Detached bag: this runs on the footer/dashboard poll, so its failures must not
      // become the `lastError` that /antigravity.doctor reports for the last model request.
      const usage = await runWithDetachedDiagnostics(() => fetchAccountUsage(apiKey));
      return [convertUsageToAccount(usage)];
    } catch (err) {
      return [
        {
          id: "antigravity-error",
          name: "Google Antigravity",
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          pools: [],
          lastUpdated: Date.now(),
        },
      ];
    }
  }

  return {
    id: PROVIDER_ID,
    displayName: "Google Antigravity",
    getAccounts,
    // Closure rather than `this.getAccounts`: the registry calls adapters as methods today,
    // but a detached reference must not break the refresh path.
    refresh: (ctx: ExtensionContext) => getAccounts(ctx),
  };
}

/**
 * Whether the `pi-usage-core` extension is loaded in this process.
 *
 * The core installs `globalThis.__PI_USAGE__` while its extension factory runs, so a lazy
 * check is required: extension load order between the two packages is not guaranteed, and
 * this package must stay usable without the core (`pi-usage-core` is a devDependency that
 * supplies types only, never a runtime import).
 */
export function isUsageCoreAvailable(): boolean {
  return typeof globalThis.__PI_USAGE__?.register === "function";
}

export function registerAntigravityUsageAdapter(pi: ExtensionAPI): UsageProviderAdapter {
  const adapter = createAntigravityUsageAdapter();

  pi.events.emit("pi-usage:register", adapter);

  pi.events.on("pi-usage:discover", () => {
    pi.events.emit("pi-usage:register", adapter);
  });

  if (globalThis.__PI_USAGE__?.register) {
    globalThis.__PI_USAGE__.register(adapter);
  }

  pi.on("session_start", () => {
    pi.events.emit("pi-usage:register", adapter);
  });

  return adapter;
}
