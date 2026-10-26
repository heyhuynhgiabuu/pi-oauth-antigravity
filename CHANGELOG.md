# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional [`pi-usage-core`](https://github.com/ReStranger/pi-usage-core) integration. When that extension is loaded, Antigravity quota pools (Gemini 5h/weekly, Claude+GPT) and account details are also registered into its unified `/usage` dashboard and persistent footer status line. `pi-usage-core` is not a runtime dependency: with or without it, this package works on its own.
- `/antigravity.doctor` now reports which usage mode is active on a `usageCore=` line.

### Changed
- `/antigravity.usage` remains available as a standalone command and now appends a one-line tip when `pi-usage-core` is installed, instead of being replaced by the integration.

### Fixed
- A background quota poll no longer overwrites the diagnostics `/antigravity.doctor` reports. Quota reads run in a detached bag, so a failed usage fetch (e.g. free-tier `SUBSCRIPTION_REQUIRED`) is no longer shown as the last model request's error.
- A quota group whose buckets were all filtered out no longer produced a `ready` account with an empty pool, and no longer suppressed the per-model quota fallback.
- Bucket periods are mapped from the reported window instead of collapsing every non-5h bucket to `weekly`, so daily and monthly quotas are no longer mislabelled in the footer's multi-window format.
- Free-tier quota synthesized from the model catalog is labelled `total` instead of claiming a 5h session the backend never reported.
- Groups sharing a model family no longer produce duplicate pool ids.
- The account email is masked before it is displayed in a usage dashboard.
- The `auth.json` credential fallback now uses the host's `readStoredCredential`, and a stored token without an expiry is usable instead of being silently ignored.

## [0.1.8] - 2026-10-15

### Fixed
- Default Antigravity client version raised from 2.8.0 to 2.23.0, since Cloud Code rejects newer models such as Gemini 4 Argon (reported as 429 "Resource has been exhausted") for older clients. Override with `ANTIGRAVITY_HUB_VERSION`.
- A transient 429 on a non-default endpoint now falls through to the remaining endpoints instead of failing immediately; plan-quota 429s still fail fast.

## [0.1.7] - 2026-10-15

### Added
- Claude Opus 5.5 and Claude Sonnet 5.5 (Low / Medium / High) catalog entries. Context and output limits are provisional same-family estimates.
- Provisional `gemini-4-argon` (Low / Medium / High) catalog entry, inferred from runtime ids referenced by Antigravity IDE 2.23.0, with fallback to Gemini 3.8 Flash when the backend rejects it. Limits and pricing are unverified.

## [0.1.6] - 2026-10-01

### Fixed
- Kept the provider loadable in packaged Pi runtimes by moving pi-ai subpath helpers into a local module, matched to the resolved pi-ai 0.86.0 implementation.
- Excluded Gemini 3.5 Flash from the selectable catalog and added a pre-stream guard for the reported retirement notice so it is not emitted as assistant text.
- Defaulted image generation to `gemini-3.1-flash-image` while retaining older image models as explicit fallbacks.
- Made image path assertions portable across Windows and POSIX systems.

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
