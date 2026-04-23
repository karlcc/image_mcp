#!/usr/bin/env node

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    tasks: path.join(repoRoot, 'bench', 'tasks.default.json'),
    repeats: 1,
    portBase: 18300,
    timeoutMs: 120000,
    skipBuild: false,
    updateConfig: true,
    configPath: path.join(os.homedir(), '.config', 'image_mcp', 'config.json'),
    candidatesPath: path.join(os.homedir(), '.config', 'image_mcp', 'model_candidates.json'),
    models: [],
    failUnder: null,
    failIfAnyNonvision: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--tasks' && argv[i + 1]) {
      args.tasks = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === '--repeats' && argv[i + 1]) {
      args.repeats = Math.max(1, parseInt(argv[i + 1], 10));
      i += 1;
    } else if (token === '--port-base' && argv[i + 1]) {
      args.portBase = parseInt(argv[i + 1], 10);
      i += 1;
    } else if (token === '--timeout-ms' && argv[i + 1]) {
      args.timeoutMs = parseInt(argv[i + 1], 10);
      i += 1;
    } else if (token === '--config' && argv[i + 1]) {
      args.configPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === '--candidates' && argv[i + 1]) {
      args.candidatesPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (token === '--models' && argv[i + 1]) {
      args.models = argv[i + 1].split(',').map((m) => m.trim()).filter(Boolean);
      i += 1;
    } else if (token === '--skip-build') {
      args.skipBuild = true;
    } else if (token === '--no-update-config') {
      args.updateConfig = false;
    } else if (token === '--fail-under' && argv[i + 1]) {
      args.failUnder = parseFloat(argv[i + 1]);
      i += 1;
    } else if (token === '--fail-if-any-nonvision') {
      args.failIfAnyNonvision = true;
    }
  }

  return args;
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonSecure(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (fssync.existsSync(filePath)) {
    fssync.chmodSync(filePath, 0o600);
  }
}

function percentileMedian(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function startServer({ model, port, configPath }) {
  return spawn(
    'node',
    ['build/index.js', '--http', '--mcp-port', String(port), '--model', model, '--config', configPath],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    }
  );
}

async function waitForHealth(port, timeoutMs = 15000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function connectClient(port) {
  const client = new Client({ name: 'image-mcp-benchmark', version: '1.0.0' });
  const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`));
  await client.connect(transport);
  return client;
}

async function callTool({ client, task, rootDir, timeoutMs }) {
  const { name, args } = taskToToolCall(task, rootDir);
  const started = performance.now();
  try {
    const result = await Promise.race([
      client.callTool({ name, arguments: args }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`tools/call timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    const elapsedMs = performance.now() - started;
    return {
      elapsedMs,
      result,
      transportError: null,
    };
  } catch (error) {
    return {
      elapsedMs: performance.now() - started,
      result: null,
      transportError: error instanceof Error ? error.message : 'Unknown transport error',
    };
  }
}

function taskToToolCall(task, rootDir) {
  if (task.tool === 'read_image_via_vision_backend') {
    return {
      name: 'read_image_via_vision_backend',
      args: {
        image_path: path.resolve(rootDir, task.image_path),
        task: task.task,
      },
    };
  }

  if (task.tool === 'compare_images_via_vision_backend') {
    return {
      name: 'compare_images_via_vision_backend',
      args: {
        image_paths: task.image_paths.map((p) => path.resolve(rootDir, p)),
        task: task.task,
      },
    };
  }

  throw new Error(`Unsupported tool in task "${task.id}": ${task.tool}`);
}

function evaluateResult(task, responseText) {
  if (typeof responseText !== 'string') {
    return false;
  }
  if (!task.expected_regex) {
    return false;
  }
  try {
    const re = new RegExp(task.expected_regex, 'i');
    return re.test(responseText);
  } catch {
    return false;
  }
}

