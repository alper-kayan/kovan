import type {
  Comment,
  CommentAnchor,
  Memory,
  MemoryKind,
  Plan,
  ServerMessage,
  StepStatus,
} from '@kovan/shared';
import type { HttpMethod } from '../../../shared/api';
import {
  activeTeamWorkspace,
  getState,
  notify,
  reportError,
  setState,
  toast,
  useStore,
} from '../store';
import { newConversation, sendPrompt } from './agent';
import { api } from './api';
import { openSession } from './sessions';
import { mentionedPeople, mentionedTeammate } from '../../../shared/mentions';

function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  return (
    body === undefined
      ? api.invoke('brain:request', method, path)
      : api.invoke('brain:request', method, path, body)
  ) as Promise<T>;
}

async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    reportError(error);
    return null;
  }
}

export function initCollab(): void {
  api.on('brain:message', handleMessage);
  // Pins are checked whenever HEAD moves (merge, pull, checkout, commit) in the open checkout.
  let timer: ReturnType<typeof setTimeout> | null = null;
  api.on('fs:changed', (event) => {
    if (!event.gitChanged) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void verifyAnchors(), 2000);
  });
  let loadedFor = '';
  const reload = (s: ReturnType<typeof getState>) => {
    const key = s.signedIn ? `${s.connection}|${s.teamWorkspaces.map((w) => w.id).join(',')}` : '';
    if (key === loadedFor) return;
    loadedFor = key;
    for (const w of s.teamWorkspaces) {
      void loadMemories(w.id);
      void loadComments(w.id);
    }
    if (s.connection === 'online') void verifyAnchors();
  };
  reload(getState());
  useStore.subscribe(reload);
}

export async function verifyAnchors(): Promise<void> {
  const s = getState();
  if (!s.signedIn || !activeTeamWorkspace(s)) return;
  try {
    const { flagged, outdated } = await api.invoke('brain:verifyAnchors');
    if (flagged || outdated)
      toast(
        [
          flagged ? `${flagged} Brain note${flagged > 1 ? 's' : ''} flagged` : '',
          outdated ? `${outdated} comment${outdated > 1 ? 's' : ''} marked outdated` : '',
        ]
          .filter(Boolean)
          .join(' and ') + ': the code they point at moved or changed.',
      );
  } catch {
    // Offline: checked again on the next change.
  }
}

function upsertBy<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const rest = (list ?? []).filter((x) => x.id !== item.id);
  return [...rest, item];
}

function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'plan':
      setState((s) => ({ plans: { ...s.plans, [message.plan.sessionId]: message.plan } }));
      return;
    case 'comment': {
      const c = message.comment;
      const seen = getState().comments[c.workspaceId]?.some((x) => x.id === c.id);
      if (!seen) noticeMention(c);
      setState((s) => ({
        comments: { ...s.comments, [c.workspaceId]: upsertBy(s.comments[c.workspaceId], c) },
      }));
      return;
    }
    case 'memory': {
      const m = message.memory;
      setState((s) => ({
        memories: {
          ...s.memories,
          [m.workspaceId]:
            m.status === 'retired'
              ? (s.memories[m.workspaceId] ?? []).filter((x) => x.id !== m.id)
              : upsertBy(s.memories[m.workspaceId], m),
        },
      }));
      return;
    }
    default:
      return;
  }
}

/** A new comment by someone else that calls you by name: say so, with a way to it. */
function noticeMention(c: Comment): void {
  const me = getState().user;
  if (!me || c.authorId === me.id || !c.body.includes('@')) return;
  if (!mentionedPeople(c.body, [{ id: me.id, name: me.name }]).length) return;
  const sessionId = c.sessionId;
  notify({
    kind: 'info',
    title: `${c.authorName} mentioned you`,
    message: c.body.length > 160 ? `${c.body.slice(0, 159)}…` : c.body,
    sticky: true,
    ...(sessionId
      ? {
          action: {
            label: 'Open',
            run: () => {
              setState({ railFocus: 'comments' });
              if (getState().room?.session?.id !== sessionId) void openSession(sessionId);
            },
          },
        }
      : {}),
  });
}

