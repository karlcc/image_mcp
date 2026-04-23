# Image Summarization MCP Server

A Model Context Protocol (MCP) server that accepts image files and sends them to an OpenAI-compatible chat completion endpoint for analysis, description, and comparison tasks.

## Use Case

Many LLMs used for agentic coding are text-only and lack support for image inputs. This tool allows you to use a secondary model dedicated to describing and analyzing images, without having to use a multi-modal LLM for your primary model. It supports both cloud and local LLMs via any server that supports the OpenAI chat completion endpoint (including llama.cpp / llama-swap, Ollama, open-webui, OpenRouter, etc).

For local models, gemma3:4b-it-qat works quite well with a relatively small footprint and fast performance (even on CPU-only).

## Features

- Accepts images via unified `image_path` parameter — local paths, URLs, and data URLs
- Supports `task` parameter to perform specific analysis beyond general description
- Sends images to OpenAI-compatible chat completion endpoints
- Returns detailed image descriptions
- Configurable endpoint URL, API key, and model
- Optional persistent config file at `~/.config/image_mcp/config.json`
- Command-line interface for configuration
- Comprehensive error handling

## Quick install from NPM

Add this to your global `mcp_settings.json` or project `mcp.json`:

```json
{
  "mcpServers": {
    "image_mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@karlcc/image_mcp"
      ],
      "env": {
        "OPENAI_API_KEY": "YOUR_API_KEY",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
        "OPENAI_MODEL": "gemini-3.1-flash-lite-preview"
      }
    }
  }
}
```

If you prefer `claude mcp add-json`, use:

```bash
claude mcp add-json image_mcp --scope user '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@karlcc/image_mcp"],
  "env": {
    "OPENAI_API_KEY": "YOUR_API_KEY",
    "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "OPENAI_MODEL": "gemini-3.1-flash-lite-preview"
  }
}'
```

At a minimum, configure base URL, API key, and model for your chosen backend.

For use with slow local models, you may need to also increase the timeout and max retries settings.

## Configuration

The MCP server can be configured using a config file, environment variables, or command-line arguments.

### Environment Variables

- `OPENAI_API_KEY`: Your API key for the OpenAI-compatible service
- `OPENAI_BASE_URL`: The base URL of the OpenAI-compatible service (default: `http://localhost:9292/v1`)
- `OPENAI_MODEL`: The model to use for image analysis
- `OPENAI_TIMEOUT`: Request timeout in milliseconds (default: 60000). When running local models you may need to increase this.
- `OPENAI_MAX_RETRIES`: Maximum number of retry attempts (default: 3)
- `OPENAI_STREAMING`: Enable/disable streaming (`true`/`false`)
- `MCP_USE_HTTP`: Enable HTTP/SSE transport (`true`/`false`)
- `MCP_PORT`: HTTP port for MCP server (default: `8080`)
- `IMAGE_MCP_CONFIG_PATH`: Override config file path (default: `~/.config/image_mcp/config.json`)

### Command Line Arguments

```bash
npx -y @karlcc/image_mcp \
  --api-key your-api-key \
  --base-url https://api.openai.com/v1 \
  --model gpt-4-vision-preview \
  --http \
  --mcp-port 8080 \
  --timeout 60000 \
  --max-retries 5
```

### Configuration Priority

1. Command-line arguments
2. Environment variables
3. Config file (`~/.config/image_mcp/config.json`)
4. Default values

### Persistent Config

Save your resolved configuration once and reuse it across sessions:

```bash
node build/index.js \
  --api-key your-api-key \
  --base-url https://api.openai.com/v1 \
  --model gpt-4.1-mini \
  --http \
  --mcp-port 8080 \
  --save-config
```

This writes `~/.config/image_mcp/config.json` (or a custom file via `--config /path/to/config.json`).

### Verifying your model has vision

Before committing to a model, verify it can actually see images:

```bash
# Automatic: --save-config verifies vision by default before writing
node build/index.js --model your-model --save-config

# Quick one-shot check:
IMAGE_MCP_SMOKE=1 npm run test:smoke

# Opt-in startup probe (warns in stderr if model can't see):
IMAGE_MCP_PROBE_ON_START=true node build/index.js
```

If verification fails, the config file is **not** written and the exit code is non-zero. Use `--no-verify` to skip the check.

## Usage

### Host model vs vision backend

When the host LLM (e.g. GLM-5.1, Claude Haiku) is text-only, it cannot inspect pixels. Wire `image_mcp` to a vision-capable backend and the host will route image tasks there automatically.

