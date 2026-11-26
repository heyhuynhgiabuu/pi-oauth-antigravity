import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANTIGRAVITY_MODELS,
	ANTIGRAVITY_ROUTING,
	PROVIDER_ID,
	getAntigravityRequestModelId,
	getFallbackRuntimeModel,
	getMaxOutputTokens,
	getThinkingConfig,
} from "../src/models/models.js";
import {
	ANTIGRAVITY_API,
	buildRequest,
	convertMessages,
	convertTools,
	friendlyAntigravityError,
	extractAccountValidation,
	isPlanQuotaError,
	mapStopReason,
	parseGoogleDurationSeconds,
	parseRetryAfterFromBody,
	parseRetryAfterSeconds,
	scrubAgentName,
	streamAntigravity,
	streamResponse,
} from "../src/stream/stream.js";
import {
	DEFAULT_ENDPOINT,
	ENDPOINT_FALLBACKS,
	antigravityHeaders,
	defaultProjectId,
	endpointCandidates,
	extractProjectId,
	isUsableRuntimeModelId,
	jsonOrTextError,
	parseApiKey,
	resolveProjectId,
	stableProjectId,
} from "../src/client/client.js";
import {
	assertSafeApiBaseUrl,
	maskEmail,
	redactSecrets,
	resolveCallbackHost,
} from "../src/utils/security.js";
import {
	antigravityRequestEnvelope,
	clearAntigravitySessions,
	deriveAntigravitySessionId,
	getOrCreateAntigravitySession,
	persistAntigravitySessions,
	resetAntigravitySessionMemory,
	sanitizeText,
} from "../src/utils/util.js";
import {
	applyCompactSystemPrompt,
	COMPACT_SYSTEM_PROMPT,
	compactSystemPromptOverride,
	replaceSystemPreamble,
} from "../src/prompt/compact.js";
import { getApiKey } from "../src/auth/index.js";
import {
	assertSafeAspectRatio,
	assertSafeImageModel,
	DEFAULT_IMAGE_MODEL,
	generateAntigravityImage,
	parseImageCommandArgs,
	resolveImageSavePath,
} from "../src/image/image.js";
import { getCurrentSystemPrompt, getCurrentTools } from "../src/stream/transcript.js";
import { createAssistantMessageEventStream, isRetryableAssistantError, normalizeContext, Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";

const testTempDir = mkdtempSync(join(tmpdir(), "pi-oauth-antigravity-test-"));
const testSessionFile = join(testTempDir, "antigravity-sessions.json");
process.env.ANTIGRAVITY_SESSIONS_FILE = testSessionFile;
after(() => rmSync(testTempDir, { recursive: true, force: true }));

function fakeModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		contextWindow: 1_048_576,
		maxTokens: 65536,
	} as unknown as Model<Api>;
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
	const prev = process.env[name];
	try {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		fn();
	} finally {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	}
}

async function withEnvAsync(
	env: Record<string, string | undefined>,
	fn: () => Promise<void>,
): Promise<void> {
	const prev = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(env)) {
		prev.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		await fn();
	} finally {
		for (const [name, value] of prev) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** Stub global fetch and record every request URL. */
async function withFetchStub(
	respond: (url: string, call: number, init?: RequestInit) => Response,
	fn: (calls: string[]) => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		return respond(url, calls.length, init);
	}) as typeof fetch;
	try {
		await fn(calls);
	} finally {
		globalThis.fetch = original;
	}
}

const STREAM_OK_SSE =
	'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n';

function streamResponseOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		model: "gemini-3.5-flash",
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
	} as AssistantMessage;
}

function retirementSse(parts: unknown[], finishReason?: string): string {
	const candidate: Record<string, unknown> = { content: { parts } };
	if (finishReason) candidate.finishReason = finishReason;
	return `data: ${JSON.stringify({ response: { candidates: [candidate] } })}\n\n`;
}

function openRetirementNoticeResponse(onCancel: () => void): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					retirementSse([{ text: "Gemini 3.5 Flash is no longer available. Please switch to" }]),
				),
			);
		},
		cancel() {
			onCancel();
		},
	});
	return new Response(body);
}

function errorResponse(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: { code: status, message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** One `streamAntigravity` turn against stubbed fetch, resolving the final message. */
async function streamAntigravityOnce(
	sessionId = "-4242424242",
	signal?: AbortSignal,
	modelId = "gemini-3.8-flash",
): Promise<{ stopReason: string; errorMessage?: string }> {
	const stream = streamAntigravity(
		fakeModel(modelId),
		normalizeContext({
			systemPrompt: "You are pi.",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		} as never),
		{
			apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
			sessionId,
			reasoning: "high",
			signal,
		} as never,
	);
	return (await stream.result()) as { stopReason: string; errorMessage?: string };
}

test("transcript adapter supports legacy contexts without a transcript subpath", () => {
	const tool: Tool = {
		name: "lookup",
		description: "Look up a value",
		parameters: Type.Object({}),
	};
	const legacyMessages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }];

	assert.equal(
		getCurrentSystemPrompt({
			systemPrompt: "legacy prompt",
			messages: legacyMessages,
			tools: [tool],
		}),
		"legacy prompt",
	);
	assert.deepEqual(
		getCurrentTools({
			systemPrompt: "legacy prompt",
			messages: legacyMessages,
			tools: [tool],
		}),
		[tool],
	);
});

test("transcript adapter replays normalized system deltas", () => {
	const firstTool: Tool = {
		name: "first",
		description: "First tool",
		parameters: Type.Object({}),
	};
	const secondTool: Tool = {
		name: "second",
		description: "Second tool",
		parameters: Type.Object({}),
	};
	const messages: Message[] = [
		{
			role: "system",
			content: "base",
			sections: { project: "old", removed: "gone" },
			toolsAdded: [firstTool],
			timestamp: 0,
		},
		{
			role: "system",
			content: "delta",
			sections: { project: "new", removed: null },
			toolsRemoved: [{ name: firstTool.name }],
			toolsAdded: [secondTool],
			timestamp: 1,
		},
	];

	assert.equal(getCurrentSystemPrompt({ messages }), "base\n\ndelta\n\nnew");
	assert.deepEqual(getCurrentTools({ messages }), [secondTool]);
});

/* ------------------------------- models.ts ------------------------------- */

test("model catalog registers all Claude 5.5 tiers with per-model thinking maps", () => {
	assert.equal(PROVIDER_ID, "antigravity");
	assert.equal(ANTIGRAVITY_MODELS.length, 14);
	const ids = ANTIGRAVITY_MODELS.map((m) => m.id).sort();
	assert.deepEqual(ids, [
		"claude-opus-5-5-high",
		"claude-opus-5-5-low",
		"claude-opus-5-5-medium",
		"claude-sonnet-5-5-high",
		"claude-sonnet-5-5-low",
		"claude-sonnet-5-5-medium",
		"gemini-3.1-pro",
		"gemini-3.6-flash",
		"gemini-3.7-flash",
		"gemini-3.8-flash",
		"gemini-4-argon",
		"gemini-4-carbon",
		"gemini-4-hydrogen",
		"gemini-4-neon",
	]);
	for (const model of ANTIGRAVITY_MODELS) {
		assert.ok((model as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap);
	}
	const opusMedium = ANTIGRAVITY_MODELS.find((model) => model.id === "claude-opus-5-5-medium");
	assert.ok(opusMedium);
	assert.equal(opusMedium.reasoning, true);
	const thinkingLevels = opusMedium.thinkingLevelMap as unknown as Record<string, string | null>;
	assert.equal(thinkingLevels.medium, "medium");
	assert.equal(thinkingLevels.low, null);
	assert.equal(thinkingLevels.high, null);

	for (const [family, tier] of [
		["opus", "low"],
		["opus", "medium"],
		["opus", "high"],
		["sonnet", "low"],
		["sonnet", "medium"],
		["sonnet", "high"],
	] as const) {
		const model = ANTIGRAVITY_MODELS.find((item) => item.id === `claude-${family}-5-5-${tier}`);
		assert.ok(model, `missing claude-${family}-5-5-${tier}`);
		assert.equal(model.reasoning, true);
		assert.deepEqual(model.input, ["text", "image"]);
		const levels = model.thinkingLevelMap as unknown as Record<string, string | null>;
		assert.equal(levels[tier], tier);
	}
});

test("effort routing maps public ids to backend runtime ids", () => {
	assert.equal(getAntigravityRequestModelId("gemini-3.7-flash", "off"), "gemini-3.7-flash-low");
	assert.equal(getAntigravityRequestModelId("gemini-3.7-flash", "medium"), "gemini-3.7-flash-medium");
	assert.equal(getAntigravityRequestModelId("gemini-3.7-flash", "high"), "gemini-3.7-flash-high");
	assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "off"), "gemini-3.8-flash-low");
	assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "low"), "gemini-3.8-flash-low");
	assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "medium"), "gemini-3.8-flash-medium");
	assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "high"), "gemini-3.8-flash-high");
	assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "xhigh"), "gemini-3.8-flash-high");
	assert.equal(getAntigravityRequestModelId("gemini-4-argon", "off"), "gemini-4-argon-low");
	assert.equal(getAntigravityRequestModelId("gemini-4-argon", "low"), "gemini-4-argon-low");
	assert.equal(getAntigravityRequestModelId("gemini-4-argon", "medium"), "gemini-4-argon-medium");
	assert.equal(getAntigravityRequestModelId("gemini-4-argon", "high"), "gemini-4-argon-high");
	assert.equal(getAntigravityRequestModelId("gemini-4-argon", "xhigh"), "gemini-4-argon-high");
	assert.equal(getAntigravityRequestModelId("gemini-3.5-flash", "off"), "gemini-3.5-flash");
	assert.equal(getAntigravityRequestModelId("gemini-3.5-flash", "high"), "gemini-3.5-flash");
	assert.equal(getAntigravityRequestModelId("gemini-3.1-pro", "high"), "gemini-pro-agent");
	assert.equal(getAntigravityRequestModelId("claude-sonnet-4-6", "high"), "claude-sonnet-4-6");
	// Gemini 4 family: Hydrogen is the only model with an -xhigh wire id.
	assert.equal(getAntigravityRequestModelId("gemini-4-neon", "xhigh"), "gemini-4-neon-xhigh");
	assert.equal(getAntigravityRequestModelId("gemini-4-neon", "medium"), "gemini-4-neon-medium");
	assert.equal(getAntigravityRequestModelId("gemini-4-hydrogen", "xhigh"), "gemini-4-hydrogen-xhigh");
	assert.equal(getAntigravityRequestModelId("gemini-4-hydrogen", "high"), "gemini-4-hydrogen-high");
	assert.equal(getAntigravityRequestModelId("gemini-4-carbon", "xhigh"), "gemini-4-carbon-high");
	assert.equal(getAntigravityRequestModelId("gemini-4-carbon", "medium"), "gemini-4-carbon-medium");
	assert.equal(getAntigravityRequestModelId("gpt-oss-120b", "off"), "gpt-oss-120b-medium");
	for (const [family, tier] of [
		["opus", "low"],
		["opus", "medium"],
		["opus", "high"],
		["sonnet", "low"],
		["sonnet", "medium"],
		["sonnet", "high"],
	] as const) {
		const id = `claude-${family}-5-5-${tier}`;
		assert.equal(ANTIGRAVITY_ROUTING[id]?.routing?.[tier], id);
		assert.equal(getAntigravityRequestModelId(id, tier), id);
	}
	assert.equal(getAntigravityRequestModelId("unknown-model", "high"), "unknown-model");
});

