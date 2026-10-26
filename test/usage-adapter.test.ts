import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertUsageToAccount,
  createAntigravityUsageAdapter,
  registerAntigravityUsageAdapter,
} from "../src/usage/adapter.js";
import { resolveApiKeyFromContext } from "../src/usage/usage.js";
import type { AccountUsage } from "../src/types/types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

test("convertUsageToAccount maps quota groups into UsageModelPools and primary buckets", () => {
  const usage: AccountUsage = {
    projectId: "proj-123",
    endpoint: "https://cloudcode-pa.googleapis.com",
    email: "dev@example.com",
    productTier: { name: "Standard" },
    paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
    planLabel: "Google AI Pro (g1-pro-tier)",
    groups: [
      {
        displayName: "Gemini Models",
        description: "Shared pool for Gemini models",
        buckets: [
          {
            bucketId: "gemini-5h",
            displayName: "Session (5h)",
            remainingFraction: 0.75,
            resetTime: "2026-03-30T16:00:00Z",
            window: "FIVE_HOURS",
          },
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Quota",
            remainingFraction: 0.9,
            resetTime: "2026-04-05T00:00:00Z",
            window: "WEEKLY",
          },
        ],
      },
      {
        displayName: "Claude & GPT Models",
        description: "Shared pool for Claude & GPT",
        buckets: [
          {
            bucketId: "claude-5h",
            displayName: "Session (5h)",
            remainingFraction: 0.4,
            resetTime: "2026-03-30T17:30:00Z",
          },
        ],
      },
    ],
    models: [],
    defaultAgentModelId: "gemini-3.8-flash",
    fetchedAt: 1700000000000,
  };

  const account = convertUsageToAccount(usage);

  assert.equal(account.id, "proj-123");
  assert.equal(account.name, "Account");
  // Email is masked before it reaches the dashboard, which renders it verbatim; assert on the
  // property (masked, not the raw value) rather than on maskEmail's exact format.
  assert.ok(account.email);
  assert.notEqual(account.email, "dev@example.com");
  assert.ok(account.email?.endsWith("@example.com"));
  assert.equal(account.status, "ready");
  assert.equal(account.isActive, true);
  assert.equal(account.pools.length, 2);

  // Gemini Pool
  const geminiPool = account.pools.find((p) => p.id === "gemini");
  assert.ok(geminiPool);
  assert.deepEqual(geminiPool.modelKeys, ["gemini"]);
  assert.equal(geminiPool.buckets.length, 2);

  const gemini5h = geminiPool.buckets.find((b) => b.id === "gemini-5h");
  assert.ok(gemini5h);
  assert.equal(gemini5h.remaining, 75);
  assert.equal(gemini5h.used, 25);
  assert.equal(gemini5h.period, "5h");
  assert.equal(gemini5h.isPrimary, true);
  assert.equal(gemini5h.resetsAt, Date.parse("2026-03-30T16:00:00Z"));

  const geminiWeekly = geminiPool.buckets.find((b) => b.id === "gemini-weekly");
  assert.ok(geminiWeekly);
  assert.equal(geminiWeekly.remaining, 90);
  assert.equal(geminiWeekly.used, 10);
  assert.equal(geminiWeekly.period, "weekly");
  assert.equal(geminiWeekly.isPrimary, false);

  // Claude & GPT Pool
  const claudePool = account.pools.find((p) => p.id === "claude-gpt");
  assert.ok(claudePool);
  assert.deepEqual(claudePool.modelKeys, ["claude", "gpt"]);
  const claude5h = claudePool.buckets[0];
  assert.ok(claude5h);
  assert.equal(claude5h.remaining, 40);
  assert.equal(claude5h.used, 60);
  assert.equal(claude5h.isPrimary, true);

  // Metrics
  assert.ok(account.metrics?.some((m) => m.id === "plan-tier" && m.value === "Google AI Pro (g1-pro-tier)"));
  assert.ok(account.metrics?.some((m) => m.id === "default-model" && m.value === "gemini-3.8-flash"));
});