// ---------- the plan ----------

const setPlan = (plan: Plan) =>
  setState((s) => ({ plans: { ...s.plans, [plan.sessionId]: plan } }));

export async function loadPlan(sessionId: string): Promise<void> {
  const r = await request<{ plan: Plan }>('GET', `/api/sessions/${sessionId}/plan`).catch(
    () => null,
  );
  if (r) setPlan(r.plan);
}

export async function addSteps(
  sessionId: string,
  steps: { title: string; ownerId?: string | null }[],
  fromCommentId: string | null = null,
): Promise<boolean> {
  const r = await attempt(() =>
    request<{ plan: Plan }>('POST', `/api/sessions/${sessionId}/plan/steps`, {
      steps: steps.map((s) => ({ title: s.title, ownerId: s.ownerId ?? null })),
      fromCommentId,
    }),
  );
  if (r) setPlan(r.plan);
  return r !== null;
}

export async function setStepStatus(stepId: string, status: StepStatus): Promise<void> {
  const r = await attempt(() =>
    request<{ plan: Plan }>('PATCH', `/api/plan-steps/${stepId}`, { status }),
  );
  if (r) setPlan(r.plan);
}

/** Says yes or no to a step an agent may start only with a person's approval. */
export async function answerStepApproval(stepId: string, approve: boolean): Promise<void> {
  const r = await attempt(() =>
    request<{ plan: Plan }>('POST', `/api/plan-steps/${stepId}/approval`, { approve }),
  );
  if (r) setPlan(r.plan);
}

export async function renameStep(stepId: string, title: string): Promise<void> {
  const r = await attempt(() =>
    request<{ plan: Plan }>('PATCH', `/api/plan-steps/${stepId}`, { title }),
  );
  if (r) setPlan(r.plan);
}

export async function deleteStep(stepId: string): Promise<void> {
  const r = await attempt(() => request<{ plan: Plan }>('DELETE', `/api/plan-steps/${stepId}`));
  if (r) setPlan(r.plan);
}

export async function assignStep(stepId: string, userId: string | null): Promise<void> {
  const r = await attempt(() =>
    request<{ plan: Plan }>('POST', `/api/plan-steps/${stepId}/assign`, { userId }),
  );
  if (r) setPlan(r.plan);
}

export async function releaseStep(stepId: string): Promise<void> {
  const r = await attempt(() =>
    request<{ plan: Plan }>('POST', `/api/plan-steps/${stepId}/release`),
  );
  if (r) setPlan(r.plan);
}

/** Free steps move at once; owned or started ones are asked of their owner. */
export async function takeOver(sessionId: string, stepIds: string[]): Promise<void> {
  const r = await attempt(() =>
    request<{ plan: Plan; transferred: string[]; requested: string[] }>(
      'POST',
      `/api/sessions/${sessionId}/plan/takeover`,
      { stepIds },
    ),
  );
  if (!r) return;
  setPlan(r.plan);
  const parts = [
    r.transferred.length
      ? `${r.transferred.length} step${r.transferred.length > 1 ? 's are' : ' is'} yours now`
      : '',
    r.requested.length
      ? `asked the owner${r.requested.length > 1 ? 's' : ''} for ${r.requested.length}`
      : '',
  ].filter(Boolean);
  if (parts.length) toast(`${parts.join('; ')}.`);
}

export async function answerOffer(offerId: string, accept: boolean): Promise<void> {
  const r = await attempt(() =>
    request<{ plan: Plan }>('POST', `/api/step-offers/${offerId}`, { accept }),
  );
  if (r) setPlan(r.plan);
}

// ---------- comments ----------

