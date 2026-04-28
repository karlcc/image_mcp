#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, maskApiKey, saveConfigFile, parseNonEmptyString, type CliOverrides, type Config } from './config.js';
import { OpenAIClient } from './openai-client.js';
import { readImage, compareImages, type HandlerContext } from './handlers.js';

const pkgVersion = '1.1.0-beta.2';

// --- Output formatting ---

function formatJsonResult(status: 'ok' | 'error', data: string | null, error: { code: string; message: string } | null, metadata: Record<string, unknown>): string {
  return JSON.stringify({ status, data, error, metadata }, null, 2);
}

function formatJsonError(code: string, message: string): string {
  return JSON.stringify({ status: 'error', data: null, error: { code, message }, metadata: {} }, null, 2);
}

// --- Exit codes ---
const EXIT_SUCCESS = 0;
const EXIT_APP_ERROR = 1;
const EXIT_CONFIG_ERROR = 2;
const EXIT_INVALID_ARGS = 3;

// --- Build context from resolved config ---

function createCliContext(config: Config): HandlerContext {
  const client = new OpenAIClient(config.baseUrl, config.apiKey, config.timeout, config.maxRetries);
  return {
    client,
    model: config.model ?? '',
    reasoningEffort: config.reasoningEffort,
    streaming: config.streaming,
    maxRetries: config.maxRetries,
  };
}

// --- Helper to get merged global + subcommand opts ---

function getGlobalOpts(): CliOverrides & { json?: boolean; raw?: boolean } {
  return program.opts<CliOverrides & { json?: boolean; raw?: boolean }>();
}

// --- CLI program ---

const program = new Command();

program
  .name('image-mcp')
  .description('CLI for image analysis via vision backend')
  .version(pkgVersion)
  .helpOption('-h, --help', 'display help for command');

// Global config flags (shared by subcommands)
program
  .option('-k, --api-key <key>', 'OpenAI API key')
  .option('-u, --base-url <url>', 'OpenAI API base URL')
  .option('-m, --model <model>', 'Model to use')
  .option('--reasoning-effort <level>', 'Reasoning effort: none, minimal, low, medium, high, xhigh')
  .option('--no-streaming', 'Disable streaming responses')
  .option('-t, --timeout <ms>', 'Request timeout in milliseconds', parseInt)
  .option('-r, --max-retries <count>', 'Maximum number of retries', parseInt)
  .option('-c, --config <path>', 'Path to JSON config file')
  .option('--json', 'Output structured JSON envelope')
  .option('--raw', 'Minimal output, no metadata');

// --- read subcommand ---

program
  .command('read <image>')
  .description('Analyze one image (OCR, describe, extract data)')
  .option('--task <prompt>', 'What to do with the image')
  .option('--smoke-test', 'Verify config + API connectivity (no image needed)')
  .action(async (image: string | undefined, opts: { task?: string; smokeTest?: boolean }, cmd: Command) => {
    const globalOpts = getGlobalOpts();
    if (opts.smokeTest) {
      await runSmokeTest(globalOpts);
    } else {
      if (!image) { cmd.error('Missing required argument: image'); }
      await runRead(image, opts.task, globalOpts);
    }
  });

// --- compare subcommand ---

program
  .command('compare <images...>')
  .description('Compare 2+ images (diffs, similarities)')
  .option('--task <prompt>', 'What to compare')
  .action(async (images: string[], opts: { task?: string }) => {
    const globalOpts = getGlobalOpts();
    await runCompare(images, opts.task, globalOpts);
  });

// --- config subcommand ---

program
  .command('config')
  .description('Show current configuration')
  .option('--init', 'Write config file (~/.config/image_mcp/config.json) from provided flags or env vars')
  .option('--api-key <key>', 'API key for --init')
  .option('--base-url <url>', 'API base URL for --init')
  .option('--model <model>', 'Model name for --init')
  .action(async (opts: { init?: boolean; apiKey?: string; baseUrl?: string; model?: string }, cmd: Command) => {
    const globalOpts = getGlobalOpts();
    await runConfig(globalOpts, opts, cmd);
  });

// --- install-skill subcommand ---

program
  .command('install-skill')
  .description('Install SKILL.md to ~/.claude/skills/image-mcp/')
  .action(async () => {
    await runInstallSkill();
  });

