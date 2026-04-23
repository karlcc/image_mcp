// HTTP/SSE transport tests — verify proper SDK wiring, tool discovery, and instructions
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';

// Find a free port
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine port')));
      }
    });
    server.on('error', reject);
  });
}

// Poll until the health endpoint responds
async function waitForHealth(port: number, maxMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        http.get(`http://localhost:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        }).on('error', reject);
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error(`Health endpoint did not respond within ${maxMs}ms`);
}

describe('HTTP/SSE Transport', () => {
  let port: number;
  let proc: ChildProcess;

  beforeAll(async () => {
    port = await findFreePort();
    // Run directly from source via tsx so `npm test` works on a clean checkout
    // without requiring a prior `npm run build` — the build/ directory is gitignored.
    const entry = path.join(__dirname, '../src/index.ts');
    const tsxBin = path.join(__dirname, '../node_modules/.bin/tsx');
    proc = spawn(tsxBin, [entry, '--http', '--mcp-port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENAI_BASE_URL: 'http://localhost:1',  // dummy — we only call get_config_info
        OPENAI_MODEL: 'test-model',
      },
    });

    // Log stderr for debugging
    proc.stderr?.on('data', (d: Buffer) => {
      // uncomment to debug: console.error('[SRV]', d.toString().trim());
    });

    await waitForHealth(port);
  }, 15000);

  afterAll(() => {
    proc.kill('SIGTERM');
  });

  it('exposes tools/list with 3 tools and annotations', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`));
    await client.connect(transport);

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(3);
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'compare_images_via_vision_backend',
      'get_config_info',
      'read_image_via_vision_backend',
    ]);

    // All image tools should have readOnlyHint and idempotentHint
    for (const tool of tools) {
      if (tool.name === 'get_config_info') {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      } else {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.idempotentHint).toBe(true);
      }
    }

    await client.close();
  });

  it('exposes server instructions', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`));
    await client.connect(transport);

    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain('Vision-capable backend');

    await client.close();
  });

  it('handles tools/call for get_config_info end-to-end', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`));
    await client.connect(transport);

    const result = await client.callTool({ name: 'get_config_info', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('model', 'test-model');

    await client.close();
  });
});
