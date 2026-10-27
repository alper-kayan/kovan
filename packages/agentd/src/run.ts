import {
  Agent,
  buildSystemPrompt,
  discoverSkills,
  type AgentEvent,
  type ApprovalRequest,
  type ModelStreamer,
} from '@kovan/harness';
import { estimateCost, OpenRouterClient, type ModelInfo } from '@kovan/model-gateway';
import {
  commandAllowed,
  runClaudeDetached,
  runCodexDetached,
  type ClaudeDetachedOptions,
  type CodexDetachedOptions,
  type DetachedRun,
} from '@kovan/runner';
import { basename } from 'node:path';

type TurnEnd = Extract<AgentEvent, { type: 'turn_end' }>;

/**
 * Asks nobody: a command the unattended policy allows runs; anything else is what the run
 * itself decides (for swarm agents: no). Edits are the mode's to allow.
 */
export function unattended(run: Pick<DetachedRun, 'approve'>) {
  return (request: ApprovalRequest): Promise<boolean> =>
    request.kind === 'command' && commandAllowed(request.detail)
      ? Promise.resolve(true)
      : run.approve(request);
}

/** The permission mode an unattended agent gets: never Full, whatever the swarm asked for. */
export function unattendedMode(mode: DetachedRun['mode']): DetachedRun['mode'] {
  return mode === 'full' ? 'allow' : mode;
}

/**
 * Runs Kovan's agent on one task outside any conversation, the way the desktop does for its
 * subagents and swarm agents, with this machine's model key and the repository's own skills.
 */
export class Runner {
  private catalog: ModelInfo[] | null = null;

  constructor(
    private readonly openRouterKey: string | null,
    /** Tests give a scripted model instead. */
    private readonly model?: (id: string) => ModelStreamer,
    /** Set to run the work with Claude Code on the person's own subscription instead. */
    private readonly claude?: ClaudeDetachedOptions,
    /** Or with Codex on their OpenAI plan. */
    private readonly codex?: CodexDetachedOptions,
  ) {}

  /** Which agent does the work here, in words for the log. */
  get agent(): string {
    return this.claude
      ? 'Claude Code (your subscription)'
      : this.codex
        ? 'Codex (your OpenAI plan)'
        : "Kovan's agent (OpenRouter)";
  }

  async run(run: DetachedRun): Promise<TurnEnd> {
    if (this.claude)
      return runClaudeDetached(
        { ...run, mode: unattendedMode(run.mode), approve: unattended(run) },
        this.claude,
      );
    if (this.codex)
      return runCodexDetached(
        { ...run, mode: unattendedMode(run.mode), approve: unattended(run) },
        this.codex,
      );
    let streamer: ModelStreamer;
    if (this.model) streamer = this.model(run.model);
    else {
      if (!this.openRouterKey)
        throw new Error('Set OPENROUTER_API_KEY so this machine can run agents.');
      const client = new OpenRouterClient({
        apiKey: this.openRouterKey,
        appName: 'Kovan agentd',
        appUrl: 'https://kovan.alperkayan.dev',
      });
      this.catalog ??= await client.listModels().catch(() => []);
      streamer = client;
    }
    let end: TurnEnd | null = null;
    const agent = new Agent({
      model: streamer,
      modelId: run.model,
      contextWindow: (model) => this.catalog?.find((m) => m.id === model)?.contextLength || null,
      effort: run.effort,
      // Nobody watches here: Full would skip the policy, so it runs as Allow at most.
      mode: unattendedMode(run.mode),
      root: run.root,
      isRepo: true,
      systemPrompt: await buildSystemPrompt({
        root: run.root,
        name: basename(run.root),
        isRepo: true,
      }),
      approve: unattended(run),
      ...(run.tools ? { extraTools: run.tools } : {}),
      // The repository's skills; agentd has no personal or Claude Code skills.
      skills: () => discoverSkills({ root: run.root, userDir: null, claudeDir: null }),
      // A swarm's run: its check before each write, and the team's work between steps.
      ...(run.checkWrite ? { checkWrite: run.checkWrite } : {}),
      ...(run.turnContext ? { turnContext: run.turnContext } : {}),
      onEvent: (event) => {
        if (event.type === 'turn_end') end = event;
        run.onEvent(event);
      },
      price: (modelId, usage) => {
        const info = this.catalog?.find((m) => m.id === modelId);
        return info ? estimateCost(info, usage) : null;
      },
    });
    run.signal.addEventListener('abort', () => agent.stop(), { once: true });
    run.onAgent?.(agent);
    await agent.send(run.task);
    return (
      end ?? {
        type: 'turn_end',
        turnId: '',
        reason: 'error',
        cost: 0,
        error: 'The agent did not finish',
      }
    );
  }
}
