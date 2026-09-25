# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2026-09-26

### Fixed
- **`403 VALIDATION_REQUIRED` now reports the account verification Google actually requires.** When an account is blocked pending identity/phone verification, the error details carry a `validation_url` that the provider previously discarded, so users were told to "re-login or try another model" — neither of which can clear an account-level block. The message now links Google's verification flow, states that re-login and model switching will not help, and points at `/login antigravity` with another personal Google account as the alternative. Supplied links are rendered only when they are `https` URLs on Google-owned hosts, so a compromised or proxied response body cannot turn the error into a phishing link.

## [0.1.4] - 2026-09-20

### Fixed
- Kept Antigravity tool declarations on the plain JSON-schema compatibility path while retaining `VALIDATED` tool calling, so optional arguments are not rewritten as required by Pi's strict-prefer schema helper.

## [0.1.3] - 2026-09-20

### Fixed
- Avoided loading `@earendil-works/pi-ai/utils/transcript` at runtime so the provider remains loadable with Pi installations that expose transcript support differently; legacy prompt/tool contexts are adapted locally.

## [0.1.2] - 2026-09-20

### Changed
- Updated the Pi dependencies to 0.86.0 and migrated the provider to normalized `TranscriptContext` prompts and tool declarations.

### Fixed
- **Gemini 3 tool schemas now use Pi's strict-prefer contract** before `VALIDATED` tool calling, preserving nullable optional arguments and rejecting unknown properties at the model boundary.
- **Gemini 3 tool-call replay now preserves matching sanitized IDs** in both function calls and function responses, reducing malformed or unexpected function-call failures.

## [0.1.1] - 2026-09-15

### Fixed
- **Transient throttles are no longer reported as quota exhaustion.** Only `Individual quota reached` (plan quota) maps to "Quota reached"; shared-capacity smoothing, per-minute rate limits, and generic `RESOURCE_EXHAUSTED` now report a transient throttle with the HTTP status and backend message preserved, so the host's retry classifier can retry them instead of failing the turn. Account-limit phrases inside the quoted backend text (e.g. `quota exceeded`) are neutralized so a transient throttle is not misclassified as non-retryable.
- **Transient 429s retry in place with backoff.** A throttled request is retried up to twice on the same endpoint (2s, then 4s; override via `ANTIGRAVITY_THROTTLE_BASE_DELAY_MS`) instead of hopping to the sandbox/production endpoints, which multiplied load on an already-throttled account.
- **Plan-quota 429s fail fast** without retrying or hopping endpoints, since the limit cannot clear before its reset time.
- **Backoff is abort-aware**: cancelling a turn stops the retry immediately.

## [0.1.0] - 2026-09-02

### Added
- **Google Antigravity OAuth Provider**: Complete PKCE browser flow with local loopback callback (`localhost:51121`) and headless paste-URL support.
- **Gemini 3.8 Flash Day-One Support**: Support for `gemini-3.8-flash` with dynamic effort-tier routing (`-low`, `-medium`, `-high`), 65,536 max output token limits, and fallback chain.
- **Prompt Cache Affinity & Trajectory Chaining**:
  - Deterministic 63-bit session IDs derived from initial turn content to preserve KV-cache cluster routing.
  - Trajectory state tracking (`agentId`, `trajectoryId`, `stepIndex`).
  - Response ID chaining via `labels.last_execution_id` from SSE responses.
  - Endpoint stickiness (`lastGoodEndpoint`) across Cloud Code Assist cluster endpoints.
  - Cross-process session state persistence in `.pi/agent/cache/antigravity-sessions.json` to retain affinity across Pi restarts.
- **Image Generation**: Built-in `generate_image` tool and `/antigravity.image` command powered by Google's image models with aspect-ratio validation and directory containment.
- **Slash Commands**:
  - `/antigravity.usage` for session token statistics and cache metrics.
  - `/antigravity.models` for model catalog discovery.
  - `/antigravity.doctor` for connection health and token validation.
- **Test Suite**: 42 unit tests covering catalog routing, fallbacks, thinking, message conversion, security, session affinity, and cross-process restart persistence.
