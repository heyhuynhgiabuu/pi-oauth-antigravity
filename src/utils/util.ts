import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ANTIGRAVITY_MODEL_ENUM } from "../models/models.js";

export function antigravityEnv(name: string): string | undefined {
  return process.env[`ANTIGRAVITY_${name}`] || process.env[`NOAGY_${name}`];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// Replace only unpaired UTF-16 surrogates so valid emoji / astral-plane pairs survive intact.
const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeText(text: unknown): string {
  return String(text ?? "").replace(UNPAIRED_SURROGATE_RE, "\uFFFD");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const INT63_MASK = (1n << 63n) - 1n;

function formatSignedDecimalSessionId(value: bigint): string {
  return `-${(value & INT63_MASK).toString()}`;
}

export function deriveSignedDecimalFromHash(text: string): string {
  const digest = createHash("sha256").update(text).digest();
  return formatSignedDecimalSessionId(digest.readBigUInt64BE(0));
}

export function randomSignedDecimalSessionId(): string {
  return formatSignedDecimalSessionId(randomBytes(8).readBigUInt64BE(0));
}

export function getFirstUserTextForAntigravitySession(context?: {
  messages?: Array<{ role: string; content?: unknown }>;
}): string | undefined {
  for (const message of context?.messages ?? []) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (typeof item === "object" && item !== null && (item as { type?: string }).type === "text") {
          return (item as { text: string }).text;
        }
      }
    }
  }
  return undefined;
}

export function deriveAntigravitySessionId(context?: {
  messages?: Array<{ role: string; content?: unknown }>;
}): string {
  const text = getFirstUserTextForAntigravitySession(context)?.trim();
  return text ? deriveSignedDecimalFromHash(text) : randomSignedDecimalSessionId();
}

export interface AntigravitySessionState {
  agentId: string;
  trajectoryId: string;
  sessionId: string;
  stepIndex: number;
  lastExecutionId?: string;
  lastGoodEndpoint?: string;
  lastUsedAt: number;
}

const sessionStates = new Map<string, AntigravitySessionState>();
const MAX_SESSIONS = 200;
let sessionsLoaded = false;

function getSessionsFilePath(): string {
  const envPath = antigravityEnv("SESSIONS_FILE");
  if (envPath) return envPath;
  const agentCache = join(homedir(), ".pi", "agent", "cache");
  if (existsSync(join(homedir(), ".pi", "agent"))) {
    return join(agentCache, "antigravity-sessions.json");
  }
  return join(homedir(), ".pi", "cache", "antigravity-sessions.json");
}

function loadPersistedSessions(): void {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    const file = getSessionsFilePath();
    if (!existsSync(file)) return;
    const content = readFileSync(file, "utf8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === "object" && typeof item.sessionId === "string") {
          sessionStates.set(item.sessionId, item);
        }
      }
    }
  } catch {
    // Ignore corrupt or unreadable cache file
  }
}

export function persistAntigravitySessions(): void {
  try {
    const file = getSessionsFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const data = [...sessionStates.values()];
    writeFileSync(file, JSON.stringify(data), "utf8");
  } catch {
    // Ignore write errors
  }
}

/** Reset in-memory cache and load state to simulate a fresh process restart. */
export function resetAntigravitySessionMemory(): void {
  sessionStates.clear();
  sessionsLoaded = false;
}

export function clearAntigravitySessions(): void {
  sessionStates.clear();
  sessionsLoaded = true;
  try {
    const file = getSessionsFilePath();
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Ignore error
  }
}

export function getOrCreateAntigravitySession(sessionId: string): AntigravitySessionState {
  loadPersistedSessions();
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      agentId: randomUUID(),
      trajectoryId: randomUUID(),
      sessionId,
      stepIndex: 1,
      lastUsedAt: Date.now(),
    };
  } else {
    state.stepIndex += 1;
    state.lastUsedAt = Date.now();
    sessionStates.delete(sessionId);
  }
  sessionStates.set(sessionId, state);
  while (sessionStates.size > MAX_SESSIONS) {
    const oldest = sessionStates.keys().next().value;
    if (!oldest) break;
    sessionStates.delete(oldest);
  }
  persistAntigravitySessions();
  return state;
}

export function nowRequestId(): string {
  return antigravityRequestEnvelope("unknown", false).requestId;
}

export function antigravityRequestEnvelope(
  wireModelId: string,
  isClaude: boolean,
  state?: AntigravitySessionState,
): { requestId: string; sessionId: string; labels: Record<string, string> } {
  const agentId = state?.agentId ?? randomUUID();
  const trajectoryId = state?.trajectoryId ?? randomUUID();
  const step = state?.stepIndex ?? 2;
  const sessionId = state?.sessionId ?? randomSignedDecimalSessionId();
  const usageLabel = isClaude ? "true" : "false";
  const labels: Record<string, string> = {
    last_step_index: String(step - 1),
    trajectory_id: trajectoryId,
    used_claude: usageLabel,
    used_claude_conservative: usageLabel,
  };
  if (state?.lastExecutionId) {
    labels.last_execution_id = state.lastExecutionId;
  }
  const modelEnum = ANTIGRAVITY_MODEL_ENUM[wireModelId];
  if (modelEnum) labels.model_enum = modelEnum;
  return {
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    sessionId,
    labels,
  };
}
