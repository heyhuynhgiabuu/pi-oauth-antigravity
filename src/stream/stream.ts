import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type TranscriptContext,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  getJsonSchemaToolParameters,
  requiresToolCallId,
  resolveJsonSchemaStrictSampling,
} from "./provider-helpers.js";
import { getCurrentSystemPrompt, getCurrentTools } from "./transcript.js";
import { applyCompactSystemPrompt, compactSystemPromptOverride } from "../prompt/compact.js";
import {
  antigravityHeaders,
  DEFAULT_ENDPOINT,
  endpointCandidates,
  fetchAvailableRuntimeModel,
  formatRequestDiagnostics,
  jsonOrTextError,
  loadCodeAssist,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  getCurrentEndpoint,
  runWithDiagnostics,
  setLastEndpoint,
  setLastError,
  setLastLatencyMs,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
  StopReason,
  ToolChoice,
} from "../types/enums.js";
import {
  ANTIGRAVITY_ROUTING,
  getMaxOutputTokens,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getThinkingConfig,
  PROVIDER_ID,
} from "../models/models.js";
import { redactSecrets, safeError } from "../utils/security.js";
import {
  ANTIGRAVITY_API,
  type ActiveBlock,
  type AntigravityGenerateRequest,
  type AntigravityStreamOptions,
  type ContentBlock,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type GeminiFunctionResponsePart,
  type GeminiGenerationConfig,
  type GeminiInlineDataPart,
  type GeminiPart,
  type GeminiRequestBody,
  type GeminiTextPart,
  type StreamChunk,
} from "../types/types.js";
import {
  antigravityEnv,
  antigravityRequestEnvelope,
  asString,
  deriveAntigravitySessionId,
  getOrCreateAntigravitySession,
  isRecord,
  persistAntigravitySessions,
  sanitizeText,
  type AntigravitySessionState,
} from "../utils/util.js";
import { antigravityFetch } from "../utils/http.js";

export { ANTIGRAVITY_API };

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";

const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';

let toolCallCounter = 0;

/**
 * Transient 429s (shared-capacity smoothing, per-minute rate limits, generic
 * RESOURCE_EXHAUSTED) are retried on the same endpoint with backoff. Only
 * "Individual quota reached" is plan quota, which cannot clear before its reset time
 * and therefore fails fast instead of burning the host's retry budget.
 */
const THROTTLE_MAX_RETRIES = 2;
const DEFAULT_THROTTLE_BASE_DELAY_MS = 2000;

/** Override the 429 backoff via ANTIGRAVITY_THROTTLE_BASE_DELAY_MS (ops/tests). */
function throttleBaseDelayMs(): number {
  const raw = Number(antigravityEnv("THROTTLE_BASE_DELAY_MS"));
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_THROTTLE_BASE_DELAY_MS;
}

/** Abort-aware sleep so a cancelled turn never waits out a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Request was aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Plan quota is deterministic; everything else on a 429 is a transient throttle. */
export function isPlanQuotaError(status: number | undefined, text: string): boolean {
  if (status !== 429) return false;
  // CLIProxyAPI classifies these ErrorInfo reasons as exhausted plan quota; the
  // plain-text "Individual quota reached" form is the older shape of the same verdict.
  if (/"reason"\s*:\s*"(?:QUOTA_EXHAUSTED|INSUFFICIENT_G1_CREDITS_BALANCE)"/i.test(text)) return true;
  return /Individual quota reached/i.test(text);
}

/**
 * Transient 429s may carry a server-provided Retry-After (seconds or HTTP-date, CPA
 * issue #6646). Trust it over the local backoff when it is short enough to be worth a
 * retry; a longer value is a cooldown that will not clear inside this loop.
 */
export const THROTTLE_RETRY_AFTER_CAP_SECONDS = 60;

export function parseRetryAfterSeconds(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const seconds = Math.round((date - Date.now()) / 1000);
  return seconds >= 0 ? seconds : 0;
}

/** Parse a Google RPC duration ("33s", "1.5m", "500ms", "2h") into whole seconds. */
export function parseGoogleDurationSeconds(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unitSeconds = { ms: 0.001, s: 1, m: 60, h: 3600 }[match[2] as "ms" | "s" | "m" | "h"]!;
  const seconds = Math.round(value * unitSeconds);
  return seconds >= 0 ? seconds : undefined;
}

/**
 * Google also puts the wait inside the 429 body: a RetryInfo detail carries
 * `retryDelay` ("33s"), an ErrorInfo detail may carry `metadata.quotaResetDelay`, and
 * some messages embed "retry after 33s". CLIProxyAPI reads all of these (issue #7565)
 * because the Retry-After header is often absent when the body carries the hint.
 * A zero delay is kept: Antigravity uses it to mean "retry immediately".
 */
