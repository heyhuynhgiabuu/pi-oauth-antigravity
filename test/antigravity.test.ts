import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANTIGRAVITY_MODELS,
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
import { getApiKey } from "../src/auth/index.js";
import {
	assertSafeAspectRatio,
	assertSafeImageModel,
	parseImageCommandArgs,
	resolveImageSavePath,
} from "../src/image/image.js";
import { getCurrentSystemPrompt, getCurrentTools } from "../src/stream/transcript.js";
import { createAssistantMessageEventStream, isRetryableAssistantError, normalizeContext, Type } from "@earendil-works/pi-ai";
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";

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
	respond: (url: string, call: number) => Response,
	fn: (calls: string[]) => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		return respond(url, calls.length);
	}) as typeof fetch;
	try {
		await fn(calls);
	} finally {
		globalThis.fetch = original;
	}
}

const STREAM_OK_SSE =
	'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n';

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
): Promise<{ stopReason: string; errorMessage?: string }> {
	const stream = streamAntigravity(
		fakeModel("gemini-3.8-flash"),
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

test("model catalog mirrors agy models with per-model thinking maps", () => {
	assert.equal(PROVIDER_ID, "antigravity");
	assert.equal(ANTIGRAVITY_MODELS.length, 8);
	const ids = ANTIGRAVITY_MODELS.map((m) => m.id).sort();
	assert.deepEqual(ids, [
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"gemini-3.1-pro",
		"gemini-3.5-flash",
		"gemini-3.6-flash",
		"gemini-3.7-flash",
		"gemini-3.8-flash",
		"gpt-oss-120b",
	]);
	for (const model of ANTIGRAVITY_MODELS) {
		assert.ok((model as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap);
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
	assert.equal(getAntigravityRequestModelId("gemini-3.5-flash", "off"), "gemini-3.5-flash-extra-low");
	assert.equal(getAntigravityRequestModelId("gemini-3.5-flash", "high"), "gemini-3-flash-agent");
	assert.equal(getAntigravityRequestModelId("gemini-3.1-pro", "high"), "gemini-pro-agent");
	assert.equal(getAntigravityRequestModelId("claude-sonnet-4-6", "high"), "claude-sonnet-4-6");
	assert.equal(getAntigravityRequestModelId("unknown-model", "high"), "unknown-model");
});

test("fallback runtime model covers next-gen gemini only", () => {
	assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-high"), "gemini-3.7-flash-high");
	assert.equal(getFallbackRuntimeModel("gemini-3.8-flash"), "gemini-3.7-flash-low");
	assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-tiered"), "gemini-3.7-flash-low");
	assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-high"), "gemini-3.6-flash-high");
	assert.equal(getFallbackRuntimeModel("gemini-3.7-flash"), "gemini-3.6-flash-low");
	assert.equal(getFallbackRuntimeModel("claude-sonnet-4-6"), undefined);
	assert.equal(getFallbackRuntimeModel("gemini-3.5-flash-low"), undefined);
});

test("max output tokens clamp per runtime id", () => {
	assert.equal(getMaxOutputTokens("gemini-3.7-flash", "gemini-3.7-flash-high"), 65536);
	assert.equal(getMaxOutputTokens("gemini-3.8-flash", "gemini-3.8-flash-high"), 65536);
	assert.equal(getMaxOutputTokens("gemini-3.8-flash", "gemini-3.8-flash-tiered"), 65536);
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
	const budget = getThinkingConfig("gemini-3.5-flash", "high");
	assert.equal((budget as { thinkingBudget?: number }).thinkingBudget, 10_000);
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

test("buildRequest sends plain schemas to Cloud Code Assist VALIDATED mode", () => {
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
	assert.deepEqual(request.request.systemInstruction.parts, [{ text: "You are pi." }]);
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

test("friendly errors are actionable and redacted", () => {
	assert.match(friendlyAntigravityError(401, "unauthorized"), /\/login antigravity/);
	assert.match(friendlyAntigravityError(429, "Individual quota reached. Resets in 23m."), /23m/);
	assert.match(friendlyAntigravityError(404, "Requested entity was not found"), /switch to/);
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
	assert.equal(validation?.learnMoreUrl, "https://support.google.com/accounts?p=al_alert");

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
});

test("403 validation links are only rendered from Google-owned https hosts", () => {
	const withUrl = (validationUrl: string, learnMoreUrl = "https://support.google.com/accounts?p=al_alert") =>
		JSON.stringify({
			error: {
				message: "Verify your account to continue.",
				details: [
					{
						reason: "VALIDATION_REQUIRED",
						metadata: { validation_url: validationUrl, validation_learn_more_url: learnMoreUrl },
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

	// With the primary link dropped, fall back to the learn-more link instead of going silent.
	const fallback = friendlyAntigravityError(403, withUrl("https://evil.example/verify"));
	assert.doesNotMatch(fallback, /evil\.example/);
	assert.match(fallback, /https:\/\/support\.google\.com\/accounts\?p=al_alert/);
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

test("transient 429 retries the same endpoint in place and stays retryable", async () => {
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
					// 1 initial attempt + THROTTLE_MAX_RETRIES in-place retries, all on the primary
					// endpoint: a shared throttle must not be amplified by region hopping.
					assert.equal(calls.length, 3);
					assert.deepEqual([...new Set(calls)], [
						`${DEFAULT_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
					]);
					assert.equal(message.stopReason, "error");
					// Status + backend text survive, so pi's retry classifier can see the 429.
					assert.match(message.errorMessage ?? "", /Antigravity API error \(429/);
					assert.match(message.errorMessage ?? "", /Generate requests per minute per user/);
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

test("antigravityHeaders carry bearer auth and client metadata", () => {
	const headers = antigravityHeaders("tok");
	assert.equal(headers.Authorization, "Bearer tok");
	assert.equal(headers.Accept, "text/event-stream");
	assert.ok(headers["Client-Metadata"].includes("ANTIGRAVITY"));
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
	const gemini = antigravityRequestEnvelope("gemini-3.5-flash-extra-low", false);
	assert.equal(gemini.labels.used_claude, "false");
	assert.equal(gemini.labels.model_enum, "MODEL_PLACEHOLDER_M187");
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
	const cwd = "/tmp/pikit-image-test";
	assert.throws(() => resolveImageSavePath(cwd, "../escape.png"), /inside the working directory/);
	const inDir = resolveImageSavePath(cwd, "sub/dir/shot.png", "image/png");
	assert.ok(inDir.startsWith(`${cwd}/sub/dir/shot.png`));
	const fallback = resolveImageSavePath(cwd, undefined, "image/png");
	assert.ok(fallback.includes(".pi/generated-images/"));
	assert.ok(fallback.endsWith(".png"));
});

test("image command args parse flags and prompt", () => {
	const parsed = parseImageCommandArgs("--ratio 16:9 --model gemini-3-pro-image --path out.png a cozy cabin");
	assert.equal(parsed.aspectRatio, "16:9");
	assert.equal(parsed.model, "gemini-3-pro-image");
	assert.equal(parsed.path, "out.png");
	assert.equal(parsed.prompt, "a cozy cabin");
});

test("image model and aspect ratio validation", () => {
	assert.equal(assertSafeImageModel("gemini-3-pro-image"), "gemini-3-pro-image");
	assert.equal(assertSafeImageModel("imagen-4.0"), "imagen-4.0");
	assert.throws(() => assertSafeImageModel("claude-sonnet-4-6"), /Unsupported image model/);
	assert.throws(() => assertSafeImageModel("gemini-3-pro-image; rm -rf /"), /Unsupported image model/);
	assert.equal(assertSafeAspectRatio("16:9"), "16:9");
	assert.throws(() => assertSafeAspectRatio("7:3"), /Unsupported aspect ratio/);
});