export async function loadComments(workspaceId: string): Promise<void> {
  const r = await request<{ comments: Comment[] }>(
    'GET',
    `/api/workspaces/${workspaceId}/comments`,
  ).catch(() => null);
  if (r) setState((s) => ({ comments: { ...s.comments, [workspaceId]: r.comments } }));
}

export async function addComment(
  workspaceId: string,
  input: {
    anchor: CommentAnchor;
    body: string;
    sessionId?: string | null;
    parentId?: string | null;
    kind?: 'comment' | 'suggestion';
    proposal?: string | null;
  },
): Promise<Comment | null> {
  const r = await attempt(() =>
    request<{ comment: Comment }>('POST', `/api/workspaces/${workspaceId}/comments`, {
      sessionId: input.sessionId ?? null,
      parentId: input.parentId ?? null,
      anchor: input.anchor,
      kind: input.kind ?? 'comment',
      body: input.body,
      proposal: input.proposal ?? null,
    }),
  );
  if (r) {
    setState((s) => ({
      comments: { ...s.comments, [workspaceId]: upsertBy(s.comments[workspaceId], r.comment) },
    }));
    void callInFromComment(r.comment).catch(reportError);
  }
  return r?.comment ?? null;
}

export async function setCommentStatus(
  comment: Comment,
  status: 'open' | 'resolved',
): Promise<void> {
  await attempt(() => request('PATCH', `/api/comments/${comment.id}`, { status }));
}

/** Turns a comment into a step of a live session's plan; the step remembers where it came from. */
export async function commentToStep(comment: Comment, sessionId: string): Promise<void> {
  const title = comment.body.split('\n')[0]!.slice(0, 200);
  if (await addSteps(sessionId, [{ title }], comment.id)) toast('Added to the plan.');
}

function where(anchor: CommentAnchor): string {
  return anchor.kind === 'file' || anchor.kind === 'hunk'
    ? `${anchor.path}:${anchor.startLine}${anchor.endLine !== anchor.startLine ? `-${anchor.endLine}` : ''}`
    : anchor.kind === 'transcript'
      ? `a lane's transcript ("${anchor.excerpt}")`
      : 'the session';
}

/** The code around a comment on a file or a hunk (ten lines each side), as a fenced block. */
async function codeAround(a: CommentAnchor): Promise<string> {
  if (a.kind !== 'file' && a.kind !== 'hunk') return '';
  const file = await api.invoke('fs:readFile', a.path).catch(() => null);
  if (file?.kind !== 'text') return '';
  const lines = file.content.split('\n');
  const from = Math.max(0, a.startLine - 11);
  const to = Math.min(lines.length, a.endLine + 10);
  return `\n\nThe code around it (${a.path}, lines ${from + 1}-${to}):\n\`\`\`\n${lines
    .slice(from, to)
    .join('\n')}\n\`\`\``;
}

/**
 * A comment in a session that says "@Name" calls that AI teammate in: it reads the thread and
 * the code it is about, and answers in the thread.
 */