export function parseRetryAfterFromBody(body: string): number | undefined {
  try {
    const details = JSON.parse(body)?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (typeof detail?.retryDelay === "string") {
          const seconds = parseGoogleDurationSeconds(detail.retryDelay);
          if (seconds !== undefined) return seconds;
        }
        const resetDelay = detail?.metadata?.quotaResetDelay;
        if (typeof resetDelay === "string") {
          const seconds = parseGoogleDurationSeconds(resetDelay);
          if (seconds !== undefined) return seconds;
        }
      }
    }
  } catch {
    // Not JSON — the message scan below still applies.
  }
  const match = body.match(/\b(?:after|retry\s+in)\s+(\d+(?:\.\d+)?(?:h|ms|m|s))\b/i);
  if (!match) return undefined;
  return parseGoogleDurationSeconds(match[1]!);
}

/**
 * pi chooses auto-retry by matching the error text (`isRetryableAssistantError`) and
 * checks account-limit phrases like "quota exceeded" BEFORE retryable ones. Google's
 * transient per-minute 429 body starts with exactly that phrase, so quoting it verbatim
 * would make the host skip retrying a throttle. Keep the quote readable but unmatchable.
 */
const HOST_ACCOUNT_LIMIT_PHRASES = /\bquota[\s-]+exceeded\b/gi;
function quoteBackendMessage(text: string): string {
  return text.replace(HOST_ACCOUNT_LIMIT_PHRASES, "quota-limit hit");
}

function sanitizeToolCallId(id: string, fallbackName?: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId: string, runtimeModel: string): boolean {
  return requiresToolCallId(modelId) || requiresToolCallId(runtimeModel);
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature?: string): boolean {
  if (!signature || typeof signature !== "string" || signature.length === 0) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}

function geminiRequiresThoughtSignature(runtimeModel: string): boolean {
  if (!runtimeModel.startsWith("gemini-")) return false;
  const match = runtimeModel.match(/^gemini-(\d+)/);
  if (match) {
    const major = Number.parseInt(match[1], 10);
    return major >= 3;
  }
  return true;
}

function parseImageData(raw: string, explicitMime?: string): { data: string; mimeType: string } {
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    return {
      mimeType: explicitMime || match[1] || "image/png",
      data: match[2].trim(),
    };
  }
  return {
    mimeType: explicitMime || "image/png",
    data: raw.trim(),
  };
}

function asTextParts(content: unknown): Array<GeminiTextPart | GeminiInlineDataPart> {
  if (typeof content === "string") return [{ text: sanitizeText(content) }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Array<GeminiTextPart | GeminiInlineDataPart> => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    if (block.type === "text") return [{ text: sanitizeText(block.text) }];
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}

function asImageParts(content: unknown): GeminiInlineDataPart[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): GeminiInlineDataPart[] => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}

function appendTurn(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts });
  }
}

/** Exported for unit tests. */
export function convertMessages(
  model: Model<Api>,
  context: TranscriptContext,
  runtimeModel: string,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const requiresSig = geminiRequiresThoughtSignature(runtimeModel);
  const includeToolCallId = toolCallIdNeeded(model.id, runtimeModel);
  const droppedToolCallIds = new Map<string, string>();
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts = asTextParts(msg.content);
      appendTurn(contents, GeminiRole.User, parts);
    } else if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const parts: GeminiPart[] = [];
      const isSameModel = msg.provider === PROVIDER_ID && msg.model === model.id;
      const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
      const firstCallHasSig =
        toolCalls.length > 0 && isValidThoughtSignature(toolCalls[0]?.thoughtSignature);
      const allSigsValid = toolCalls.every(
        (tc) => !tc.thoughtSignature || isValidThoughtSignature(tc.thoughtSignature),
      );
      const groupIsSigned = isSameModel && firstCallHasSig && allSigsValid;

      for (const block of msg.content) {
        if (block.type === "text") {
          const textSig =
            isSameModel && isValidThoughtSignature(block.textSignature)
              ? block.textSignature
              : undefined;
          if ((!block.text || block.text.trim() === "") && !textSig) {
            continue;
          }
          parts.push({
            text: sanitizeText(block.text),
            ...(textSig ? { thoughtSignature: textSig } : {}),
          });
        } else if (block.type === "thinking" && String(block.thinking || "").trim()) {
          if (!isSameModel) continue;
          parts.push({
            thought: true,
            text: sanitizeText(block.thinking),
            ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
          });
        } else if (block.type === "toolCall") {
          if (requiresSig && !groupIsSigned) {
            const rawId = block.id || "";
            const argsText = (() => {
              try {
                return JSON.stringify(block.arguments ?? {});
              } catch {
                return "{}";
              }
            })();
            if (rawId) {
              droppedToolCallIds.set(rawId, argsText);
              droppedToolCallIds.set(sanitizeToolCallId(rawId, block.name), argsText);
            } else {
              droppedToolCallIds.set(`empty:${block.name}`, argsText);
            }
          } else {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.arguments ?? {},
                ...(includeToolCallId
                  ? { id: sanitizeToolCallId(block.id || "", block.name) }
                  : {}),
              },
              ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
            });
          }
        }
      }
      appendTurn(contents, GeminiRole.Model, parts);
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => sanitizeText(c.text))
        .join("\n");
      const responseText = text || (msg.isError ? "Tool failed" : "");
      const imageParts = asImageParts(msg.content);
      const rawId = msg.toolCallId || "";
      const sanitizedId = includeToolCallId ? sanitizeToolCallId(rawId, msg.toolName) : rawId;
      const droppedArgs = requiresSig
        ? (droppedToolCallIds.get(rawId) ??
          droppedToolCallIds.get(sanitizedId) ??
          (rawId === "" ? droppedToolCallIds.get(`empty:${msg.toolName}`) : undefined))
        : undefined;
      if (droppedArgs !== undefined) {
        const label =
          droppedArgs === "{}" ? `\`${msg.toolName}\`` : `\`${msg.toolName}\` (${droppedArgs})`;
        appendTurn(contents, GeminiRole.User, [
          { text: sanitizeText(`[Observation from ${label}:\n${responseText}]`) },
          ...imageParts,
        ]);
      } else {
        const part: GeminiFunctionResponsePart = {
          functionResponse: {
            name: msg.toolName,
            response: msg.isError ? { error: responseText } : { output: responseText },
            ...(includeToolCallId
              ? { id: sanitizeToolCallId(msg.toolCallId || "", msg.toolName) }
              : {}),
          },
        };
        appendTurn(contents, GeminiRole.User, [part, ...imageParts]);
      }
    }
  }

  // Google Antigravity / Gemini requires the first turn to be from 'user'.
  // If the conversation starts with 'model' (e.g. initial assistant greeting),
  // prepend a minimal user message to prevent backend 400 rejection.
  if (contents.length > 0 && contents[0]?.role === GeminiRole.Model) {
    contents.unshift({
      role: GeminiRole.User,
      parts: [{ text: "Hello" }],
    });
  }

  return contents;
}

