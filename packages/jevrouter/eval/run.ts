// Runs the eval task set against fixed models and JevRouter and reports score vs cost.
//
//   OPENROUTER_API_KEY=… npx tsx packages/jevrouter/eval/run.ts \
//     --configs openai/gpt-5.6-luna,anthropic/claude-sonnet-5,kovan/jevrouter --budget 2
//
// Writes packages/jevrouter/eval/results/latest.json and the copy the desktop app shows on its
// Models page (apps/desktop/src/shared/jevrouter-benchmark.json).
import { Agent, buildSystemPrompt, runShell } from '@kovan/harness';
import { OpenRouterClient, type ModelInfo } from '@kovan/model-gateway';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JEV_MODEL_ID, JevRouter } from '../src/index.js';
import { TASKS, type EvalTask } from './tasks.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const configs = (
  args.get('configs') ?? `openai/gpt-5.6-luna,anthropic/claude-sonnet-5,${JEV_MODEL_ID}`
).split(',');
const budget = Number(args.get('budget') ?? 2);
const only = args.get('tasks');
const tasks = only ? TASKS.filter((t) => only.split(',').includes(t.id)) : TASKS;
const TASK_TIMEOUT_MS = 5 * 60_000;

const apiKey = process.env['OPENROUTER_API_KEY'];
if (!apiKey) throw new Error('Set OPENROUTER_API_KEY');
const client = new OpenRouterClient({ apiKey, appName: 'Kovan eval' });
const catalog: ModelInfo[] = (await client.listModels()).filter((m) => m.tools);

interface TaskResult {
  task: string;
  level: EvalTask['level'];
  pass: boolean;
  cost: number;
  models: string[];
  seconds: number;
  error?: string;
}

async function setUp(task: EvalTask): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `kovan-eval-${task.id}-`));
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n');
  for (const [path, content] of Object.entries(task.files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await writeFile(join(dir, '.check.mjs'), task.check);
  return dir;
}

async function passes(dir: string): Promise<boolean> {
  return (await runShell('node .check.mjs', dir, { timeoutMs: 30_000 })).exitCode === 0;
}

async function runTask(task: EvalTask, config: string): Promise<TaskResult> {
  const dir = await setUp(task);
  const started = Date.now();
  const models = new Set<string>();
  let cost = 0;
  let error: string | undefined;
  try {
    if (await passes(dir))
      throw new Error(`The check for ${task.id} passes before any change; the task is broken`);
    const streamer =
      config === JEV_MODEL_ID
        ? new JevRouter({ client, catalog, classifierModel: 'openai/gpt-5.6-luna' })
        : client;
    const agent = new Agent({
      model: streamer,
      modelId: config,
      effort: null,
      mode: 'full',
      root: dir,
      isRepo: false,
      maxSteps: 25,
      systemPrompt: await buildSystemPrompt({ root: dir, name: task.id, isRepo: false }),
      approve: async () => true,
      onEvent: (e) => {
        if (e.type === 'usage' && e.kind === 'model' && e.model) models.add(e.model);
        if (e.type === 'turn_end') {
          cost = e.cost;
          if (e.error) error = e.error;
        }
      },
    });
    const timer = setTimeout(() => agent.stop(), TASK_TIMEOUT_MS);
    await agent.send(`${task.prompt}\n\nThe check for this task is in .check.mjs; don't edit it.`);
    clearTimeout(timer);
    const pass = await passes(dir);
    return {
      task: task.id,
      level: task.level,
      pass,
      cost,
      models: [...models],
      seconds: Math.round((Date.now() - started) / 1000),
      ...(error ? { error } : {}),
    };
  } catch (e) {
    return {
      task: task.id,
      level: task.level,
      pass: false,
      cost,
      models: [...models],
      seconds: Math.round((Date.now() - started) / 1000),
      error: (e as Error).message,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let spent = 0;
const report: {
  config: string;
  name: string;
  solved: number;
  total: number;
  score: number;
  costPerTask: number;
  totalCost: number;
  tasks: TaskResult[];
}[] = [];
outer: for (const config of configs) {
  const results: TaskResult[] = [];
  for (const task of tasks) {
    if (spent >= budget) {
      console.log(`Budget of $${budget} reached; stopping.`);
      break outer;
    }
    const r = await runTask(task, config);
    spent += r.cost;
    results.push(r);
    console.log(
      `${config.padEnd(28)} ${task.id.padEnd(15)} ${r.pass ? 'PASS' : 'fail'}  $${r.cost.toFixed(5)}  ${r.seconds}s  ${r.models.join(', ')}${r.error ? `  (${r.error.slice(0, 80)})` : ''}`,
    );
  }
  const solved = results.filter((r) => r.pass).length;
  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  report.push({
    config,
    name:
      config === JEV_MODEL_ID
        ? 'JevRouter'
        : (catalog.find((m) => m.id === config)?.name ?? config),
    solved,
    total: results.length,
    score: results.length ? Math.round((solved / results.length) * 1000) / 10 : 0,
    costPerTask: results.length ? totalCost / results.length : 0,
    totalCost,
    tasks: results,
  });
}

console.log('\n| Config | Solved | Score | Cost / task | Total |\n| --- | --- | --- | --- | --- |');
for (const r of report)
  console.log(
    `| ${r.name} | ${r.solved}/${r.total} | ${r.score}% | $${r.costPerTask.toFixed(5)} | $${r.totalCost.toFixed(4)} |`,
  );
console.log(`\nSpent $${spent.toFixed(4)} of a $${budget} budget.`);

const result = {
  date: new Date().toISOString(),
  tasks: tasks.map((t) => ({ id: t.id, level: t.level })),
  configs: report,
};
const here = dirname(new URL(import.meta.url).pathname);
await mkdir(join(here, 'results'), { recursive: true });
await writeFile(join(here, 'results', 'latest.json'), JSON.stringify(result, null, 2) + '\n');
const summary = {
  date: result.date,
  taskCount: tasks.length,
  points: report.map((r) => ({
    config: r.config,
    name: r.name,
    score: r.score,
    costPerTask: r.costPerTask,
    solved: r.solved,
    total: r.total,
  })),
};
await writeFile(
  join(here, '../../../apps/desktop/src/shared/jevrouter-benchmark.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
