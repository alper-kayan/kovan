import type { Effort } from '@kovan/model-gateway';
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDot,
  CircleHelp,
  CornerDownLeft,
  ListPlus,
  MessageSquarePlus,
  Paperclip,
  Plus,
  ShieldCheck,
  Square,
  SquareTerminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  foldEvents,
  HARNESS_NAMES,
  JEV_MODEL_ID,
  type Attachment,
  type ChatItem,
  type Harness,
  type PermissionMode,
  parseCustomModelId,
  type ApprovalRequest,
} from '../../../shared/agent';
import { limitLabel, limitNow, type AgentLimit } from '../../../shared/limits';
import {
  answerApproval,
  configureConversation,
  setAutoAgent,
  setHarness,
  deleteConversation,
  loadConversations,
  newConversation,
  openConversation,
  queuePrompt,
  saveOpenRouterKey,
  sendPrompt,
  setDraft,
  unqueuePrompt,
  setEffort,
  setMode,
  stopAgent,
  toggleAgentPanel,
} from '../services/agent';
import { addSteps } from '../services/collab';
import { issueFromReply } from '../services/issues';
import { useFileOpener } from '../fileOpener';
import { overlapFor, steer } from '../services/flow';
import { openSession } from '../services/sessions';
import { startSubagent } from '../services/sync';
import { api } from '../services/api';
import type { OverlapWarning, SkillInfo } from '../../../shared/api';
import { newTerminal } from '../services/terminal';
import { getState, notify, reportError, setState, showView, useStore } from '../store';
import { updateSettings } from '../services/settings';
import { Markdown } from './Markdown';
import { ModelPicker } from './ModelPicker';
import { MentionMenu, useMentionMenu, useTeammates } from './MentionMenu';
import { mentionedTeammate } from '../../../shared/mentions';
import { Avatar, personColor, ProgressRing, useFloating } from './ui';

export const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan only', hint: 'Reads and plans, never edits' },
  { id: 'request', label: 'Ask first', hint: 'Asks before every edit and command' },
  { id: 'allow', label: 'Edit freely', hint: 'Edits files, asks before commands' },
  { id: 'full', label: 'Full access', hint: 'Edits and runs anything without asking' },
];

/** First prompts for an empty chat: a click puts one in the composer, to send or change. */
const STARTERS = [
  'Explain how this repository is organized',
  'Find a failing test and fix it',
  'Review my uncommitted changes',
];

/** Costs are shown down to the smallest charge; zero is shown as zero. */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00000000';
  if (cost < 0.01) return `$${cost.toFixed(cost < 0.0001 ? 8 : 6)}`;
  return `$${cost.toFixed(4)}`;
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ProviderSetup() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="agent-empty">
      <Zap size={22} />
      <div className="empty-title">Connect a model provider</div>
      <p className="empty-text">
        Kovan's agent runs on your machine and calls models through OpenRouter with your own key.
        The key stays in the system keychain.
      </p>
      <form
        className="key-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void saveOpenRouterKey(key.trim()).then((ok) => {
            setBusy(false);
            if (ok) setKey('');
          });
        }}
      >
        <input
          className="input mono"
          type="password"
          placeholder="sk-or-v1-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy || key.trim().length < 10}>
          {busy ? 'Checking…' : 'Save key'}
        </button>
      </form>
      <a className="link-btn" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
        Get a key at openrouter.ai
      </a>
    </div>
  );
}

/** A short quote of a transcript row, to recognise what a comment is about. */
function excerptOf(item: ChatItem): string {
  switch (item.kind) {
    case 'prompt':
    case 'text':
    case 'reasoning':
      return item.text.slice(0, 200);
    case 'tool':
      return item.summary;
    case 'route':
      return `JevRouter → ${item.model}`;
    case 'end':
      return `Turn ended (${item.reason})`;
    case 'note':
      return item.text.slice(0, 200);
    case 'mention':
      return `@${item.name}: ${item.text}`.slice(0, 200);
    case 'teammate':
      return `${item.name}: ${item.text ?? item.status}`.slice(0, 200);
  }
}

const TEAMMATE_STATUS: Record<Extract<ChatItem, { kind: 'teammate' }>['status'], string> = {
  working: 'looking into it…',
  answered: 'answered',
  changed: 'answered · its change joined the session',
  failed: "couldn't finish",
  stopped: 'stopped',
};

/** A teammate called in with @: at work, then its answer, in the conversation it was called to. */
function TeammateReply({ item }: { item: Extract<ChatItem, { kind: 'teammate' }> }) {
  const bad = item.status === 'failed' || item.status === 'stopped';
  return (
    <div className={`teammate-reply ${item.status}`}>
      <div className="prompt-head">
        <span className="ai-avatar sm" title="AI teammate">
          <Bot size={12} />
        </span>
        <span className="prompt-author teammate-name">
          {item.name}
          <span className="ai-badge">AI</span>
        </span>
        <span className={`muted small ${item.status === 'working' ? 'teammate-working' : ''}`}>
          {TEAMMATE_STATUS[item.status]}
        </span>
        <span className="prompt-time mono">{time(item.at)}</span>
      </div>
      {item.text &&
        (bad ? (
          <div className="muted small">{item.text}</div>
        ) : (
          <div className="agent-text">
            <Markdown text={item.text} />
          </div>
        ))}
    </div>
  );
}

/**
 * An issue an agent drafted, before it goes to GitHub: the person picks the repository, edits
 * the text, or turns it into a comment on an issue that already says the same.
 */