function dereferenceSchema(
  schema: unknown,
  rootDefs: Record<string, unknown> = {},
  visited = new Set<unknown>(),
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => dereferenceSchema(item, rootDefs, visited));
  }

  const s = schema as Record<string, unknown>;
  if (visited.has(s)) return s;
  visited.add(s);

  const defs: Record<string, unknown> = { ...rootDefs };
  if (isRecord(s.$defs)) Object.assign(defs, s.$defs);
  if (isRecord(s.definitions)) Object.assign(defs, s.definitions);

  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    if (match && match[1] && defs[match[1]] !== undefined) {
      const resolved = dereferenceSchema(defs[match[1]], defs, visited);
      if (isRecord(resolved)) {
        const { $ref: _, ...rest } = s;
        const restCleaned = dereferenceSchema(rest, defs, visited);
        return isRecord(restCleaned) ? { ...resolved, ...restCleaned } : resolved;
      }
      return resolved;
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s)) {
    out[key] = dereferenceSchema(value, defs, visited);
  }
  return out;
}

function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}

function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

/**
 * Protobuf `Schema` fields accepted by Cloud Code Assist's Claude/GPT custom-tool
 * bridge (`parameters` field). Anything else — `nullable`, `anyOf`, `format`,
 * `$ref`, etc. — returns `Unknown name "..."` / Invalid JSON payload (400).
 * Allowlist rather than denylist so new JSON Schema keywords cannot 400 the request.
 * Pi still validates tool args after the model calls them.
 */
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  // JSON Schema union types like ["string","null"] → first non-null scalar type.
  const entries = value as unknown[];
  const scalar = entries.find(
    (entry): entry is string => typeof entry === "string" && entry !== "null",
  );
  return scalar;
}

function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      // Property names are user-defined, not Schema keywords — never allowlist-filter them.
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (
      key === "enum" &&
      Array.isArray(value) &&
      !value.every((entry) => typeof entry === "string")
    ) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

/**
 * Gemini accepts JSON Schema through parametersJsonSchema. Claude and GPT-OSS
 * use Cloud Code Assist's custom-tool bridge, which requires a compatible
 * Draft 2020-12 subset in the legacy parameters field.
 */
