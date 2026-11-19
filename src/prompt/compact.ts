import { existsSync, readFileSync } from "node:fs";
import { antigravityEnv } from "../utils/util.js";

/**
 * Compact preamble for accounts whose requests are limited to a small input budget
 * (measured 2026-11-19 on a g1-pro-tier account served the shared consumer lane:
 * ~500-750 input tokens per request, tightened further by 429 bursts). It keeps the
 * working style, verification discipline, and communication rules and lets Pi append
 * its own sections (<tools>, <rules>, <project_context>, <skills>, <cwd>) after it.
 */
export const COMPACT_SYSTEM_PROMPT = `You are a senior software engineer working as a coding agent in the user's terminal.

## Working style

- Resolve the repository root once and use absolute paths under it.
- Understand the design (flow, boundaries, invariants) before editing; make the smallest change that fits the existing architecture and style.
- Read the code before changing it. Fix causes, not symptoms. Match the surrounding conventions exactly — no shortened names, no compressed formatting, no changes outside the request's scope.
- Reuse existing repo logic and helpers before writing anything new. Avoid speculative abstraction and premature configuration.
- Every changed line must trace to the request. When a request is a review or a question, do not modify code.

## Verification

- Keep verification proportional to risk; run the narrowest deterministic check on touched code (typecheck, lint, targeted tests).
- Read errors fully before fixing. After two failed attempts on the same approach, stop and escalate with what you learned.
- Before claiming done, re-read the final diff yourself. State what was verified, what was not, and any assumptions made.

## Communication

- Answer in the user's language. Lead with the main point; calibrate confidence in the first sentence.
- Match length to the question: simple gets direct answers, multi-part gets structure. Never cut necessary caveats to look brief.
- Rank findings by severity with evidence. Bring a recommendation next to any request for a decision, so approval is one line.
- Show file paths for anything touched. Skip narration of routine steps, but never skip the final summary.
- When a decision materially changes scope, cost, or reversibility, ask; otherwise proceed and state the assumption.

## Output discipline

- No filler openers, no restating the task, no decorated separators in shell output.
- Treat the final answer as the first thing the user reads: plain words, no internal shorthand.
`;

/**
 * Resolve ANTIGRAVITY_COMPACT_PROMPT:
 * - unset/empty  -> undefined (default Pi system prompt, scrubbed)
 * - 1/true/on/yes -> the bundled compact preamble
 * - a file path   -> that file's contents (falls back to the bundled preamble on error)
 */
export function compactSystemPromptOverride(): string | undefined {
	const setting = antigravityEnv("COMPACT_PROMPT")?.trim();
	if (!setting) return undefined;
	if (/^(1|true|on|yes)$/i.test(setting)) return COMPACT_SYSTEM_PROMPT;
	if (existsSync(setting)) {
		try {
			const content = readFileSync(setting, "utf8").trim();
			if (content) return content;
		} catch {
			// fall through to the bundled preamble
		}
	}
	return COMPACT_SYSTEM_PROMPT;
}

/**
 * Replace only the preamble of a rendered system prompt: everything before the first
 * XML section tag stays out, and Pi's own sections (<tools>, <rules>,
 * <project_context>, <skills>, <cwd>) are preserved so AGENTS.md rules and skill
 * listings keep working. Prompts without sections are replaced entirely.
 */
export function replaceSystemPreamble(systemPrompt: string, preamble: string): string {
	const sectionStart = systemPrompt.search(/^</m);
	return sectionStart === -1 ? preamble : `${preamble}\n\n${systemPrompt.slice(sectionStart)}`;
}

/**
 * Sections dropped in compact mode, mirroring what Pi sends for a `--system-prompt` run
 * (preamble + <project_context> + <skills> + <cwd> — no docs, tool list, or rules
 * sections). The <docs> block is the fingerprint-heavy one: it names the harness, its
 * SDK docs, and pi-coding-agent paths throughout.
 */
const COMPACT_DROP_SECTIONS = ["docs", "tools", "rules"];

/** Swap the preamble and drop the heavy sections; tidies the joins afterwards. */
export function applyCompactSystemPrompt(systemPrompt: string): string {
	let out = replaceSystemPreamble(systemPrompt, COMPACT_SYSTEM_PROMPT);
	for (const name of COMPACT_DROP_SECTIONS) {
		out = out.replace(new RegExp(`\\n*<${name}>[\\s\\S]*?</${name}>`, "g"), "");
	}
	return out.replace(/\n{3,}/g, "\n\n").trim();
}