// --- Command implementations ---

async function runRead(image: string, task: string | undefined, opts: CliOverrides & { json?: boolean; raw?: boolean }) {
  const startMs = Date.now();
  try {
    const { config } = resolveConfig(opts);

    if (!config.model) {
      const msg = 'No model configured. Set OPENAI_MODEL or use --model.';
      if (opts.json) { console.log(formatJsonError('CONFIG_ERROR', msg)); process.exit(EXIT_CONFIG_ERROR); }
      console.error(msg); process.exit(EXIT_CONFIG_ERROR);
    }

    const ctx = createCliContext(config);
    const text = await readImage(ctx, image, task);
    const latencyMs = Date.now() - startMs;

    if (opts.json) {
      console.log(formatJsonResult('ok', text, null, { model: config.model, latency_ms: latencyMs }));
    } else if (opts.raw) {
      console.log(text);
    } else {
      console.log(text);
    }
    process.exit(EXIT_SUCCESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (opts.json) {
      console.log(formatJsonError('VISION_ERROR', message));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(EXIT_APP_ERROR);
  }
}

async function runCompare(images: string[], task: string | undefined, opts: CliOverrides & { json?: boolean; raw?: boolean }) {
  const startMs = Date.now();
  try {
    if (images.length < 2) {
      const msg = 'At least 2 images are required for comparison';
      if (opts.json) { console.log(formatJsonError('INVALID_ARGS', msg)); process.exit(EXIT_INVALID_ARGS); }
      console.error(msg); process.exit(EXIT_INVALID_ARGS);
    }

    const { config } = resolveConfig(opts);

    if (!config.model) {
      const msg = 'No model configured. Set OPENAI_MODEL or use --model.';
      if (opts.json) { console.log(formatJsonError('CONFIG_ERROR', msg)); process.exit(EXIT_CONFIG_ERROR); }
      console.error(msg); process.exit(EXIT_CONFIG_ERROR);
    }

    const ctx = createCliContext(config);
    const text = await compareImages(ctx, images, task);
    const latencyMs = Date.now() - startMs;

    if (opts.json) {
      console.log(formatJsonResult('ok', text, null, { model: config.model, latency_ms: latencyMs }));
    } else if (opts.raw) {
      console.log(text);
    } else {
      console.log(text);
    }
    process.exit(EXIT_SUCCESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (opts.json) {
      console.log(formatJsonError('VISION_ERROR', message));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(EXIT_APP_ERROR);
  }
}

async function runConfig(opts: CliOverrides & { json?: boolean; raw?: boolean }, initOpts: { init?: boolean; apiKey?: string; baseUrl?: string; model?: string }, cmd: Command) {
  try {
    if (initOpts.init) {
      // Build overrides: --init flags > global flags > env vars
      const initOverrides: CliOverrides = {
        apiKey: initOpts.apiKey ?? opts.apiKey ?? parseNonEmptyString(process.env.OPENAI_API_KEY),
        baseUrl: initOpts.baseUrl ?? opts.baseUrl ?? parseNonEmptyString(process.env.OPENAI_BASE_URL),
        model: initOpts.model ?? opts.model ?? parseNonEmptyString(process.env.OPENAI_MODEL),
        ...opts,
      };
      // Apply init-specific values on top (they take precedence)
      if (initOpts.apiKey) initOverrides.apiKey = initOpts.apiKey;
      if (initOpts.baseUrl) initOverrides.baseUrl = initOpts.baseUrl;
      if (initOpts.model) initOverrides.model = initOpts.model;

      const { config, configPath } = resolveConfig(initOverrides);
      saveConfigFile(configPath, config);

      const output = {
        status: 'ok',
        configPath,
        message: `Config written to ${configPath}`,
        apiKey: maskApiKey(config.apiKey),
        baseUrl: config.baseUrl,
        model: config.model ?? '',
      };
      if (opts.json) {
        console.log(JSON.stringify({ status: 'ok', data: output, error: null, metadata: {} }, null, 2));
      } else {
        console.log(`Config written to ${configPath}`);
        console.log(`  apiKey: ${maskApiKey(config.apiKey)}`);
        console.log(`  baseUrl: ${config.baseUrl}`);
        console.log(`  model: ${config.model ?? '(not set)'}`);
      }
      process.exit(EXIT_SUCCESS);
    }

    const { config, configFileExists, configFileKeys } = resolveConfig(opts);

    const configInfo = {
      apiKey: maskApiKey(config.apiKey),
      baseUrl: config.baseUrl,
      model: config.model ?? '',
      reasoningEffort: config.reasoningEffort ?? null,
      streaming: config.streaming,
      useHttp: config.useHttp,
      mcpPort: config.mcpPort,
      timeout: config.timeout,
      maxRetries: config.maxRetries,
      configPath: config.configPath,
      configFileExists,
      configFileKeys,
    };

    const incomplete = !config.apiKey || config.apiKey === 'key' || !config.model;

    if (opts.json) {
      const result: Record<string, unknown> = { status: 'ok', data: configInfo, error: null, metadata: {} };
      if (incomplete) result.hint = 'Run `image-mcp config --init` to configure';
      console.log(JSON.stringify(result, null, 2));
    } else if (opts.raw) {
      console.log(JSON.stringify(configInfo));
    } else {
      console.log(JSON.stringify(configInfo, null, 2));
      if (incomplete) {
        console.error('\nConfiguration incomplete. Run `image-mcp config --init` to set up.');
      }
    }
    process.exit(EXIT_SUCCESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (opts.json) {
      console.log(formatJsonError('CONFIG_ERROR', message));
    } else {
      console.error(`Config error: ${message}`);
    }
    process.exit(EXIT_CONFIG_ERROR);
  }
}

async function runInstallSkill() {
  try {
    // Find SKILL.md — check skills/ directory next to this script, then legacy root location
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const candidates = [
      path.resolve(scriptDir, '..', 'skills', 'image_mcp', 'SKILL.md'),  // build/../skills/image_mcp/SKILL.md
      path.resolve(scriptDir, '..', 'SKILL.md'),                         // legacy: build/../SKILL.md
    ];

    let skillSource: string | undefined;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        skillSource = candidate;
        break;
      }
    }

    if (!skillSource) {
      console.error('SKILL.md not found in package directory');
      process.exit(EXIT_APP_ERROR);
    }

    const skillDir = path.join(os.homedir(), '.claude', 'skills', 'image_mcp');
    fs.mkdirSync(skillDir, { recursive: true });

    const destPath = path.join(skillDir, 'SKILL.md');
    fs.copyFileSync(skillSource, destPath);

    console.log(`Skill installed to ${destPath}`);
    process.exit(EXIT_SUCCESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Install error: ${message}`);
    process.exit(EXIT_APP_ERROR);
  }
}

async function runSmokeTest(opts: CliOverrides & { json?: boolean; raw?: boolean }) {
  try {
    const { config } = resolveConfig(opts);

    if (!config.model) {
      const msg = 'No model configured. Set OPENAI_MODEL or use --model.';
      if (opts.json) { console.log(formatJsonError('CONFIG_ERROR', msg)); process.exit(EXIT_CONFIG_ERROR); }
      console.error(msg); process.exit(EXIT_CONFIG_ERROR);
    }

    const ctx = createCliContext(config);

    // Minimal vision request: 1x1 white PNG
    const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    await readImage(ctx, testImage, 'Reply with exactly: OK');

    if (opts.json) {
      console.log(formatJsonResult('ok', 'Vision backend connected successfully', null, { model: config.model }));
    } else {
      console.log('Vision backend connected successfully');
    }
    process.exit(EXIT_SUCCESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (opts.json) {
      console.log(formatJsonError('VISION_ERROR', message));
    } else {
      console.error(`Smoke test failed: ${message}`);
    }
    process.exit(EXIT_APP_ERROR);
  }
}

// Claude Code Plugin Hint Protocol: emit hint when running inside Claude Code
// and the skill is not already installed. Fires before program.parse() so it
// doesn't interfere with command execution.
if (process.env.CLAUDECODE === '1') {
  const skillDest = path.join(os.homedir(), '.claude', 'skills', 'image_mcp', 'SKILL.md');
  if (!fs.existsSync(skillDest)) {
    process.stderr.write('<claude-code-hint v="1" type="plugin" value="image_mcp@marketplace" />\n');
  }
}

program.parse();