function IssueCard({ request }: { request: ApprovalRequest }) {
  const draft = request.issue!;
  const [repo, setRepo] = useState(draft.repo);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [labels, setLabels] = useState(draft.labels.join(', '));
  const [commentOn, setCommentOn] = useState<number | null>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const conversationId = useStore((s) => s.conversation?.id);
  // Look-alikes were searched in the drafted repository only.
  const similar = repo === draft.repo ? draft.similar : [];
  const send = () => {
    if (!conversationId) return;
    void api
      .invoke('agent:approveIssue', conversationId, request.id, {
        repo,
        title: title.trim(),
        body: body.trim(),
        labels: labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 10),
        commentOn: repo === draft.repo ? commentOn : null,
        dontAsk,
      })
      .catch(reportError);
  };
  return (
    <div className="approval issue-card">
      <div className="approval-head">
        <CircleHelp size={15} />
        <span>{request.title}</span>
      </div>
      <label className="issue-field">
        <span>Repository</span>
        {draft.repos.length > 1 ? (
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {draft.repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span className="mono">{repo}</span>
        )}
      </label>
      <label className="issue-field">
        <span>Title</span>
        <input value={title} maxLength={240} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="issue-field">
        <span>Body</span>
        <textarea value={body} rows={8} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="issue-field">
        <span>Labels</span>
        <input
          value={labels}
          placeholder="bug, good first issue"
          onChange={(e) => setLabels(e.target.value)}
        />
      </label>
      {similar.length > 0 && (
        <div className="issue-similar">
          <div className="issue-similar-head">Open issues that look similar</div>
          {similar.map((i) => (
            <label key={i.number} className="issue-similar-row">
              <input
                type="checkbox"
                checked={commentOn === i.number}
                onChange={(e) => setCommentOn(e.target.checked ? i.number : null)}
              />
              <span>
                <span className="mono">#{i.number}</span> {i.title}
              </span>
            </label>
          ))}
          <div className="approval-note">
            Tick one to add this as a comment there instead of opening a new issue.
          </div>
        </div>
      )}
      <label className="issue-similar-row">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        <span>Don't ask again for {repo}</span>
      </label>
      <div className="approval-actions">
        <button
          className="btn btn-primary btn-sm"
          disabled={!title.trim() || !body.trim()}
          onClick={send}
        >
          <Check size={13} />{' '}
          {commentOn !== null && repo === draft.repo ? `Comment on #${commentOn}` : 'Create issue'}
        </button>
        <button className="btn btn-sm" onClick={() => answerApproval(request.id, false)}>
          <X size={13} /> Don't create
        </button>
        <span className="approval-note">Goes to GitHub as you, with git's credentials</span>
      </div>
    </div>
  );
}

/** How an approval card is answered: your own agent here, or a teammate's through the Brain. */
export interface ApprovalHandler {
  answer(approvalId: string, approved: boolean): void;
  note: string;
}

const ownApproval: ApprovalHandler = {
  answer: answerApproval,
  note: 'Approves this exact action, once',
};

function ToolRow({
  item,
  approvals = ownApproval,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
  approvals?: ApprovalHandler | undefined;
}) {
  const [open, setOpen] = useState(false);
  const openPath = useFileOpener();
  const [verb, ...rest] = item.summary.split(' ');
  const target = rest.join(' ');
  const path = item.meta?.path;
  return (
    <div className={`tool-row tool-${item.status}`}>
      <div className="tool-line" onClick={() => item.output && setOpen(!open)}>
        <span className="tool-bullet">
          {item.status === 'running' ? <span className="dot-pulse" /> : '•'}
        </span>
        <span className="tool-verb">{item.status === 'denied' ? 'Denied' : verb}</span>
        {path ? (
          <button
            className="tool-target md-file"
            onClick={(e) => {
              e.stopPropagation();
              openPath(path);
            }}
          >
            {target}
          </button>
        ) : (
          <span className="tool-target mono">{target}</span>
        )}
        {item.meta?.added !== undefined && (
          <span className="tool-stat mono">
            <span className="add">+{item.meta.added}</span>{' '}
            <span className="del">−{item.meta.removed}</span>
          </span>
        )}
        {item.status === 'failed' && <CircleAlert size={13} className="tool-fail" />}
      </div>
      {open && item.output && <pre className="tool-output">{item.output}</pre>}
      {item.status === 'waiting' && item.approval?.issue && approvals === ownApproval && (
        <IssueCard request={item.approval} />
      )}
      {item.status === 'waiting' &&
        item.approval &&
        !(item.approval.issue && approvals === ownApproval) && (
          <div className="approval">
            <div className="approval-head">
              <CircleHelp size={15} />
              <span>{item.approval.title}</span>
            </div>
            <pre className="approval-detail">{item.approval.detail}</pre>
            <div className="approval-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => approvals.answer(item.approval!.id, true)}
              >
                <Check size={13} /> {item.approval.trustKey ? 'Allow once' : 'Approve'}
              </button>
              {item.approval.trustKey && approvals === ownApproval && (
                <button
                  className="btn btn-sm"
                  title="Starts without asking from now on, until the file changes (Settings → Agents → MCP servers)"
                  onClick={() => {
                    const { id, trustKey } = item.approval!;
                    void api
                      .invoke('mcp:trust', trustKey!, 'always')
                      .then(() => approvals.answer(id, true), reportError);
                  }}
                >
                  Always allow
                </button>
              )}
              {item.approval.kind === 'external' &&
                !item.approval.trustKey &&
                approvals === ownApproval && (
                  <button
                    className="btn btn-sm"
                    title="This tool runs without asking from now on (Settings → Agents)"
                    onClick={() => {
                      const { id, tool } = item.approval!;
                      const allowed = getState().settings.mcpAlwaysAllow;
                      void updateSettings({
                        mcpAlwaysAllow: allowed.includes(tool) ? allowed : [...allowed, tool],
                      }).then(() => approvals.answer(id, true));
                    }}
                  >
                    Always allow
                  </button>
                )}
              <button
                className="btn btn-sm"
                onClick={() => {
                  const { id, trustKey } = item.approval!;
                  // "Don't allow" is remembered until the file changes; a plain no from
                  // someone else's device only skips it this turn.
                  if (trustKey && approvals === ownApproval)
                    void api
                      .invoke('mcp:trust', trustKey, 'deny')
                      .then(() => approvals.answer(id, false), reportError);
                  else approvals.answer(id, false);
                }}
              >
                <X size={13} /> {item.approval.trustKey ? "Don't allow" : 'Deny'}
              </button>
              {!item.approval.trustKey && <span className="approval-note">{approvals.note}</span>}
            </div>
          </div>
        )}
      {item.steps?.length ? <ToolSteps steps={item.steps} approvals={approvals} /> : null}
    </div>
  );
}

