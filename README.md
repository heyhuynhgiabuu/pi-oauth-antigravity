# @heyhuynhgiabuu/pi-oauth-antigravity

Google Antigravity OAuth provider extension for [Pi](https://pi.dev). Connects Pi directly to Google Cloud Code Assist / Antigravity with zero-friction OAuth login, day-one support for **Gemini 3.8 Flash**, prompt-cache session affinity, and image generation.

## Features

- **Google OAuth Login**: Browser-based PKCE flow with local loopback callback (`localhost:51121`) and headless paste-URL fallback. Automatically handles token refresh with `AbortSignal` forwarding.
- **Day-One Gemini 3.8 Flash**: First-class support for `gemini-3.8-flash` with dynamic effort-tier routing (`-low`, `-medium`, `-high`), 65,536 max output token clamping, and fallback resilience.
- **Prompt Cache Affinity & Trajectory Chaining**:
  - Deterministic 63-bit session IDs derived from initial turn content.
  - Monotonic trajectory tracking (`agentId`, `trajectoryId`, `stepIndex`).
  - Response ID chaining via `labels.last_execution_id`.
  - Endpoint stickiness to prevent cluster hopping across Google's daily and fallback endpoints.
  - Cross-restart session state persistence (`.pi/agent/cache/antigravity-sessions.json`) to maintain cluster affinity across quick Pi restarts.
- **Image Generation**: Built-in `generate_image` tool and `/antigravity.image` command powered by Google's image models with aspect-ratio selection and safe directory containment.
- **Diagnostic & Usage Tools**:
  - `/antigravity.usage` — token counts, cache read efficiency, and session metrics.
  - `/antigravity.models` — backend discovery of available Cloud Code Assist models.
  - `/antigravity.doctor` — connection check, token expiry inspection, and diagnostic dump.

## Supported Models

| Public Model ID | Backend Wire ID | Max Output | Context Window |
| :--- | :--- | :--- | :--- |
| `antigravity/gemini-3.8-flash` | `gemini-3.8-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.7-flash` | `gemini-3.7-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.7-flash-thinking` | `gemini-3.7-flash-thinking` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.6-flash` | `gemini-3.6-flash-{low,medium,high}` | 65,536 | 1,048,576 |
| `antigravity/gemini-3.1-pro` | `gemini-3.1-pro` | 65,536 | 1,048,576 |
| `antigravity/claude-sonnet-4-6` | `claude-sonnet-4-6` | 64,000 | 200,000 |
| `antigravity/claude-opus-4-6` | `claude-opus-4-6` | 64,000 | 200,000 |
| `antigravity/gpt-oss-120b` | `gpt-oss-120b` | 8,192 | 131,072 |

## Installation

Install directly into Pi via npm:

```bash
pi install npm:@heyhuynhgiabuu/pi-oauth-antigravity
```

Or run directly from source:

```bash
pi -e /path/to/pi-oauth-antigravity/dist/index.js
```

## Setup & Login

1. Run Pi and start the OAuth login:
   ```bash
   pi auth login --provider antigravity
   ```
2. Your browser will open the Google Sign-In page. Sign in with your Google account.
3. Once authenticated, the extension saves credentials and discovers your available Cloud Code Assist project.
4. Select or switch to any Antigravity model:
   ```bash
   pi --model antigravity/gemini-3.8-flash
   ```

## Slash Commands

- `/antigravity.usage` — View current session usage, cached token statistics, and cost estimates.
- `/antigravity.models` — List dynamically fetched and statically registered models.
- `/antigravity.doctor` — Diagnose OAuth state, refresh token health, and endpoint connectivity.
- `/antigravity.image <prompt> [--aspect 1:1|16:9|...]` — Generate images directly to your project.

## Development

```bash
# Install dependencies
npm install

# Run unit tests (50 tests)
npm test

# Typecheck
npm run typecheck

# Build TypeScript to dist/
npm run build
```

## Credits & Upstream

Vendored and adapted from [Rahularya01/pi-antigravity](https://github.com/Rahularya01/pi-antigravity) (MIT License) with prompt-cache session affinity, day-one Gemini 3.8 Flash catalog, response chaining, and cross-process persistence.

## License

[MIT](LICENSE) © 2026 huynhgiabuu