test("Claude 5.5 tier requests keep their exact runtime model ids", () => {
	for (const [family, tier] of [
		["opus", "low"],
		["opus", "medium"],
		["opus", "high"],
		["sonnet", "low"],
		["sonnet", "medium"],
		["sonnet", "high"],
	] as const) {
		const id = `claude-${family}-5-5-${tier}`;
		const model = fakeModel(id);
		const runtimeModel = getAntigravityRequestModelId(model.id, tier);
		const request = buildRequest(
			model,
			normalizeContext({
				systemPrompt: "You are pi.",
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			} as never),
			"project-1",
			{ reasoning: tier } as never,
			runtimeModel,
		);
		assert.equal(request.model, id);
		// Claude's effort tier is encoded in its runtime model ID, not Gemini thinkingConfig.
		assert.equal(request.request.generationConfig?.thinkingConfig, undefined);
	}
});

test("agent-name scrub clears harness-authored text but keeps message text", async () => {
	assert.equal(
		scrubAgentName("You are a coding assistant running inside pi, a coding agent harness."),
		"You are a coding assistant running inside, a coding agent harness.",
	);
	assert.equal(scrubAgentName("Search exact Pi session history"), "Search exact session history");
	// Path and identifier forms are the shapes Google does not flag — keep them verbatim.
	assert.equal(scrubAgentName("docs under /.pi/agent"), "docs under /.pi/agent");
	assert.equal(scrubAgentName("the pi-oauth-antigravity repo"), "the pi-oauth-antigravity repo");
	assert.equal(scrubAgentName("a pi-task subagent"), "a pi-task subagent");
	assert.equal(scrubAgentName("relative pi/agent paths"), "relative pi/agent paths");
	assert.equal(scrubAgentName("an api endpoint and pixel art"), "an api endpoint and pixel art");
	// Whitespace and indentation outside a match must survive untouched (markdown
	// nesting and indented code live in AGENTS.md context and tool descriptions).
	assert.equal(
		scrubAgentName("Run:\n  - nested item\n    code  indented"),
		"Run:\n  - nested item\n    code  indented",
	);
	assert.equal(
		scrubAgentName("Tools:\n  - read: read files (see pi docs)\n    continued  line"),
		"Tools:\n  - read: read files (see docs)\n    continued  line",
	);
	// The punctuation collapse is scoped to the deleted span: text without the harness
	// name is byte-identical (reviewer Major finding — the old global pass rewrote
	// " :"/" ?"/" ." everywhere).
	assert.equal(scrubAgentName("x ? y : z"), "x ? y : z");
	assert.equal(scrubAgentName('Note : hi . ok'), "Note : hi . ok");
	assert.equal(scrubAgentName('x = {"a" : 1}'), 'x = {"a" : 1}');
	// A name at line start keeps the line's indentation.
	assert.equal(scrubAgentName("  pi is great"), "  is great");
	assert.equal(scrubAgentName("text\n\npi\n\nmore"), "text\n\n\n\nmore");

	const model = fakeModel("gemini-3.8-flash");
	await withEnvAsync({ ANTIGRAVITY_COMPACT_PROMPT: undefined, NOAGY_COMPACT_PROMPT: undefined }, async () => {
		const built = buildRequest(
			model,
			normalizeContext({
				systemPrompt: "You are a coding assistant running inside pi, a coding agent harness.",
				messages: [{ role: "user", content: [{ type: "text", text: "look at pi-oauth-antigravity under ~/.pi" }] }],
				tools: [
					{ name: "recall", description: "Search exact Pi session history" },
					{ name: "bash", description: "Run commands via pi's shell" },
				],
			} as never),
			"project-1",
			{ reasoning: "off" } as never,
			"gemini-3.8-flash-low",
		);
		const systemText = built.request.systemInstruction.parts.map((part) => part.text).join(" ");
		assert.doesNotMatch(systemText, /\bpi\b/i);
		assert.match(systemText, /running inside, a coding agent harness/);
		const declarations = built.request.tools?.[0]?.functionDeclarations ?? [];
		assert.equal(declarations[0]?.description, "Search exact session history");
		// Deletion leaves the possessive apostrophe behind; harmless for the model.
		assert.equal(declarations[1]?.description, "Run commands via 's shell");
		// Message text keeps the user's own words, including identifier and path forms.
		const userParts = built.request.contents?.[0]?.parts ?? [];
		const userText = userParts.map((part) => (typeof part.text === "string" ? part.text : "")).join(" ");
		assert.match(userText, /pi-oauth-antigravity/);
		assert.match(userText, /\.pi/);
	});
});

test("compact-prompt override replaces the preamble and keeps Pi sections", () => {
	const rendered = "You are a coding assistant running inside pi.\n\n<tools>\n- read: Read file contents\n</tools>\n\n<project_context>\nAGENTS.md rules\n</project_context>";
	const replaced = replaceSystemPreamble(rendered, COMPACT_SYSTEM_PROMPT);
	assert.match(replaced, /^You are a senior software engineer/);
	assert.match(replaced, /<tools>\n- read: Read file contents\n<\/tools>/);
	assert.match(replaced, /<project_context>\nAGENTS.md rules\n<\/project_context>/);
	// Prompts without section tags are replaced entirely.
	assert.equal(replaceSystemPreamble("plain preamble only", COMPACT_SYSTEM_PROMPT), COMPACT_SYSTEM_PROMPT);
});

test("applyCompactSystemPrompt swaps the preamble and drops fingerprint-heavy sections", () => {
	const rendered = [
		"You are a coding assistant running inside pi.",
		"",
		"<tools>",
		"- read: Read file contents",
		"</tools>",
		"",
		"<rules>",
		"- Use bash for file operations like ls, rg, find",
		"</rules>",
		"",
		"<docs>",
		"Pi documentation (read only when the user asks about the harness itself):",
		"</docs>",
		"",
		"<project_context>",
		"AGENTS.md rules",
		"</project_context>",
		"",
		"<skills>",
		"skill listings",
		"</skills>",
		"",
		"/current/working/directory",
	].join("\n");
	const out = applyCompactSystemPrompt(rendered);
	assert.match(out, /^You are a senior software engineer/);
	assert.match(out, /<project_context>\nAGENTS.md rules\n<\/project_context>/);
	assert.match(out, /<skills>/);
	assert.doesNotMatch(out, /<docs>/);
	assert.doesNotMatch(out, /<tools>/);
	assert.doesNotMatch(out, /<rules>/);
	assert.doesNotMatch(out, /\bpi\b/i);
	assert.ok(!out.includes("\n\n\n"));
});

test("ANTIGRAVITY_COMPACT_PROMPT resolves bundled, file, and missing-path sources", async () => {
	await withEnvAsync({ ANTIGRAVITY_COMPACT_PROMPT: undefined, NOAGY_COMPACT_PROMPT: undefined }, async () => {
		assert.equal(compactSystemPromptOverride(), undefined);
	});
	await withEnvAsync({ ANTIGRAVITY_COMPACT_PROMPT: "1" }, async () => {
		assert.equal(compactSystemPromptOverride(), COMPACT_SYSTEM_PROMPT);
	});
	const file = join(tmpdir(), `ag-compact-${Date.now()}.md`);
	writeFileSync(file, "Custom compact preamble.");
	await withEnvAsync({ ANTIGRAVITY_COMPACT_PROMPT: file }, async () => {
		assert.equal(compactSystemPromptOverride(), "Custom compact preamble.");
	});
	await withEnvAsync({ ANTIGRAVITY_COMPACT_PROMPT: join(tmpdir(), "missing-compact.md") }, async () => {
		assert.equal(compactSystemPromptOverride(), COMPACT_SYSTEM_PROMPT);
	});
});

test("ANTIGRAVITY_COMPACT_PROMPT=1 mirrors the verified --system-prompt composition", async () => {
	await withEnvAsync({ ANTIGRAVITY_COMPACT_PROMPT: "1" }, async () => {
		const built = buildRequest(
			fakeModel("gemini-3.8-flash"),
			normalizeContext({
				systemPrompt: [
					"You are a coding assistant running inside pi.",
					"",
					"<tools>",
					"- read: Read file contents",
					"</tools>",
					"",
					"<rules>",
					"- Use bash for file operations like ls, rg, find",
					"</rules>",
					"",
					"<docs>",
					"Pi documentation (read only when the user asks about the harness itself):",
					"</docs>",
					"",
					"<project_context>",
					"AGENTS.md rules",
					"</project_context>",
				].join("\n"),
				messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			} as never),
			"project-1",
			{ reasoning: "off" } as never,
			"gemini-3.8-flash-low",
		);
		const parts = built.request.systemInstruction.parts
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("");
		assert.match(parts, /^You are a senior software engineer/);
		assert.match(parts, /<project_context>\nAGENTS.md rules\n<\/project_context>/);
		assert.doesNotMatch(parts, /<docs>|<tools>|<rules>/);
		assert.doesNotMatch(parts, /running inside/);
	});
});