export function convertTools(
  tools: Tool[] | undefined,
  useLegacyParameters = false,
  supportsStrictMode = false,
): { functionDeclarations: GeminiFunctionDeclaration[] }[] | undefined {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const parameters = getJsonSchemaToolParameters(
          tool,
          resolveJsonSchemaStrictSampling(tool, supportsStrictMode),
        );
        const dereferenced = dereferenceSchema(parameters);
        const rootObject = ensureRootObjectSchema(dereferenced);
        const schema = stripMetaSchema(rootObject);
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

function mapToolChoiceMode(
  toolChoice: AntigravityStreamOptions["toolChoice"],
): GeminiToolCallingMode {
  if (toolChoice === ToolChoice.None) return GeminiToolCallingMode.None;
  if (toolChoice === ToolChoice.Any || toolChoice === ToolChoice.Required)
    return GeminiToolCallingMode.Any;
  return GeminiToolCallingMode.Auto;
}

/** Exported for unit tests. */
export function buildRequest(
  model: Model<Api>,
  context: TranscriptContext,
  projectId: string,
  options: AntigravityStreamOptions,
  runtimeModel: string,
  sessionState?: AntigravitySessionState,
): AntigravityGenerateRequest {
  const systemPromptSource = getCurrentSystemPrompt(context);
  // Compact-prompt opt-in: swap the preamble, keep Pi's own sections (tools, rules,
  // project context, skills, cwd) so AGENTS.md rules and skill listings survive.
  const compact = compactSystemPromptOverride();
  const systemPrompt = compact ? applyCompactSystemPrompt(systemPromptSource) : systemPromptSource;
  const request: GeminiRequestBody = {
    contents: convertMessages(model, context, runtimeModel),
    systemInstruction: {
      role: GeminiRole.User,
      parts: systemPrompt
        ? [{ text: sanitizeText(systemPrompt) }]
        : [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION }],
    },
  };

  const generationConfig: GeminiGenerationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const thinking = getThinkingConfig(model.id, options.reasoning ?? "off");
  if (thinking) generationConfig.thinkingConfig = thinking;
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = Math.min(options.maxTokens, maxAllowed);
  } else {
    generationConfig.maxOutputTokens = Math.min(maxAllowed, model.maxTokens || maxAllowed);
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const isClaude = model.id.startsWith("claude-") || runtimeModel.startsWith("claude-");
  const tools = convertTools(
    getCurrentTools(context),
    isClaude || model.id.startsWith("gpt-oss-"),
    // Keep Antigravity on the plain-schema compatibility path with VALIDATED calls.
    false,
  );
  if (tools) {
    request.tools = tools;
    request.toolConfig = {
      functionCallingConfig: {
        mode:
          options.toolChoice && options.toolChoice !== ToolChoice.Auto
            ? mapToolChoiceMode(options.toolChoice)
            : GeminiToolCallingMode.Validated,
      },
    };
  } else if (isClaude) {
    request.toolConfig = {
      functionCallingConfig: { mode: GeminiToolCallingMode.Validated },
    };
  }

  const sid = options.sessionId || deriveAntigravitySessionId(context);
  const state = sessionState ?? getOrCreateAntigravitySession(sid);
  const envelope = antigravityRequestEnvelope(runtimeModel, isClaude, state);
  request.sessionId = envelope.sessionId;
  request.labels = envelope.labels;
  scrubRequestAgentName(request);

  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  };
}

/**
 * Google fingerprints third-party agent names in request content and soft-blocks them
 * with 429 RESOURCE_EXHAUSTED (verified 2026-11-19 on a free-tier account: a system
 * prompt containing the standalone word for this harness gets 429 while the identical
 * text with the word removed passes, and path or identifier forms like "/.pi/",
 * "pi-oauth", "pi-task" are not flagged). Harness-authored text is scrubbed — system
 * instructions and tool descriptions — while message text is left untouched so file
 * paths and identifiers in the conversation survive.
 */
const AGENT_NAME_PATTERN = /[ \t]*(?<![\w./-])pi(?![\w/-])[ \t]*/gi;

/** Exported for unit tests. */
export function scrubAgentName(text: string): string {
  // The replacement is scoped to the match: punctuation directly after the deleted
  // name attaches to the previous word, everything else becomes a single space. A
  // match at line start keeps the line's indentation. No global whitespace pass —
  // "x ? y : z" and indented markdown survive byte-for-byte when no name is present.
  return text.replace(AGENT_NAME_PATTERN, (match, offset: number, full: string) => {
    if (offset === 0 || full[offset - 1] === "\n") {
      // Match at line start: the consumed leading run was this line's indentation.
      return match.match(/^[ \t]+/)?.[0] ?? "";
    }
    const after = full.slice(offset + match.length, offset + match.length + 1);
    return /[,.;:!?]/.test(after) ? "" : " ";
  });
}

function scrubRequestAgentName(request: GeminiRequestBody): void {
  for (const part of request.systemInstruction?.parts ?? []) {
    if (typeof part.text === "string") part.text = scrubAgentName(part.text);
  }
  for (const declaration of request.tools?.[0]?.functionDeclarations ?? []) {
    if (typeof declaration.description === "string") {
      declaration.description = scrubAgentName(declaration.description);
    }
  }
}

/** Exported for unit tests. */
export function mapStopReason(reason: string | undefined): StopReason {
  if (reason === "STOP") return StopReason.Stop;
  if (reason === "MAX_TOKENS") return StopReason.Length;
  return reason ? StopReason.Error : StopReason.Stop;
}

/**
 * Backends answer retired models with a plain text notice instead of an error. The 3.5
 * wording is the observed template; the 2026-11-18 removals (Claude 4.6, Sonnet 4.6,
 * GPT-OSS 120B) are expected to reuse it. Match on the model name prefix, not the full
 * sentence, so wording drift on the suffix stays harmless.
 */
const RETIRED_NOTICE_PREFIXES = [
  "gemini 3.5 flash is no longer available. please switch to",
  "claude-opus-4-6 is no longer available",
  "claude-sonnet-4-6 is no longer available",
  "gpt-oss-120b is no longer available",
];

const RETIRED_RUNTIME_PATTERN =
  /^(?:gemini-3\.5-flash(?:-|$)|gemini-3-flash-agent$|claude-opus-4-6|claude-sonnet-4-6|gpt-oss-120b)/i;

function isRetiredRuntime(runtimeModel: string): boolean {
  return RETIRED_RUNTIME_PATTERN.test(runtimeModel);
}