function scoreModel(entries) {
  const calls = entries.length;
  const okEntries = entries.filter((e) => e.status === 'ok');
  const successRate = calls ? okEntries.length / calls : 0;

  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  const passedWeight = entries.reduce((sum, e) => sum + (e.pass ? e.weight : 0), 0);
  const weightedAccuracy = totalWeight ? passedWeight / totalWeight : 0;

  const latencies = okEntries.map((e) => e.latencyMs).filter((v) => Number.isFinite(v));
  const latencyMedian = latencies.length ? percentileMedian(latencies) : null;
  const latencyAvg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

  return {
    calls,
    okCalls: okEntries.length,
    successRate,
    weightedAccuracy,
    latencyMedian,
    latencyAvg,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  const tasks = await readJson(args.tasks, null);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`Task file is empty or invalid: ${args.tasks}`);
  }

  const candidates = await readJson(args.candidatesPath, {});
  const config = await readJson(args.configPath, {});

  const models = args.models.length
    ? args.models
    : Array.isArray(candidates.candidates) && candidates.candidates.length
      ? candidates.candidates
      : config.model
        ? [config.model]
        : [];

  if (models.length === 0) {
    throw new Error('No models to benchmark. Provide --models or set ~/.config/image_mcp/model_candidates.json');
  }

  if (!args.skipBuild) {
    await new Promise((resolve, reject) => {
      const build = spawn('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit', env: process.env });
      build.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm run build failed with code ${code}`));
        }
      });
    });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = `/tmp/image_mcp_accuracy_benchmark_${ts}.jsonl`;
  const summaryPath = `/tmp/image_mcp_accuracy_summary_${ts}.json`;
  const rawEntries = [];
  let nextId = 1;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const port = args.portBase + i;
    const proc = startServer({ model, port, configPath: args.configPath });

    const ready = await waitForHealth(port, 15000);
    if (!ready) {
      rawEntries.push({
        model,
        taskId: 'startup',
        repeat: 0,
        weight: 1,
        status: 'server_start_failed',
        pass: false,
        latencyMs: null,
        httpCode: null,
        responseText: '',
        error: 'server_not_ready',
      });

      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    let client = null;
    try {
      client = await connectClient(port);
    } catch (err) {
      rawEntries.push({
        model,
        taskId: 'connect',
        repeat: 0,
        weight: 1,
        status: 'connect_failed',
        pass: false,
        latencyMs: null,
        httpCode: null,
        responseText: '',
        error: err instanceof Error ? err.message : String(err),
      });
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
      for (const task of tasks) {
        nextId += 1;

        const call = await callTool({ client, task, rootDir: repoRoot, timeoutMs: args.timeoutMs });
        const result = call.result;
        const text = result?.content?.[0]?.text ?? '';

        let status = 'ok';
        let error = '';
        if (call.transportError) {
          status = 'transport_error';
          error = call.transportError;
        } else if (result?.isError) {
          status = 'mcp_tool_error';
          error = text || 'mcp_tool_error';
        }

        const pass = status === 'ok' && evaluateResult(task, text);

        rawEntries.push({
          model,
          taskId: task.id,
          repeat,
          weight: typeof task.weight === 'number' ? task.weight : 1,
          status,
          pass,
          latencyMs: Number(call.elapsedMs.toFixed(1)),
          httpCode: null,
          responseText: String(text).replace(/\s+/g, ' ').trim(),
          error: String(error).replace(/\s+/g, ' ').trim(),
          expectedRegex: task.expected_regex,
        });
      }
    }

    try { await client.close(); } catch { /* ignore */ }
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }

  await fs.writeFile(rawPath, `${rawEntries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');

  const byModel = {};
  for (const model of models) {
    const entries = rawEntries.filter((e) => e.model === model && e.taskId !== 'startup');
    const scored = scoreModel(entries);
    byModel[model] = {
      ...scored,
      calls: entries,
    };
  }

  const ranked = Object.entries(byModel)
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => {
      if (b.weightedAccuracy !== a.weightedAccuracy) {
        return b.weightedAccuracy - a.weightedAccuracy;
      }
      if (b.successRate !== a.successRate) {
        return b.successRate - a.successRate;
      }
      const aLat = a.latencyMedian ?? Number.POSITIVE_INFINITY;
      const bLat = b.latencyMedian ?? Number.POSITIVE_INFINITY;
      return aLat - bLat;
    });

  // Only recommend from candidates with at least one successful call.
  const rankedWithUsableData = ranked.filter((entry) => entry.okCalls > 0);
  const recommendation = rankedWithUsableData.length ? rankedWithUsableData[0].model : null;
  const summary = {
    createdAt: new Date().toISOString(),
    taskFile: args.tasks,
    repeats: args.repeats,
    rankingRule: 'weightedAccuracy desc, successRate desc, latencyMedian asc',
    source: rawPath,
    models: byModel,
    recommendation,
    hasUsableData: rankedWithUsableData.length > 0,
    recommendationReason: recommendation
      ? 'best_model_with_successful_calls'
      : 'no_model_had_successful_calls',
  };

  await writeJsonSecure(summaryPath, summary);

  if (args.updateConfig && recommendation) {
    const nextConfig = { ...config, model: recommendation };
    await writeJsonSecure(args.configPath, nextConfig);

    const nextCandidates = {
      ...candidates,
      active: recommendation,
      candidates: Array.isArray(candidates.candidates) ? candidates.candidates : models,
      last_accuracy_benchmark: {
        ran_at: new Date().toISOString(),
        summary_file: summaryPath,
        raw_results_file: rawPath,
        summary,
      },
    };
    await writeJsonSecure(args.candidatesPath, nextCandidates);
  }

  const compact = ranked.map((r) => ({
    model: r.model,
    weightedAccuracy: Number(r.weightedAccuracy.toFixed(4)),
    successRate: Number(r.successRate.toFixed(4)),
    latencyMedianMs: r.latencyMedian === null ? null : Number(r.latencyMedian.toFixed(1)),
    latencyAvgMs: r.latencyAvg === null ? null : Number(r.latencyAvg.toFixed(1)),
  }));

  console.log(JSON.stringify({
    recommendation,
    summaryFile: summaryPath,
    rawFile: rawPath,
    ranking: compact,
  }, null, 2));

  // Post-run gate checks
  const gateErrors = [];

  if (args.failUnder !== null) {
    const topAccuracy = ranked.length ? ranked[0].weightedAccuracy : 0;
    if (topAccuracy < args.failUnder) {
      gateErrors.push(
        `--fail-under ${args.failUnder}: top model accuracy ${topAccuracy.toFixed(4)} is below threshold`
      );
    }
  }

  if (args.failIfAnyNonvision) {
    const zeroAccuracy = ranked.filter((r) => r.weightedAccuracy === 0);
    if (zeroAccuracy.length > 0) {
      const names = zeroAccuracy.map((r) => r.model).join(', ');
      gateErrors.push(
        `--fail-if-any-nonvision: ${zeroAccuracy.length} model(s) scored 0% accuracy (likely text-only): ${names}`
      );
    }
  }

  if (gateErrors.length > 0) {
    for (const err of gateErrors) {
      console.error(`[benchmark-models] GATE FAILED: ${err}`);
    }
    process.exit(2);
  }
}

run().catch((error) => {
  console.error(`[benchmark-models] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