test("fallback runtime model covers next-gen gemini only", () => {
	assert.equal(getFallbackRuntimeModel("gemini-4-neon-xhigh"), "gemini-4-hydrogen-xhigh");
	assert.equal(getFallbackRuntimeModel("gemini-4-neon-medium"), "gemini-4-hydrogen-medium");
	assert.equal(getFallbackRuntimeModel("gemini-4-neon"), "gemini-4-hydrogen-low");
	assert.equal(getFallbackRuntimeModel("gemini-4-hydrogen-xhigh"), "gemini-4-carbon-high");
	assert.equal(getFallbackRuntimeModel("gemini-4-hydrogen-high"), "gemini-4-carbon-high");
	assert.equal(getFallbackRuntimeModel("gemini-4-hydrogen"), "gemini-4-carbon-low");
	assert.equal(getFallbackRuntimeModel("gemini-4-carbon-high"), "gemini-4-argon-high");
	assert.equal(getFallbackRuntimeModel("gemini-4-carbon"), "gemini-4-argon-low");
	assert.equal(getFallbackRuntimeModel("gemini-4-argon-high"), "gemini-3.8-flash-high");
	assert.equal(getFallbackRuntimeModel("gemini-4-argon"), "gemini-3.8-flash-low");
	assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-high"), "gemini-3.7-flash-high");
	assert.equal(getFallbackRuntimeModel("gemini-3.8-flash"), "gemini-3.7-flash-low");
	assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-tiered"), "gemini-3.7-flash-low");
	assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-high"), "gemini-3.6-flash-high");
	assert.equal(getFallbackRuntimeModel("gemini-3.7-flash"), "gemini-3.6-flash-low");
	assert.equal(getFallbackRuntimeModel("claude-sonnet-4-6"), undefined);
	assert.equal(getFallbackRuntimeModel("gemini-3.5-flash-low"), undefined);
	assert.equal(getFallbackRuntimeModel("gemini-3.5-flash"), undefined);
});

test("max output tokens clamp per runtime id", () => {
	assert.equal(getMaxOutputTokens("gemini-3.7-flash", "gemini-3.7-flash-high"), 65536);
	assert.equal(getMaxOutputTokens("gemini-3.8-flash", "gemini-3.8-flash-high"), 65536);
	assert.equal(getMaxOutputTokens("gemini-3.8-flash", "gemini-3.8-flash-tiered"), 65536);
	assert.equal(getMaxOutputTokens("gemini-4-argon", "gemini-4-argon-high"), 65536);
	assert.equal(getMaxOutputTokens("claude-opus-4-6", "claude-opus-4-6-thinking"), 64000);
	assert.equal(getMaxOutputTokens("gpt-oss-120b", "gpt-oss-120b-medium"), 32768);
	assert.equal(getMaxOutputTokens("mystery", undefined), 8192);
	assert.equal(getMaxOutputTokens("mystery", "claude-x"), 64000);
});

test("thinking config per model family", () => {
	assert.deepEqual(getThinkingConfig("gemini-3.7-flash", "high"), {
		includeThoughts: true,
		thinkingLevel: "HIGH",
	});
	assert.deepEqual(getThinkingConfig("gemini-3.8-flash", "medium"), {
		includeThoughts: true,
		thinkingLevel: "MEDIUM",
	});
	assert.deepEqual(getThinkingConfig("gemini-4-argon", "high"), {
		includeThoughts: true,
		thinkingLevel: "HIGH",
	});
	// Gemini 4 family: thought summaries come back only when includeThoughts is set
	// (verified live on gemini-4-neon 2026-11-19; without it the backend returns none).
	assert.deepEqual(getThinkingConfig("gemini-4-neon", "medium"), {
		includeThoughts: true,
		thinkingLevel: "MEDIUM",
	});
	assert.deepEqual(getThinkingConfig("gemini-4-hydrogen", "xhigh"), {
		includeThoughts: true,
		thinkingLevel: "HIGH",
	});
	assert.deepEqual(getThinkingConfig("gemini-4-carbon", "low"), {
		includeThoughts: true,
		thinkingLevel: "LOW",
	});
	assert.equal(getThinkingConfig("gemini-3.5-flash", "high"), undefined);
	assert.equal(getThinkingConfig("claude-sonnet-4-6", "high"), undefined);
});

/* ------------------------------- stream.ts ------------------------------- */

test("convertMessages maps plain user/assistant turns", () => {
	const model = fakeModel("gemini-3.7-flash");
	const contents = convertMessages(
		model,
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", provider: PROVIDER_ID, model: model.id, stopReason: "stop", content: [{ type: "text", text: "hello" }] },
			],
		} as never,
		"gemini-3.7-flash-low",
	);
	assert.deepEqual(contents, [
		{ role: "user", parts: [{ text: "hi" }] },
		{ role: "model", parts: [{ text: "hello" }] },
	]);
});

test("convertMessages keeps valid same-model thought signatures", () => {
	const model = fakeModel("gemini-3.7-flash");
	const sig = "QUJDREVGR0g=";
	const contents = convertMessages(
		model,
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{
					role: "assistant",
					provider: PROVIDER_ID,
					model: model.id,
					stopReason: "stop",
					content: [{ type: "text", text: "answer", textSignature: sig }],
				},
			],
		} as never,
		"gemini-3.7-flash-low",
	);
	assert.deepEqual(contents[1]?.parts, [{ text: "answer", thoughtSignature: sig }]);
});

test("convertMessages drops foreign thinking blocks", () => {
	const contents = convertMessages(
		fakeModel("gemini-3.7-flash"),
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{
					role: "assistant",
					provider: "other",
					model: "other-model",
					stopReason: "stop",
					content: [
						{ type: "thinking", thinking: "secret", thinkingSignature: "AAAA" },
						{ type: "text", text: "visible" },
					],
				},
			],
		} as never,
		"gemini-3.7-flash-low",
	);
	assert.deepEqual(contents[1]?.parts, [{ text: "visible" }]);
});

test("convertMessages drops unsigned tool calls on gemini runtimes to user observations", () => {
	const contents = convertMessages(
		fakeModel("gemini-3.7-flash"),
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{
					role: "assistant",
					provider: PROVIDER_ID,
					model: "gemini-3.7-flash",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
				},
				{ role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }] },
			],
		} as never,
		"gemini-3.7-flash-high",
	);
	const parts = contents.flatMap((c) => c.parts);
	assert.ok(!parts.some((p) => "functionCall" in p), "unsigned tool call must not become functionCall");
	const observation = parts.find((p) => "text" in p && p.text.includes("[Observation from"));
	assert.ok(observation && "text" in observation && observation.text.includes("file body"));
});

test("convertMessages keeps Gemini 3 tool-call ids in function calls and responses", () => {
	const contents = convertMessages(
		fakeModel("gemini-3.7-flash"),
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{
					role: "assistant",
					provider: PROVIDER_ID,
					model: "gemini-3.7-flash",
					stopReason: "toolUse",
					content: [
						{
							type: "toolCall",
							id: "call|1",
							name: "read",
							arguments: { path: "a.ts" },
							thoughtSignature: "QUJDREVGR0g=",
						},
					],
				},
				{ role: "toolResult", toolCallId: "call|1", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }] },
			],
		} as never,
		"gemini-3.7-flash-high",
	);
	const parts = contents.flatMap((c) => c.parts);
	const call = parts.find((p) => "functionCall" in p);
	assert.ok(call && "functionCall" in call);
	assert.deepEqual(call.functionCall, {
		name: "read",
		args: { path: "a.ts" },
		id: "call_1",
	});
	const response = parts.find((p) => "functionResponse" in p);
	assert.ok(response && "functionResponse" in response);
	assert.equal(response.functionResponse.id, "call_1");
});

test("convertMessages keeps unsigned claude tool calls with sanitized ids", () => {
	const contents = convertMessages(
		fakeModel("claude-sonnet-4-6"),
		{
			messages: [
				{ role: "user", content: [{ type: "text", text: "q" }] },
				{
					role: "assistant",
					provider: PROVIDER_ID,
					model: "claude-sonnet-4-6",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
				},
				{ role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }] },
			],
		} as never,
		"claude-sonnet-4-6",
	);
	const parts = contents.flatMap((c) => c.parts);
	const call = parts.find((p) => "functionCall" in p);
	assert.ok(call && "functionCall" in call);
	assert.deepEqual(call.functionCall, { name: "read", args: { path: "a.ts" }, id: "call_1" });
	const response = parts.find((p) => "functionResponse" in p);
	assert.ok(response && "functionResponse" in response);
	assert.deepEqual(response.functionResponse.response, { output: "file body" });
});

test("convertMessages prepends user turn when history starts with model", () => {
	const contents = convertMessages(
		fakeModel("gemini-3.7-flash"),
		{
			messages: [
				{ role: "assistant", provider: PROVIDER_ID, model: "gemini-3.7-flash", stopReason: "stop", content: [{ type: "text", text: "hey" }] },
			],
		} as never,
		"gemini-3.7-flash-low",
	);
	assert.equal(contents[0]?.role, "user");
	assert.equal(contents[1]?.role, "model");
});

test("convertTools dereferences $refs and strips meta keys", () => {
	const tools = [
		{
			name: "read",
			description: "read a file",
			parameters: {
				type: "object",
				$schema: "https://json-schema.org/draft/2020-12/schema",
				$defs: { name: { type: "string" } },
				properties: { file: { $ref: "#/$defs/name" } },
				required: ["file"],
			},
		},
	] as never[];
	const out = convertTools(tools);
	const decl = out?.[0]?.functionDeclarations[0];
	assert.ok(decl && "parametersJsonSchema" in decl);
	const schema = decl.parametersJsonSchema as { properties: { file: { type: string } }; $schema?: unknown; $defs?: unknown };
	assert.deepEqual(schema.properties.file, { type: "string" });
	assert.equal(schema.$schema, undefined);
	assert.equal(schema.$defs, undefined);
});

test("convertTools claude bridge allowlist drops unknown keywords", () => {
	const tools = [
		{
			name: "exec",
			description: "run",
			parameters: {
				type: "object",
				properties: {
					cmd: { type: ["string", "null"], anyOf: [{ type: "string" }], format: "binary" },
				},
			},
		},
	] as never[];
	const out = convertTools(tools, true);
	const decl = out?.[0]?.functionDeclarations[0];
	assert.ok(decl && "parameters" in decl && !("parametersJsonSchema" in decl));
	const prop = (decl.parameters as { properties: { cmd: Record<string, unknown> } }).properties.cmd;
	assert.equal(prop.type, "string");
	assert.equal(prop.anyOf, undefined);
	assert.equal(prop.format, undefined);
});