### Z.AI / GLM example

```bash
npx -y @karlcc/image_mcp \
  --base-url https://open.bigmodel.cn/api/paas/v4 \
  --api-key $ZAI_API_KEY \
  --model glm-4.6v-flash
```

The app stays backend-agnostic — any OpenAI-compatible endpoint works. `glm-4.6v-flash` is shown because it is a capable, low-latency vision model available on Z.AI.

### Client routing snippet

Add to your MCP client config (e.g. Claude Desktop, Cursor, or `.claude/settings.json`):

```json
{
  "mcpServers": {
    "image_mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@karlcc/image_mcp@latest"
      ],
      "env": {
        "OPENAI_API_KEY": "YOUR_ZAI_KEY",
        "OPENAI_BASE_URL": "https://open.bigmodel.cn/api/paas/v4",
        "OPENAI_MODEL": "glm-4.6v-flash"
      }
    }
  }
}
```

### MCP Tools

#### `read_image_via_vision_backend`

Reads and analyzes one image via the vision backend. Accepts local absolute paths, http(s) URLs, and data URLs.

##### Parameters

- `image_path` (string): Image to analyze. Supports:
  - Absolute local paths (e.g. `/Users/me/screenshot.png`)
  - HTTP/HTTPS URLs (e.g. `https://example.com/image.jpg`)
  - Data URLs with base64 encoded images (e.g. `data:image/png;base64,...`)
- `task` (string, optional): What to do with the image (e.g. `"Read all text"`, `"Describe the UI layout"`, `"Extract data from chart"`). Defaults to a general description.

##### Example Usage

Using file path:
```json
{
  "name": "read_image_via_vision_backend",
  "arguments": {
    "image_path": "/Users/me/screenshot.png",
    "task": "Read all text in this screenshot"
  }
}
```

Using HTTP URL:
```json
{
  "name": "read_image_via_vision_backend",
  "arguments": {
    "image_path": "https://example.com/image.jpg"
  }
}
```

#### `compare_images_via_vision_backend`

Compares 2 or more images via the vision backend. Accepts local absolute paths, http(s) URLs, and data URLs.

##### Parameters

- `image_paths` (array of strings, min 2): Images to compare. Each entry supports the same formats as `image_path` above.
- `task` (string, optional): What to compare (e.g. `"Describe UI differences"`, `"Which chart shows higher values?"`). Defaults to a general comparison.

##### Example Usage

```json
{
  "name": "compare_images_via_vision_backend",
  "arguments": {
    "image_paths": [
      "/Users/me/before.png",
      "/Users/me/after.png"
    ],
    "task": "Describe the UI differences between these screenshots"
  }
}
```

#### `get_config_info`

Returns the active server configuration for diagnostics with the API key redacted.

## Dev Setup

1. Clone the repository:
```bash
git clone https://github.com/karlcc/image_mcp.git
cd image_mcp
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

4. Starting the Server
```bash
node build/index.js
```

The server will start and listen on stdio for MCP protocol communications.

To run with HTTP/SSE transport:
```bash
node build/index.js --http --mcp-port 8080
```

### MCP Tool Installation (local dev build)

Add this to your global mcp_settings.json or project mcp.json:

```json
{
  "mcpServers": {
    "image_mcp": {
      "command": "node",
      "args": [
        "/path/to/image_mcp/build/index.js"
      ],
      "env": {
        "OPENAI_API_KEY": "YOUR_API_KEY",
        "OPENAI_BASE_URL": "http://localhost:9292/v1",
        "OPENAI_MODEL": "gemma3:4b-it-qat"
      }
    }
  }
}
```

## Testing

### Running Tests

Run the test suite:
```bash
npm test
```

The test suite includes:
- Unit tests for image processing functionality
- Integration tests that require a mock server
- Tests for both `read_image_via_vision_backend` and `compare_images_via_vision_backend` tools

### Model Benchmark (Accuracy + Latency)

Run the built-in benchmark to compare candidate models with weighted accuracy and response latency:

```bash
npm run benchmark:models
```

By default this uses:
- Task file: `bench/tasks.default.json`
- Models: `~/.config/image_mcp/model_candidates.json` (`candidates` array)
- Ranking: weighted accuracy (desc), success rate (desc), median latency (asc)

Useful overrides:

```bash
node scripts/benchmark-models.mjs \
  --models gemma-4-31b,kimi-k2.5-fw,qwen3.5-397b-fw \
  --repeats 2 \
  --tasks bench/tasks.default.json
