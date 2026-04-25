#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ChatMessage, ChatRequest, OpenAIClient } from './openai-client.js';
import { ImageProcessor } from './image-processor.js';
import { assertVisionResponse, buildVisionGuardPrompt, EmptyModelResponseError, VisionFailureError } from './vision-response.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';

import { configManager } from './config.js';

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

// Extract text from OpenAI chat response, handling thinking models that put
// the answer in reasoning_content or reasoning instead of content.
export function extractMessageText(message: any): string {
  return message?.content || message?.reasoning_content || message?.reasoning || '';
}

// Build a chat request with optional reasoning_effort injection.
function buildChatRequest(model: string, messages: ChatMessage[], stream: boolean): ChatRequest {
  const req: ChatRequest = { model, messages, stream };
  const reasoningEffort = configManager.getReasoningEffort();
  if (reasoningEffort) {
    req.reasoning_effort = reasoningEffort;
  }
  return req;
}

async function executeChatRequest(chatRequest: ChatRequest): Promise<string> {
  if (chatRequest.stream) {
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    const result = await openaiClient.chatCompletion(chatRequest, (chunk) => {
      const delta = chunk.choices?.[0]?.delta as any;
      if (delta?.content) {
        accumulatedContent += delta.content;
      }
      if (delta?.reasoning_content) {
        accumulatedReasoning += delta.reasoning_content;
      }
      if (delta?.reasoning) {
        accumulatedReasoning += delta.reasoning;
      }
    });
    const message = result.choices?.[0]?.message as any;
    // Priority: streamed content > final message object > accumulated reasoning deltas.
    // For thinking models that stream only reasoning, we prefer the final message's
    // content/reasoning fields over the raw reasoning stream.
    const text = accumulatedContent || extractMessageText(message) || accumulatedReasoning;
    if (!text) {
      throw new EmptyModelResponseError();
    }
    return text;
  }

  const result = await openaiClient.chatCompletion(chatRequest);
  const message = result.choices?.[0]?.message as any;
  const text = extractMessageText(message);
  if (!text) {
    throw new EmptyModelResponseError();
  }
  return text;
}

function textContent(text: string) {
  return { type: 'text' as const, text };
}