test("convertTools applies Pi 0.86 preferred strict schemas for Gemini 3", () => {
	const tools = [
		{
			name: "read",
			description: "read",
			parameters: {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string" },
					offset: { type: "number" },
				},
			},
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		},
	] as never[];
	const out = convertTools(tools, false, true);
	const schema = out?.[0]?.functionDeclarations[0]?.parametersJsonSchema as {
		required: string[];
		additionalProperties: boolean;
		properties: { offset: { anyOf: unknown[] } };
	};
	assert.deepEqual(schema.required, ["path", "offset"]);
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.properties.offset.anyOf, [{ type: "number" }, { type: "null" }]);
});

test("convertTools strict schema edge cases match pi-ai 0.86", () => {
	const makeTool = (property: unknown, strict: "prefer" | "require" = "prefer") =>
		[
			{
				name: "schema",
				description: "schema test",
				parameters: { type: "object", properties: { value: property } },
				constrainedSampling: { type: "json_schema", strict },
			},
		] as never[];

	assert.throws(
		() => convertTools(makeTool({ type: "array", items: [{ type: "string" }] }, "require"), false, true),
		/tuple schemas are unsupported/,
	);
	assert.throws(
		() => convertTools(makeTool(false, "require"), false, true),
		/boolean schemas are unsupported/,
	);

	for (const property of [{ enum: ["value", null] }, { const: null }]) {
		const out = convertTools(makeTool(property), false, true);
		const schema = out?.[0]?.functionDeclarations[0]?.parametersJsonSchema as {
			properties: { value: Record<string, unknown> };
		};
		assert.deepEqual(schema.properties.value, property);
	}
});

test("convertTools leaves preferred schemas unchanged when strict sampling is unsupported", () => {
	const tools = [
		{
			name: "read",
			description: "read",
			parameters: {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string" },
					offset: { type: "number" },
				},
			},
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		},
	] as never[];
	const out = convertTools(tools, false, false);
	const schema = out?.[0]?.functionDeclarations[0]?.parametersJsonSchema as {
		required: string[];
		additionalProperties?: unknown;
		properties: { offset: { type: string; anyOf?: unknown[] } };
	};
	assert.deepEqual(schema.required, ["path"]);
	assert.equal(schema.additionalProperties, undefined);
	assert.deepEqual(schema.properties.offset, { type: "number" });
});

test("mapStopReason maps backend finish reasons", () => {
	assert.equal(mapStopReason("STOP"), "stop");
	assert.equal(mapStopReason("MAX_TOKENS"), "length");
	assert.equal(mapStopReason("OTHER"), "error");
	assert.equal(mapStopReason(undefined), "stop");
});

test("buildRequest sends plain schemas to Cloud Code Assist VALIDATED mode", async () => {
	await withEnvAsync({ ANTIGRAVITY_COMPACT_PROMPT: undefined, NOAGY_COMPACT_PROMPT: undefined }, async () => {
	const model = fakeModel("gemini-3.7-flash");
	const request = buildRequest(
		model,
		normalizeContext({
			systemPrompt: "You are pi.",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			tools: [
				{
					name: "read",
					description: "d",
					parameters: {
						type: "object",
						required: ["path"],
						properties: { path: { type: "string" }, offset: { type: "number" } },
					},
					constrainedSampling: { type: "json_schema", strict: "prefer" },
				},
			],
		} as never),
		"project-1",
		{ sessionId: "sess-42", reasoning: "high" } as never,
		"gemini-3.7-flash-high",
	);
	assert.equal(request.project, "project-1");
	assert.equal(request.model, "gemini-3.7-flash-high");
	assert.equal(request.requestType, "agent");
	assert.equal(request.request.sessionId, "sess-42");
	assert.match(request.requestId, /^agent\//);
	// The agent-name scrub rewrites harness-authored system text (see the scrub test below).
	assert.deepEqual(request.request.systemInstruction.parts, [{ text: "You are." }]);
	assert.equal(request.request.generationConfig?.thinkingConfig?.thinkingLevel, "HIGH");
	assert.equal(request.request.generationConfig?.maxOutputTokens, 65536);
	assert.equal(request.request.toolConfig?.functionCallingConfig.mode, "VALIDATED");
	const declaration = request.request.tools?.[0]?.functionDeclarations[0];
	assert.ok(declaration);
	const schema = declaration.parametersJsonSchema as {
		required: string[];
		additionalProperties?: unknown;
		properties: { offset: { type: string; anyOf?: unknown[] } };
	};
	assert.deepEqual(schema.required, ["path"]);
	assert.equal(schema.additionalProperties, undefined);
	assert.deepEqual(schema.properties.offset, { type: "number" });
	});
});

test("friendly errors are actionable and redacted", () => {
	assert.match(friendlyAntigravityError(401, "unauthorized"), /\/login antigravity/);
	assert.match(friendlyAntigravityError(429, "Individual quota reached. Resets in 23m."), /23m/);
	const unavailableModel = friendlyAntigravityError(404, "Requested entity was not found");
	assert.match(unavailableModel, /switch to gemini-3\.8-flash/i);
	assert.doesNotMatch(unavailableModel, /gemini-3\.5-flash/i);
	assert.match(friendlyAntigravityError(503, "No capacity available"), /capacity/);
});

/** Real 403 body captured from cloudcode-pa when the account is unverified. */
const VALIDATION_REQUIRED_BODY = JSON.stringify({
	error: {
		code: 403,
		message: "Verify your account to continue.",
		status: "PERMISSION_DENIED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "VALIDATION_REQUIRED",
				domain: "cloudcode-pa.googleapis.com",
				metadata: {
					validation_url_link_text: "Verify your account",
					validation_url:
						"https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=AKgnsbuZNC0cynwEO0jeMIHLqFoLPHO9kak443jZfkB8I8S3oGpK6w1Y1-5ykSBoq3HrOagIjz251AgtW-KB3SaXyBgiMGV6d0YdGkEqny9aPjFnzFTt8NPw-d_e-MA8gXiDphzKDiJr&flowName=GlifWebSignIn&authuser",
					validation_learn_more_link_text: "Learn more",
					validation_learn_more_url: "https://support.google.com/accounts?p=al_alert",
					validation_error_message: "Verify your account to continue.",
				},
			},
		],
	},
});

test("403 VALIDATION_REQUIRED surfaces Google's verification link instead of useless advice", () => {
	const validation = extractAccountValidation(VALIDATION_REQUIRED_BODY);
	assert.equal(validation?.message, "Verify your account to continue.");
	assert.match(validation?.url ?? "", /^https:\/\/accounts\.google\.com\/signin\/continue\?/);

	const message = friendlyAntigravityError(403, VALIDATION_REQUIRED_BODY);
	// The whole point: the user gets a link they can act on.
	assert.match(message, /complete verification at https:\/\/accounts\.google\.com\/signin\/continue\?/);
	assert.match(message, /VALIDATION_REQUIRED/);
	assert.match(message, /another personal Google account/);
	// And is told the generic advice does not apply, so they stop re-logging in.
	assert.match(message, /Re-login and switching models will not clear it/);
	// The URL must survive redaction intact or it is useless to click.
	assert.match(message, /plt=AKgnsbuZNC0cynwEO0jeMIHLqFoLPHO9kak443jZfkB8I8S3oGpK6w1Y1-5ykSBoq3HrOag/);
	assert.doesNotMatch(message, /Next: re-login or try another model/);
	// Only the verification link is actionable; the body also carries a learn-more
	// support link, and rendering it would send the user to a help page instead of the fix.
	assert.doesNotMatch(message, /support\.google\.com/);
});

test("403 validation links are only rendered from Google-owned https hosts", () => {
	const withUrl = (validationUrl: string) =>
		JSON.stringify({
			error: {
				message: "Verify your account to continue.",
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: validationUrl },
					},
				],
			},
		});

	// A response body is untrusted: a foreign host would be a ready-made phishing link.
	assert.equal(extractAccountValidation(withUrl("https://evil.example/verify"))?.url, undefined);
	assert.equal(extractAccountValidation(withUrl("javascript:alert(1)"))?.url, undefined);
	assert.equal(extractAccountValidation(withUrl("http://accounts.google.com/verify"))?.url, undefined);
	assert.equal(extractAccountValidation(withUrl("https://accounts.google.com.evil.test/verify"))?.url, undefined);
	assert.equal(extractAccountValidation(withUrl("not a url"))?.url, undefined);

	// A rejected link degrades to the plain instruction and renders no URL at all.
	const fallback = friendlyAntigravityError(403, withUrl("https://evil.example/verify"));
	assert.doesNotMatch(fallback, /evil\.example/);
	assert.doesNotMatch(fallback, /https:\/\//);
	assert.match(fallback, /complete Google account verification/);
});