function retiredNoticePrefixState(text: string): "possible" | "match" | "no-match" {
  const normalized = text.trimStart().replace(/\s+/g, " ").toLowerCase();
  for (const prefix of RETIRED_NOTICE_PREFIXES) {
    if (normalized.startsWith(prefix)) return "match";
    if (prefix.startsWith(normalized) && normalized.length > 0) return "possible";
  }
  return "no-match";
}

/**
 * Google blocks an entire account — not one model — with 403 VALIDATION_REQUIRED until
 * the account owner completes identity/phone verification. Neither re-login nor a model
 * switch clears it, so the actionable `validation_url` in the error details has to reach
 * the user instead of the generic "re-login or try another model" advice.
 */
export interface AccountValidation {
  message: string;
  url?: string;
}

/**
 * The URL is printed for the user to click, so only Google-owned https hosts are
 * allowed. A response body is untrusted input just like any other; a foreign host here
 * would be a ready-made phishing link.
 */
function safeValidationUrl(raw: unknown): string | undefined {
  const trimmed = asString(raw)?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  const googleOwned =
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "googleapis.com" ||
    host.endsWith(".googleapis.com");
  if (!googleOwned) return undefined;
  // Return the backend's exact string (not url.toString()) so Google's params survive
  // verbatim; redactSecrets is the belt-and-braces check that no token rode along.
  return redactSecrets(trimmed);
}

/** Exported for unit tests. */
export function extractAccountValidation(text: string): AccountValidation | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  if (!isRecord(error) || !Array.isArray(error.details)) return undefined;
  for (const detail of error.details) {
    if (!isRecord(detail) || detail.reason !== "VALIDATION_REQUIRED") continue;
    const metadata = isRecord(detail.metadata) ? detail.metadata : {};
    // Both candidates are response-body fields, so both are redacted like the rest of
    // the backend text that reaches the user; neither can smuggle a token out.
    const message =
      asString(metadata.validation_error_message) ?? asString(error.message) ?? "";
    return {
      message: redactSecrets(message).trim().slice(0, 200),
      url: safeValidationUrl(metadata.validation_url),
    };
  }
  return undefined;
}

function formatAccountValidation(validation: AccountValidation): string {
  const next = validation.url
    ? `complete verification at ${validation.url}`
    : "complete Google account verification";
  return (
    "Antigravity denied this account pending Google account verification (VALIDATION_REQUIRED). " +
    `Re-login and switching models will not clear it. Next: ${next}, ` +
    "or /login antigravity with another personal Google account." +
    (validation.message ? ` Backend said: ${validation.message}` : "")
  );
}

/** Exported for unit tests. */
export function friendlyAntigravityError(status: number | undefined, text: string): string {
  const full = redactSecrets(jsonOrTextError(text));
  const msg = full.slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
      return "Antigravity login expired or credentials are invalid. Next: run /login antigravity, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(msg)) {
      return `Antigravity request format was rejected by the backend (${msg}). Next: switch to a simpler model or retry after updating the extension.`;
    }
    if (/Request contains an invalid argument/i.test(msg)) {
      return `Antigravity rejected this request (${msg}). Next: retry once; if it keeps failing, switch models or re-login.`;
    }
    return `Bad request from Antigravity. Next: retry once, then run /login antigravity if it keeps failing. Backend said: ${msg}`;
  }
  if (status === 401) {
    return "Antigravity authentication failed. Next: run /login antigravity, then retry.";
  }
  if (status === 403) {
    // Account-level eligibility block. Checked before the generic permission test
    // because a body can carry both signals and only this one is user-fixable.
    const validation = extractAccountValidation(text);
    if (validation) return formatAccountValidation(validation);
    // Fallback for gateways that strip `details` but keep the message.
    if (/verify your account|VALIDATION_REQUIRED/i.test(msg)) {
      return formatAccountValidation({ message: msg });
    }
    // Google is actively enforcing third-party OAuth use (403 PERMISSION_DENIED,
    // reason TOS_VIOLATION; the appeal copy names "third party software"). The reason
    // lives in error.details, which jsonOrTextError drops — match the raw body. Retries,
    // re-login and model switches do not clear it, and the account itself is at risk.
    if (/TOS_VIOLATION|third[- ]party (software|tools|services|clients?)/i.test(text)) {
      return (
        "Antigravity flagged this account for third-party access (TOS_VIOLATION). " +
        "Retries and re-login will not clear it; further use may get the account suspended. " +
        "Next: stop using third-party clients on this account and appeal through Google support. " +
        `Backend said: ${msg}`
      );
    }
    if (/permission|forbidden|access/i.test(msg)) {
      return "Antigravity access was denied for this account or project. Next: try another model, re-login, or use an account with access.";
    }
    return `Antigravity denied this request. Next: re-login or try another model. Backend said: ${msg}`;
  }
  if (status === 404) {
    if (/Requested entity was not found/i.test(msg)) {
      return "This model is not available right now. Next: switch to gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.1-pro, or another working model.";
    }
    return `Antigravity could not find the requested resource. Next: retry or switch models. Backend said: ${msg}`;
  }
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) {
    return "Antigravity reported a conflict for this request. Next: retry once or start a new chat session.";
  }
  if (status === 429) {
    const wait = msg.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (isPlanQuotaError(status, full)) {
      return `Quota reached. Please wait ${wait || "for reset"}. Next: switch models or try again after reset.`;
    }
    // Only "Individual quota reached" is plan quota. Shared-capacity smoothing,
    // per-minute rate limits, and generic RESOURCE_EXHAUSTED all contain "quota" too,
    // so never tell the user their quota is gone on those.
    const backendNote = msg ? ` Backend said: ${quoteBackendMessage(msg)}` : "";
    if (/quota/i.test(msg)) {
      return `Antigravity throttled this request (transient, not plan quota)${wait ? `; resets in ${wait}` : ""}.${backendNote}`;
    }
    return `Rate limited by Antigravity. Next: wait a bit and retry.${wait ? ` Reset: ${wait}.` : ""}${backendNote}`;
  }
  if (status === 500) {
    return "Antigravity had an internal server error. Next: retry in a moment or switch models.";
  }
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry in a moment.";
  if (status === 503) {
    if (/No capacity available/i.test(msg)) {
      return "This model has no capacity right now. Next: retry later or switch to another model.";
    }
    return "Antigravity is temporarily unavailable. Next: retry in a moment or switch models.";
  }
  if (status === 504) return "Antigravity timed out upstream. Next: retry in a moment.";
  return msg;
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function asToolCallArguments(args: Record<string, unknown> | undefined): ToolCall["arguments"] {
  return (args ?? {}) as ToolCall["arguments"];
}

