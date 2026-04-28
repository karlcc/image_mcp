import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

describe('ConfigManager configuration precedence', () => {
  const originalArgv = [...process.argv];
  const originalEnv = { ...process.env };
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-mcp-config-'));
    configPath = path.join(tempDir, 'config.json');
  });

  afterEach(async () => {
    process.argv = [...originalArgv];
    process.env = { ...originalEnv };
    jest.resetModules();
    await fs.remove(tempDir);
  });

  it('uses OPENAI_BASE_URL from env when --base-url is not provided', async () => {
    process.argv = ['node', 'image_mcp', '--config', configPath];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'env-test-key',
      OPENAI_BASE_URL: 'https://env.example.com/v1',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getBaseUrl()).toBe('https://env.example.com/v1');
  });

  it('uses --base-url from CLI when both CLI and env are provided', async () => {
    process.argv = ['node', 'image_mcp', '--config', configPath, '--base-url', 'https://cli.example.com/v1'];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'env-test-key',
      OPENAI_BASE_URL: 'https://env.example.com/v1',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getBaseUrl()).toBe('https://cli.example.com/v1');
  });

  it('uses persistent config file when env and CLI are not provided', async () => {
    await fs.writeJson(configPath, {
      apiKey: 'file-key',
      baseUrl: 'https://file.example.com/v1',
      model: 'file-model',
      useHttp: true,
      mcpPort: 9099,
    });

    process.argv = ['node', 'image_mcp', '--config', configPath];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      OPENAI_MODEL: '',
      MCP_USE_HTTP: '',
      MCP_PORT: '',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getApiKey()).toBe('file-key');
    expect(manager.getBaseUrl()).toBe('https://file.example.com/v1');
    expect(manager.getModel()).toBe('file-model');
    expect(manager.isHttpEnabled()).toBe(true);
    expect(manager.getMcpPort()).toBe(9099);
  });

  it('allows env vars to override persistent config file values', async () => {
    await fs.writeJson(configPath, {
      apiKey: 'file-key',
      baseUrl: 'https://file.example.com/v1',
      model: 'file-model',
      useHttp: false,
      mcpPort: 9099,
    });

    process.argv = ['node', 'image_mcp', '--config', configPath];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'env-key',
      OPENAI_BASE_URL: 'https://env.example.com/v1',
      OPENAI_MODEL: 'env-model',
      MCP_USE_HTTP: 'true',
      MCP_PORT: '8181',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getApiKey()).toBe('env-key');
    expect(manager.getBaseUrl()).toBe('https://env.example.com/v1');
    expect(manager.getModel()).toBe('env-model');
    expect(manager.isHttpEnabled()).toBe(true);
    expect(manager.getMcpPort()).toBe(8181);
  });

  it('supports explicit HTTP CLI flags and saves resolved config', async () => {
    process.argv = [
      'node',
      'image_mcp',
      '--config',
      configPath,
      '--api-key',
      'cli-save-key',
      '--base-url',
      'https://cli-save.example.com/v1',
      '--model',
      'cli-save-model',
      '--http',
      '--mcp-port',
      '8282',
      '--save-config'
    ];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      OPENAI_MODEL: '',
      MCP_USE_HTTP: '',
      MCP_PORT: '',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();
    const persisted = await fs.readJson(configPath);

    expect(manager.isHttpEnabled()).toBe(true);
    expect(manager.getMcpPort()).toBe(8282);
    expect(persisted.apiKey).toBe('cli-save-key');
    expect(persisted.baseUrl).toBe('https://cli-save.example.com/v1');
    expect(persisted.model).toBe('cli-save-model');
    expect(persisted.useHttp).toBe(true);
    expect(persisted.mcpPort).toBe(8282);
  });

  it('hardens config file permissions to 600 when saving over an existing file', async () => {
    await fs.writeJson(configPath, {
      apiKey: 'old-key',
      baseUrl: 'https://old.example.com/v1',
      model: 'old-model'
    });
    await fs.chmod(configPath, 0o644);

    process.argv = [
      'node',
      'image_mcp',
      '--config',
      configPath,
      '--api-key',
      'new-key',
      '--base-url',
      'https://new.example.com/v1',
      '--model',
      'new-model',
      '--save-config'
    ];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      OPENAI_MODEL: '',
      MCP_USE_HTTP: '',
      MCP_PORT: '',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    new ConfigManager();

    const stat = await fs.stat(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('accepts --reasoning-effort from CLI', async () => {
    process.argv = ['node', 'image_mcp', '--config', configPath, '--reasoning-effort', 'high'];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: '',
      OPENAI_REASONING_EFFORT: '',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getReasoningEffort()).toBe('high');
  });

  it('accepts OPENAI_REASONING_EFFORT from env', async () => {
    process.argv = ['node', 'image_mcp', '--config', configPath];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'test-key',
      OPENAI_REASONING_EFFORT: 'medium',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getReasoningEffort()).toBe('medium');
  });

  it('CLI --reasoning-effort overrides env', async () => {
    process.argv = ['node', 'image_mcp', '--config', configPath, '--reasoning-effort', 'low'];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'test-key',
      OPENAI_REASONING_EFFORT: 'high',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getReasoningEffort()).toBe('low');
  });

  it('returns undefined when reasoning-effort is not configured', async () => {
    process.argv = ['node', 'image_mcp', '--config', configPath];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: 'test-key',
      OPENAI_REASONING_EFFORT: '',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    const manager = new ConfigManager();

    expect(manager.getReasoningEffort()).toBeUndefined();
  });

  it('persists reasoning_effort to config file', async () => {
    process.argv = [
      'node', 'image_mcp', '--config', configPath,
      '--api-key', 'test-key',
      '--reasoning-effort', 'xhigh',
      '--save-config',
    ];
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: '',
      OPENAI_REASONING_EFFORT: '',
    };

    const { ConfigManager } = await import('../src/mcp-config');
    new ConfigManager();

    const persisted = await fs.readJson(configPath);
    expect(persisted.reasoningEffort).toBe('xhigh');
  });
});