test("convertUsageToAccount synthesizes pools from models when quota groups are empty (e.g. Free Tier)", () => {
  const usage: AccountUsage = {
    projectId: "free-proj",
    endpoint: "https://cloudcode-pa.googleapis.com",
    groups: [],
    quotaSummaryError: "403 SUBSCRIPTION_REQUIRED",
    models: [
      {
        modelId: "gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        remainingFraction: 0.8,
        resetTime: "2026-03-30T18:00:00Z",
      },
      {
        modelId: "claude-sonnet-4-6",
        displayName: "Claude Sonnet",
        remainingFraction: 0.5,
        resetTime: "2026-03-30T19:00:00Z",
      },
    ],
    fetchedAt: 1700000000000,
  };

  const account = convertUsageToAccount(usage);
  assert.equal(account.id, "free-proj");
  assert.equal(account.pools.length, 2);

  const gemini = account.pools.find((p) => p.id === "gemini");
  assert.ok(gemini);
  assert.equal(gemini.buckets[0]?.remaining, 80);
  assert.equal(gemini.buckets[0]?.used, 20);
  assert.equal(gemini.buckets[0]?.isPrimary, true);

  const claude = account.pools.find((p) => p.id === "claude-gpt");
  assert.ok(claude);
  assert.equal(claude.buckets[0]?.remaining, 50);
  assert.equal(claude.buckets[0]?.used, 50);
  assert.equal(claude.buckets[0]?.isPrimary, true);
});

test("convertUsageToAccount preserves quotaSummaryError and sets status to error when pools are empty", () => {
  const usage: AccountUsage = {
    projectId: "failed-proj",
    endpoint: "https://cloudcode-pa.googleapis.com",
    groups: [],
    quotaSummaryError: "403 SUBSCRIPTION_REQUIRED",
    models: [],
    fetchedAt: 1700000000000,
  };

  const account = convertUsageToAccount(usage);
  assert.equal(account.id, "failed-proj");
  assert.equal(account.status, "error");
  assert.equal(account.errorMessage, "403 SUBSCRIPTION_REQUIRED");
  assert.equal(account.pools.length, 0);
});

test("createAntigravityUsageAdapter returns auth-required when no credentials exist", async () => {
  const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  try {
    const adapter = createAntigravityUsageAdapter();
    assert.equal(adapter.id, "antigravity");
    assert.equal(adapter.displayName, "Google Antigravity");

    const mockCtx = {
      modelRegistry: {
        getApiKeyForProvider: async () => undefined,
      },
    } as unknown as ExtensionContext;

    const accounts = await adapter.getAccounts(mockCtx);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.status, "auth-required");
    assert.match(accounts[0]?.errorMessage ?? "", /Run \/login antigravity/);
  } finally {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});

