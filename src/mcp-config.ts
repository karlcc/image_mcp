import { Command } from 'commander';
import { resolveConfig, saveConfigFile, maskApiKey, type CliOverrides, type Config, type ReasoningEffort } from './config.js';

const pkgVersion = '1.1.0-beta.0';

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
      .version(pkgVersion);

    program
      .option('-k, --api-key <key>', 'OpenAI API key')
      .option('-u, --base-url <url>', 'OpenAI API base URL')
      .option('-m, --model <model>', 'Default model to use')
      .option('--reasoning-effort <level>', 'Reasoning effort: none, minimal, low, medium, high, xhigh')
      .option('--no-streaming', 'Disable streaming responses')
      .option('--http', 'Enable HTTP/SSE transport mode')
      .option('-p, --mcp-port <port>', 'HTTP port for MCP server', parseInt)
      .option('-c, --config <path>', 'Path to JSON config file')
      .option('--save-config', 'Save resolved configuration to config file')
      .option('--verify', 'Probe model vision capability and exit')
      .option('-t, --timeout <ms>', 'Request timeout in milliseconds', parseInt)
      .option('-r, --max-retries <count>', 'Maximum number of retries', parseInt);

    program.parse();

    const cliOptions = program.opts<CliOverrides & { saveConfig?: boolean; verify?: boolean }>();

    const resolved = resolveConfig(cliOptions);
    this.config = resolved.config;
    this.configPath = resolved.configPath;
    this.configFileExists = resolved.configFileExists;
    this.configFileKeys = resolved.configFileKeys;

    // --verify is a standalone flag: probe vision and exit
    // When combined with --save-config, defer save until after verification.
    if (cliOptions.verify) {
      this._pendingVerify = true;
    }

    if (cliOptions.saveConfig) {
      if (cliOptions.verify) {
        this._pendingSave = true;
      } else {
        saveConfigFile(this.configPath, this.config);
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
      saveConfigFile(this.configPath, this.config);
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

  getReasoningEffort(): ReasoningEffort | undefined {
    return this.config.reasoningEffort;
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
      reasoningEffort: this.config.reasoningEffort ?? null,
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
}

// Export singleton instance
export const configManager = new ConfigManager();