test("403 keeps generic handling when the block is not an account validation", () => {
	assert.equal(extractAccountValidation("permission denied"), undefined);
	assert.equal(extractAccountValidation('{"error":{"message":"nope"}}'), undefined);
	// A permission body with no validation details must keep the pre-existing advice.
	const denied = friendlyAntigravityError(403, "permission denied for this project");
	assert.match(denied, /access was denied for this account or project/);
	// Details stripped by a gateway: still actionable, just without the link.
	const stripped = friendlyAntigravityError(
		403,
		JSON.stringify({ error: { message: "Verify your account to continue." } }),
	);
	assert.match(stripped, /VALIDATION_REQUIRED/);
	assert.doesNotMatch(stripped, /https:\/\//);
	assert.match(stripped, /complete Google account verification/);
});

test("429 mapping separates plan quota from transient throttles", () => {
	const plan = friendlyAntigravityError(
		429,
		"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h6m27s.",
	);
	assert.match(plan, /Quota reached\. Please wait 3h6m27s/);
	assert.equal(isPlanQuotaError(429, "Individual quota reached. Resets in 3h6m27s."), true);
	assert.equal(isPlanQuotaError(429, "Resource has been exhausted (e.g. check quota)."), false);
	assert.equal(isPlanQuotaError(500, "quota"), false);
	// Plan quota is deterministic: the host must not spend retries on it.
	assert.equal(
		isRetryableAssistantError({ stopReason: "error", errorMessage: plan } as never),
		false,
	);

	// Shared-capacity smoothing and per-minute limits also contain "quota" but are not
	// plan quota: keep the backend text instead of claiming the user's quota is gone.
	const throttle = friendlyAntigravityError(429, "Resource has been exhausted (e.g. check quota).");
	assert.match(throttle, /transient, not plan quota/);
	assert.match(throttle, /Resource has been exhausted/);

	// "quota exceeded" is a non-retryable phrase for pi's classifier, so the quoted
	// backend text must not match it verbatim — the throttle has to stay retryable.
	const metric = friendlyAntigravityError(
		429,
		"Quota exceeded for quota metric 'Generate requests per minute per user'.",
	);
	assert.match(metric, /transient, not plan quota/);
	assert.match(metric, /Generate requests per minute per user/);
	assert.match(metric, /quota-limit hit/);
	assert.doesNotMatch(metric, /quota exceeded/i);
	assert.equal(
		isRetryableAssistantError({
			stopReason: "error",
			errorMessage: `Antigravity API error (429, endpoint=x): ${metric}`,
		} as never),
		true,
	);

	// A 429 with no body must not leave a dangling "Backend said:".
	assert.doesNotMatch(friendlyAntigravityError(429, ""), /Backend said/);
});

test("transient 429 retries in place, then the fallback model, and stays retryable", async () => {
	const sessionsFile = join(tmpdir(), `ag-throttle-${Date.now()}.json`);
	await withEnvAsync(
		{ ANTIGRAVITY_SESSIONS_FILE: sessionsFile, ANTIGRAVITY_THROTTLE_BASE_DELAY_MS: "0" },
		async () => {
			await withFetchStub(
				() =>
					errorResponse(
						429,
						"Quota exceeded for quota metric 'Generate requests per minute per user'.",
					),
				async (calls) => {
					const message = await streamAntigravityOnce("-4242424242");
					// Per runtime model (primary, then fallback): 1 initial attempt +
					// THROTTLE_MAX_RETRIES in-place retries, all on the primary endpoint: a shared
					// throttle must not be amplified by region hopping.
					assert.equal(calls.length, 6);
					assert.deepEqual([...new Set(calls)], [
						`${DEFAULT_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
					]);
					assert.equal(message.stopReason, "error");
					// Status + backend text survive, so pi's retry classifier can see the 429.
					assert.match(message.errorMessage ?? "", /Antigravity API error \(429/);
					assert.match(message.errorMessage ?? "", /Generate requests per minute per user/);
					assert.match(message.errorMessage ?? "", /runtimeModel=gemini-3\.7-flash-high/);
					assert.equal(
						isRetryableAssistantError({ stopReason: "error", errorMessage: message.errorMessage } as never),
						true,
					);
				},
			);
		},
	);
});

test("aborting during a 429 backoff stops retrying", async () => {
	const sessionsFile = join(tmpdir(), `ag-abort-${Date.now()}.json`);
	await withEnvAsync(
		{ ANTIGRAVITY_SESSIONS_FILE: sessionsFile, ANTIGRAVITY_THROTTLE_BASE_DELAY_MS: "500" },
		async () => {
			await withFetchStub(
				() => errorResponse(429, "Resource has been exhausted (e.g. check quota)."),
				async (calls) => {
					const controller = new AbortController();
					const abortTimer = setTimeout(() => controller.abort(), 20);
					const message = await streamAntigravityOnce("-4545454545", controller.signal);
					clearTimeout(abortTimer);
					assert.equal(calls.length, 1);
					assert.equal(message.stopReason, "aborted");
				},
			);
		},
	);
});

test("plan-quota 429 fails fast without retries or endpoint hopping", async () => {
	const sessionsFile = join(tmpdir(), `ag-plan-quota-${Date.now()}.json`);
	await withEnvAsync(
		{ ANTIGRAVITY_SESSIONS_FILE: sessionsFile, ANTIGRAVITY_THROTTLE_BASE_DELAY_MS: "0" },
		async () => {
			await withFetchStub(
				() =>
					errorResponse(
						429,
						"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h6m27s.",
					),
				async (calls) => {
					const message = await streamAntigravityOnce("-4343434343");
					assert.equal(calls.length, 1);
					assert.equal(message.stopReason, "error");
					assert.match(message.errorMessage ?? "", /^Quota reached\. Please wait 3h6m27s/);
					assert.equal(
						isRetryableAssistantError({ stopReason: "error", errorMessage: message.errorMessage } as never),
						false,
					);
				},
			);
		},
	);
});

test("transient 429 honors a short Retry-After and retries the same endpoint", async () => {
	const sessionsFile = join(tmpdir(), `ag-retry-after-${Date.now()}.json`);
	await withEnvAsync(
		{ ANTIGRAVITY_SESSIONS_FILE: sessionsFile, ANTIGRAVITY_THROTTLE_BASE_DELAY_MS: "0" },
		async () => {
			await withFetchStub(
				(_url, call) =>
					call === 1
						? new Response(JSON.stringify({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }), {
								status: 429,
								headers: { "content-type": "application/json", "retry-after": "0" },
							})
						: new Response(STREAM_OK_SSE, {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							}),
				async (calls) => {
					const message = await streamAntigravityOnce("-4545454545");
					assert.equal(calls.length, 2);
					assert.notEqual(message.stopReason, "error");
				},
			);
		},
	);
});

test("a 429 RetryInfo in the body is honored like a Retry-After header", async () => {
	const sessionsFile = join(tmpdir(), `ag-retry-info-${Date.now()}.json`);
	await withEnvAsync(
		{ ANTIGRAVITY_SESSIONS_FILE: sessionsFile, ANTIGRAVITY_THROTTLE_BASE_DELAY_MS: "0" },
		async () => {
			await withFetchStub(
				(_url, call) =>
					call === 1
						? new Response(
								JSON.stringify({
									error: {
										code: 429,
										status: "RESOURCE_EXHAUSTED",
										details: [
											{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0s" },
										],
									},
								}),
								{ status: 429, headers: { "content-type": "application/json" } },
							)
						: new Response(STREAM_OK_SSE, {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							}),
				async (calls) => {
					const message = await streamAntigravityOnce("-4848484848");
					assert.equal(calls.length, 2);
					assert.notEqual(message.stopReason, "error");
				},
			);
		},
	);
});

test("a long Retry-After cooldown burns no retry attempts", async () => {
	const sessionsFile = join(tmpdir(), `ag-retry-after-long-${Date.now()}.json`);
	await withEnvAsync(
		{ ANTIGRAVITY_SESSIONS_FILE: sessionsFile, ANTIGRAVITY_THROTTLE_BASE_DELAY_MS: "0" },
		async () => {
			await withFetchStub(
				() =>
					new Response(JSON.stringify({ error: { code: 429, message: "RESOURCE_EXHAUSTED" } }), {
						status: 429,
						headers: { "content-type": "application/json", "retry-after": "3600" },
					}),
				async (calls) => {
					const message = await streamAntigravityOnce("-4646464646");
					// One attempt on the primary model, one on the fallback model, no in-place retries.
					assert.equal(calls.length, 2);
					assert.equal(message.stopReason, "error");
					assert.match(message.errorMessage ?? "", /Rate limited by Antigravity/);
				},
			);
		},
	);
});

test("a throttled Gemini 4 Hydrogen request is served by the Carbon fallback", async () => {
	const sessionsFile = join(tmpdir(), `ag-throttle-fallback-${Date.now()}.json`);
	const requestedModels: string[] = [];
	await withEnvAsync(
		{ ANTIGRAVITY_SESSIONS_FILE: sessionsFile, ANTIGRAVITY_THROTTLE_BASE_DELAY_MS: "0" },
		async () => {
			await withFetchStub(
				(_url, _call, init) => {
					const runtimeModel = (JSON.parse(String(init?.body)) as { model: string }).model;
					requestedModels.push(runtimeModel);
					return runtimeModel === "gemini-4-hydrogen-medium"
						? errorResponse(429, "Resource has been exhausted (e.g. check quota).")
						: new Response(STREAM_OK_SSE, {
								status: 200,
								headers: { "content-type": "text/event-stream" },
							});
				},
				async () => {
					const stream = streamAntigravity(
						fakeModel("gemini-4-hydrogen"),
						normalizeContext({
							systemPrompt: "You are pi.",
							messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
						} as never),
						{
							apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
							sessionId: "-4747474747",
							reasoning: "medium",
						} as never,
					);
					const message = (await stream.result()) as { stopReason: string };
					assert.notEqual(message.stopReason, "error");
					assert.deepEqual(requestedModels, [
						"gemini-4-hydrogen-medium",
						"gemini-4-hydrogen-medium",
						"gemini-4-hydrogen-medium",
						"gemini-4-carbon-medium",
					]);
				},
			);
		},
	);
});

test("parseGoogleDurationSeconds parses Google RPC durations", () => {
	assert.equal(parseGoogleDurationSeconds("33s"), 33);
	assert.equal(parseGoogleDurationSeconds("0s"), 0);
	assert.equal(parseGoogleDurationSeconds("1.5m"), 90);
	assert.equal(parseGoogleDurationSeconds("2h"), 7200);
	assert.equal(parseGoogleDurationSeconds("500ms"), 1);
	assert.equal(parseGoogleDurationSeconds(" 12s "), 12);
	assert.equal(parseGoogleDurationSeconds("soon"), undefined);
	assert.equal(parseGoogleDurationSeconds(""), undefined);
});

test("parseRetryAfterFromBody reads RetryInfo, quotaResetDelay, and message text", () => {
	assert.equal(
		parseRetryAfterFromBody(
			JSON.stringify({
				error: {
					code: 429,
					status: "RESOURCE_EXHAUSTED",
					details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33s" }],
				},
			}),
		),
		33,
	);
	assert.equal(
		parseRetryAfterFromBody(
			JSON.stringify({
				error: {
					code: 429,
					details: [
						{
							"@type": "type.googleapis.com/google.rpc.ErrorInfo",
							metadata: { quotaResetDelay: "1m30s" },
						},
					],
				},
			}),
		),
		undefined,
	); // compound "1m30s" is not a single-unit duration
	assert.equal(
		parseRetryAfterFromBody(
			JSON.stringify({
				error: {
					code: 429,
					details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetDelay: "90s" } }],
				},
			}),
		),
		90,
	);
	assert.equal(parseRetryAfterFromBody("upstream reverted to retry after 45s"), 45);
	assert.equal(parseRetryAfterFromBody("Resource has been exhausted (e.g. check quota)."), undefined);
	assert.equal(parseRetryAfterFromBody(""), undefined);
});

test("QUOTA_EXHAUSTED / INSUFFICIENT_G1_CREDITS_BALANCE reasons are plan quota", () => {
	const exhausted = JSON.stringify({
		error: {
			code: 429,
			status: "RESOURCE_EXHAUSTED",
			details: [
				{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" },
			],
		},
	});
	assert.equal(isPlanQuotaError(429, exhausted), true);
	assert.equal(
		isPlanQuotaError(
			429,
			JSON.stringify({ error: { details: [{ reason: "INSUFFICIENT_G1_CREDITS_BALANCE" }] } }),
		),
		true,
	);
	assert.equal(isPlanQuotaError(429, "Resource has been exhausted (e.g. check quota)."), false);
	assert.equal(
		isPlanQuotaError(
			429,
			JSON.stringify({ error: { details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } }),
		),
		false,
	);
});

test("parseRetryAfterSeconds accepts seconds and HTTP dates, refuses garbage", () => {
	assert.equal(parseRetryAfterSeconds("120"), 120);
	assert.equal(parseRetryAfterSeconds(" 0 "), 0);
	assert.equal(parseRetryAfterSeconds(null), undefined);
	assert.equal(parseRetryAfterSeconds(""), undefined);
	assert.equal(parseRetryAfterSeconds("soon"), undefined);
	const inAnHour = new Date(Date.now() + 3_600_000).toUTCString();
	const parsed = parseRetryAfterSeconds(inAnHour);
	assert.ok(parsed !== undefined && parsed > 3500 && parsed <= 3600);
	assert.equal(parseRetryAfterSeconds(new Date(Date.now() - 60_000).toUTCString()), 0);
});

test("friendly 403 TOS_VIOLATION warns about account risk instead of re-login advice", () => {
	const body = JSON.stringify({
		error: {
			code: 403,
			message: "PERMISSION_DENIED",
			status: "PERMISSION_DENIED",
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.ErrorInfo",
					reason: "TOS_VIOLATION",
					metadata: { violation: "Using third party software, tools, or services to access Antigravity" },
				},
			],
		},
	});
	const message = friendlyAntigravityError(403, body);
	assert.match(message, /TOS_VIOLATION/);
	assert.match(message, /suspended/);
	assert.doesNotMatch(message, /re-login, or use an account with access/);
});

test("5xx still falls back to the next endpoint", async () => {
	const sessionsFile = join(tmpdir(), `ag-endpoint-fallback-${Date.now()}.json`);
	await withEnvAsync({ ANTIGRAVITY_SESSIONS_FILE: sessionsFile }, async () => {
		await withFetchStub(
			(_url, call) =>
				call === 1
					? errorResponse(500, "internal error")
					: new Response(STREAM_OK_SSE, {
							status: 200,
							headers: { "content-type": "text/event-stream" },
						}),
			async (calls) => {
				const message = await streamAntigravityOnce("-4444444444");
				assert.equal(calls.length, 2);
				assert.equal(calls[0], `${DEFAULT_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`);
				assert.equal(
					calls[1],
					`${ENDPOINT_FALLBACKS[1]}/v1internal:streamGenerateContent?alt=sse`,
				);
				assert.equal(message.stopReason, "stop");
			},
		);
	});
});

test("retired Gemini 3.5 SSE notice fails without emitting it as assistant text", async () => {
	const noticeParts = [
		"Gemini 3.5 Flash is no longer available. Please ",
		"switch to Gemini 3.7 Flash in the latest version of Antigravity.",
	];
	const sse = noticeParts
		.map((text) =>
			`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text }] } }] } })}`,
		)
		.join("\n\n");

	await withFetchStub(
		(url) =>
			url.includes("fetchAvailableModels")
				? new Response(JSON.stringify({ models: {} }), { status: 200 })
				: new Response(`${sse}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }),
		async () => {
			const stream = streamAntigravity(
				fakeModel("gemini-3.5-flash"),
				normalizeContext({
					systemPrompt: "You are pi.",
					messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
				} as never),
				{
					apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
					sessionId: "-3535353535",
				} as never,
			);
			const result = await stream.result();
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);

			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /switch to a current catalog model/i);
			assert.deepEqual(result.content, []);
			assert.equal(eventTypes.some((type) => type.startsWith("text_")), false);
		}
	);
});

