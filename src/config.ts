import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const ReasoningEffortValues = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = typeof ReasoningEffortValues[number];

export const ConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  baseUrl: z.string().url().default('http://localhost:9292/v1'),
  model: z.string().optional(),
  reasoningEffort: z.enum(ReasoningEffortValues).optional(),
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
  reasoningEffort: z.enum(ReasoningEffortValues).optional(),
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

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'image_mcp', 'config.json');

export function parseBoolean(value: string | undefined): boolean | undefined {
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

export function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseNonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) {
    return '***';
  }
  return `${key.slice(0, 4)}${'*'.repeat(key.length - 8)}${key.slice(-4)}`;
}

export function loadConfigFile(configPath: string): { config: PersistedConfig; exists: boolean; keys: string[] } {
  const exists = fs.existsSync(configPath);
  if (!exists) {
    return { config: {}, exists: false, keys: [] };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsedJson = JSON.parse(raw);
    const parsedConfig = PersistedConfigSchema.safeParse(parsedJson);
    if (!parsedConfig.success) {
      console.warn(`Ignoring invalid config file at ${configPath}: ${parsedConfig.error.message}`);
      return { config: {}, exists: true, keys: [] };
    }
    return { config: parsedConfig.data, exists: true, keys: Object.keys(parsedConfig.data) };
  } catch {
    return { config: {}, exists: true, keys: [] };
  }
}

/** CLI overrides shape — all optional, matching Commander output */
export interface CliOverrides {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: string;
  streaming?: boolean;
  http?: boolean;
  mcpPort?: number;
  config?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Resolve configuration from overrides > env vars > config file > defaults.
 * Shared by both MCP server and CLI entry points.
 */
export function resolveConfig(overrides: CliOverrides = {}): { config: Config; configPath: string; configFileExists: boolean; configFileKeys: string[] } {
  const configPath = path.resolve(
    overrides.config ?? parseNonEmptyString(process.env.IMAGE_MCP_CONFIG_PATH) ?? DEFAULT_CONFIG_PATH
  );

  const { config: fileConfig, exists: configFileExists, keys: configFileKeys } = loadConfigFile(configPath);

  const config = ConfigSchema.parse({
    apiKey: overrides.apiKey ?? parseNonEmptyString(process.env.OPENAI_API_KEY) ?? fileConfig.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseUrl: overrides.baseUrl ?? parseNonEmptyString(process.env.OPENAI_BASE_URL) ?? fileConfig.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    model: overrides.model ?? parseNonEmptyString(process.env.OPENAI_MODEL) ?? fileConfig.model,
    reasoningEffort: overrides.reasoningEffort ?? parseNonEmptyString(process.env.OPENAI_REASONING_EFFORT) ?? fileConfig.reasoningEffort ?? DEFAULT_CONFIG.reasoningEffort,
    streaming: (overrides.streaming === false ? false : undefined) ?? parseBoolean(process.env.OPENAI_STREAMING) ?? fileConfig.streaming ?? DEFAULT_CONFIG.streaming,
    timeout: overrides.timeout ?? parseInteger(process.env.OPENAI_TIMEOUT) ?? fileConfig.timeout ?? DEFAULT_CONFIG.timeout,
    maxRetries: overrides.maxRetries ?? parseInteger(process.env.OPENAI_MAX_RETRIES) ?? fileConfig.maxRetries ?? DEFAULT_CONFIG.maxRetries,
    useHttp: overrides.http ?? parseBoolean(process.env.MCP_USE_HTTP) ?? fileConfig.useHttp ?? DEFAULT_CONFIG.useHttp,
    mcpPort: overrides.mcpPort ?? parseInteger(process.env.MCP_PORT) ?? fileConfig.mcpPort ?? DEFAULT_CONFIG.mcpPort,
    configPath,
  });

  return { config, configPath, configFileExists, configFileKeys };
}

export function saveConfigFile(configPath: string, config: Config): void {
  const toPersist: PersistedConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
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
  fs.chmodSync(configPath, 0o600);
}
