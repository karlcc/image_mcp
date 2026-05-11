# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — Compile TypeScript to `build/` (runs `tsc` then chmod index.js and cli.js as executable)
- `npm run dev` — Dev mode with `tsx watch` (hot reload)
- `npm test` — Run full Jest suite
- `npm run test:watch` — Jest in watch mode
- `npx jest tests/basic.test.ts` — Run a single test file
- `npm run lint` / `npm run lint:fix` — ESLint on `src/`
- `npm run type-check` — `tsc --noEmit`
- `npm run test:smoke` — Vision smoke tests (requires `IMAGE_MCP_SMOKE=1` + live API config)
- `npm run preflight` — Lint + type-check + smoke tests (pre-release gate)
- `npm run benchmark:models` — Accuracy benchmark harness (`scripts/benchmark-models.mjs`, uses MCP SDK client). Requires `~/.config/image_mcp/model_candidates.json` with a `models` array.
- `image-mcp read <path>` — CLI: analyze one image
- `image-mcp compare <p1> <p2>` — CLI: compare two images
- `image-mcp config` — CLI: show current config
- `image-mcp config --init --api-key <k> --base-url <u> --model <m>` — CLI: write persistent config
- `image-mcp read --smoke-test` — CLI: verify vision backend connectivity
- `image-mcp install-skill` — CLI: install SKILL.md to ~/.claude/skills/

## Architecture

Hybrid MCP server + CLI tool that proxies image files to an OpenAI-compatible vision endpoint. Two transport modes for MCP: **stdio** (default) and **HTTP/SSE** (enabled via `--http` or `MCP_USE_HTTP=true`). CLI provides direct Bash access to the same core logic via subcommands.

### Source files

| File | Role |
|---|---|
| `src/config.ts` | Pure config resolution. Exports `resolveConfig(overrides)`, `loadConfigFile()`, `saveConfigFile()`, parsing helpers (`parseBoolean`, `parseInteger`, `parseNonEmptyString`), `maskApiKey()`, `ConfigSchema`, `Config` type, `ReasoningEffort` type, `CliOverrides` interface, `DEFAULT_CONFIG_PATH`. No Commander — pure functions for shared use by MCP and CLI entry points. |
| `src/mcp-config.ts` | `ConfigManager` singleton. Uses Commander + `resolveConfig()` from config.ts. Parses `process.argv` immediately on construction. Exports `configManager`. MCP server entry point imports this. |
| `src/image-processor.ts` | `ImageProcessor` static class. Normalizes input (`@`-prefix shorthand, `file://` stripping), detects input type (file path / HTTP URL / data URL / raw base64), reads and converts all inputs to base64 data URLs for the API. Validates MIME type and 10MB size limit. |
| `src/handlers.ts` | Shared core business logic with dependency injection. Exports `HandlerContext` interface, `readImage()`, `compareImages()`, `extractMessageText()`, `buildChatRequest()`, `executeChatRequest()`, `withRetry()`. Handlers return plain text strings — MCP and CLI wrap results in their own format. |
| `src/index.ts` | MCP server entrypoint. Registers 3 MCP tools and their handlers. Creates `HandlerContext` from `configManager` singletons. `dispatchToolCall` switch routes by tool name. Stdio and HTTP/SSE transport setup. |
| `src/cli.ts` | CLI entrypoint. Commander subcommands: `read`, `compare`, `config`, `install-skill`. Uses `resolveConfig()` directly (no ConfigManager). Creates `HandlerContext` per invocation. Output modes: default (text), `--json` (structured envelope), `--raw`. Exit codes: 0/1/2/3. |
| `src/openai-client.ts` | `OpenAIClient` class. Axios-based client with exponential-backoff retry (1s→2s→4s→..., capped 30s). Supports streaming and non-streaming chat completions. Retries on network errors, 5xx, and 429. |
| `src/vision-response.ts` | Vision guard system — `buildVisionGuardPrompt()` appends anti-hallucination instructions to user prompts; `assertVisionResponse()` validates API responses don't contain non-vision text patterns. `stripGrokAssetUrls()` removes hosted asset URLs that some gateways (e.g. grok2api) append to responses. |
| `src/vision-probe.ts` | Runtime probe to detect whether the configured model supports vision/image inputs. |

### Data flow

**MCP path**: MCP tool call → `index.ts` handler → `handlers.ts` → `ImageProcessor` → `OpenAIClient` → response text → MCP content envelope

**CLI path**: `image-mcp <subcommand>` → `cli.ts` → `resolveConfig()` → `handlers.ts` → `ImageProcessor` → `OpenAIClient` → response text → stdout (text/JSON/raw)

### Key patterns