test("interleaved Gemini thinking does not leak a retired-model notice", async () => {
	const parts = [
		{ text: "Gemini 3.5 Flash is no longer available. Please " },
		{ text: "checking service status", thought: true, thoughtSignature: "dGhpbmtpbmc=" },
		{ text: "switch to Gemini 3.7 Flash in the latest version of Antigravity." },
	];
	const sse = parts
		.map((part) => `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [part] } }] } })}`)
		.join("\n\n");

	await withFetchStub(
		(url) =>
			url.includes("fetchAvailableModels")
				? new Response(JSON.stringify({ models: {} }), { status: 200 })
				: new Response(`${sse}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }),
		async () => {
			const stream = streamAntigravity(
				fakeModel("gemini-3.5-flash"),
				normalizeContext({
					systemPrompt: "You are pi.",
					messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
				} as never),
				{
					apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
					sessionId: "-3535353536",
				} as never,
			);
			const result = await stream.result();
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);

			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /switch to a current catalog model/i);
			assert.deepEqual(result.content, []);
			assert.equal(eventTypes.some((type) => type.startsWith("text_")), false);
		},
	);
});

test("interleaved thinking and text keep their order when the retirement prefix diverges", async () => {
	const parts = [
		{ text: "Gemini 3.5 Flash is no longer available. Please ", thoughtSignature: "dGV4dA==" },
		{ text: "checking service status", thought: true, thoughtSignature: "dGhpbmtpbmc=" },
		{ text: "actually, I was quoting another transcript." },
	];
	const sse = parts
		.map((part) => `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [part] } }] } })}`)
		.join("\n\n");

	await withFetchStub(
		(url) =>
			url.includes("fetchAvailableModels")
				? new Response(JSON.stringify({ models: {} }), { status: 200 })
				: new Response(`${sse}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }),
		async () => {
			const stream = streamAntigravity(
				fakeModel("gemini-3.5-flash"),
				normalizeContext({
					systemPrompt: "You are pi.",
					messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
				} as never),
				{
					apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
					sessionId: "-3535353537",
				} as never,
			);
			const result = await stream.result();
			const content = result.content as Array<{
				type: string;
				text?: string;
				textSignature?: string;
				thinking?: string;
				thinkingSignature?: string;
			}>;
			const eventTypes: string[] = [];
			for await (const event of stream) eventTypes.push(event.type);

			assert.equal(result.stopReason, "stop");
			assert.deepEqual(content.map((block) => block.type), ["text", "thinking", "text"]);
			assert.equal(content[0]?.text, parts[0]?.text);
			assert.equal(content[0]?.textSignature, "dGV4dA==");
			assert.equal(content[1]?.thinking, parts[1]?.text);
			assert.equal(content[1]?.thinkingSignature, "dGhpbmtpbmc=");
			assert.equal(content[2]?.text, parts[2]?.text);
			assert.deepEqual(
				eventTypes.filter((type) => /^(?:text|thinking)_(?:start|delta|end)$/.test(type)),
				[
					"text_start",
					"text_delta",
					"text_end",
					"thinking_start",
					"thinking_delta",
					"thinking_end",
					"text_start",
					"text_delta",
					"text_end",
				],
			);
		},
	);
});

test("streamResponse flushes an incomplete retirement prefix and thinking at EOF", async () => {
	const response = new Response(
		retirementSse(
			[
				{ text: "Gemini 3.5 Flash is no longer available. Please ", thoughtSignature: "dGV4dA==" },
				{ text: "checking service status", thought: true, thoughtSignature: "dGhpbmtpbmc=" },
			],
			"STOP",
		),
	);
	const stream = createAssistantMessageEventStream();
	const output = streamResponseOutput();

	assert.equal(await streamResponse(response, stream, output, undefined, undefined, true), true);
	stream.end(output);
	const result = await stream.result();
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.content.map((block) => block.type), ["text", "thinking"]);
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "Gemini 3.5 Flash is no longer available. Please ");
	assert.equal(result.content[1]?.type === "thinking" ? result.content[1].thinking : undefined, "checking service status");
});

test("streamResponse flushes a tentative prefix before a function call", async () => {
	const response = new Response(
		retirementSse(
			[
				{ text: "Gemini 3.5 Flash is no longer available. Please " },
				{ text: "checking service status", thought: true },
				{ functionCall: { id: "read-1", name: "read", args: { path: "src/index.ts" } } },
			],
			"STOP",
		),
	);
	const stream = createAssistantMessageEventStream();
	const output = streamResponseOutput();

	assert.equal(await streamResponse(response, stream, output, undefined, undefined, true), true);
	stream.end(output);
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(result.content.map((block) => block.type), ["text", "thinking", "toolCall"]);
	assert.equal(result.content[2]?.type === "toolCall" ? result.content[2].name : undefined, "read");
});

test("retirement detection releases the reader when cancellation succeeds", async () => {
	let cancelCalled = false;
	const response = openRetirementNoticeResponse(() => {
		cancelCalled = true;
	});
	const output = streamResponseOutput();
	const stream = createAssistantMessageEventStream();

	await assert.rejects(
		streamResponse(response, stream, output, undefined, undefined, true),
		/retired and is no longer available/,
	);
	assert.equal(cancelCalled, true);
	assert.equal(response.body?.locked, false);
	assert.deepEqual(output.content, []);
});

test("retirement detection releases the reader when cancellation rejects", async () => {
	let cancelCalled = false;
	const response = openRetirementNoticeResponse(() => {
		cancelCalled = true;
		throw new Error("cancel rejected");
	});
	const output = streamResponseOutput();
	const stream = createAssistantMessageEventStream();

	await assert.rejects(
		streamResponse(response, stream, output, undefined, undefined, true),
		/retired and is no longer available/,
	);
	assert.equal(cancelCalled, true);
	assert.equal(response.body?.locked, false);
	assert.deepEqual(output.content, []);
});