async function callInFromComment(comment: Comment): Promise<void> {
  const teammates = (getState().aiAgents[comment.workspaceId] ?? []).filter((a) => !a.archived);
  const called = mentionedTeammate(comment.body, teammates);
  if (!called) return;
  const all = getState().comments[comment.workspaceId] ?? [];
  const rootId = comment.parentId ?? comment.id;
  const root = all.find((c) => c.id === rootId) ?? comment;
  const sessionId = comment.sessionId ?? root.sessionId;
  if (!sessionId) {
    toast(`${called.name} works in a session: comment on one to call them in.`, 'error');
    return;
  }
  const thread = [root, ...all.filter((c) => c.parentId === rootId)]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(
      (c) =>
        `${c.authorName}: ${c.body}${c.proposal ? `\nProposed code:\n\`\`\`\n${c.proposal}\n\`\`\`` : ''}`,
    );
  const context = `A comment thread on ${where(root.anchor)}:\n${thread.join('\n')}${await codeAround(root.anchor)}`;
  await request('POST', `/api/sessions/${sessionId}/mention`, {
    agentId: called.id,
    text: comment.body,
    context,
    reply: { kind: 'comment', commentId: rootId },
  });
  toast(`${called.name} is looking at it.`);
}

/**
 * Starts your own agent on a comment: it gets the repository, the file and lines, the code
 * around them and the comment text. The comment remembers it led to a prompt.
 */
export async function promptFromComment(comment: Comment): Promise<void> {
  const a = comment.anchor;
  const context = await codeAround(a);
  const prompt = `${comment.authorName} commented on ${where(a)}${comment.kind === 'suggestion' ? ' with a suggestion' : ''}:\n\n> ${comment.body.split('\n').join('\n> ')}${comment.proposal ? `\n\nProposed code:\n\`\`\`\n${comment.proposal}\n\`\`\`` : ''}${context}\n\nAddress this comment.`;
  setState({ agentOpen: true });
  if (getState().conversation?.running) await newConversation();
  if (await sendPrompt(prompt, [])) {
    await attempt(() => request('PATCH', `/api/comments/${comment.id}`, { prompted: true }));
  }
}

/** Writes a suggestion's proposed code over the lines it was made on. */
export async function applySuggestion(comment: Comment): Promise<void> {
  const a = comment.anchor;
  if ((a.kind !== 'file' && a.kind !== 'hunk') || comment.proposal === null) return;
  const file = await attempt(() => api.invoke('fs:readFile', a.path));
  if (!file || file.kind !== 'text') return;
  const lines = file.content.split('\n');
  const current = lines.slice(a.startLine - 1, a.endLine).join('\n');
  if (current.replace(/\s+$/gm, '') !== a.snippet.replace(/\s+$/gm, '')) {
    toast('The code changed since this suggestion was made; apply it by hand.', 'error');
    return;
  }
  lines.splice(a.startLine - 1, a.endLine - a.startLine + 1, ...comment.proposal.split('\n'));
  await attempt(() => api.invoke('fs:writeFile', a.path, lines.join('\n')));
  await setCommentStatus(comment, 'resolved');
  toast(`Applied to ${a.path}.`);
}

// ---------- the Brain ----------

export async function loadMemories(workspaceId: string): Promise<void> {
  const r = await request<{ memories: Memory[] }>(
    'GET',
    `/api/workspaces/${workspaceId}/memories`,
  ).catch(() => null);
  if (r) setState((s) => ({ memories: { ...s.memories, [workspaceId]: r.memories } }));
}

export async function loadRetired(workspaceId: string): Promise<Memory[]> {
  const r = await attempt(() =>
    request<{ memories: Memory[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/memories?status=retired`,
    ),
  );
  return r?.memories ?? [];
}

export async function addMemory(
  workspaceId: string,
  input: { kind: MemoryKind; text: string; path: string | null; line: number | null },
): Promise<boolean> {
  let snippet: string | null = null;
  let endLine: number | null = null;
  if (input.path && input.line) {
    const file = await api.invoke('fs:readFile', input.path).catch(() => null);
    if (file?.kind === 'text') {
      const lines = file.content.split('\n');
      endLine = Math.min(lines.length, input.line + 2);
      snippet = lines
        .slice(input.line - 1, endLine)
        .map((l) => l.trimEnd())
        .join('\n');
    }
  }
  const commit = await api.invoke('git:head').catch(() => null);
  const r = await attempt(() =>
    request<{ memory: Memory }>('POST', `/api/workspaces/${workspaceId}/memories`, {
      kind: input.kind,
      text: input.text,
      path: input.path,
      startLine: snippet ? input.line : null,
      endLine,
      snippet,
      commit,
    }),
  );
  return r !== null;
}

export async function updateMemory(
  memory: Memory,
  patch: Partial<{
    text: string;
    kind: MemoryKind;
    status: 'active' | 'retired';
    verified: true;
    clearConflicts: true;
  }>,
): Promise<void> {
  await attempt(() => request('PATCH', `/api/memories/${memory.id}`, patch));
}
