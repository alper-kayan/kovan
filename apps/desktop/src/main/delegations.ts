import type { Tool } from '@kovan/harness';
import type { SubagentOutcome } from '@kovan/runner';

/** How often an agent goes on by itself with delegated results before the person writes. */
export const MAX_DELEGATION_ROUNDS = 3;

interface Entry {
  task: string;
  outcome: SubagentOutcome | null;
}

export interface DelegationDeps {
  /** Starts a subagent on the task; `onSettled` hears how it ended. */
  delegate(task: string, onSettled: (outcome: SubagentOutcome) => void): Promise<{ id: string }>;
  /** Whether the conversation is in a turn now. */
  running(): boolean;
  /** A line from Kovan in the conversation. */
  notice(text: string): void;
  /** A new turn with this prompt, from Kovan rather than the person. */
  resume(text: string): Promise<void>;
}

/**
 * The work one conversation's agent handed to subagents (delegate_task). Once none is left
 * running and the conversation is idle, the agent goes on with the results by itself (a few
 * times at most before the person writes again); while some still run, the lane says so.
 */
export class Delegations {
  private readonly entries = new Map<string, Entry>();
  private rounds = 0;
  private waitingSaid = false;

  constructor(private readonly deps: DelegationDeps) {}

  /** The person wrote: the agent may go on by itself again. */
  personWrote(): void {
    this.rounds = 0;
  }

  /** The tool Kovan's agent hands work over with. */
  tool(): Tool {
    return {
      spec: {
        name: 'delegate_task',
        description:
          "Hand a self-contained piece of this work to a subagent: it works in its own copy of the repository, and its change joins this checkout once the repository's checks pass. Use it for independent work (a separate module, its tests) while you carry on. You hear how it ended when it finishes; if your turn ends first, you are woken with the results. Describe the task fully: the subagent sees nothing of this conversation.",
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'What to do, with every detail it needs' },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
      kind: 'team',
      describe: (a) => `Delegated: ${String(a['task'] ?? '').slice(0, 80)}`,
      run: async (a) => {
        const task = String(a['task'] ?? '').trim();
        if (task.length < 10) return { ok: false, output: 'Describe the task fully first.' };
        // Made first: a subagent can end (fail at once) before its id comes back.
        const entry: Entry = { task, outcome: null };
        try {
          const sub = await this.deps.delegate(task, (outcome) => {
            entry.outcome = outcome;
            this.check();
          });
          this.entries.set(sub.id, entry);
          this.waitingSaid = false;
          return {
            ok: true,
            output: `A subagent started on it (${sub.id}). Carry on with other work; you will hear how it ended.`,
          };
        } catch (error) {
          return { ok: false, output: `Couldn't delegate: ${(error as Error).message}` };
        }
      },
    };
  }

  /** After a turn, and whenever a delegated task ends: wait, or go on with the results. */
  check(): void {
    if (this.entries.size === 0 || this.deps.running()) return;
    const all = [...this.entries.values()];
    const running = all.filter((d) => d.outcome === null);
    if (running.length) {
      if (!this.waitingSaid)
        this.deps.notice(
          `Waiting for delegated work: ${running.length} subagent${running.length === 1 ? '' : 's'} still running. The agent goes on by itself when they finish.`,
        );
      this.waitingSaid = true;
      return;
    }
    this.entries.clear();
    this.waitingSaid = false;
    if (this.rounds >= MAX_DELEGATION_ROUNDS) {
      this.deps.notice(
        `Delegated work finished (${all.length}). Send a message to have the agent go on with it.`,
      );
      return;
    }
    this.rounds += 1;
    const lines = all.map((d) => {
      const o = d.outcome!;
      const checks = o.checks.total ? ` · checks ${o.checks.passed}/${o.checks.total}` : '';
      const said = (o.reply ?? o.detail ?? '').replace(/\s+/g, ' ').slice(0, 400);
      return `- "${d.task.slice(0, 120)}": ${o.status}${checks}${said ? ` · ${said}` : ''}`;
    });
    void this.deps
      .resume(
        [
          'Delegated work finished:',
          ...lines,
          'Integrated work is in this checkout now. Check it and carry on with the goal.',
        ].join('\n'),
      )
      .catch((error: unknown) =>
        this.deps.notice(`Couldn't go on with the delegated results: ${String(error)}`),
      );
  }
}