- **Shared core via handlers.ts** — `readImage()`, `compareImages()`, and utility functions live in handlers.ts with `HandlerContext` DI. Both MCP (index.ts) and CLI (cli.ts) call the same functions.
- **Config resolution is pure** — `resolveConfig()` in config.ts has no side effects. ConfigManager (mcp-config.ts) wraps it with Commander for the MCP entry point. CLI uses `resolveConfig()` directly with its own Commander options.
- **ConfigManager is a singleton** (`configManager` exported from `mcp-config.ts`) — constructed at import time, parses `process.argv` immediately. Tests must mock/restore `process.argv` and `process.env` for isolation.
- **ImageProcessor is all static methods** — no state, no instantiation needed.
- **Streaming is controlled by `streaming` config only** — no longer gated on `useHttp`. Stdio mode can stream when `streaming=true`.
- **`reasoning_effort` is conditionally injected** — only added to chat requests when `getReasoningEffort()` returns a value. Not included by default.
- **Thinking models** — some models return analysis in `reasoning_content` or `reasoning` instead of `content`. `extractMessageText()` checks all three fields.
- **Grok asset URL stripping** — gateways like grok2api append `https://assets.grok.com/...` image URLs to responses; these are stripped by `assertVisionResponse()`.
- **Image-type-aware default prompts** — `DEFAULT_SUMMARIZE_PROMPT` and `DEFAULT_COMPARE_PROMPT` in `handlers.ts` guide the model toward OCR, UI description, chart extraction, or scene description depending on content. Tool schema `default` fields must stay in sync.
- **Grok model access tiers** — `grok-4.20-auto` and `grok-4.20-beta` return 403 for basic-tier accounts; only `grok-4.20-fast` works reliably. Do not add AUTO/EXPERT models to `model_candidates.json`.
- **Module type: ESM** (`"type": "module"` in package.json). TypeScript targets ES2022 with ESNext modules. Imports use `.js` extension for compiled output.
- **3 MCP tools**: `read_image_via_vision_backend`, `compare_images_via_vision_backend`, `get_config_info`. The image tools accept local absolute paths, http(s) URLs, and data URLs.
- **4 CLI subcommands**: `read`, `compare`, `config`, `install-skill`. CLI binary is `image-mcp` (distinct from MCP binary `image_mcp`).
- **Server instructions field** — the `Server` constructor includes `instructions` describing the vision-capable backend.
- **Vision guard** — all image prompts pass through `buildVisionGuardPrompt()` and responses through `assertVisionResponse()` to prevent hallucinated non-vision text.
- **SKILL.md** — agent skill definition at `skills/image_mcp/SKILL.md`. Installed via `image-mcp install-skill` to `~/.claude/skills/image_mcp/`.
- **Version sync** — three places must match when bumping: `package.json` version, `.claude-plugin/plugin.json` version, `cli.ts` `pkgVersion` constant (line 11).
- **Plugin structure** — "Skill-Focused Plugin" pattern: `.claude-plugin/plugin.json` + `skills/image_mcp/SKILL.md`. No `commands/` or `agents/` dirs needed. Shipped via `files` field in package.json (`build/`, `skills/`, `.claude-plugin/`).
- **SKILL.md frontmatter** — `name` and `description` are required. `argument-hint` is a valid Claude Code extension but has no functional effect for tool-matched skills (only useful with `allowed-tools` slash commands). Omit it unless the skill becomes a slash command.
- **Vision detection layers** — three built-in: `image-mcp read --smoke-test` (tiny fixture), `npm run test:smoke` (Jest, requires `IMAGE_MCP_SMOKE=1`), `npm run benchmark:models` (accuracy + latency).
- **npm publish** — uses OIDC trusted publishing (no `NODE_AUTH_TOKEN` secret). One-time setup: `npx -y npm@latest trust github @karlcc/image_mcp --repo karlcc/image_mcp --file publish.yml --yes`. CI triggers on `v*` tags via `.github/workflows/publish.yml`.

## Testing

- Jest with ts-jest preset, node environment
- `tests/basic.test.ts` — unit tests for ImageProcessor and OpenAIClient
- `tests/config.test.ts` — ConfigManager tests (requires argv/env mocking; imports from `mcp-config`)
- `tests/integration.test.ts` — requires mock server at `localhost:9293`
- `tests/transport.test.ts` — MCP tool discovery and instructions over stdio transport
- `tests/vision-failure.test.ts` — vision guard assertion failures
- `tests/vision-smoke.test.ts` — live vision pipeline smoke tests, gated by `IMAGE_MCP_SMOKE=1`
- `tests/vision-utils.test.ts` — extractMessageText and stripGrokAssetUrls unit tests (imports from `handlers`)
- `tests/mock-server.js` — local mock OpenAI-compatible server on port 9293 for integration tests
- Module alias: `@/*` maps to `src/*` in both tsconfig and jest config