```

Outputs:
- Raw call-level results at `/tmp/image_mcp_accuracy_benchmark_*.jsonl`
- Summary at `/tmp/image_mcp_accuracy_summary_*.json`
- Auto-updates active model in `~/.config/image_mcp/config.json` (disable with `--no-update-config`)

### Mock Server Testing

The project includes a mock OpenAI-compatible server for testing purposes.

1. Start the mock server in a separate terminal:
```bash
node tests/mock-server.js
```

The mock server will start on `http://localhost:9293` and provides endpoints for:
- `GET /v1/models` - Lists available models
- `POST /v1/chat/completions` - Mock chat completions with image support
- `POST /v1/test/image-process` - Test endpoint for image processing validation

2. Set environment variables for the mock server:
```bash
export OPENAI_BASE_URL=http://localhost:9293/v1
export OPENAI_API_KEY=test-key
export OPENAI_MODEL=test-model-vision
```

3. Run the integration tests:
```bash
npm test tests/integration.test.ts
```

### Real OpenAI-Compatible Server Testing

To test with a real OpenAI-compatible endpoint:

1. Set up your environment variables:
```bash
export OPENAI_API_KEY=your-actual-api-key
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_MODEL=gpt-4-vision-preview
```

Or for other OpenAI-compatible services:
```bash
export OPENAI_API_KEY=your-service-api-key
export OPENAI_BASE_URL=https://your-service-endpoint/v1
export OPENAI_MODEL=your-vision-model
```

2. Start the MCP server:
```bash
node build/index.js --http --mcp-port 8080
```

3. Send test requests using an MCP client or test the tools directly.

### Manual Testing

You can manually test the MCP server using tools like `curl` or MCP clients:

```bash
# Test with a local image file
curl -X POST http://localhost:8080/sse \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "read_image_via_vision_backend",
      "arguments": {
        "image_path": "/path/to/your/test/image.jpg"
      }
    }
  }'
```

## API Reference

### OpenAI-Compatible API Integration

The server sends requests to the OpenAI-compatible chat completion endpoint with the following structure:

```json
{
  "model": "your-model",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Describe this image in detail, including all text."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,..."
          }
        }
      ]
    }
  ],
  "stream": false
}
```

### Supported Image Formats

- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- WebP (.webp)
- SVG (.svg)
- BMP (.bmp)
- TIFF (.tiff)

## Error Handling

The server includes comprehensive error handling for:

- Invalid image files
- Unsupported image formats
- Missing API keys
- Network connectivity issues
- API response errors

## Development

### Project Structure

```
src/
├── config.ts          # Configuration management
├── image-processor.ts # Image processing utilities
├── index.ts          # Main MCP server
└── openai-client.ts  # OpenAI-compatible API client
```

### Building

```bash
npm run build
```

### Testing

```bash
npm test
```

Vision smoke test (requires API credentials):

```bash
IMAGE_MCP_SMOKE=1 npm run test:smoke
```

Full preflight before release:

```bash
npm run preflight
```

### Release: tag and publish to npm

Recommended flow: GitHub Actions trusted publishing (OIDC).

One-time setup (npm package owner):

```bash
# Requires npm v11.10+ and package 2FA enabled on npm.
# If local npm is older, run via npx as shown here.
npx -y npm@latest trust github @karlcc/image_mcp \
  --repo karlcc/image_mcp \
  --file publish.yml \
  --yes
```

Then ship each release with:

```bash
# 1) Verify quality gates
npm run build
npm test

# 2) Commit pending changes
git add -A
git commit -m "chore(release): prepare next version"

# 3) Bump version + create git tag (patch/minor/major)
npm version patch

# 4) Push commit + tag (GitHub Actions publishes to npm)
git push origin main --follow-tags
```

Fallback manual publish (if trusted publishing is not configured):

```bash
npm publish --access public --otp <6-digit-otp>
```

### Dev cycle: four layers of vision detection

The repo is designed so a non-vision model can't slip through silently:

| Layer | When | How |
|---|---|---|
| Config save | `--save-config` | Probes model with a tiny fixture before writing config |
| Smoke test | `npm run test:smoke` | Jest test against the configured model |
| Startup probe | `IMAGE_MCP_PROBE_ON_START=true` | Warns on stderr if model fails |
| Benchmark | `npm run benchmark:models` | `--fail-if-any-nonvision` exits non-zero for 0% scorers |

## License

This project is licensed under the MIT License.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Support

For issues and questions, please open an issue on the GitHub repository.

## Tips

Tips / donations always appreciated to help fund future development.