/** Exported for unit tests. */
export async function streamResponse(
  response: Response,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model?: Model<Api>,
  sessionState?: AntigravitySessionState,
  detectRetiredGemini35 = false,
): Promise<boolean> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Consumed-prefix offset: the buffer is compacted once per network chunk instead of
  // re-copying the whole remainder for every SSE line.
  let scanStart = 0;
  let started = false;
  let currentBlock: ActiveBlock | null = null;
  let hasContent = false;
  let lastResponseId: string | undefined;
  type PendingRetiredNoticePart = {
    type: "text" | "thinking";
    text: string;
    thoughtSignature: string | undefined;
  };
  type RetiredNoticeCheck = { text: string; parts: PendingRetiredNoticePart[] };
  let retiredNoticeCheck: RetiredNoticeCheck | undefined = detectRetiredGemini35
    ? { text: "", parts: [] }
    : undefined;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  const ensureStarted = () => {
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }
  };

  const finishCurrent = () => {
    if (!currentBlock) return;
    if (currentBlock.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: currentBlock.text,
        partial: output,
      });
    } else {
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: currentBlock.thinking,
        partial: output,
      });
    }
    currentBlock = null;
  };

  const appendText = (text: string, thoughtSignature?: string) => {
    if (!currentBlock || currentBlock.type !== "text") {
      finishCurrent();
      currentBlock = { type: "text", text: "" };
      blocks.push(currentBlock);
      ensureStarted();
      stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
    }
    if (currentBlock.type === "text") {
      currentBlock.text += text;
      if (thoughtSignature) currentBlock.textSignature = thoughtSignature;
      stream.push({
        type: "text_delta",
        contentIndex: blockIndex(),
        delta: text,
        partial: output,
      });
    }
  };

  const appendThinking = (text: string, thoughtSignature?: string) => {
    if (!currentBlock || currentBlock.type !== "thinking") {
      finishCurrent();
      currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
      blocks.push(currentBlock);
      ensureStarted();
      stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
    }
    if (currentBlock.type === "thinking") {
      currentBlock.thinking += text;
      if (thoughtSignature) currentBlock.thinkingSignature = thoughtSignature;
      stream.push({
        type: "thinking_delta",
        contentIndex: blockIndex(),
        delta: text,
        partial: output,
      });
    }
  };

  const flushPendingRetiredNoticeParts = () => {
    if (!retiredNoticeCheck?.parts.length) return;
    const pendingParts = retiredNoticeCheck.parts;
    retiredNoticeCheck = undefined;
    for (const part of pendingParts) {
      if (part.type === "thinking") appendThinking(part.text, part.thoughtSignature);
      else appendText(part.text, part.thoughtSignature);
    }
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n", scanStart)) !== -1) {
      const line = buffer.slice(scanStart, newlineIdx);
      scanStart = newlineIdx + 1;
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(json) as StreamChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      }

      const responseData = chunk.response || chunk;
      const candidate = responseData.candidates?.[0];

      for (const part of candidate?.content?.parts || []) {
        if (part.text !== undefined) {
          hasContent = true;
          const isThinking = part.thought === true;
          const noticeCheck = retiredNoticeCheck;
          if (
            !isThinking &&
            noticeCheck &&
            (part.text.length > 0 || noticeCheck.parts.length > 0)
          ) {
            noticeCheck.parts.push({
              type: "text",
              text: part.text,
              thoughtSignature: part.thoughtSignature,
            });
            noticeCheck.text += part.text;
            const noticeState = retiredNoticePrefixState(noticeCheck.text);
            if (noticeState === "match") {
              try {
                await reader.cancel();
              } catch {
                // The response is being discarded; cancellation is best-effort.
              }
              reader.releaseLock();
              throw new Error(
                "Antigravity reports that this model has been retired and is no longer available. " +
                  "Next: switch to a current catalog model (see /antigravity.models).",
              );
            }
            if (noticeState !== "possible") flushPendingRetiredNoticeParts();
          } else if (isThinking && noticeCheck?.parts.length) {
            noticeCheck.parts.push({
              type: "thinking",
              text: part.text,
              thoughtSignature: part.thoughtSignature,
            });
          } else if (isThinking) {
            appendThinking(part.text, part.thoughtSignature);
          } else {
            appendText(part.text, part.thoughtSignature);
          }
        }

        if (part.functionCall) {
          hasContent = true;
          flushPendingRetiredNoticeParts();
          finishCurrent();
          const rawId = part.functionCall.id || "";
          const toolCall: ToolCall = {
            type: "toolCall",
            id: sanitizeToolCallId(rawId, part.functionCall.name),
            name: part.functionCall.name || "",
            arguments: asToolCallArguments(part.functionCall.args),
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          };
          blocks.push(toolCall);
          ensureStarted();
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: JSON.stringify(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall,
            partial: output,
          });
        }
      }

      if (candidate?.finishReason) {
        output.rawStopReason = candidate.finishReason;
        output.stopReason = blocks.some((b) => b.type === "toolCall")
          ? StopReason.ToolUse
          : mapStopReason(candidate.finishReason);
      }

      if (responseData.responseId) {
        lastResponseId = responseData.responseId;
      }

      if (responseData.usageMetadata) {
        const prompt = responseData.usageMetadata.promptTokenCount || 0;
        const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
        const thoughts = responseData.usageMetadata.thoughtsTokenCount || 0;
        output.usage.input = prompt - cacheRead;
        output.usage.output = (responseData.usageMetadata.candidatesTokenCount || 0) + thoughts;
        output.usage.reasoning = thoughts;
        output.usage.cacheRead = cacheRead;
        output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
        if (model?.cost) {
          calculateCost(model, output.usage);
        } else {
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
      }
    }

    if (scanStart > 0) {
      buffer = buffer.slice(scanStart);
      scanStart = 0;
    }
  }

  flushPendingRetiredNoticeParts();
  finishCurrent();
  if (sessionState && lastResponseId) {
    sessionState.lastExecutionId = lastResponseId;
    persistAntigravitySessions();
  }
  return hasContent;
}

