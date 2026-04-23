# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — Compile TypeScript to `build/` (runs `tsc` then chmod index.js as executable)
- `npm run dev` — Dev mode with `tsx watch` (hot reload)
- `npm test` — Run full Jest suite
- `npm run test:watch` — Jest in watch mode
- `npx jest tests/basic.test.ts` — Run a single test file
- `npm run lint` / `npm run lint:fix` — ESLint on `src/`
- `npm run type-check` — `tsc --noEmit`
- `npm run test:smoke` — Vision smoke tests (requires `IMAGE_MCP_SMOKE=1` + live API config)
- `npm run preflight` — Lint + type-check + smoke tests (pre-release gate)
- `npm run benchmark:models` — Accuracy benchmark harness (`scripts/benchmark-models.mjs`, uses MCP SDK client)

## Architecture

MCP server that proxies image files to an OpenAI-compatible vision endpoint. Two transport modes: **stdio** (default) and **HTTP/SSE** (enabled via `--http` or `MCP_USE_HTTP=true`).

### Source files

| File | Role |
|---|---|
| `src/config.ts` | `ConfigManager` singleton. Parses CLI args (commander) + env vars + defaults via zod schema. Config precedence: CLI > env > defaults. Persistent config saved to `~/.config/image_mcp/config.json`. |
| `src/image-processor.ts` | `ImageProcessor` static class. Normalizes input (`@`-prefix shorthand, `file://` stripping), detects input type (file path / HTTP URL / data URL / raw base64), reads and converts all inputs to base64 data URLs for the API. Validates MIME type and 10MB size limit. |
| `src/openai-client.ts` | `OpenAIClient` class. Axios-based client with exponential-backoff retry (1s→2s→4s→..., capped 30s). Supports streaming and non-streaming chat completions. Retries on network errors, 5xx, and 429. |
| `src/index.ts` | Server entrypoint. Registers 3 MCP tools and their handlers. `dispatchToolCall` switch routes by tool name. Stdio and HTTP/SSE transport setup. |
| `src/vision-response.ts` | Vision guard system — `buildVisionGuardPrompt()` appends anti-hallucination instructions to user prompts; `assertVisionResponse()` validates API responses don't contain non-vision text patterns. |
| `src/vision-probe.ts` | Runtime probe to detect whether the configured model supports vision/image inputs. |

### Data flow

1. MCP tool call → `index.ts` handler
2. Handler calls `ImageProcessor.processImage()` → returns `{ url: data:image/...;base64,... }`
3. Handler builds OpenAI chat completion request with prompt + base64 image(s)
4. `OpenAIClient.chatCompletion()` sends to configured endpoint
5. Response text returned as MCP content

### Key patterns

- **ConfigManager is a singleton** (`configManager` exported from `config.ts`) — constructed at import time, parses `process.argv` immediately. Tests must mock/restore `process.argv` and `process.env` for isolation.
- **ImageProcessor is all static methods** — no state, no instantiation needed.
- **Streaming is HTTP-only** — stdio mode always uses non-streaming requests; SSE mode can stream when enabled.
- **Module type: ESM** (`"type": "module"` in package.json). TypeScript targets ES2022 with ESNext modules. Imports use `.js` extension for compiled output.
- **3 MCP tools**: `read_image_via_vision_backend`, `compare_images_via_vision_backend`, `get_config_info`. The image tools accept local absolute paths, http(s) URLs, and data URLs.
- **Server instructions field** — the `Server` constructor includes `instructions` describing the vision-capable backend.
- **Vision guard** — all image prompts pass through `buildVisionGuardPrompt()` and responses through `assertVisionResponse()` to prevent hallucinated non-vision text.

## Testing

- Jest with ts-jest preset, node environment
- `tests/basic.test.ts` — unit tests for ImageProcessor and OpenAIClient
- `tests/config.test.ts` — ConfigManager tests (requires argv/env mocking)
- `tests/integration.test.ts` — requires mock server at `localhost:9293`
- `tests/transport.test.ts` — MCP tool discovery and instructions over stdio transport
- `tests/vision-failure.test.ts` — vision guard assertion failures
- `tests/vision-smoke.test.ts` — live vision pipeline smoke tests, gated by `IMAGE_MCP_SMOKE=1`
- `tests/mock-server.js` — local mock OpenAI-compatible server on port 9293 for integration tests
- Module alias: `@/*` maps to `src/*` in both tsconfig and jest config