test("retirement notice quoted in a normal Gemini reply is not treated as an error", async () => {
	const reply =
		'The previous session said: "Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash."';
	const sse = `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: reply }] }, finishReason: "STOP" }] } })}\n\n`;

	await withFetchStub(
		() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		async () => {
			const stream = streamAntigravity(
				fakeModel("gemini-3.8-flash"),
				normalizeContext({
					systemPrompt: "You are pi.",
					messages: [{ role: "user", content: [{ type: "text", text: "What happened?" }] }],
				} as never),
				{
					apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
					sessionId: "-3838383838",
				} as never,
			);
			const result = await stream.result();

			assert.equal(result.stopReason, "stop");
			assert.equal(result.content[0]?.type, "text");
			if (result.content[0]?.type === "text") assert.equal(result.content[0].text, reply);
		}
	);
});

test("streamResponse parses SSE into blocks, usage, and stop reason", async () => {
	const sse = [
		'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}}',
		"",
		'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"pondering","thoughtSignature":"QUJDRA=="}]}}]}}',
		"",
		'data: {"response":{"candidates":[{"content":{"parts":[{"text":"world"}]}}]}}',
		"",
		'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"weird id!!","name":"read","args":{"path":"a.ts"}}}]}}]}}',
		"",
		'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":10,"candidatesTokenCount":5,"thoughtsTokenCount":7,"totalTokenCount":112}}}',
		"",
	].join("\n");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(sse));
			controller.close();
		},
	});
	const response = new Response(body);
	const stream = createAssistantMessageEventStream();
	const output = {
		role: "assistant",
		content: [],
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		model: "gemini-3.7-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
	const hasContent = await streamResponse(response, stream, output as never);
	assert.equal(hasContent, true);
	const blocks = output.content as Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string }>;
	const texts = blocks.filter((b) => b.type === "text").map((b) => b.text);
	assert.deepEqual(texts, ["Hello ", "world"]);
	const thinking = blocks.find((b) => b.type === "thinking");
	assert.equal(thinking?.thinking, "pondering");
	const toolCall = blocks.find((b) => b.type === "toolCall");
	assert.equal(toolCall?.name, "read");
	assert.equal(toolCall?.id, "weird_id__");
	assert.equal(output.usage.input, 90);
	assert.equal(output.usage.output, 12);
	assert.equal(output.usage.cacheRead, 10);
	assert.equal(output.usage.totalTokens, 112);
	assert.equal(output.stopReason, "toolUse");
});

test("streamResponse updates sessionState.lastExecutionId from responseId", async () => {
	const sse = 'data: {"response":{"responseId":"resp-session-999","candidates":[{"finishReason":"STOP"}]}}\n\n';
	const body = new Response(sse);
	const stream = createAssistantMessageEventStream();
	const output = { role: "assistant", content: [], usage: {}, stopReason: "stop" } as never;
	const state = {
		agentId: "agent-1",
		trajectoryId: "traj-1",
		sessionId: "-12345",
		stepIndex: 1,
		lastUsedAt: Date.now(),
	};
	await streamResponse(body, stream, output, undefined, state);
	assert.equal(state.lastExecutionId, "resp-session-999");
});

/* ------------------------------- client.ts ------------------------------- */

test("endpoint candidates prefer explicit safe override", () => {
	assert.deepEqual(endpointCandidates(), ENDPOINT_FALLBACKS);
	assert.equal(DEFAULT_ENDPOINT, "https://daily-cloudcode-pa.googleapis.com");
	withEnv("ANTIGRAVITY_BASE_URL", "https://cloudcode-pa.googleapis.com/", () => {
		assert.deepEqual(endpointCandidates(), ["https://cloudcode-pa.googleapis.com"]);
	});
});

test("endpoint candidates prioritize preferredEndpoint when available", () => {
	const sandbox = "https://daily-cloudcode-pa.sandbox.googleapis.com";
	const candidates = endpointCandidates(sandbox);
	assert.equal(candidates[0], sandbox);
	assert.equal(candidates.length, ENDPOINT_FALLBACKS.length);
});

test("stableProjectId is deterministic and UUID v4-shaped", () => {
	const a = stableProjectId("user@example.com");
	const b = stableProjectId("user@example.com");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.notEqual(stableProjectId("other@example.com"), a);
});

test("project id precedence: env over credential over default", () => {
	withEnv("ANTIGRAVITY_PROJECT_ID", "env-project", () => {
		assert.equal(resolveProjectId({ token: "t", credentialProjectId: "cred" }), "env-project");
	});
	assert.equal(resolveProjectId({ token: "t", credentialProjectId: "cred" }), "cred");
	assert.equal(resolveProjectId({ token: "t" }), defaultProjectId("antigravity-default"));
});

test("parseApiKey requires token and projectId", () => {
	const parsed = parseApiKey(JSON.stringify({ token: "tok", projectId: "proj" }));
	assert.deepEqual(parsed, { token: "tok", projectId: "proj" });
	assert.throws(() => parseApiKey(undefined), /No Antigravity OAuth credentials/);
	assert.throws(() => parseApiKey(JSON.stringify({ token: "tok" })), /Invalid Antigravity credentials/);
});

test("extractProjectId digs through nested discovery payloads", () => {
	assert.equal(extractProjectId({ antigravityProjectId: "p1" }), "p1");
	assert.equal(extractProjectId({ projects: ["p2"] }), "p2");
	assert.equal(extractProjectId({ cloudaicompanionProjects: ["p3"] }), "p3");
	assert.equal(extractProjectId({ unrelated: true }), undefined);
});

test("jsonOrTextError prefers the JSON error message", () => {
	assert.equal(jsonOrTextError('{"error":{"message":"boom"}}'), "boom");
	assert.equal(jsonOrTextError("plain failure"), "plain failure");
});

test("antigravityHeaders map the host platform and preserve overrides", async () => {
	await withEnvAsync({
		ANTIGRAVITY_USER_AGENT: undefined,
		NOAGY_USER_AGENT: undefined,
		ANTIGRAVITY_HUB_OS: undefined,
		NOAGY_HUB_OS: undefined,
		ANTIGRAVITY_HUB_ARCH: undefined,
		NOAGY_HUB_ARCH: undefined,
	}, async () => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
		try {
			for (const [platform, arch, expectedOs, expectedArch] of [
				["win32", "x64", "windows", "amd64"],
				["darwin", "arm64", "darwin", "arm64"],
				["linux", "arm64", "linux", "arm64"],
			]) {
				Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
				Object.defineProperty(process, "arch", { ...originalArch, value: arch });
				const headers = antigravityHeaders("tok");
				assert.equal(headers.Authorization, "Bearer tok");
				assert.equal(headers.Accept, "text/event-stream");
				assert.ok(headers["Client-Metadata"].includes("ANTIGRAVITY"));
				assert.ok(headers["User-Agent"].includes(`os_type=${expectedOs}; arch=${expectedArch};`));
			}

			process.env.ANTIGRAVITY_HUB_OS = "custom-os";
			process.env.ANTIGRAVITY_HUB_ARCH = "custom-arch";
			assert.ok(antigravityHeaders("tok")["User-Agent"].includes("os_type=custom-os; arch=custom-arch;"));
		} finally {
			Object.defineProperty(process, "platform", originalPlatform);
			Object.defineProperty(process, "arch", originalArch);
		}
	});
});

test("antigravityHeaders generate a fresh trace and request id per call", () => {
	const first = antigravityHeaders("tok");
	const second = antigravityHeaders("tok");
	assert.ok(first["x-cloudaicompanion-trace-id"]);
	assert.ok(first["X-Aicode-Request-Id"]);
	assert.notEqual(first["x-cloudaicompanion-trace-id"], second["x-cloudaicompanion-trace-id"]);
	assert.notEqual(first["X-Aicode-Request-Id"], second["X-Aicode-Request-Id"]);
});

test("retirement detection covers the models removed 2026-11-18", async () => {
	// Claude/GPT retirements reuse the plain-text notice shape observed for Gemini 3.5.
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					retirementSse([{ text: "claude-opus-4-6 is no longer available. Please switch to" }]),
				),
			);
		},
		cancel() {},
	});
	const output = streamResponseOutput();
	const stream = createAssistantMessageEventStream();
	await assert.rejects(
		streamResponse(new Response(body), stream, output, undefined, undefined, true),
		/retired and is no longer available/,
	);
	assert.deepEqual(output.content, []);
});

test("isUsableRuntimeModelId rejects placeholder enums", () => {
	assert.ok(isUsableRuntimeModelId("gemini-3.7-flash-low"));
	assert.ok(isUsableRuntimeModelId("claude-sonnet-4-6"));
	assert.ok(!isUsableRuntimeModelId("MODEL_PLACEHOLDER_M20"));
	assert.ok(!isUsableRuntimeModelId("not a model id"));
});

/* ------------------------------ security.ts ------------------------------ */

test("redactSecrets scrubs token shapes", () => {
	const text = "ya29.abc123 def and Bearer sk-xyz and 1//0dLongRefreshToken123 and {\"access_token\":\"sup3rsecret\"}";
	const redacted = redactSecrets(text);
	assert.ok(!redacted.includes("ya29.abc123"));
	assert.ok(!redacted.includes("sk-xyz"));
	assert.ok(!redacted.includes("0dLongRefreshToken123"));
	assert.ok(!redacted.includes("sup3rsecret"));
	assert.ok(redacted.includes("[redacted-access-token]"));
});

test("api base URL guard blocks non-Google and unsafe overrides", () => {
	assert.equal(assertSafeApiBaseUrl("https://cloudcode-pa.googleapis.com/x"), "https://cloudcode-pa.googleapis.com/x");
	assert.throws(() => assertSafeApiBaseUrl("http://cloudcode-pa.googleapis.com"), /https/);
	assert.throws(() => assertSafeApiBaseUrl("https://user:pass@cloudcode-pa.googleapis.com"), /credentials/);
	assert.throws(() => assertSafeApiBaseUrl("https://evil.example.com"), /not allowed/);
});

test("callback host is loopback-only", () => {
	assert.equal(resolveCallbackHost(), "127.0.0.1");
	withEnv("ANTIGRAVITY_CALLBACK_HOST", "localhost", () => {
		assert.equal(resolveCallbackHost(), "127.0.0.1");
	});
	withEnv("ANTIGRAVITY_CALLBACK_HOST", "0.0.0.0", () => {
		assert.throws(() => resolveCallbackHost(), /loopback/);
	});
});

test("maskEmail keeps domain, hides local part", () => {
	assert.equal(maskEmail("someone@example.com"), "s***e@example.com");
	assert.equal(maskEmail(undefined), undefined);
});

/* -------------------------------- util.ts -------------------------------- */

