/**
 * Vision smoke test — verifies the currently configured model can see images.
 *
 * Gated on IMAGE_MCP_SMOKE=1 env var so it doesn't run in hermetic CI
 * that lacks API credentials. To run locally:
 *
 *   IMAGE_MCP_SMOKE=1 npm run test:smoke
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { OpenAIClient } from '../src/openai-client';
import { probeVisionCapability, VisionProbeResult } from '../src/vision-probe';

const SMOKE_ENABLED = process.env.IMAGE_MCP_SMOKE === '1';

// Read config the same way the server does
const baseUrl = process.env.OPENAI_BASE_URL || '';
const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || '';

const describe_ = SMOKE_ENABLED ? describe : describe.skip;

describe_('Vision smoke test (IMAGE_MCP_SMOKE=1)', () => {
  let client: OpenAIClient;

  beforeAll(() => {
    if (!apiKey || !baseUrl) {
      throw new Error(
        'Vision smoke test requires OPENAI_API_KEY and OPENAI_BASE_URL env vars. ' +
        'Set IMAGE_MCP_SMOKE=1 and provide credentials to run.'
      );
    }
    client = new OpenAIClient(baseUrl, apiKey, 15000, 1);
  });

  it('configured model passes the vision probe', async () => {
    if (!model) {
      throw new Error('OPENAI_MODEL env var is required for vision smoke test.');
    }

    const result: VisionProbeResult = await probeVisionCapability(client, model);

    if (!result.ok) {
      const details = [
        `Model "${model}" failed vision probe.`,
        `Reason: ${result.reason}`,
        result.rawResponse ? `Response: ${result.rawResponse.slice(0, 300)}` : '',
        `Latency: ${result.latencyMs}ms`,
      ].filter(Boolean).join('\n  ');

      fail(details);
    }

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThan(0);
  });
});