test("resolveApiKeyFromContext rejects expired tokens from auth.json", async () => {
  const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  try {
    const mockCtx = {
      modelRegistry: {
        getApiKeyForProvider: async () => undefined,
      },
    } as unknown as ExtensionContext;

    // 1. Expired token in auth.json
    writeFileSync(
      join(tmpAgentDir, "auth.json"),
      JSON.stringify({
        antigravity: {
          access: "expired-token",
          projectId: "test-proj",
          expires: Date.now() - 60000,
        },
      }),
      "utf-8",
    );

    const expiredKey = await resolveApiKeyFromContext(mockCtx);
    assert.equal(expiredKey, undefined);

    // 2. Valid (unexpired) token in auth.json
    writeFileSync(
      join(tmpAgentDir, "auth.json"),
      JSON.stringify({
        antigravity: {
          access: "valid-token",
          projectId: "test-proj",
          expires: Date.now() + 3600000,
          email: "valid@example.com",
        },
      }),
      "utf-8",
    );

    const validKey = await resolveApiKeyFromContext(mockCtx);
    assert.ok(validKey);
    const parsed = JSON.parse(validKey as string);
    assert.equal(parsed.token, "valid-token");
    assert.equal(parsed.projectId, "test-proj");
    assert.equal(parsed.email, "valid@example.com");

    // 3. Token without a stored expiry is still usable (only known-expired tokens are rejected).
    writeFileSync(
      join(tmpAgentDir, "auth.json"),
      JSON.stringify({ antigravity: { access: "no-expiry-token", projectId: "test-proj" } }),
      "utf-8",
    );
    const noExpiryKey = await resolveApiKeyFromContext(mockCtx);
    assert.ok(noExpiryKey);
    assert.equal((JSON.parse(noExpiryKey as string) as { token: string }).token, "no-expiry-token");
  } finally {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});

test("registerAntigravityUsageAdapter registers on event bus, discover, and global bridge", () => {
  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const eventListeners = new Map<string, Array<(data: unknown) => void>>();
  const lifecycleListeners = new Map<string, Array<() => void>>();

  const mockPi = {
    events: {
      emit: (name: string, data: unknown) => {
        emittedEvents.push({ name, data });
      },
      on: (name: string, cb: (data: unknown) => void) => {
        const list = eventListeners.get(name) || [];
        list.push(cb);
        eventListeners.set(name, list);
        return () => {};
      },
    },
    on: (event: string, cb: () => void) => {
      const list = lifecycleListeners.get(event) || [];
      list.push(cb);
      lifecycleListeners.set(event, list);
    },
  } as unknown as ExtensionAPI;

  let globalRegistered = false;
  globalThis.__PI_USAGE__ = {
    register: () => {
      globalRegistered = true;
    },
    getAdapters: () => [],
  };

  const adapter = registerAntigravityUsageAdapter(mockPi);
  assert.equal(adapter.id, "antigravity");

  // Initial emit on bus
  assert.equal(emittedEvents.some((e) => e.name === "pi-usage:register" && e.data === adapter), true);

  // Global bridge registered
  assert.equal(globalRegistered, true);

  // Discovery callback emits register again
  const discoverHandlers = eventListeners.get("pi-usage:discover") || [];
  assert.equal(discoverHandlers.length, 1);
  const beforeCount = emittedEvents.length;
  discoverHandlers[0]?.(undefined);
  assert.equal(emittedEvents.length, beforeCount + 1);

  // session_start callback emits register again
  const sessionStartHandlers = lifecycleListeners.get("session_start") || [];
  assert.equal(sessionStartHandlers.length, 1);
  sessionStartHandlers[0]?.();
  assert.equal(emittedEvents.length, beforeCount + 2);

  // Cleanup
  delete (globalThis as Record<string, unknown>).__PI_USAGE__;
});

test("convertUsageToAccount maps wire windows to the matching footer period", () => {
  const usage: AccountUsage = {
    projectId: "p",
    endpoint: "https://example.invalid",
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "s", displayName: "Session", window: "FIVE_HOURS", remainingFraction: 0.5 },
          { bucketId: "s2", displayName: "Session (5h)", remainingFraction: 0.5 },
          { bucketId: "d", displayName: "Daily", remainingFraction: 0.4 },
          { bucketId: "w", displayName: "Weekly Quota", window: "WEEKLY", remainingFraction: 0.9 },
          { bucketId: "m", displayName: "Monthly", window: "MONTHLY", remainingFraction: 0.2 },
          { bucketId: "u", displayName: "Mystery", window: "SOMETHING_ELSE", remainingFraction: 0.1 },
        ],
      },
    ],
    models: [],
    fetchedAt: 1,
  };

  const periods = convertUsageToAccount(usage).pools[0]?.buckets.map((b) => [b.label, b.period]);
  assert.deepEqual(periods, [
    ["Session", "5h"],
    // Labels without `window` still resolve, e.g. "Session (5h)".
    ["Session (5h)", "5h"],
    ["Daily", "daily"],
    ["Weekly Quota", "weekly"],
    ["Monthly", "monthly"],
    // Unknown windows stay undefined so the footer falls back to the label.
    ["Mystery", undefined],
  ]);
});