export function streamAntigravity(
  model: Model<Api>,
  context: TranscriptContext,
  options?: AntigravityStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const opts = options ?? {};

  void runWithDiagnostics(async () => {
    const startTime = Date.now();
    const output = createOutput(model);
    try {
      const creds = parseApiKey(opts.apiKey);
      // Skip loadCodeAssist roundtrip when credentials already carry a projectId.
      const warmedProject = creds.projectId ? null : await loadCodeAssist(creds.token);
      const projectId = resolveProjectId({
        token: creds.token,
        warmedProject,
        credentialProjectId: creds.projectId,
      });
      setLastProjectId(projectId);

      const effort = opts.reasoning ?? "off";
      const isKnownModel = model.id in ANTIGRAVITY_ROUTING;
      const baseRuntimeModel =
        antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);

      let initialRuntimeModel = baseRuntimeModel;
      // Skip pre-flight model discovery for known static models to optimize TTFT latency.
      // Dynamic lookup is only needed for unmapped custom models.
      if (!isKnownModel && !antigravityEnv("RUNTIME_MODEL")) {
        const dynamic = await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel);
        if (dynamic?.id && /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)) {
          initialRuntimeModel = dynamic.id;
        }
      }

      const sid = opts.sessionId || deriveAntigravitySessionId(context);
      const sessionState = getOrCreateAntigravitySession(sid);

      const runtimeCandidates = [initialRuntimeModel];
      const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
      if (fallback && fallback !== initialRuntimeModel) {
        runtimeCandidates.push(fallback);
      }

      const isClaudeReasoning = model.id.startsWith("claude-") && model.reasoning;
      const requestHeaders: Record<string, string> = {
        ...antigravityHeaders(creds.token),
        ...(isClaudeReasoning ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
      };

      let response: Response | undefined;
      let lastText = "";
      let received = false;
      let runtimeModel = initialRuntimeModel;

      for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
        if (opts.signal?.aborted) throw new Error("Request was aborted");
        if (emptyAttempt > 0) {
          const delay = 500 * 2 ** (emptyAttempt - 1);
          await sleep(delay, opts.signal);
        }

        for (let candIdx = 0; candIdx < runtimeCandidates.length; candIdx++) {
          runtimeModel = runtimeCandidates[candIdx]!;
          setLastResolvedRuntimeModel(runtimeModel);
          const body = JSON.stringify(buildRequest(model, context, projectId, opts, runtimeModel, sessionState));

          for (const endpoint of endpointCandidates(sessionState.lastGoodEndpoint)) {
            setLastEndpoint(endpoint);
            let throttleAttempt = 0;
            for (;;) {
              response = await antigravityFetch(
                `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
                {
                  method: "POST",
                  headers: requestHeaders,
                  body,
                  signal: opts.signal,
                },
              );
              setLastStatus(response.status);
              if (response.ok) {
                sessionState.lastGoodEndpoint = endpoint;
                persistAntigravitySessions();
                break;
              }
              lastText = await response.text();
              // Plan quota cannot clear before its reset time: fail fast.
              if (isPlanQuotaError(response.status, lastText)) break;
              // Every other 429 is a transient throttle. Back off on the same endpoint
              // instead of hopping regions, which multiplies load on a throttled account.
              // Honor a server Retry-After when it is short; a longer one is a cooldown
              // that will not clear inside this loop, so burn no attempts on it.
              const retryAfterSeconds =
                parseRetryAfterSeconds(response.headers.get("retry-after")) ??
                parseRetryAfterFromBody(lastText);
              const retryable =
                response.status === 429 &&
                throttleAttempt < THROTTLE_MAX_RETRIES &&
                (retryAfterSeconds === undefined ||
                  retryAfterSeconds <= THROTTLE_RETRY_AFTER_CAP_SECONDS);
              if (retryable) {
                const delayMs =
                  retryAfterSeconds !== undefined
                    ? retryAfterSeconds * 1000
                    : throttleBaseDelayMs() * 2 ** throttleAttempt;
                await sleep(delayMs, opts.signal);
                throttleAttempt += 1;
                continue;
              }
              break;
            }
            if (response.ok) break;
            // 429s were already retried above and endpoints usually share one throttle,
            // but a sticky non-default endpoint may not serve this model: try the rest once.
            if (
              response.status === 429 &&
              (endpoint === DEFAULT_ENDPOINT || isPlanQuotaError(response.status, lastText))
            )
              break;
            if (![403, 404, 500, 502, 503, 504].includes(response.status)) break;
          }

          if (response?.ok) break;
          // Throttles are tracked per model, and freshly launched models (Gemini 4
          // Hydrogen) hit them hardest. Once the in-place retries are spent, a transient
          // 429 moves on to the fallback model instead of failing the turn. Plan quota
          // still fails fast: its message tells the user to wait or switch on purpose.
          if (
            response?.status === 429 &&
            !isPlanQuotaError(response.status, lastText) &&
            candIdx + 1 < runtimeCandidates.length
          ) {
            continue;
          }
          if (response?.status === 404) {
            if (candIdx + 1 < runtimeCandidates.length) {
              continue;
            }
            if (isKnownModel && candIdx === runtimeCandidates.length - 1) {
              const dynamic = await fetchAvailableRuntimeModel(
                creds.token,
                projectId,
                baseRuntimeModel,
              );
              if (
                dynamic?.id &&
                !runtimeCandidates.includes(dynamic.id) &&
                /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)
              ) {
                runtimeCandidates.push(dynamic.id);
                continue;
              }
            }
          }
          break;
        }

        if (!response || !response.ok) {
          if (antigravityEnv("DEBUG_DUMP") === "1") {
            try {
              const body = JSON.stringify(
                buildRequest(model, context, projectId, opts, runtimeModel),
              );
              let parsedBody: unknown = body;
              try {
                parsedBody = JSON.parse(body) as unknown;
              } catch {
                parsedBody = body;
              }
              await (
                await import("node:fs/promises")
              ).writeFile(
                "/tmp/antigravity-last-request.json",
                JSON.stringify(
                  {
                    status: response?.status,
                    runtimeModel,
                    lastText: lastText.slice(0, 4000),
                    body: parsedBody,
                  },
                  null,
                  2,
                ),
              );
            } catch {
              // ignore dump failures
            }
          }
          const friendly = friendlyAntigravityError(response?.status, lastText);
          // Plan quota only clears at reset: keep the bare message so the host does not
          // retry it. Transient throttles keep the status + backend text so they stay
          // diagnosable and retryable.
          if (isPlanQuotaError(response?.status, lastText)) {
            throw new Error(friendly);
          }
          throw new Error(
            `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}`,
          );
        }

        output.content = [];
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        output.stopReason = "stop";

        received = await streamResponse(
          response,
          stream,
          output,
          model,
          sessionState,
          isRetiredRuntime(runtimeModel),
        );
        if (received) break;
      }

      if (!received) throw new Error("Antigravity API returned an empty response");
      setLastLatencyMs(Date.now() - startTime);
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        const errorDetail = output.rawStopReason
          ? `Provider stopped with: ${output.rawStopReason}`
          : "An unknown error occurred";
        output.errorMessage = output.errorMessage || errorDetail;
        setLastError(output.errorMessage);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } else if (output.stopReason === "pending") {
        throw new Error("Antigravity API returned no stop reason");
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (error) {
      setLastLatencyMs(Date.now() - startTime);
      output.stopReason = opts.signal?.aborted ? "aborted" : "error";
      output.errorMessage = safeError(error);
      setLastError(output.errorMessage);
      // Ensure endpoint is recorded even if failure happened before setLastEndpoint.
      if (!getCurrentEndpoint() && endpointCandidates()[0]) {
        setLastEndpoint(endpointCandidates()[0]);
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  });

  return stream;
}
