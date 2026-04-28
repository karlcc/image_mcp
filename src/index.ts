#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { OpenAIClient } from './openai-client.js';
import { HandlerContext, readImage, compareImages, DEFAULT_SUMMARIZE_PROMPT, DEFAULT_COMPARE_PROMPT } from './handlers.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';

import { configManager } from './mcp-config.js';

// Tool name constants
const TOOL_GET_CONFIG_INFO = 'get_config_info';
const TOOL_READ_IMAGE_VIA_VISION_BACKEND = 'read_image_via_vision_backend';
const TOOL_COMPARE_IMAGES_VIA_VISION_BACKEND = 'compare_images_via_vision_backend';

// Initialize components
const openaiClient = new OpenAIClient(
  configManager.getBaseUrl(),
  configManager.getApiKey(),
  configManager.getTimeout(),
  configManager.getMaxRetries()
);

// Build handler context from module-level singletons
function createHandlerContext(): HandlerContext {
  return {
    client: openaiClient,
    model: configManager.getModel(),
    reasoningEffort: configManager.getReasoningEffort(),
    streaming: configManager.isStreamingEnabled(),
    maxRetries: configManager.getMaxRetries(),
  };
}

// Factory: each MCP transport (stdio or one SSE connection) gets its own
// Server instance. The SDK keeps only one active transport per Server, so
// sharing a single Server across concurrent SSE clients would misroute
// responses/logs between sessions.
function createMcpServer(): Server {
  const server = new Server(
    {
      name: '@karlcc/image_mcp',
      version: '1.0.3',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        logging: {},
      },
      instructions:
        'Vision-capable backend for image inspection (OCR, screenshots, diagrams/charts, UI diffs). Use for any image analysis the host can\'t do natively. Accepts local absolute paths, http(s) URLs, and data URLs.',
    }
  );
  registerHandlers(server);
  return server;
}

function textContent(text: string) {
  return { type: 'text' as const, text };
}

function toolErrorResult(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  return {
    content: [textContent(`Error: ${errorMessage}`)],
    isError: true
  };
}

function requireObjectArgs(args: unknown): Record<string, any> {
  if (!args || typeof args !== 'object') {
    throw new Error('Invalid arguments: expected an object');
  }
  return args as Record<string, any>;
}