test("convertUsageToAccount lets an explicit window win over a rolling label detail", () => {
  const usage: AccountUsage = {
    projectId: "p",
    endpoint: "https://example.invalid",
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "w", displayName: "Weekly (rolling 5h)", window: "WEEKLY", remainingFraction: 0.9 },
          { bucketId: "d", displayName: "Session (5h)", window: "DAILY", remainingFraction: 0.4 },
          // Underscore-separated windows must not defeat word boundaries.
          { bucketId: "r", displayName: "Rolling", window: "ROLLING_5_HOURS", remainingFraction: 0.3 },
        ],
      },
    ],
    models: [],
    fetchedAt: 1,
  };

  const periods = convertUsageToAccount(usage).pools[0]?.buckets.map((b) => b.period);
  assert.deepEqual(periods, ["weekly", "daily", "5h"]);
});

test("convertUsageToAccount keeps pool ids unique when groups share a family", () => {
  const usage: AccountUsage = {
    projectId: "p",
    endpoint: "https://example.invalid",
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [{ bucketId: "a", displayName: "Session (5h)", remainingFraction: 0.5 }],
      },
      {
        displayName: "Gemini Flash",
        buckets: [{ bucketId: "b", displayName: "Session (5h)", remainingFraction: 0.5 }],
      },
    ],
    models: [],
    fetchedAt: 1,
  };

  const ids = convertUsageToAccount(usage).pools.map((p) => p.id);
  assert.deepEqual(ids, ["gemini", "gemini-2"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("convertUsageToAccount falls back to models when the only group has no usable buckets", () => {
  const usage: AccountUsage = {
    projectId: "p",
    endpoint: "https://example.invalid",
    // A named group survives parseQuotaSummary even when every bucket was filtered out.
    groups: [{ displayName: "Gemini Models", buckets: [] }],
    models: [{ modelId: "gemini-3.8-flash", remainingFraction: 0.8 }],
    fetchedAt: 1,
  };

  const account = convertUsageToAccount(usage);
  assert.equal(account.pools.length, 1);
  assert.equal(account.pools[0]?.id, "gemini");
  assert.equal(account.pools[0]?.buckets[0]?.remaining, 80);
  assert.equal(account.status, "ready");
});

test("convertUsageToAccount reports error when no buckets can be built at all", () => {
  const usage: AccountUsage = {
    projectId: "p",
    endpoint: "https://example.invalid",
    groups: [{ displayName: "Gemini Models", buckets: [] }],
    quotaSummaryError: "403 SUBSCRIPTION_REQUIRED",
    models: [],
    fetchedAt: 1,
  };

  const account = convertUsageToAccount(usage);
  assert.equal(account.pools.length, 0);
  assert.equal(account.status, "error");
  assert.equal(account.errorMessage, "403 SUBSCRIPTION_REQUIRED");
});

test("isUsageCoreAvailable tracks the global bridge", async () => {
  const { isUsageCoreAvailable } = await import("../src/usage/adapter.js");
  delete (globalThis as Record<string, unknown>).__PI_USAGE__;
  assert.equal(isUsageCoreAvailable(), false);

  globalThis.__PI_USAGE__ = { register: () => {}, getAdapters: () => [] };
  assert.equal(isUsageCoreAvailable(), true);

  delete (globalThis as Record<string, unknown>).__PI_USAGE__;
});

test("a usage poll does not overwrite the diagnostics /antigravity.doctor reports", async () => {
  const { getLastDiagnostics, runWithDiagnostics, resetDiagnosticsForTests } = await import(
    "../src/diagnostics/diagnostics.js"
  );
  resetDiagnosticsForTests();
  // Stub fetch so the poll never leaves the process; a 403 makes every endpoint report a
  // status and an error, which is exactly the signal that must not leak into the snapshot.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "403 SUBSCRIPTION_REQUIRED" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    // Stand in for the last model request, which records what doctor must keep reporting.
    await runWithDiagnostics(async () => {
      const { setLastStatus, setLastError } = await import("../src/diagnostics/diagnostics.js");
      setLastStatus(200);
      setLastError(undefined);
    });
    const before = getLastDiagnostics();
    assert.equal(before.status, 200);

    // A background usage poll that fails on the subscription-gated quota RPC.
    const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-usage-diag-"));
    const prevEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
    try {
      writeFileSync(
        join(tmpAgentDir, "auth.json"),
        JSON.stringify({
          antigravity: {
            access: "tok",
            projectId: "proj",
            expires: Date.now() + 3_600_000,
          },
        }),
        "utf-8",
      );
      const adapter = createAntigravityUsageAdapter();
      const ctx = {
        modelRegistry: { getApiKeyForProvider: async () => undefined },
      } as unknown as ExtensionContext;
      await adapter.getAccounts(ctx);
    } finally {
      if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevEnv;
      rmSync(tmpAgentDir, { recursive: true, force: true });
    }

    const after = getLastDiagnostics();
    assert.equal(after.status, before.status);
    assert.equal(after.error, before.error);
    assert.equal(after.endpoint, before.endpoint);
    assert.equal(after.projectId, before.projectId);
  } finally {
    globalThis.fetch = originalFetch;
    resetDiagnosticsForTests();
  }
});

test("convertUsageToAccount drops only the bucket-less groups when others carry data", () => {
  const usage: AccountUsage = {
    projectId: "p",
    endpoint: "https://example.invalid",
    groups: [
      { displayName: "Gemini Models", buckets: [] },
      {
        displayName: "Claude & GPT Models",
        buckets: [{ bucketId: "c", displayName: "Session (5h)", remainingFraction: 0.6 }],
      },
    ],
    models: [{ modelId: "gemini-3.8-flash", remainingFraction: 0.2 }],
    fetchedAt: 1,
  };

  const account = convertUsageToAccount(usage);
  // The empty Gemini group is dropped, and the models fallback does NOT overwrite real data.
  assert.deepEqual(account.pools.map((p) => p.id), ["claude-gpt"]);
  assert.equal(account.pools[0]?.buckets[0]?.remaining, 60);
  assert.equal(account.status, "ready");
});

test("a dropped empty group does not consume a pool id", () => {
  const usage: AccountUsage = {
    projectId: "p",
    endpoint: "https://example.invalid",
    groups: [
      { displayName: "Gemini Models", buckets: [] },
      {
        displayName: "Gemini Flash",
        buckets: [{ bucketId: "b", displayName: "Session (5h)", remainingFraction: 0.5 }],
      },
    ],
    models: [],
    fetchedAt: 1,
  };

  // The surviving Gemini group must keep the plain "gemini" id, not "gemini-2".
  assert.deepEqual(
    convertUsageToAccount(usage).pools.map((p) => p.id),
    ["gemini"],
  );
});

test("free-tier synthesized buckets do not claim a 5h window the backend never sent", () => {
  const usage: AccountUsage = {
    projectId: "free",
    endpoint: "https://example.invalid",
    groups: [],
    quotaSummaryError: "403 SUBSCRIPTION_REQUIRED",
    models: [
      { modelId: "gemini-3.8-flash", remainingFraction: 0.7, resetTime: "2026-03-30T18:00:00Z" },
      { modelId: "claude-sonnet-4-6", remainingFraction: 0.4 },
    ],
    fetchedAt: 1,
  };

  const periods = convertUsageToAccount(usage).pools.map((p) => p.buckets[0]?.period);
  assert.deepEqual(periods, ["total", "total"]);
});

test("refresh works when the adapter method is detached from the object", async () => {
  const tmpAgentDir = mkdtempSync(join(tmpdir(), "pi-usage-detached-"));
  const prevEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
  try {
    const { refresh } = createAntigravityUsageAdapter();
    const ctx = {
      modelRegistry: { getApiKeyForProvider: async () => undefined },
    } as unknown as ExtensionContext;
    // No credentials in this dir, so the auth-required path is returned without any network.
    const accounts = await refresh(ctx);
    assert.equal(accounts[0]?.status, "auth-required");
  } finally {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevEnv;
    rmSync(tmpAgentDir, { recursive: true, force: true });
  }
});
