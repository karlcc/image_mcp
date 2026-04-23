#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  baseUrl: z.string().url().default('http://localhost:9292/v1'),
  model: z.string().optional(),
  streaming: z.boolean().default(true),
  timeout: z.number().min(1000).max(300000).default(60000),
  maxRetries: z.number().min(0).max(5).default(3),
  useHttp: z.boolean().default(false),
  mcpPort: z.number().int().min(1).max(65535).default(8080),
  configPath: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
type PersistedConfig = Partial<Omit<Config, 'configPath'>>;

const PersistedConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
  streaming: z.boolean().optional(),
  timeout: z.number().int().min(1000).max(300000).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
  useHttp: z.boolean().optional(),
  mcpPort: z.number().int().min(1).max(65535).optional(),
});

const DEFAULT_CONFIG: PersistedConfig = {
  baseUrl: 'http://localhost:9292/v1',
  apiKey: 'key',
  streaming: true,
  timeout: 60000,
  maxRetries: 3,
  useHttp: false,
  mcpPort: 8080,
};

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'image_mcp', 'config.json');

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function maskApiKey(key: string): string {
  if (!key || key.length <= 8) {
    return '***';
  }
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

export class ConfigManager {
  private config: Config;
  private configPath: string;
  private configFileKeys: string[];
  private configFileExists: boolean;

  constructor() {
    const program = new Command();

    program
      .name('@karlcc/image_mcp')
      .description('MCP server for image summarization')
      .version('1.0.0');

    program
      .option('-k, --api-key <key>', 'OpenAI API key')
      .option('-u, --base-url <url>', 'OpenAI API base URL')
      .option('-m, --model <model>', 'Default model to use')
      .option('--no-streaming', 'Disable streaming responses')
      .option('--http', 'Enable HTTP/SSE transport mode')
      .option('-p, --mcp-port <port>', 'HTTP port for MCP server', parseInt)
      .option('-c, --config <path>', 'Path to JSON config file')
      .option('--save-config', 'Save resolved configuration to config file')
      .option('--verify', 'Probe model vision capability and exit')
      .option('-t, --timeout <ms>', 'Request timeout in milliseconds', parseInt)
      .option('-r, --max-retries <count>', 'Maximum number of retries', parseInt);

    program.parse();

    const cliOptions = program.opts<{
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      streaming?: boolean;
      http?: boolean;
      mcpPort?: number;
      config?: string;
      saveConfig?: boolean;
      verify?: boolean;
      timeout?: number;
      maxRetries?: number;
    }>();

    this.configPath = path.resolve(
      cliOptions.config ?? parseNonEmptyString(process.env.IMAGE_MCP_CONFIG_PATH) ?? DEFAULT_CONFIG_PATH
    );

    const fileConfig = this.loadConfigFile(this.configPath);
    this.configFileKeys = Object.keys(fileConfig);
    this.configFileExists = fs.existsSync(this.configPath);

    // Build configuration with precedence: CLI > Environment > Config file > Defaults
    // Commander sets `undefined` when a flag is omitted and `true`/`false` when explicit,
    // which correctly short-circuits the nullish-coalescing chain.
    this.config = ConfigSchema.parse({
      apiKey: cliOptions.apiKey ?? parseNonEmptyString(process.env.OPENAI_API_KEY) ?? fileConfig.apiKey ?? DEFAULT_CONFIG.apiKey,
      baseUrl: cliOptions.baseUrl ?? parseNonEmptyString(process.env.OPENAI_BASE_URL) ?? fileConfig.baseUrl ?? DEFAULT_CONFIG.baseUrl,
      model: cliOptions.model ?? parseNonEmptyString(process.env.OPENAI_MODEL) ?? fileConfig.model,
      // Commander's `--no-streaming` defaults `streaming` to `true` when the flag is omitted,
      // so we only treat an explicit `false` as CLI input. Everything else falls through to env/config.
      streaming: (cliOptions.streaming === false ? false : undefined) ?? parseBoolean(process.env.OPENAI_STREAMING) ?? fileConfig.streaming ?? DEFAULT_CONFIG.streaming,
      timeout: cliOptions.timeout ?? parseInteger(process.env.OPENAI_TIMEOUT) ?? fileConfig.timeout ?? DEFAULT_CONFIG.timeout,
      maxRetries: cliOptions.maxRetries ?? parseInteger(process.env.OPENAI_MAX_RETRIES) ?? fileConfig.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      useHttp: cliOptions.http ?? parseBoolean(process.env.MCP_USE_HTTP) ?? fileConfig.useHttp ?? DEFAULT_CONFIG.useHttp,
      mcpPort: cliOptions.mcpPort ?? parseInteger(process.env.MCP_PORT) ?? fileConfig.mcpPort ?? DEFAULT_CONFIG.mcpPort,
      configPath: this.configPath,
    });

    // --verify is a standalone flag: probe vision and exit
    // When combined with --save-config, defer save until after verification.
    if (cliOptions.verify) {
      this._pendingVerify = true;
    }

    if (cliOptions.saveConfig) {
      if (cliOptions.verify) {
        // Defer: save only after successful verification in main()
        this._pendingSave = true;
      } else {
        this.saveConfigFile(this.configPath, this.config);
      }
    }
  }

  private _pendingVerify = false;
  private _pendingSave = false;

  get needsVerify(): boolean {
    return this._pendingVerify;
  }

  get needsSave(): boolean {
    return this._pendingSave;
  }

  /** Execute deferred save (called from main() after successful verification). */
  saveConfig(): void {
    if (this._pendingSave) {
      this._pendingSave = false;
      this.saveConfigFile(this.configPath, this.config);
    }
  }

  async runVerify(): Promise<boolean> {
    this._pendingVerify = false;

    const config = this.config;
    if (!config.model) {
      console.error('No model configured — nothing to verify.');
      return false;
    }

    const { OpenAIClient } = await import('./openai-client.js');
    const { probeVisionCapability } = await import('./vision-probe.js');

    const client = new OpenAIClient(config.baseUrl, config.apiKey, 15000, 1);
    console.error(`Verifying vision capability for model "${config.model}" at ${config.baseUrl}...`);

    const result = await probeVisionCapability(client, config.model);

    if (!result.ok) {
      console.error(
        `Vision verification FAILED for model "${config.model}": ${result.reason}` +
        (result.rawResponse ? `\n  Model response: ${result.rawResponse.slice(0, 200)}` : '')
      );
      return false;
    }

    console.error(`Vision verified for ${config.model} (${result.latencyMs}ms)`);
    return true;
  }

  getConfig(): Config {
    return this.config;
  }

  getApiKey(): string {
    return this.config.apiKey;
  }

  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  getModel(): string {
    return this.config.model ?? '';
  }

  isStreamingEnabled(): boolean {
    return this.config.streaming;
  }

  getTimeout(): number {
    return this.config.timeout;
  }

  getMaxRetries(): number {
    return this.config.maxRetries;
  }

  isHttpEnabled(): boolean {
    return this.config.useHttp;
  }

  getMcpPort(): number {
    return this.config.mcpPort;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getConfigInfo(): Record<string, unknown> {
    return {
      apiKey: maskApiKey(this.config.apiKey),
      baseUrl: this.config.baseUrl,
      model: this.config.model ?? '',
      streaming: this.config.streaming,
      useHttp: this.config.useHttp,
      mcpPort: this.config.mcpPort,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
      configPath: this.configPath,
      configFileExists: this.configFileExists,
      configFileKeys: this.configFileKeys,
    };
  }

  private loadConfigFile(configPath: string): PersistedConfig {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsedJson = JSON.parse(raw);
      const parsedConfig = PersistedConfigSchema.safeParse(parsedJson);
      if (!parsedConfig.success) {
        console.warn(`Ignoring invalid config file at ${configPath}: ${parsedConfig.error.message}`);
        return {};
      }
      return parsedConfig.data;
    } catch {
      return {};
    }
  }

  private saveConfigFile(configPath: string, config: Config): void {
    const toPersist: PersistedConfig = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      streaming: config.streaming,
      timeout: config.timeout,
      maxRetries: config.maxRetries,
      useHttp: config.useHttp,
      mcpPort: config.mcpPort,
    };

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(toPersist, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    // `mode` is only guaranteed on file creation. Force restrictive permissions on updates too.
    fs.chmodSync(configPath, 0o600);
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
