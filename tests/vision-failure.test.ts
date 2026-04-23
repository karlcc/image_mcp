import axios from 'axios';
import express from 'express';
import fs from 'fs-extra';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'os';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const PROJECT_ROOT = path.resolve(__dirname, '..');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a local port'));
        return;
      }

      const { port } = address as AddressInfo;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    try {
      const response = await axios.get(url, { timeout: 500 });
      if (response.status === 200) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for server health check: ${url}`);
}

describe('Vision failure handling', () => {
  let mockServer: Server | undefined;
  let mockPort = 0;
  let mcpPort = 0;
  let mcpProcess: ChildProcessWithoutNullStreams | undefined;
  let tempDir = '';
  let screenshotPath = '';

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-mcp-vision-'));
    screenshotPath = path.join(tempDir, '螢幕截圖 2025-11-30 15.00.14.svg');
    await fs.copy(path.join(PROJECT_ROOT, 'test.svg'), screenshotPath);

    const app = express();
    app.use(express.json());

    app.post('/v1/chat/completions', (_req, res) => {
      res.json({
        id: 'chatcmpl-hallucinated',
        object: 'chat.completion',
        created: Date.now(),
        model: 'mock-text-only',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'This is a macOS screenshot (captured Nov 30, 2025 at 3:00:14 PM). The image shows what appears to be a macOS desktop/application interface with a dark theme. I can see it contains Chinese-language content.'
            },
            finish_reason: 'stop'
          }
        ]
      });
    });

    app.get('/v1/models', (_req, res) => {
      res.json({
        object: 'list',
        data: [
          {
            id: 'mock-text-only',
            object: 'model',
            created: Date.now(),
            owned_by: 'tests'
          }
        ]
      });
    });

    mockServer = createServer(app);
    await new Promise<void>((resolve) => {
      mockServer!.listen(0, '127.0.0.1', () => {
        const address = mockServer!.address() as AddressInfo;
        mockPort = address.port;
        resolve();
      });
    });

    mcpPort = await getFreePort();

    const tsxBinary = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
    mcpProcess = spawn(
      tsxBinary,
      [
        'src/index.ts',
        '--http',
        '--mcp-port',
        String(mcpPort),
        '--base-url',
        `http://127.0.0.1:${mockPort}/v1`,
        '--api-key',
        'key',
        '--model',
        'mock-text-only',
        '--no-streaming',
      ],
      {
        cwd: PROJECT_ROOT,
        env: process.env,
      }
    );

    await waitForHealth(`http://127.0.0.1:${mcpPort}/health`);
  });

  afterAll(async () => {
    if (mcpProcess && !mcpProcess.killed) {
      mcpProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (mockServer) {
      await new Promise<void>((resolve, reject) => {
        mockServer!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  it('returns a tool error instead of hallucinated screenshot metadata', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${mcpPort}/sse`));
    await client.connect(transport);

    const result = await client.callTool({
      name: 'read_image_via_vision_backend',
      arguments: { image_path: screenshotPath }
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(result.isError).toBe(true);
    expect(text).toContain('vision-capable model or endpoint');
    expect(text).not.toContain('This is a macOS screenshot');

    await client.close();
  });
});
