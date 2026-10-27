import { getStatus, git } from '@kovan/git-engine';
import type { Tool } from '@kovan/harness';
import type {
  Comment,
  Member,
  Memory,
  Outcome,
  PathLock,
  Plan,
  Session,
  Swarm,
  Workspace,
} from '@kovan/shared';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionLink } from '../shared/agent.js';
import { checkAnchor, describeAnchorState, snippetAt, type Anchor } from './anchors.js';
import type { OverlapWarning } from '../shared/api.js';
import { BrainError, type BrainClient } from './brain.js';
import { liveWorkOf, WriteCheck, type Bindings, type LiveWork } from '@kovan/runner';

/** Who is calling: the checkout, and (for lanes) the session and the agent's label. */
export interface TeamCaller {
  root: string;
  session: SessionLink | null;
  /** "Claude Code · haiku", "Kovan · JevRouter": shown on notes the agent writes. */
  agent: string;
}

export interface TeamToolResult {
  text: string;
  isError?: boolean;
}

const MAX_NOTES_IN_CONTEXT = 40;

function line(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

function noteLine(m: Memory, members: Map<string, string>): string {
  const where = m.path
    ? `${m.path}${m.startLine ? `:${m.startLine}${m.endLine && m.endLine !== m.startLine ? `-${m.endLine}` : ''}` : ''}`
    : 'workspace';
  const who = m.byAgent
    ? `${members.get(m.authorId ?? '') ?? m.authorName ?? 'someone'}'s agent${m.verified ? '' : ', unverified'}`
    : (m.authorName ?? 'a teammate');
  // A server older than these fields leaves them out.
  const disputes = m.conflictsWith ?? [];
  const affects = m.affects ?? [];
  const head = `${m.status === 'flagged' ? 'FLAGGED ' : ''}${disputes.length ? 'DISPUTED ' : ''}[${m.kind}]`;
  const tail =
    m.status === 'flagged'
      ? ` (${m.flagReason ?? 'the code changed'} If you work near it, check the code and rewrite the note with record_memory, replaces: "${m.id}".)`
      : '';
  // A decision's why and what follows travel with it.
  const decision = [
    m.rationale ? ` Why: ${m.rationale}` : '',
    m.consequences ? ` What follows: ${m.consequences}` : '',
    affects.length ? ` Governs: ${affects.join(', ')}.` : '',
  ].join('');
  // Notes that may disagree: both stand, with their source and date, until a person decides.
  const dispute = disputes.length
    ? ` (May disagree with note${disputes.length === 1 ? '' : 's'} ${disputes.join(', ')}. Both are kept until a person decides; don't pick one silently: follow neither blindly and tell the person.)`
    : '';
  const when = m.createdAt ? `, ${m.createdAt.slice(0, 10)}` : '';
  return `- ${head} ${where}: ${m.text}${decision} (by ${who}${when}; id ${m.id})${tail}${dispute}`;
}

/**
 * Kovan's coordination tools for agents: team context, the session plan and the Brain. The
 * same calls back the MCP server (Claude Code, Codex) and Kovan's own agent.
 */
/** How often a CLI agent's long turn gets the team note again (after a tool call). */
const NOTE_REFRESH_MS = 20_000;

export class TeamTools {
  constructor(
    private readonly brain: BrainClient,
    private readonly bindings: Bindings,
  ) {}

  private async workspaceId(root: string): Promise<string | null> {
    return this.bindings.idFor(root);
  }

  private shared(): boolean {
    return this.brain.status().signedIn;
  }

  /** The team note each agent (checkout + session) last got, and when. */
  private readonly delivered = new Map<string, { note: string; at: number }>();

  private noteKey(caller: TeamCaller): string {
    return `${caller.root}\0${caller.session?.id ?? ''}`;
  }

  /** One per checkout and session: it remembers what each agent there was already told. */
  private readonly writeChecks = new Map<string, WriteCheck>();

  /**
   * Before an agent writes a file: a note to hold the write with when it collides with work in
   * another live session of the workspace (see WriteCheck), or null.
   */
  async checkWrite(caller: TeamCaller, path: string): Promise<string | null> {
    if (!this.shared()) return null;
    const workspaceId = await this.workspaceId(caller.root);
    if (!workspaceId) return null;
    const key = `${caller.root}\0${caller.session?.id ?? ''}`;
    let check = this.writeChecks.get(key);
    if (!check) {
      check = new WriteCheck({
        root: caller.root,
        others: () => this.liveWork(workspaceId, caller.session?.id ?? null),
      });
      this.writeChecks.set(key, check);
    }
    return check.check(path);
  }

  /** The workspace's live sessions other than this one, as the write check reads them. */
  private liveWork(workspaceId: string, own: string | null): Promise<LiveWork[]> {
    return liveWorkOf((method, path) => this.brain.request(method, path), workspaceId, own);
  }

  async memories(workspaceId: string): Promise<Memory[]> {
    return (
      await this.brain.request<{ memories: Memory[] }>(
        'GET',
        `/api/workspaces/${workspaceId}/memories`,
      )
    ).memories;
  }

  private async plan(sessionId: string): Promise<Plan | null> {
    try {
      return (await this.brain.request<{ plan: Plan }>('GET', `/api/sessions/${sessionId}/plan`))
        .plan;
    } catch {
      return null;
    }
  }

  /** The Brain notes worth an agent's attention: flagged first, then verified, newest first. */
  private notesBlock(memories: Memory[], members: Map<string, string>): string[] {
    if (memories.length === 0)
      return ['Brain notes: none yet. Record durable knowledge with record_memory.'];
    const ranked = [...memories].sort(
      (a, b) =>
        Number(b.status === 'flagged') - Number(a.status === 'flagged') ||
        Number(b.verified) - Number(a.verified) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    return [
      'Brain notes (shared team memory, pinned to code; follow them unless the code clearly contradicts them):',
      ...ranked.slice(0, MAX_NOTES_IN_CONTEXT).map((m) => noteLine(m, members)),
      ...(ranked.length > MAX_NOTES_IN_CONTEXT
        ? [`(${ranked.length - MAX_NOTES_IN_CONTEXT} more notes not shown)`]
        : []),
    ];
  }

  private planBlock(plan: Plan, session: SessionLink, members: Map<string, string>): string[] {
    if (plan.steps.length === 0)
      return [
        `Session "${session.title}": no plan yet. For big tasks, propose steps with propose_split.`,
      ];
    return [
      `Session "${session.title}" plan (work belongs to people; claim a free step with claim_plan_step before working on it):`,
      ...plan.steps.map(
        (s, i) =>
          `${i + 1}. [${s.status}] ${s.title} (${s.ownerId ? `owner: ${members.get(s.ownerId) ?? 'a teammate'}` : 'unowned'}; id ${s.id})`,
      ),
    ];
  }

  /**
   * Paths teammates locked (advisory: don't edit them) and actions whose outcome is unknown
   * (never run again). The person's own locks don't bind their own agent.
   */
  private async guardBlock(workspaceId: string, session: SessionLink | null): Promise<string[]> {
    const me = this.brain.status().user?.id;
    const lines: string[] = [];
    const { locks } = await this.brain
      .request<{ locks: PathLock[] }>('GET', `/api/workspaces/${workspaceId}/locks`)
      .catch(() => ({ locks: [] as PathLock[] }));
    const theirs = locks.filter((l) => l.userId !== me);
    if (theirs.length)
      lines.push(
        'LOCKED by teammates (do not edit these files; if you must, stop and ask the person first):',
        ...theirs.map((l) => `- ${l.path} (locked by ${l.userName})`),
      );
    if (session) {
      const { outcomes } = await this.brain
        .request<{ outcomes: Outcome[] }>('GET', `/api/workspaces/${workspaceId}/flow`)
        .catch(() => ({ outcomes: [] as Outcome[] }));
      const unknown = outcomes.filter((o) => o.sessionId === session.id);
      if (unknown.length)
        lines.push(
          'Outcome unknown (cut off mid-flight; NEVER run these again until a person records what happened):',
          ...unknown.map((o) => `- ${o.command}`),
        );
    }
    return lines;
  }

  private async membersOf(workspaceId: string): Promise<Member[]> {
    return (
      await this.brain.request<{ members: Member[] }>(
        'GET',
        `/api/workspaces/${workspaceId}/members`,
      )
    ).members;
  }

  /** Everything an agent should know about the team, for get_team_context. */
  async context(caller: TeamCaller): Promise<string> {
    const { root } = caller;
    const lines: string[] = [`Repository: ${root}`];
    const status = await getStatus(root).catch(() => null);
    if (status)
      lines.push(
        `Branch: ${status.branch ?? '(detached)'}; ${status.files.length} changed file(s) in this checkout.`,
      );
    const workspaceId = await this.workspaceId(root);
    if (!this.shared()) {
      lines.push(
        'Team: the person is working locally (not signed in), so there is no shared team context.',
      );
      return lines.join('\n');
    }
    if (!workspaceId) {
      lines.push('Team: this folder is not a shared Kovan workspace, so no teammates see it.');
      return lines.join('\n');
    }
    try {
      const { workspace } = await this.brain.request<{ workspace: Workspace }>(
        'GET',
        `/api/workspaces/${workspaceId}`,
      );
      const members = await this.membersOf(workspaceId);
      const names = new Map(members.map((m) => [m.userId, m.name]));
      const online = new Map(this.brain.presenceOf(workspaceId).map((p) => [p.userId, p]));
      const me = this.brain.status().user?.id;
      lines.push(`Shared workspace: ${workspace.name} (your role: ${workspace.role}).`, 'Members:');
      for (const m of members) {
        const p = online.get(m.userId);
        const state = p
          ? p.inWorkspace
            ? 'online, has this repository open'
            : 'online'
          : 'offline';
        lines.push(
          `- ${m.name}${m.githubLogin ? ` (@${m.githubLogin})` : ''}, ${m.role}, ${state}${m.userId === me ? ' (you are acting for this person)' : ''}`,
        );
      }
      const { sessions } = await this.brain.request<{ sessions: Session[] }>(
        'GET',
        `/api/workspaces/${workspaceId}/sessions`,
      );
      if (sessions.length) {
        lines.push('Live sessions:');
        for (const s of sessions)
          lines.push(
            `- "${s.title}" on ${s.branch ?? 'no branch'}: ${
              s.participants
                .filter((p) => p.mode === 'join')
                .map((p) => `${p.name} (${p.state})`)
                .join(', ') || 'nobody yet'
            }${s.touchedFiles.length ? `; touched ${s.touchedFiles.slice(0, 8).join(', ')}` : ''}`,
          );
      }
      if (caller.session) {
        const plan = await this.plan(caller.session.id);
        if (plan) lines.push(...this.planBlock(plan, caller.session, names));
      }
      lines.push(...(await this.guardBlock(workspaceId, caller.session)));
      lines.push(...this.notesBlock(await this.memories(workspaceId), names));
    } catch (error) {
      lines.push(
        `Team: unavailable right now (${(error as Error).message}). Continue on your own.`,
      );
    }
    return lines.join('\n');
  }

  /** A short system note for each turn of Kovan's agent: the plan and the Brain notes. */
  async turnNote(caller: TeamCaller): Promise<string | null> {
    if (!this.shared()) return null;
    const workspaceId = await this.workspaceId(caller.root);
    if (!workspaceId) return null;
    try {
      const members = await this.membersOf(workspaceId);
      const names = new Map(members.map((m) => [m.userId, m.name]));
      const lines = ['Kovan team context for this turn.'];
      if (caller.session) {
        const plan = await this.plan(caller.session.id);
        if (plan) lines.push(...this.planBlock(plan, caller.session, names));
      }
      lines.push(...(await this.guardBlock(workspaceId, caller.session)));
      lines.push(...this.notesBlock(await this.memories(workspaceId), names));
      return lines.join('\n');
    } catch {
      return null; // offline: the agent works on without it
    }
  }

  private async fileText(root: string, path: string): Promise<string | null> {
    if (path.includes('..') || path.startsWith('/')) return null;
    return readFile(join(root, path), 'utf8').catch(() => null);
  }

  /** Runs one coordination tool. Errors come back as text the agent can act on. */
  async call(
    tool: string,
    args: Record<string, unknown>,
    caller: TeamCaller,
  ): Promise<TeamToolResult> {
    if (tool === 'get_team_context') return { text: await this.context(caller) };
    if (!this.shared())
      return {
        text: 'The person is working locally (not signed in), so there is no shared team to coordinate with. Continue on your own.',
      };
    const workspaceId = await this.workspaceId(caller.root);
    if (!workspaceId)
      return {
        text: 'This folder is not a shared Kovan workspace, so plans and notes are not available. Continue on your own.',
      };
    try {
      switch (tool) {
        case 'record_memory':
          return await this.recordMemory(workspaceId, args, caller);
        case 'claim_plan_step': {
          const stepId = String(args['stepId'] ?? '');
          const { plan } = await this.brain.request<{ plan: Plan }>(
            'POST',
            `/api/plan-steps/${stepId}/claim`,
          );
          const step = plan.steps.find((s) => s.id === stepId);
          return {
            text: `Claimed "${step?.title ?? stepId}" for the person you work for. It is now in progress.`,
          };
        }
        case 'update_plan_step': {
          const stepId = String(args['stepId'] ?? '');
          const status = String(args['status'] ?? '');
          if (!['todo', 'doing', 'done'].includes(status))
            return { text: 'status must be todo, doing or done', isError: true };
          await this.brain.request('PATCH', `/api/plan-steps/${stepId}`, { status });
          return { text: `Step marked ${status}.` };
        }
        case 'propose_split': {
          if (!caller.session)
            return {
              text: 'There is no shared session here, so there is no plan to split into. Continue the task yourself.',
            };
          const steps = Array.isArray(args['steps'])
            ? (args['steps'] as Record<string, unknown>[])
            : [];
          if (steps.length === 0) return { text: 'Give at least one step.', isError: true };
          const { plan } = await this.brain.request<{ plan: Plan }>(
            'POST',
            `/api/sessions/${caller.session.id}/plan/steps`,
            {
              steps: steps.slice(0, 30).map((s) => ({
                title: String(s['title'] ?? '').slice(0, 200) || 'Step',
                files: Array.isArray(s['files'])
                  ? (s['files'] as unknown[]).map(String).slice(0, 50)
                  : [],
              })),
            },
          );
          return {
            text: `Added ${steps.length} step(s) to the session plan (now ${plan.steps.length}). Teammates can take them; claim one with claim_plan_step before you start it.`,
          };
        }
        case 'message_agent':
          return this.messageAgent(workspaceId, args, caller);
        case 'assign_work': {
          if (!caller.session)
            return {
              text: 'There is no shared session here to assign work in. Tell the person who should take it instead.',
            };
          const to = String(args['to'] ?? '')
            .replace(/^@/, '')
            .toLowerCase();
          const member = (await this.membersOf(workspaceId)).find(
            (m) => m.githubLogin?.toLowerCase() === to || m.name.toLowerCase() === to,
          );
          if (!member)
            return { text: `No one called "${to}" is in this workspace.`, isError: true };
          await this.brain.request('POST', `/api/sessions/${caller.session.id}/plan/steps`, {
            steps: [
              {
                title: String(args['title'] ?? 'Work item').slice(0, 200),
                detail: typeof args['note'] === 'string' ? args['note'].slice(0, 2000) : null,
                ownerId: member.userId,
              },
            ],
          });
          return { text: `Added "${String(args['title'])}" to the plan, owned by ${member.name}.` };
        }
        default:
          return { text: `Unknown tool ${tool}`, isError: true };
      }
    } catch (error) {
      const message = error instanceof BrainError ? error.message : (error as Error).message;
      return { text: `Kovan could not do that: ${message}`, isError: true };
    }
  }

  /**
   * A message for another agent in the session: an AI teammate of the session's swarm hears it in
   * the swarm's chat; anyone else's agent (or an AI teammate's lane) gets it as guidance.
   */
  private async messageAgent(
    workspaceId: string,
    args: Record<string, unknown>,
    caller: TeamCaller,
  ): Promise<TeamToolResult> {
    if (!caller.session)
      return { text: 'There is no shared session here; leave a comment instead.', isError: true };
    const sessionId = caller.session.id;
    const text = String(args['text'] ?? '').trim();
    if (!text) return { text: 'Write the message in text.', isError: true };
    const to = String(args['to'] ?? '')
      .replace(/^@/, '')
      .toLowerCase();
    const member = (await this.membersOf(workspaceId)).find(
      (m) => m.githubLogin?.toLowerCase() === to || m.name.toLowerCase() === to,
    );
    if (!member) return { text: `No one called "${to}" is in this workspace.`, isError: true };
    const { swarm } = await this.brain.request<{ swarm: Swarm | null }>(
      'GET',
      `/api/sessions/${sessionId}/swarm`,
    );
    if (swarm?.status === 'running' && swarm.agents.some((a) => a.agentId === member.userId)) {
      await this.brain.request('POST', `/api/swarms/${swarm.id}/messages`, {
        toId: member.userId,
        text: text.slice(0, 4000),
      });
      return { text: `Sent to ${member.name} in the swarm's chat.` };
    }
    const { session } = await this.brain.request<{ session: Session }>(
      'GET',
      `/api/sessions/${sessionId}`,
    );
    if (!session.participants.some((p) => p.userId === member.userId && p.mode === 'join'))
      return {
        text: `${member.name} has no agent in this session. Leave a comment for them instead.`,
        isError: true,
      };
    if (!this.brain.steer(sessionId, member.userId, randomUUID(), text.slice(0, 10_000)))
      return { text: "Kovan is offline; the message wasn't sent.", isError: true };
    return { text: `Sent to ${member.name}'s agent; it gets it before its next step.` };
  }

  private async recordMemory(
    workspaceId: string,
    args: Record<string, unknown>,
    caller: TeamCaller,
  ): Promise<TeamToolResult> {
    const kind = String(args['kind'] ?? '');
    if (!['decision', 'gotcha', 'convention'].includes(kind))
      return { text: 'kind must be decision, gotcha or convention', isError: true };
    const text = String(args['text'] ?? '').trim();
    if (!text) return { text: 'Write the note in text.', isError: true };
    const path =
      typeof args['path'] === 'string' && args['path'] ? args['path'].replace(/^\.\//, '') : null;
    const start = line(args['line']);
    const content = path ? await this.fileText(caller.root, path) : null;
    if (path && content === null)
      return {
        text: `${path} doesn't exist in this checkout; pin the note to a file that does.`,
        isError: true,
      };
    const total = content?.split('\n').length ?? 0;
    // Pinned to a few lines when a line is given, so a later change to that code is noticed.
    const startLine = start && content ? Math.min(start, total) : null;
    const endLine = startLine ? Math.min(line(args['endLine']) ?? startLine + 2, total) : null;
    const commit = (await git(caller.root, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
    const { memory } = await this.brain.request<{ memory: Memory }>(
      'POST',
      `/api/workspaces/${workspaceId}/memories`,
      {
        kind,
        text: text.slice(0, 2000),
        path,
        startLine,
        endLine,
        snippet: startLine && endLine && content ? snippetAt(content, startLine, endLine) : null,
        commit,
        byAgent: caller.agent,
        sessionId: caller.session?.id ?? null,
        replacesId:
          typeof args['replaces'] === 'string' && args['replaces'] ? args['replaces'] : null,
        rationale:
          typeof args['why'] === 'string' && args['why'].trim() ? args['why'].slice(0, 2000) : null,
        consequences:
          typeof args['consequences'] === 'string' && args['consequences'].trim()
            ? args['consequences'].slice(0, 2000)
            : null,
        affects: Array.isArray(args['affects'])
          ? args['affects']
              .map((a) => String(a))
              .filter(Boolean)
              .slice(0, 20)
          : [],
      },
    );
    return {
      text: `Saved to the Brain (id ${memory.id}). Every agent in this workspace will see it; a teammate can verify it.`,
    };
  }

  /**
   * Answers a hook from an agent CLI started outside Kovan (the repo was connected). Before a
   * prompt: the team context and any overlap warnings, as extra context for the model. Before
   * an edit: a teammate's lock makes the CLI ask the person first. After a tool, during a long
   * turn: the team context again when it changed. Empty means "go ahead".
   */
  async hook(
    event: string,
    input: Record<string, unknown>,
    caller: TeamCaller,
    overlap: (text: string, paths: string[]) => Promise<OverlapWarning[]>,
  ): Promise<string> {
    if (!this.shared()) return '';
    const workspaceId = await this.workspaceId(caller.root);
    if (!workspaceId) return '';
    if (event === 'UserPromptSubmit') {
      const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : '';
      const [note, warnings] = await Promise.all([
        this.turnNote(caller),
        overlap(prompt, []).catch(() => [] as OverlapWarning[]),
      ]);
      const lines = [
        ...(note ? [note] : []),
        ...warnings.map(
          (w) =>
            `OVERLAP (${w.kind}): ${w.people.join(', ') || 'a teammate'}'s session "${w.title}": ${w.reason}. Tell the person before changing the same code; they may want to join that session or split the work.`,
        ),
      ];
      if (note) this.delivered.set(this.noteKey(caller), { note, at: Date.now() });
      if (lines.length === 0) return '';
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: lines.join('\n'),
        },
      });
    }
    if (event === 'PostToolUse') {
      // A long turn: what the team does changes meanwhile. Read again at most every 20 s, and
      // given to the model only when it changed since it last got it.
      const key = this.noteKey(caller);
      const last = this.delivered.get(key);
      if (last && Date.now() - last.at < NOTE_REFRESH_MS) return '';
      const note = await this.turnNote(caller).catch(() => null);
      this.delivered.set(key, { note: note ?? last?.note ?? '', at: Date.now() });
      if (!note || note === last?.note) return '';
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `The team's state changed while you work:\n${note}`,
        },
      });
    }
    if (event === 'PreToolUse') {
      const tool = String(input['tool_name'] ?? '');
      if (!['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) return '';
      const args = (input['tool_input'] ?? {}) as Record<string, unknown>;
      const raw = String(args['file_path'] ?? args['notebook_path'] ?? '');
      const path = raw.startsWith(`${caller.root}/`) ? raw.slice(caller.root.length + 1) : raw;
      const me = this.brain.status().user?.id;
      const { locks } = await this.brain
        .request<{ locks: PathLock[] }>('GET', `/api/workspaces/${workspaceId}/locks`)
        .catch(() => ({ locks: [] as PathLock[] }));
      const lock = locks.find((l) => l.path === path && l.userId !== me);
      if (!lock) {
        // Another live session is changing this code: held once, with why (asking again goes).
        const held = await this.checkWrite(caller, path);
        if (!held) return '';
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: held,
          },
        });
      }
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `${path} is locked by ${lock.userName} in a Kovan session. Check with them before editing it.`,
        },
      });
    }
    return '';
  }

  /** Kovan's own agent gets the same tools as Claude Code and Codex get over MCP. */
  harnessTools(caller: () => TeamCaller): Tool[] {
    const tool = (
      name: string,
      description: string,
      parameters: Record<string, unknown>,
      describe: (args: Record<string, unknown>) => string,
    ): Tool => ({
      spec: { name, description, parameters },
      kind: 'team',
      describe,
      run: async (args) => {
        const result = await this.call(name, args, caller());
        return { ok: !result.isError, output: result.text };
      },
    });
    const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    });
    return [
      tool(
        'get_team_context',
        "Who is in this workspace and online, live sessions and the files they touch, this session's plan, and the Brain notes. Use at the start of a bigger task; it changes slowly.",
        obj({}),
        () => 'Read the team context',
      ),
      tool(
        'record_memory',
        "Save a short, durable note pinned to a file for every future agent: a decision, a gotcha or a convention. Don't record temporary state or task progress. To rewrite a flagged note, pass its id as replaces.",
        obj(
          {
            path: {
              type: 'string',
              description: 'File the note is about, relative to the repo root',
            },
            line: { type: 'number', description: 'First line of the code it is about' },
            endLine: { type: 'number' },
            kind: { type: 'string', enum: ['decision', 'gotcha', 'convention'] },
            text: { type: 'string', description: 'One or two sentences' },
            replaces: { type: 'string', description: 'Id of a flagged note this rewrites' },
            why: { type: 'string', description: 'For a decision: why it was made' },
            consequences: {
              type: 'string',
              description: 'For a decision: what follows from it (what others must or must not do)',
            },
            affects: {
              type: 'array',
              items: { type: 'string' },
              description: 'For a decision: the folders or files (modules, services) it governs',
            },
          },
          ['kind', 'text'],
        ),
        (a) => `Recorded a note on ${typeof a['path'] === 'string' ? a['path'] : 'the workspace'}`,
      ),
      tool(
        'message_agent',
        "Send a short message to another agent in this session: a teammate's agent or an AI teammate (by name). Use it to coordinate on a shared file or hand over a finding. Don't use it for status chatter or to reach the person you work for.",
        obj(
          {
            to: {
              type: 'string',
              description: 'Name (or GitHub username) of the teammate or AI teammate',
            },
            text: { type: 'string' },
          },
          ['to', 'text'],
        ),
        (a) => `Messaged ${String(a['to'] ?? 'an agent')}`,
      ),
      tool(
        'claim_plan_step',
        "Claim an unowned step of the session plan before working on it. Don't claim steps someone else owns; ask them instead.",
        obj({ stepId: { type: 'string' } }, ['stepId']),
        () => 'Claimed a plan step',
      ),
      tool(
        'update_plan_step',
        "Mark a plan step you own as doing or done when your work on it starts or is finished. Don't change steps other people own.",
        obj(
          {
            stepId: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'doing', 'done'] },
          },
          ['stepId', 'status'],
        ),
        (a) => `Marked a plan step ${String(a['status'] ?? '')}`,
      ),
      tool(
        'propose_split',
        "Add steps to the session plan for a task big enough to split between teammates. Don't use it for small or single-file changes.",
        obj(
          {
            summary: { type: 'string' },
            steps: {
              type: 'array',
              items: obj(
                { title: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
                ['title'],
              ),
            },
          },
          ['summary', 'steps'],
        ),
        (a) => `Proposed ${Array.isArray(a['steps']) ? a['steps'].length : 0} plan steps`,
      ),
    ];
  }

  // ---------- keeping pins honest ----------

  /**
   * Checks pinned notes and comments against this checkout's HEAD after it moved (merge, pull,
   * checkout) and tells the Brain about code that moved or changed: notes are flagged (the next
   * agent nearby rewrites them), comments labelled. HEAD, not the working tree, so work in
   * progress doesn't raise flags; and only pins whose code was really committed in a commit
   * this checkout has, so a teammate's uncommitted code isn't judged against ours.
   */
  async verifyAnchors(root: string): Promise<{ flagged: number; outdated: number }> {
    const workspaceId = await this.workspaceId(root);
    if (!workspaceId || this.brain.status().connection !== 'online')
      return { flagged: 0, outdated: 0 };
    const atHead = new Map<string, Promise<string | null>>();
    const headText = (path: string) => {
      if (!atHead.has(path))
        atHead.set(
          path,
          git(root, ['show', `HEAD:${path}`]).catch(() => null),
        );
      return atHead.get(path)!;
    };
    const judgeable = async (commit: string | null, path: string, anchor: Anchor) => {
      if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) return false;
      const inHistory = await git(root, ['merge-base', '--is-ancestor', commit, 'HEAD'])
        .then(() => true)
        .catch(() => false);
      if (!inHistory) return false;
      const then = await git(root, ['show', `${commit}:${path}`]).catch(() => null);
      return checkAnchor(then, anchor).state === 'ok';
    };

    let flagged = 0;
    let outdated = 0;
    for (const m of await this.memories(workspaceId)) {
      if (m.status !== 'active' || !m.path || !m.snippet || !m.startLine) continue;
      const anchor = {
        startLine: m.startLine,
        endLine: m.endLine ?? m.startLine,
        snippet: m.snippet,
      };
      const state = checkAnchor(await headText(m.path), anchor);
      if (state.state === 'ok' || !(await judgeable(m.commit, m.path, anchor))) continue;
      await this.brain
        .request('POST', `/api/memories/${m.id}/flag`, {
          reason: describeAnchorState(state, m.path, m.startLine),
        })
        .then(() => (flagged += 1))
        .catch(() => undefined);
    }
    const { comments } = await this.brain.request<{ comments: Comment[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/comments`,
    );
    for (const c of comments) {
      if (c.outdated || (c.anchor.kind !== 'file' && c.anchor.kind !== 'hunk')) continue;
      const state = checkAnchor(await headText(c.anchor.path), c.anchor);
      if (
        state.state === 'ok' ||
        !(await judgeable(c.anchor.commit ?? null, c.anchor.path, c.anchor))
      )
        continue;
      await this.brain
        .request('PATCH', `/api/comments/${c.id}`, { outdated: true })
        .then(() => (outdated += 1))
        .catch(() => undefined);
    }
    return { flagged, outdated };
  }
}