// Backoff intentionally matches the HTTP-layer retry in openai-client.ts.
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = configManager.getMaxRetries()): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable =
        error instanceof EmptyModelResponseError ||
        (error instanceof VisionFailureError && error.reason === 'explicit');
      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }
      const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), RETRY_MAX_DELAY_MS);
      const reason = error instanceof VisionFailureError ? 'explicit vision failure' : 'empty model response';
      console.error(`[withRetry] Retrying ${reason} (attempt ${attempt + 1}/${maxRetries}) after ${delay}ms delay`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
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

const DEFAULT_COMPARE_PROMPT = 'Compare these images thoroughly: describe the similarities and differences in content, text, layout, colors, and style. If the images contain text, note any textual differences.';

const DEFAULT_SUMMARIZE_PROMPT = 'Describe this image thoroughly: if it contains text, read and transcribe all visible text; if it shows a UI, describe the layout and interactive elements; if it is a chart or diagram, extract the data and explain the visualization; if it is a photo, describe the scene, objects, and notable details.';

async function handleSummarizeImage(image_url: string, custom_prompt?: string, enableStreaming: boolean = false) {
  if (!image_url) {
    throw new Error('image_url must be provided');
  }

  if (typeof image_url !== 'string') {
    throw new Error('image_url must be a string');
  }

  const processStart = Date.now();
  const processedImage = await ImageProcessor.processImage(image_url);
  const processTimeMs = Date.now() - processStart;

  console.error(`[summarize_image] Processed input in ${processTimeMs}ms — type: ${processedImage.mimeType}, size: ${processedImage.size} bytes`);

  const prompt = buildVisionGuardPrompt(custom_prompt || DEFAULT_SUMMARIZE_PROMPT);
  const model = configManager.getModel();
  if (!model) {
    throw new Error('No model configured. Set OPENAI_MODEL or run with --model.');
  }

  const chatRequest = buildChatRequest(
    model,
    [{ role: 'user' as const, content: [
        { type: 'text' as const, text: prompt },
        { type: 'image_url' as const, image_url: { url: processedImage.url } }
      ]
    }],
    enableStreaming,
  );

  const checkedText = await withRetry(async () => {
    const text = await executeChatRequest(chatRequest);
    return assertVisionResponse(text, {
      loadedSummary: `Image input (${processedImage.mimeType}, ${processedImage.size} bytes)`,
      model,
      sourceHints: [image_url],
    });
  });
  return { content: [textContent(checkedText)] };
}

async function handleCompareImages(image_urls: string[], custom_prompt?: string, enableStreaming: boolean = false) {
  if (!image_urls || !Array.isArray(image_urls)) {
    throw new Error('image_urls must be provided as an array');
  }

  if (image_urls.length < 2) {
    throw new Error('At least 2 images are required for comparison');
  }

  const processStart = Date.now();
  const processedImages = await Promise.all(
    image_urls.map(async (image_url, index) => {
      if (typeof image_url !== 'string') {
        throw new Error(`image_urls[${index}] must be a string`);
      }
      return await ImageProcessor.processImage(image_url);
    })
  );
  const processTimeMs = Date.now() - processStart;

  console.error(`[compare_images] Processed ${processedImages.length} images in ${processTimeMs}ms`);

  const prompt = buildVisionGuardPrompt(
    custom_prompt || DEFAULT_COMPARE_PROMPT
  );
  const model = configManager.getModel();
  if (!model) {
    throw new Error('No model configured. Set OPENAI_MODEL or run with --model.');
  }

  const content: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [
    { type: 'text' as const, text: prompt }
  ];

  processedImages.forEach(processedImage => {
    content.push({
      type: 'image_url' as const,
      image_url: { url: processedImage.url }
    });
  });

  const chatRequest = buildChatRequest(
    model,
    [{ role: 'user' as const, content }],
    enableStreaming,
  );

  const checkedText = await withRetry(async () => {
    const text = await executeChatRequest(chatRequest);
    return assertVisionResponse(text, {
      loadedSummary: `${processedImages.length} image inputs (first image ${processedImages[0].mimeType}, ${processedImages[0].size} bytes)`,
      model,
      sourceHints: image_urls,
    });
  });
  return { content: [textContent(checkedText)] };
}

function handleGetConfigInfo() {
  const configInfo = configManager.getConfigInfo();
  return { content: [textContent(JSON.stringify(configInfo, null, 2))] };
}

// Unified tool dispatch — returns handler result or throws
async function dispatchToolCall(toolName: string, args: Record<string, any>, enableStreaming: boolean) {
  switch (toolName) {
    case TOOL_GET_CONFIG_INFO:
      return handleGetConfigInfo();
    case TOOL_READ_IMAGE_VIA_VISION_BACKEND: {
      const validatedArgs = requireObjectArgs(args);
      const imageUrl = validatedArgs.image_path as string;
      if (!imageUrl || typeof imageUrl !== 'string') {
        throw new Error('image_path must be provided as a string');
      }
      return await handleSummarizeImage(imageUrl, validatedArgs.task as string | undefined, enableStreaming);
    }
    case TOOL_COMPARE_IMAGES_VIA_VISION_BACKEND: {
      const validatedArgs = requireObjectArgs(args);
      const imageUrls = validatedArgs.image_paths as string[];
      if (!Array.isArray(imageUrls) || imageUrls.length < 2) {
        throw new Error('image_paths must be an array of at least 2 image paths/URLs');
      }
      return await handleCompareImages(imageUrls, validatedArgs.task as string | undefined, enableStreaming);
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
              default: 'Describe this image thoroughly: if it contains text, read and transcribe all visible text; if it shows a UI, describe the layout and interactive elements; if it is a chart or diagram, extract the data and explain the visualization; if it is a photo, describe the scene, objects, and notable details.'
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
              default: 'Compare these images thoroughly: describe the similarities and differences in content, text, layout, colors, and style. If the images contain text, note any textual differences.'
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
