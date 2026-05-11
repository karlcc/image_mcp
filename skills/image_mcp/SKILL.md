---
name: image_mcp
description: Use when analyzing images, screenshots, diagrams, charts, or UI layouts. OCR text extraction, visual comparison, UI diff detection, chart data extraction.
---

# image-mcp

Vision-capable CLI for image analysis via OpenAI-compatible backend.

## Quick start

```bash
# Read/OCR an image
image-mcp read /path/to/screenshot.png

# Compare two images
image-mcp compare before.png after.png

# Show current config
image-mcp config
```

## Commands

| Command | Purpose |
|---------|---------|
| `image-mcp read <image> [--task "..."]` | Analyze one image — OCR, describe, extract data |
| `image-mcp read --smoke-test` | Verify config + API connectivity |
| `image-mcp compare <img1> <img2> [...more] [--task "..."]` | Compare 2+ images — diffs, similarities |
| `image-mcp config [--json]` | Show current configuration |
| `image-mcp config --init [--api-key --base-url --model]` | Write config file from flags or env vars |
| `image-mcp install-skill` | Install this skill to ~/.claude/skills/ |

## Global flags

| Flag | Purpose |
|------|---------|
| `-m, --model <model>` | Override model |
| `-k, --api-key <key>` | Override API key |
| `-u, --base-url <url>` | Override API base URL |
| `--reasoning-effort <level>` | none, minimal, low, medium, high, xhigh |
| `--no-streaming` | Disable streaming |
| `--json` | Structured JSON output `{status, data, error, metadata}` |
| `--raw` | Minimal output, no metadata |
| `-c, --config <path>` | Config file path |

## Output format

- **Default**: plain text (compact markdown)
- **`--json`**: `{ "status": "ok"|"error", "data": "...", "error": null|{code, message}, "metadata": {model, latency_ms} }`
- **`--raw`**: result text only, no decoration

Exit codes: 0 = success, 1 = app error, 2 = config error, 3 = invalid args

## Common tasks

- OCR from screenshot: `image-mcp read screenshot.png --task "read all text"`
- Chart data extraction: `image-mcp read chart.png --task "extract data from chart"`
- UI diff: `image-mcp compare before.png after.png --task "describe UI differences"`
- URL image: `image-mcp read https://example.com/img.png`
- JSON output: `image-mcp read diagram.svg --json | jq .data`

## Installation

```bash
npm install -g @karlcc/image_mcp
image-mcp install-skill
```

## Pre-flight check

Before using image-mcp, verify installation:

```bash
which image-mcp || command -v image-mcp
```

If not installed:

```bash
npm install -g @karlcc/image_mcp
```

Fallback (no global install):

```bash
npx @karlcc/image_mcp read <path>
```

Verify config:

```bash
image-mcp config
```

If configuration is incomplete (missing apiKey or model), initialize it:

```bash
image-mcp config --init --api-key <key> --base-url <url> --model <model>
```

This writes to `~/.config/image_mcp/config.json`. Values can also be picked up from env vars (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`).

Verify end-to-end connectivity:

```bash
image-mcp read --smoke-test
# Expected: exit 0, "Vision backend connected successfully"
```