/** What a helper agent is doing: its last few steps, and any step waiting for an answer. */
function ToolSteps({
  steps,
  approvals,
}: {
  steps: Extract<ChatItem, { kind: 'tool' }>[];
  approvals?: ApprovalHandler | undefined;
}) {
  const [all, setAll] = useState(false);
  const shown = all
    ? steps
    : steps.filter((s, i) => i >= steps.length - 3 || s.status === 'waiting');
  const hidden = steps.length - shown.length;
  return (
    <div className="tool-steps">
      {hidden > 0 && (
        <button className="tool-steps-more" onClick={() => setAll(true)}>
          {hidden} earlier step{hidden === 1 ? '' : 's'}
        </button>
      )}
      {shown.map((s) => (
        <ToolRow key={s.id} item={s} approvals={approvals} />
      ))}
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280;
  return (
    <div
      className={`reasoning ${open || !long ? 'open' : ''}`}
      onClick={() => long && setOpen(!open)}
    >
      ✻ {open || !long ? text : `${text.slice(0, 280)}…`}
    </div>
  );
}

export function Chat({
  items,
  userName,
  avatarUrl,
  approvals,
  annotate,
}: {
  items: ChatItem[];
  userName: string;
  avatarUrl: string | null;
  /** Leave out for your own conversation; a lane in a session passes how to answer there. */
  approvals?: ApprovalHandler;
  /** In a session: comment on a row, and what to show under it (its thread). */
  annotate?: {
    comment: (index: number) => void;
    after: (index: number, excerpt: string) => React.ReactNode;
  };
}) {
  // A reply worth tracking becomes an issue in this checkout's repository.
  const repoOpen = useStore((s) => Boolean(s.workspace?.isRepo));
  const sessionTitle = useStore((s) => {
    const id = s.room?.sessionId;
    return id
      ? (Object.values(s.sessions)
          .flat()
          .find((x) => x.id === id)?.title ?? null)
      : null;
  });
  const issueFrom = repoOpen ? (text: string) => issueFromReply(text, sessionTitle) : null;
  return (
    <>
      {items.map((item, i) => {
        const node = (() => {
          switch (item.kind) {
            case 'prompt':
              return (
                <div
                  key={i}
                  className="prompt-card"
                  style={{ borderLeftColor: personColor(userName) }}
                >
                  <div className="prompt-head">
                    <Avatar name={userName} src={avatarUrl} size={18} />
                    <span className="prompt-author" style={{ color: personColor(userName) }}>
                      {userName}
                    </span>
                    <span className="muted small">prompt</span>
                    <span className="prompt-time mono">{time(item.at)}</span>
                  </div>
                  <div className="prompt-text">{item.text}</div>
                  {item.attachments.length > 0 && (
                    <div className="prompt-attachments">
                      {item.attachments.map((a) => (
                        <span key={a} className="chip mono">
                          <Paperclip size={11} /> {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            case 'mention':
              return (
                <div
                  key={i}
                  className="prompt-card"
                  style={{ borderLeftColor: personColor(userName) }}
                >
                  <div className="prompt-head">
                    <Avatar name={userName} src={avatarUrl} size={18} />
                    <span className="prompt-author" style={{ color: personColor(userName) }}>
                      {userName}
                    </span>
                    <span className="muted small">
                      to <span className="mention-chip">@{item.name}</span>
                    </span>
                    <span className="prompt-time mono">{time(item.at)}</span>
                  </div>
                  <div className="prompt-text">{item.text}</div>
                </div>
              );
            case 'reasoning':
              return <Reasoning key={i} text={item.text} />;
            case 'tool':
              return <ToolRow key={item.id} item={item} approvals={approvals} />;
            case 'text':
              return (
                <div key={i} className="agent-text">
                  <Markdown text={item.text} />
                  {issueFrom && (
                    <button
                      className="agent-text-issue"
                      title="Create a GitHub issue from this reply"
                      onClick={() => issueFrom(item.text)}
                    >
                      <CircleDot size={12} /> Create issue…
                    </button>
                  )}
                </div>
              );
            case 'teammate':
              return <TeammateReply key={item.requestId} item={item} />;
            case 'route':
              return (
                <div key={i} className="route-row mono" title={item.reason}>
                  <Zap size={11} /> JevRouter → {item.model} · {item.tier} · {item.reason}
                </div>
              );
            case 'end':
              return <TurnEnd key={i} item={item} />;
            case 'note':
              return (
                <div key={i} className={`chat-note ${item.tone}`}>
                  {item.text}
                </div>
              );
          }
        })();
        if (!annotate) return node;
        return (
          <div key={`row-${i}`} className="chat-row">
            <button
              className="row-comment"
              title="Comment on this moment"
              onClick={() => annotate.comment(i)}
            >
              <MessageSquarePlus size={12} />
            </button>
            {node}
            {annotate.after(i, excerptOf(item))}
          </div>
        );
      })}
    </>
  );
}

function TurnEnd({ item }: { item: Extract<ChatItem, { kind: 'end' }> }) {
  const [open, setOpen] = useState(false);
  const estimated = item.receipt.some((r) => r.estimated);
  const unpriced = item.receipt.length > 0 && item.receipt.every((r) => r.unpriced);
  const price = (cost: number, isUnpriced?: boolean) =>
    isUnpriced ? 'on your own account' : formatCost(cost);
  const tokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}K` : n.toLocaleString());
  return (
    <div className={`turn-end ${item.reason === 'error' ? 'turn-error' : ''}`}>
      {item.reason === 'error' && <div className="turn-error-text">{item.error}</div>}
      <button
        className="receipt-toggle mono"
        onClick={() => setOpen(!open)}
        title="Show the receipt"
      >
        {item.model ?? ''} · {estimated ? '≈ ' : ''}
        {price(item.cost, unpriced)}
        {item.reason === 'stopped'
          ? ' · stopped'
          : item.reason === 'step_limit'
            ? ' · step limit reached'
            : ''}
        {item.payer ? ` · paid by ${item.payer}` : ''}
      </button>
      {open && (
        <table className="receipt mono">
          <tbody>
            {item.receipt.map((r) => (
              <tr key={`${r.kind}:${r.model}`}>
                <td>{r.kind === 'routing' ? `routing · ${r.model}` : r.model}</td>
                <td>
                  {tokens(r.promptTokens)} in
                  {r.cachedTokens ? ` (${tokens(r.cachedTokens)} cached)` : ''} ·{' '}
                  {tokens(r.completionTokens)} out
                </td>
                <td>
                  {r.estimated ? '≈ ' : ''}
                  {price(r.cost, r.unpriced)}
                </td>
              </tr>
            ))}
            <tr className="receipt-total">
              <td>
                Total
                {unpriced
                  ? ' (the CLI reports tokens, not cost)'
                  : estimated
                    ? ' (≈ estimated from the rate card)'
                    : ' (settled by the provider)'}
              </td>
              <td />
              <td>{price(item.cost, unpriced)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function readAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isImage = file.type.startsWith('image/');
    reader.onload = () =>
      resolve({
        kind: isImage ? 'image' : 'markdown',
        name: file.name,
        content: String(reader.result),
      });
    reader.onerror = () => reject(reader.error);
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

/** "2.1.296 (Claude Code)" or "codex-cli 0.162.1" → the version number. */
function versionNumber(version: string): string {
  return /\d+\.\d+(?:\.\d+)?/.exec(version)?.[0] ?? version;
}

/** A composer menu that stays on screen however narrow its lane is. */
function FloatingMenu({ onLeave, children }: { onLeave: () => void; children: ReactNode }) {
  const ref = useFloating<HTMLDivElement>();
  return (
    <div className="menu" ref={ref} onMouseLeave={onLeave}>
      {children}
    </div>
  );
}

/** Typing "/" at the start of a prompt: the skills that match, to call one directly. */
function useSkillMenu(text: string, enabled: boolean) {
  const typed = enabled ? /^\/([a-z0-9:-]*)$/.exec(text)?.[1] : undefined;
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const open = typed !== undefined && closedFor !== text;
  useEffect(() => {
    // Read when the menu opens: skills are files that may have changed.
    if (!open) return;
    let live = true;
    void api
      .invoke('skills:list')
      .then((l) => live && setSkills(l.skills.filter((sk) => sk.enabled)))
      .catch(() => live && setSkills([]));
    return () => {
      live = false;
    };
  }, [open]);
  const matches = open
    ? (skills ?? []).filter(
        // A plugin's skill is found by its own name too: "/chan" → release-tools:changelog.
        (sk) => sk.name.startsWith(typed ?? '') || sk.name.split(':')[1]?.startsWith(typed ?? ''),
      )
    : [];
  useEffect(() => setActive(0), [typed]);
  return {
    matches,
    active: Math.min(active, Math.max(0, matches.length - 1)),
    move: (by: number) =>
      setActive((a) => (matches.length ? (a + by + matches.length) % matches.length : 0)),
    close: () => setClosedFor(text),
  };
}

/** Who pays for a prompt sent from this composer. */
/** Stands in for an agent nothing is known about yet. */
const NO_LIMIT: AgentLimit = {
  account: 'kovan',
  status: 'ok',
  windows: [],
  resetsAt: null,
  reason: null,
  updatedAt: 0,
};

function payer(harness: Harness, modelId: string, managed: boolean): string {
  if (harness === 'claude-code') return 'your Claude account';
  if (harness === 'codex') return 'your OpenAI account';
  const custom = parseCustomModelId(modelId);
  if (custom) return `your @${custom.provider} provider`;
  return managed ? 'you · Kovan managed (cost + 5%)' : 'your OpenRouter key';
}

/** A teammate is already on this: join them, split the work, talk to them, or go ahead. */
function OverlapCard({
  warnings,
  task,
  onSend,
  onDismiss,
}: {
  warnings: OverlapWarning[];
  task: string;
  onSend: () => void;
  onDismiss: () => void;
}) {
  const me = useStore((s) => s.user?.id ?? null);
  return (
    <div className="overlap-card">
      {warnings.map((w) => (
        <div key={w.sessionId} className="overlap-row">
          <CircleAlert size={14} className={w.kind === 'overlapping' ? 'warn' : 'muted'} />
          <div className="overlap-text">
            <b>{w.kind === 'overlapping' ? 'Overlapping' : 'Related'}:</b>{' '}
            {w.people.join(', ') || 'A teammate'} in “{w.title}”: {w.reason}.
            <div className="overlap-actions">
              <button className="link-btn" onClick={() => void openSession(w.sessionId)}>
                Join
              </button>
              <button
                className="link-btn"
                title="Add your task to their plan, owned by you"
                onClick={() =>
                  void addSteps(w.sessionId, [
                    { title: task.split('\n')[0]!.slice(0, 200), ownerId: me },
                  ]).then((ok) => ok && onDismiss())
                }
              >
                Split
              </button>
              <button className="link-btn" onClick={() => void openSession(w.sessionId)}>
                Coordinate
              </button>
            </div>
          </div>
        </div>
      ))}
      <div className="overlap-foot">
        <button className="btn btn-sm" onClick={onDismiss}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" onClick={onSend}>
          Send anyway
        </button>
      </div>
    </div>
  );
}

export function Composer() {
  const conversation = useStore((s) => s.conversation);
  const settings = useStore((s) => s.settings);
  const userName = useStore((s) => s.user?.name ?? s.appInfo?.userName ?? 'you');
  const models = useStore((s) => s.models);
  // Drafts are kept per conversation (lane), so switching away loses nothing.
  const draftKey = conversation?.id ?? 'new';
  const text = useStore((s) => s.drafts[draftKey] ?? '');
  const setText = (value: string) => setDraft(draftKey, value);
  const queued = useStore((s) => (conversation ? s.queues[conversation.id] : undefined));
  const [intent, setIntent] = useState<'prompt' | 'queue' | 'steer' | 'subagent'>('prompt');
  // Overlap warnings for the prompt about to be sent, and the text they were checked for.
  const [overlap, setOverlap] = useState<{ text: string; warnings: OverlapWarning[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [intentMenu, setIntentMenu] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [picker, setPicker] = useState(false);
  const [modeMenu, setModeMenu] = useState(false);
  const [harnessMenu, setHarnessMenu] = useState(false);
  const externalAgents = useStore((s) => s.externalAgents);
  const accounts = useStore((s) => s.agentAccounts);
  const account = conversation?.account;
  const agentLimits = useStore((s) => s.agentLimits);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // In a session, "@Name" calls an AI teammate in instead of prompting your agent.
  const teammates = useTeammates(conversation?.session?.workspaceId);
  const mentionMenu = useMentionMenu(text, setText, teammates, input);

  const modelId = conversation?.model ?? settings.agentModel;
  const mode = conversation?.mode ?? settings.agentMode;
  const effort = conversation?.effort ?? (conversation ? null : settings.agentEffort);
  const info = useMemo(() => models.find((m) => m.id === modelId), [models, modelId]);
  const running = conversation?.running ?? false;
  const harness = conversation?.harness ?? (conversation ? 'kovan' : settings.agentHarness);
  // No account named runs as the first one added for that agent, the same rule the app runs it by.
  const accountName =
    harness === 'kovan'
      ? undefined
      : (account
          ? accounts.find((a) => a.id === account)
          : accounts.find((a) => a.harness === harness)
        )?.name;
  const isExternal = harness !== 'kovan';
  // Auto: JevRouter picks the agent from the first prompt, then the conversation keeps it.
  const autoOn = conversation ? conversation.auto === true : settings.agentAuto;
  const autoPending = autoOn && !conversation?.events.some((e) => e.type === 'auto');
  // Kovan's agent bills managed usage when that's the choice (or there's no own key).
  const managedNow = useStore(
    (st) =>
      st.settings.modelBilling === 'managed' ||
      (st.settings.modelBilling === 'auto' &&
        !(st.providers?.openrouter.configured ?? false) &&
        (st.providers?.managed ?? false)),
  );
  const isAuto = !isExternal && modelId === JEV_MODEL_ID;
  // With JevRouter, show the model it last picked.
  const routed = useMemo(() => {
    if (!isAuto) return null;
    const last = [...(conversation?.events ?? [])].reverse().find((e) => e.type === 'route');
    const id = last?.type === 'route' ? last.decision.model : null;
    return id ? (models.find((m) => m.id === id)?.name ?? id) : null;
  }, [isAuto, conversation?.events, models]);

  // How full the model's context window was on the last call (Kovan's agent only: the CLIs
  // report totals per turn, not the size of one call).
  const context = useMemo(() => {
    if (isExternal) return null;
    const last = [...(conversation?.events ?? [])]
      .reverse()
      .find((e) => e.type === 'usage' && e.kind === 'model');
    if (last?.type !== 'usage') return null;
    const window = (models.find((m) => m.id === last.model) ?? info)?.contextLength ?? 0;
    if (!window) return null;
    return { used: last.usage.promptTokens + last.usage.completionTokens, window };
  }, [isExternal, conversation?.events, models, info]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);

  const submit = async (force = false) => {
    if (!text.trim() && attachments.length === 0) return;
    const called = conversation?.session ? mentionedTeammate(text, teammates) : null;
    if (conversation && called) {
      try {
        await api.invoke('agent:mention', conversation.id, called.id, called.name, text.trim());
        setText('');
      } catch (error) {
        reportError(error);
      }
      return;
    }
    if (intent === 'subagent') {
      if (!conversation?.session) {
        notify({
          kind: 'info',
          message: 'Subagents run beside a session lane: open a session and take a lane first.',
        });
        return;
      }
      if (await startSubagent(conversation.id, text)) setText('');
      return;
    }
    if (intent === 'steer') {
      if (!running || !conversation) {
        notify({
          kind: 'info',
          message: 'Steer guides a running turn. Your agent is idle: send it as a prompt.',
        });
        return;
      }
      const me = useStore.getState().user?.id;
      const sent =
        conversation.session && me
          ? await steer(conversation.session.id, me, text)
          : await api.invoke('agent:steer', conversation.id, text);
      if (sent) setText('');
      else if (isExternal)
        notify({
          kind: 'info',
          message: `${HARNESS_NAMES[harness]} can't take guidance mid-turn. Queue it instead, or stop it (Esc).`,
        });
      return;
    }
    // Before a new task runs: does it collide with a teammate's live session? Fails open.
    if (!running && intent === 'prompt' && !force && overlap?.text !== text) {
      setChecking(true);
      const warnings = await overlapFor(text).finally(() => setChecking(false));
      if (warnings.length) {
        setOverlap({ text, warnings });
        return;
      }
    }
    setOverlap(null);
    if (running && intent === 'prompt') {
      notify({
        kind: 'info',
        message:
          'Your agent is still working. Pick "Queue next" to run this after it, or stop it (Esc).',
      });
      return;
    }
    if (
      !autoPending &&
      attachments.some((a) => a.kind === 'image') &&
      (isExternal || (info && !info.vision))
    ) {
      notify({
        kind: 'error',
        message: isExternal
          ? `${HARNESS_NAMES[harness]} in Kovan takes text and Markdown files for now. Remove the image or switch to Kovan.`
          : `${info?.name ?? modelId} can't read images. Pick a vision model or remove the image.`,
      });
      return;
    }
    if (running && conversation) {
      queuePrompt(conversation.id, text, attachments);
      setText('');
      setAttachments([]);
      return;
    }
    const ok = await sendPrompt(text, attachments);
    if (ok) {
      setText('');
      setAttachments([]);
    }
  };
  const modelName = isAuto ? 'JevRouter' : (info?.name ?? modelId);
  // Skills are Kovan's agent's; Auto may still pick it.
  const skillMenu = useSkillMenu(text, !isExternal);
  const pickSkill = (name: string) => {
    setText(`/${name} `);
    input.current?.focus();
  };

  return (
    <div className="composer" style={{ ['--owner' as string]: personColor(userName) }}>
      <span className="composer-owner">{userName}</span>
      {overlap && overlap.text === text && (
        <OverlapCard
          warnings={overlap.warnings}
          task={text}
          onSend={() => void submit(true)}
          onDismiss={() => setOverlap(null)}
        />
      )}
      {conversation && queued && queued.length > 0 && (
        <div className="composer-queue">
          {queued.map((q, i) => (
            <span key={i} className="queue-item" title={q.text}>
              <span className="mono muted">{i + 1}</span>
              <span className="queue-text">{q.text}</span>
              <button
                className="icon-btn"
                title="Remove from queue"
                onClick={() => unqueuePrompt(conversation.id, i)}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a, i) => (
            <span key={i} className="chip mono">
              <Paperclip size={11} /> {a.name}
              <button
                className="icon-btn"
                onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {skillMenu.matches.length > 0 && (
        <div className="menu menu-wide skill-menu" role="listbox" aria-label="Skills">
          {skillMenu.matches.map((sk, i) => (
            <button
              key={sk.name}
              role="option"
              aria-selected={i === skillMenu.active}
              className={`menu-item ${i === skillMenu.active ? 'on' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the prompt
                pickSkill(sk.name);
              }}
            >
              <span>
                <span className="menu-title mono">/{sk.name}</span>
                <span className="menu-hint">{sk.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <MentionMenu menu={mentionMenu} />
      <textarea
        ref={input}
        className="composer-input"
        rows={2}
        placeholder={
          running
            ? 'Add guidance, or queue the next task…'
            : isExternal
              ? `What should ${HARNESS_NAMES[harness]} do?`
              : teammates.length
                ? 'Describe a task, or @ a teammate to ask them…'
                : 'Describe a task or ask a question…'
        }
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          mentionMenu.track(e.target);
        }}
        onSelect={(e) => mentionMenu.track(e.currentTarget)}
        aria-label="Prompt"
        onKeyDown={(e) => {
          if (mentionMenu.keyDown(e)) return;
          if (skillMenu.matches.length > 0 && !e.nativeEvent.isComposing) {
            const pick = skillMenu.matches[skillMenu.active]!;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              skillMenu.move(e.key === 'ArrowDown' ? 1 : -1);
              return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              e.preventDefault();
              pickSkill(pick.name);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              skillMenu.close();
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div
        className="composer-sponsor"
        title={`Where it goes and who pays${autoPending ? ': JevRouter picks the agent for each prompt, from your order in Settings → Agents' : ''}`}
      >
        {checking
          ? 'Checking for overlapping work… · '
          : intent === 'subagent'
            ? 'As a subagent, in its own copy · '
            : running && intent === 'queue'
              ? 'After this turn · '
              : running && intent === 'steer'
                ? 'Into this turn · '
                : ''}
        {autoPending
          ? 'Auto picks Claude Code, Codex or Kovan'
          : `${HARNESS_NAMES[harness]} · ${modelName} · ${payer(harness, modelId, managedNow)}`}
      </div>
      <div className="composer-bar">
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".md,.markdown,.txt,image/*"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            void Promise.all(files.map(readAttachment)).then((read) =>
              setAttachments((a) => [...a, ...read]),
            );
          }}
        />
        <button
          className="icon-btn"
          title="Attach Markdown or images"
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={14} />
        </button>
        <div className="popover-anchor">
          <button
            className="pill"
            onClick={() => setHarnessMenu(!harnessMenu)}
            title={
              autoOn && !autoPending
                ? `Who runs the agent (Auto picked ${HARNESS_NAMES[harness]})`
                : 'Who runs the agent'
            }
          >
            <Bot size={12} />{' '}
            {autoPending
              ? 'Auto'
              : `${HARNESS_NAMES[harness]}${accountName && harness !== 'kovan' ? ` (${accountName})` : ''}`}{' '}
            <ChevronDown size={12} />
          </button>
          {harnessMenu && (
            <FloatingMenu onLeave={() => setHarnessMenu(false)}>
              <button
                className={`menu-item ${autoOn ? 'on' : ''}`}
                onClick={() => {
                  setAutoAgent();
                  setHarnessMenu(false);
                }}
              >
                <span>
                  <span className="menu-title">Auto</span>
                  <span className="menu-hint">
                    JevRouter reads the prompt and picks the agent · [jev: codex] names one
                  </span>
                </span>
                {autoOn && <Check size={13} />}
              </button>
              {(['kovan', 'claude-code', 'codex'] as Harness[]).map((h) => {
                const cli = h === 'kovan' ? null : externalAgents.find((x) => x.id === h);
                const usageOf = (key: string) => {
                  const l = limitNow(
                    agentLimits.find((x) => x.account === key) ?? NO_LIMIT,
                    Date.now(),
                  );
                  return l.status === 'ok' ? null : limitLabel(l, Date.now());
                };
                if (h === 'kovan') {
                  const limit = limitNow(
                    agentLimits.find((l) => l.account === 'kovan') ?? NO_LIMIT,
                    Date.now(),
                  );
                  const usage = limit.status === 'ok' ? null : limitLabel(limit, Date.now());
                  return (
                    <button
                      key={h}
                      className={`menu-item ${h === harness && !autoOn ? 'on' : ''}`}
                      onClick={() => {
                        setHarness(h);
                        setHarnessMenu(false);
                      }}
                    >
                      <span>
                        <span className="menu-title">{HARNESS_NAMES[h]}</span>
                        <span className={`menu-hint ${usage ? `limit-${limit.status}` : ''}`}>
                          {usage ?? "Kovan's agent · any model via OpenRouter"}
                        </span>
                      </span>
                      {h === harness && !autoOn && <Check size={13} />}
                    </button>
                  );
                }
                const mine = accounts.filter((a) => a.harness === h);
                // Claude Code and Codex run only as an account added in Settings, never as the
                // sign-in the CLI already has on this computer.
                if (mine.length === 0)
                  return (
                    <button
                      key={h}
                      className="menu-item"
                      title={cli?.reason ?? ''}
                      onClick={() => {
                        setHarnessMenu(false);
                        setState({ settingsSection: 'agents' });
                        showView('settings');
                      }}
                    >
                      <span>
                        <span className="menu-title">
                          {HARNESS_NAMES[h]}
                          {cli?.version ? ` · ${versionNumber(cli.version)}` : ''}
                        </span>
                        <span className="menu-hint">
                          {cli?.supported
                            ? 'Add an account in Settings → Agents → Accounts'
                            : (cli?.reason ?? 'Checking…')}
                        </span>
                      </span>
                    </button>
                  );
                return mine.map((a) => {
                  const on =
                    h === harness && !autoOn && (account === a.id || (!account && a === mine[0]));
                  return (
                    <button
                      key={`${h}:${a.id}`}
                      className={`menu-item ${on ? 'on' : ''}`}
                      disabled={!cli?.supported}
                      title={cli?.reason ?? ''}
                      onClick={() => {
                        setHarness(h, a.id);
                        setHarnessMenu(false);
                      }}
                    >
                      <span>
                        <span className="menu-title">
                          {HARNESS_NAMES[h]} ({a.name})
                          {cli?.version ? ` · ${versionNumber(cli.version)}` : ''}
                        </span>
                        <span className="menu-hint">
                          {usageOf(`${h}#${a.id}`) ??
                            (cli?.supported
                              ? `Your ${h === 'codex' ? 'OpenAI' : 'Claude'} account · coordinated over MCP`
                              : (cli?.reason ?? 'Checking…'))}
                        </span>
                      </span>
                      {on && <Check size={13} />}
                    </button>
                  );
                });
              })}
            </FloatingMenu>
          )}
        </div>
        <div className="popover-anchor">
          <button
            className="pill"
            onClick={() => setIntentMenu(!intentMenu)}
            title="What Enter does: send now, queue next, steer the running turn, or start a subagent"
          >
            <CornerDownLeft size={12} />
            {intent === 'prompt'
              ? ' Send'
              : intent === 'queue'
                ? ' Queue'
                : intent === 'steer'
                  ? ' Steer'
                  : ' Subagent'}{' '}
            <ChevronDown size={12} />
          </button>
          {intentMenu && (
            <FloatingMenu onLeave={() => setIntentMenu(false)}>
              {(
                [
                  ['prompt', 'Prompt now', 'Runs right away (when your agent is idle)'],
                  ['queue', 'Queue next', 'Runs after the current turn finishes'],
                  ['steer', 'Steer', 'Guides the running turn before its next step'],
                  [
                    'subagent',
                    'Subagent',
                    'A child task in its own worktree; joins your lane once its checks pass',
                  ],
                ] as const
              ).map(([id, title, hint]) => (
                <button
                  key={id}
                  className={`menu-item ${intent === id ? 'on' : ''}`}
                  onClick={() => {
                    setIntent(id);
                    setIntentMenu(false);
                  }}
                >
                  <span>
                    <span className="menu-title">{title}</span>
                    <span className="menu-hint">{hint}</span>
                  </span>
                  {intent === id && <Check size={13} />}
                </button>
              ))}
            </FloatingMenu>
          )}
        </div>
        <div className="popover-anchor">
          <button
            className="pill"
            onClick={() => setModeMenu(!modeMenu)}
            title={`What it may do without asking: ${MODES.find((m) => m.id === mode)?.hint ?? ''}`}
          >
            <ShieldCheck size={12} /> {MODES.find((m) => m.id === mode)?.label}{' '}
            <ChevronDown size={12} />
          </button>
          {modeMenu && (
            <FloatingMenu onLeave={() => setModeMenu(false)}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`menu-item ${m.id === mode ? 'on' : ''}`}
                  title={
                    harness === 'codex' && m.id === 'request'
                      ? "Codex can't pause for approval in chat, so Request runs read-only here. Open Codex in the terminal to approve step by step."
                      : ''
                  }
                  onClick={() => {
                    void setMode(m.id);
                    setModeMenu(false);
                  }}
                >
                  <span>
                    <span className="menu-title">{m.label}</span>
                    <span className="menu-hint">
                      {harness === 'codex' && m.id === 'request'
                        ? 'Read-only in chat; approve step by step in the terminal'
                        : m.hint}
                    </span>
                  </span>
                  {m.id === mode && <Check size={13} />}
                </button>
              ))}
            </FloatingMenu>
          )}
        </div>
        <span className="composer-spacer" />
        {context && (
          <span
            className="context-meter mono"
            title={`Context: ${context.used.toLocaleString()} of ${context.window.toLocaleString()} tokens on the last call`}
          >
            <ProgressRing value={Math.min(context.used, context.window)} total={context.window} />
            {Math.max(1, Math.round((context.used / context.window) * 100))}%
          </span>
        )}
        {autoPending ? null : isExternal ? (
          <select
            className="effort-select mono"
            value={modelId}
            title={`${HARNESS_NAMES[harness]} model`}
            onChange={(e) => void configureConversation({ model: e.target.value })}
          >
            {(harness === 'codex' ? CODEX_MODELS : CLAUDE_MODELS).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="popover-anchor model-anchor">
            <button className="pill" onClick={() => setPicker(!picker)} title="Model">
              <Zap size={12} />
              <span className="pill-label">
                {isAuto ? `JevRouter${routed ? ` → ${routed}` : ''}` : (info?.name ?? modelId)}
              </span>
              {effort && !isAuto && <span className="pill-effort">{effort}</span>}
              <ChevronDown size={12} />
            </button>
            {picker && <ModelPicker current={modelId} onClose={() => setPicker(false)} />}
          </div>
        )}
        {!isExternal && !isAuto && info?.reasoning && info.reasoning.efforts.length > 0 && (
          <select
            className="effort-select mono"
            value={effort ?? ''}
            title="Reasoning effort"
            onChange={(e) => void setEffort((e.target.value || null) as Effort | null)}
          >
            <option value="">
              default{info.reasoning.defaultEffort ? ` (${info.reasoning.defaultEffort})` : ''}
            </option>
            {info.reasoning.efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
        {running && (intent === 'queue' || intent === 'steer') && (
          <button
            className="send-btn"
            title="Queue next (Enter)"
            disabled={!text.trim() && attachments.length === 0}
            onClick={() => void submit()}
          >
            <ListPlus size={14} />
          </button>
        )}
        {running ? (
          <button className="send-btn stop" title="Stop (Esc)" onClick={stopAgent}>
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button
            className="send-btn"
            title="Send (Enter)"
            disabled={!text.trim() && attachments.length === 0}
            onClick={() => void submit()}
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentPanel() {
  const providers = useStore((s) => s.providers);
  const conversation = useStore((s) => s.conversation);
  const conversations = useStore((s) => s.conversations);
  const userName = useStore((s) => s.user?.name ?? s.appInfo?.userName ?? 'you');
  const avatarUrl = useStore((s) => s.user?.avatarUrl ?? null);
  const [history, setHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const items = useMemo(() => foldEvents(conversation?.events ?? []), [conversation?.events]);

  useEffect(() => {
    void loadConversations(false);
  }, []);

  // Follow new output unless the person scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const settings = useStore((s) => s.settings);
  // Claude Code, Codex and custom providers run on the person's own account; no OpenRouter key needed.
  const harness = conversation?.harness ?? (conversation ? 'kovan' : settings.agentHarness);
  const configured =
    (providers?.openrouter.configured ?? false) ||
    (providers?.customModels ?? 0) > 0 ||
    (providers?.managed ?? false) ||
    harness !== 'kovan';

  return (
    <aside className="agent-panel">
      <div className="agent-head">
        <div className="popover-anchor agent-title-wrap">
          <button className="agent-title" onClick={() => setHistory(!history)}>
            <span>{conversation?.title ?? 'New chat'}</span>
            <ChevronDown size={12} />
          </button>
          {history && (
            <div className="menu menu-wide" onMouseLeave={() => setHistory(false)}>
              {conversations.length === 0 && <div className="menu-empty">No conversations yet</div>}
              {conversations.map((c) => (
                <div key={c.id} className={`menu-item ${c.id === conversation?.id ? 'on' : ''}`}>
                  <button
                    className="menu-main"
                    onClick={() => {
                      void openConversation(c.id);
                      setHistory(false);
                    }}
                  >
                    <span className="menu-title">{c.title}</span>
                    <span className="menu-hint mono">
                      {new Date(c.updatedAt).toLocaleString([], {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}{' '}
                      · {formatCost(c.cost)}
                    </span>
                  </button>
                  <button
                    className="icon-btn"
                    title="Delete"
                    onClick={() => void deleteConversation(c.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {conversation && conversation.cost > 0 && (
          <span className="agent-cost mono">{formatCost(conversation.cost)}</span>
        )}
        {harness !== 'kovan' && (
          <button
            className="icon-btn"
            title={`Open ${HARNESS_NAMES[harness]} in the terminal`}
            onClick={() => void newTerminal(harness)}
          >
            <SquareTerminal size={15} />
          </button>
        )}
        <button className="icon-btn" title="New chat" onClick={() => void newConversation()}>
          <Plus size={15} />
        </button>
        <button className="icon-btn" title="Hide agent" onClick={toggleAgentPanel}>
          <X size={15} />
        </button>
      </div>
      {!configured ? (
        <ProviderSetup />
      ) : (
        <>
          <div
            className="agent-scroll"
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {items.length === 0 ? (
              <div className="agent-empty">
                <div className="empty-title">What should we work on?</div>
                <p className="empty-text">
                  Your agent reads this repository, edits files and runs commands. It asks first
                  whenever the shield below says so.
                </p>
                <div className="agent-starters">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      className="agent-starter"
                      onClick={() => {
                        setDraft(conversation?.id ?? 'new', s);
                        document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <p className="empty-keys">Enter sends · Shift+Enter adds a line · Esc stops</p>
              </div>
            ) : (
              <Chat items={items} userName={userName} avatarUrl={avatarUrl} />
            )}
            {conversation?.running && items.at(-1)?.kind !== 'tool' && (
              <div className="thinking">
                <span className="dot-pulse" /> Working…
              </div>
            )}
          </div>
          <Composer />
        </>
      )}
    </aside>
  );
}