// Unified tool dispatch — returns handler result or throws
async function dispatchToolCall(toolName: string, args: Record<string, any>, enableStreaming: boolean) {
  const ctx = createHandlerContext();

  switch (toolName) {
    case TOOL_GET_CONFIG_INFO: {
      const configInfo = configManager.getConfigInfo();
      return { content: [textContent(JSON.stringify(configInfo, null, 2))] };
    }
    case TOOL_READ_IMAGE_VIA_VISION_BACKEND: {
      const validatedArgs = requireObjectArgs(args);
      const imageUrl = validatedArgs.image_path as string;
      if (!imageUrl || typeof imageUrl !== 'string') {
        throw new Error('image_path must be provided as a string');
      }
      const text = await readImage(ctx, imageUrl, validatedArgs.task as string | undefined);
      return { content: [textContent(text)] };
    }
    case TOOL_COMPARE_IMAGES_VIA_VISION_BACKEND: {
      const validatedArgs = requireObjectArgs(args);
      const imageUrls = validatedArgs.image_paths as string[];
      if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
        throw new Error('image_paths must be an array of at least 2 image paths/URLs');
      }
      const text = await compareImages(ctx, imageUrls, validatedArgs.task as string | undefined);
      return { content: [textContent(text)] };
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function registerHandlers(server: Server): void {
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: TOOL_READ_IMAGE_VIA_VISION_BACKEND,
        description: 'Read/OCR/analyze one image (local path, URL, or data URL) via a vision backend.',
        inputSchema: {
          type: 'object',
          properties: {
            image_path: {
              type: 'string',
              description: 'Image to analyze — absolute local path, http(s) URL, or data URL (e.g. /Users/me/screenshot.png, https://example.com/img.png, data:image/png;base64,...)'
            },
            task: {
              type: 'string',
              description: 'What to do with the image (e.g. "Read all text", "Describe the UI layout", "Extract data from chart"). Defaults to a general description.',
              default: DEFAULT_SUMMARIZE_PROMPT
            }
          },
          required: ['image_path'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      {
        name: TOOL_COMPARE_IMAGES_VIA_VISION_BACKEND,
        description: 'Compare 2+ images (local paths, URLs, or data URLs) via a vision backend.',
        inputSchema: {
          type: 'object',
          properties: {
            image_paths: {
              type: 'array',
              items: {
                type: 'string',
                description: 'Image to compare — absolute local path, http(s) URL, or data URL'
              },
              minItems: 2,
              description: 'Array of images to compare (minimum 2 required)'
            },
            task: {
              type: 'string',
              description: 'What to compare (e.g. "Describe UI differences", "Which chart shows higher values?"). Defaults to a general comparison.',
              default: DEFAULT_COMPARE_PROMPT
            }
          },
          required: ['image_paths'],
          additionalProperties: false
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      {
        name: TOOL_GET_CONFIG_INFO,
        description: 'Show current server configuration with API key redacted',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        annotations: { readOnlyHint: true }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  server.sendLoggingMessage({
    level: "info",
    data: JSON.stringify(request.params),
  });

  try {
    const enableStreaming = configManager.isStreamingEnabled();
    return await dispatchToolCall(name, args ?? {}, enableStreaming);
  } catch (error) {
    server.sendLoggingMessage({
      level: "error",
      data: JSON.stringify(error),
    });

    return toolErrorResult(error);
  }
});
}

async function main() {
  try {
    // Handle --verify flag: probe vision capability, then save if --save-config was deferred
    if (configManager.needsVerify) {
      const ok = await configManager.runVerify();
      if (ok && configManager.needsSave) {
        configManager.saveConfig();
      }
      process.exit(ok ? 0 : 1);
    }

    // Optional startup probe: warn (don't exit) if model can't see images
    const probeOnStart = process.env.IMAGE_MCP_PROBE_ON_START === 'true';
    if (probeOnStart) {
      const model = configManager.getModel();
      if (model) {
        try {
          const { probeVisionCapability } = await import('./vision-probe.js');
          const result = await probeVisionCapability(openaiClient, model);
          if (!result.ok) {
            console.error(
              `[VISION PROBE WARNING] Model "${model}" failed vision probe: ${result.reason}` +
              (result.rawResponse ? ` — ${result.rawResponse.slice(0, 150)}` : '') +
              `. Server is running but image tools will likely fail.`
            );
          } else {
            console.error(`[VISION PROBE OK] Model "${model}" verified in ${result.latencyMs}ms`);
          }
        } catch (e: any) {
          console.error(`[VISION PROBE ERROR] Could not verify model "${model}": ${e.message}`);
        }
      }
    }

    if (configManager.isHttpEnabled()) {
      await startHttpServer();
    } else {
      await startStdioServer();
    }
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    throw error;
  }
}

async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('Image Summarization MCP server running on stdio');
}

const sseTransports = new Map<string, SSEServerTransport>();
const sseServers = new Map<string, Server>();

async function startHttpServer() {
  const app = express();
  const httpServer = createServer(app);

  app.use(cors());
  app.use(express.json());

  // SSE endpoint: client connects here to receive server-initiated messages.
  // server.connect(transport) wires the SDK request router so that
  // initialize, tools/list, tools/call, and logging all work over HTTP.
  app.get('/sse', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/messages', res);
      // Each SSE connection gets a fresh Server so overlapping clients can't
      // share the single _transport slot inside the SDK's Protocol base.
      const server = createMcpServer();
      sseTransports.set(transport.sessionId, transport);
      sseServers.set(transport.sessionId, server);

      transport.onclose = () => {
        sseTransports.delete(transport.sessionId);
        const s = sseServers.get(transport.sessionId);
        sseServers.delete(transport.sessionId);
        if (s) {
          s.close().catch((err) => console.error('Error closing SSE server:', err));
        }
      };

      // Connect the MCP server to this transport — this replaces the old
      // hand-rolled onmessage dispatch with full SDK routing.
      await server.connect(transport);

      console.error(`[SSE] Client connected (session ${transport.sessionId})`);
    } catch (error) {
      console.error('Error setting up SSE transport:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  });

  // Message endpoint: clients POST here to send JSON-RPC messages.
  // The sessionId query parameter routes to the correct transport.
  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sessionId ? sseTransports.get(sessionId) : undefined;

    if (!transport) {
      return res.status(400).json({ error: 'No active SSE session for this sessionId' });
    }

    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error('Error handling POST message:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      transports: sseTransports.size,
      mode: 'http',
      mcpPort: configManager.getMcpPort()
    });
  });

  const PORT = configManager.getMcpPort();

  httpServer.listen(PORT, () => {
    console.log(`Image Summarization MCP server running on HTTP at http://localhost:${PORT}`);
    console.log(`SSE endpoint: http://localhost:${PORT}/sse  |  Messages: http://localhost:${PORT}/messages`);
    console.log(`Health check available at http://localhost:${PORT}/health`);
  });

  process.on('SIGTERM', () => {
    for (const transport of sseTransports.values()) {
      try {
        transport.close();
      } catch (error) {
        console.error('Error closing SSE transport:', error);
      }
    }
    sseTransports.clear();
    for (const s of sseServers.values()) {
      s.close().catch((err) => console.error('Error closing SSE server:', err));
    }
    sseServers.clear();

    httpServer.close(() => {
      console.log('HTTP server closed');
    });
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
