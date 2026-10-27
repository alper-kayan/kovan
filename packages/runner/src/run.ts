import type { Agent, AgentEvent, ApprovalRequest, PermissionMode, Tool } from '@kovan/harness';
import type { Effort } from '@kovan/model-gateway';

/** What a swarm needs of an agent while it works: is it busy, guide it, stop it. */
export type LiveAgent = Pick<Agent, 'running' | 'steer' | 'stop'>;

/** A Kovan agent outside any conversation (a subagent): its own events, its own approvals. */
export interface DetachedRun {
  root: string;
  model: string;
  effort: Effort | null;
  mode: PermissionMode;
  task: string;
  approve(request: ApprovalRequest): Promise<boolean>;
  onEvent(event: AgentEvent): void;
  signal: AbortSignal;
  /** Extra tools (a swarm's message_agent), next to the usual file and shell tools. */
  tools?: Tool[];
  /** The agent once it exists, to steer or stop it. */
  onAgent?(agent: LiveAgent): void;
  /** Before a write: a note to hold it with (it collides with a teammate's work), or null. */
  checkWrite?(path: string): Promise<string | null>;
  /** What the team is doing now, given to the model and read again between its steps. */
  turnContext?(): Promise<string | null>;
}