test("deriveAntigravitySessionId derives deterministic signed decimal from first user message", () => {
	const context1 = {
		messages: [
			{ role: "user", content: "hello antigravity" },
			{ role: "assistant", content: "hi" },
		],
	};
	const id1 = deriveAntigravitySessionId(context1);
	assert.match(id1, /^-[0-9]+$/);
	// Same context gives identical sessionId
	assert.equal(deriveAntigravitySessionId(context1), id1);

	// Context with same first user message but additional turns gives identical sessionId
	const contextExtended = {
		messages: [
			{ role: "user", content: "hello antigravity" },
			{ role: "assistant", content: "hi" },
			{ role: "user", content: "next question" },
		],
	};
	assert.equal(deriveAntigravitySessionId(contextExtended), id1);

	// Context with text parts array also derives properly
	const contextParts = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "hello antigravity" }] },
		],
	};
	assert.equal(deriveAntigravitySessionId(contextParts), id1);

	// Different initial message gives different sessionId
	const context2 = {
		messages: [{ role: "user", content: "something completely different" }],
	};
	const id2 = deriveAntigravitySessionId(context2);
	assert.match(id2, /^-[0-9]+$/);
	assert.notEqual(id1, id2);

	// Empty messages fallback produces valid signed decimal
	const emptyId = deriveAntigravitySessionId({ messages: [] });
	assert.match(emptyId, /^-[0-9]+$/);
});

test("getOrCreateAntigravitySession manages sticky agentId, trajectoryId and increments stepIndex", () => {
	clearAntigravitySessions();
	const sid = "-9876543210";
	const s1 = getOrCreateAntigravitySession(sid);
	assert.equal(s1.sessionId, sid);
	assert.equal(s1.stepIndex, 1);
	assert.ok(s1.agentId.length > 0);
	assert.ok(s1.trajectoryId.length > 0);

	// Re-fetching same sessionId increments stepIndex and preserves agentId & trajectoryId
	const s2 = getOrCreateAntigravitySession(sid);
	assert.equal(s2.stepIndex, 2);
	assert.equal(s2.agentId, s1.agentId);
	assert.equal(s2.trajectoryId, s1.trajectoryId);

	// Different session has distinct state
	const sOther = getOrCreateAntigravitySession("-1111111111");
	assert.notEqual(sOther.agentId, s1.agentId);
	assert.notEqual(sOther.trajectoryId, s1.trajectoryId);
});

test("getOrCreateAntigravitySession persists session state across process restarts", () => {
	clearAntigravitySessions();
	const sid = "-7777777777";
	const s1 = getOrCreateAntigravitySession(sid);
	s1.lastExecutionId = "resp-before-restart";
	s1.lastGoodEndpoint = "https://daily-cloudcode-pa.googleapis.com";
	persistAntigravitySessions();

	// Simulate complete process termination & restart by clearing memory and resetting load state
	resetAntigravitySessionMemory();

	const sRestored = getOrCreateAntigravitySession(sid);
	assert.equal(sRestored.sessionId, sid);
	assert.equal(sRestored.agentId, s1.agentId);
	assert.equal(sRestored.trajectoryId, s1.trajectoryId);
	assert.equal(sRestored.lastExecutionId, "resp-before-restart");
	assert.equal(sRestored.lastGoodEndpoint, "https://daily-cloudcode-pa.googleapis.com");
	assert.equal(sRestored.stepIndex, 2); // advanced to next step
});

test("antigravityRequestEnvelope preserves session identity and chains last_execution_id", () => {
	clearAntigravitySessions();
	const sid = "-5555555555";
	const state = getOrCreateAntigravitySession(sid);
	state.lastExecutionId = "resp-abc-123";

	const envelope = antigravityRequestEnvelope("gemini-3.8-flash-high", false, state);
	assert.equal(envelope.sessionId, sid);
	assert.equal(envelope.labels.trajectory_id, state.trajectoryId);
	assert.equal(envelope.labels.last_step_index, "0"); // stepIndex 1 -> last_step_index 0
	assert.equal(envelope.labels.last_execution_id, "resp-abc-123");
	assert.match(envelope.requestId, new RegExp(`^agent/${state.agentId}/\\d+/${state.trajectoryId}/1$`));
});

test("buildRequest advances stepIndex and retains sessionId and trajectory across turns", () => {
	clearAntigravitySessions();
	const model = fakeModel("gemini-3.8-flash");
	const context = normalizeContext({
		messages: [
			{ role: "user", content: [{ type: "text", text: "task step 1" }] },
		],
	} as never);

	const req1 = buildRequest(model, context, "proj-1", {}, "gemini-3.8-flash-high");
	assert.match(req1.request.sessionId!, /^-[0-9]+$/);
	assert.equal(req1.request.labels!.last_step_index, "0");
	assert.equal(req1.request.labels!.last_execution_id, undefined);

	// Simulate turn 2
	const req2 = buildRequest(model, context, "proj-1", {}, "gemini-3.8-flash-high");
	assert.equal(req2.request.sessionId, req1.request.sessionId);
	assert.equal(req2.request.labels!.trajectory_id, req1.request.labels!.trajectory_id);
	assert.equal(req2.request.labels!.last_step_index, "1");
});

test("sanitizeText replaces lone surrogates", () => {
	assert.equal(sanitizeText("a\uD800b"), "a\uFFFDb");
	assert.equal(sanitizeText(undefined), "");
});

test("request envelope labels use claude flags and model enums", () => {
	const claude = antigravityRequestEnvelope("claude-opus-4-6-thinking", true);
	assert.equal(claude.labels.used_claude, "true");
	assert.match(claude.requestId, /^agent\//);
	const gemini = antigravityRequestEnvelope("gemini-3.1-pro-low", false);
	assert.equal(gemini.labels.used_claude, "false");
	assert.equal(gemini.labels.model_enum, "MODEL_PLACEHOLDER_M36");
});

/* ------------------------------- auth/oauth ------------------------------ */

test("getApiKey serializes token + projectId for the stream layer", () => {
	const key = getApiKey({ access: "tok", refresh: "r", expires: 0 });
	const parsed = JSON.parse(key) as { token: string; projectId: string };
	assert.equal(parsed.token, "tok");
	assert.equal(parsed.projectId, defaultProjectId("antigravity-default"));
	const withProject = getApiKey({ access: "tok", refresh: "r", expires: 0, projectId: "p9", email: "me@x.com" });
	assert.equal((JSON.parse(withProject) as { projectId: string }).projectId, "p9");
});

/* -------------------------------- image.ts ------------------------------- */

test("image save paths are contained to the working directory", () => {
	const cwd = join(tmpdir(), "pikit-image-test");
	assert.throws(() => resolveImageSavePath(cwd, "../escape.png"), /inside the working directory/);
	const inDir = resolveImageSavePath(cwd, "sub/dir/shot.png", "image/png");
	assert.equal(inDir, join(cwd, "sub", "dir", "shot.png"));
	const fallback = resolveImageSavePath(cwd, undefined, "image/png");
	assert.ok(fallback.includes(join(".pi", "generated-images")));
	assert.ok(fallback.endsWith(".png"));
});

test("image command args parse flags and prompt", () => {
	const parsed = parseImageCommandArgs("--ratio 16:9 --model gemini-3-pro-image --path out.png a cozy cabin");
	assert.equal(parsed.aspectRatio, "16:9");
	assert.equal(parsed.model, "gemini-3-pro-image");
	assert.equal(parsed.path, "out.png");
	assert.equal(parsed.prompt, "a cozy cabin");
});

test("image generation uses the supported model as its default", async () => {
	const models: string[] = [];
	const imageResponse = `data: ${JSON.stringify({
		response: {
			candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }],
		},
	})}\n\n`;

	await withFetchStub(
		(_url, _call, init) => {
			assert.equal(typeof init?.body, "string");
			models.push((JSON.parse(init.body as string) as { model: string }).model);
			return new Response(imageResponse, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
		async (calls) => {
			const result = await generateAntigravityImage({
				apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
				cwd: testTempDir,
				path: "default-image.png",
				prompt: "a test image",
			});
			assert.equal(DEFAULT_IMAGE_MODEL, "gemini-3.1-flash-image");
			assert.deepEqual(models, ["gemini-3.1-flash-image"]);
			assert.equal(calls.length, 1);
			assert.equal(result.model, "gemini-3.1-flash-image");
		},
	);
});

test("explicit retired image-model override falls back to the new default", async () => {
	const models: string[] = [];
	const imageResponse = `data: ${JSON.stringify({
		response: {
			candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }],
		},
	})}\n\n`;

	await withFetchStub(
		(_url, _call, init) => {
			assert.equal(typeof init?.body, "string");
			const model = (JSON.parse(init.body as string) as { model: string }).model;
			models.push(model);
			if (model === "gemini-3-pro-image") {
				return errorResponse(404, "Requested entity was not found");
			}
			return new Response(imageResponse, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
		async (calls) => {
			const result = await generateAntigravityImage({
				apiKey: JSON.stringify({ token: "token-1", projectId: "project-1" }),
				cwd: testTempDir,
				path: "override-fallback.png",
				prompt: "a test image",
				model: "gemini-3-pro-image",
			});
			assert.deepEqual(models, [
				"gemini-3-pro-image",
				"gemini-3-pro-image",
				"gemini-3-pro-image",
				"gemini-3.1-flash-image",
			]);
			assert.equal(calls.length, 4);
			assert.equal(result.model, "gemini-3.1-flash-image");
		},
	);
});

test("image model and aspect ratio validation", () => {
	assert.equal(DEFAULT_IMAGE_MODEL, "gemini-3.1-flash-image");
	assert.equal(assertSafeImageModel(DEFAULT_IMAGE_MODEL), DEFAULT_IMAGE_MODEL);
	assert.equal(assertSafeImageModel("gemini-3-pro-image"), "gemini-3-pro-image");
	assert.equal(assertSafeImageModel("imagen-4.0"), "imagen-4.0");
	assert.throws(() => assertSafeImageModel("claude-sonnet-4-6"), /Unsupported image model/);
	assert.throws(() => assertSafeImageModel("gemini-3-pro-image; rm -rf /"), /Unsupported image model/);
	assert.equal(assertSafeAspectRatio("16:9"), "16:9");
	assert.throws(() => assertSafeAspectRatio("7:3"), /Unsupported aspect ratio/);
});
