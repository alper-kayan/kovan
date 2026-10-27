import { can, type Comment, type Session } from '@kovan/shared';
import { Bot, Check, CircleDot, ListPlus, MessageSquare, RotateCcw, Wand2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  addComment,
  applySuggestion,
  commentToStep,
  promptFromComment,
  setCommentStatus,
} from '../services/collab';
import { openFile } from '../services/editor';
import { issueFromComment } from '../services/issues';
import { activeTeamWorkspace, getState, setState, useStore } from '../store';
import { Avatar } from './ui';
import { MentionMenu, useMentionMenu, useTeammates } from './MentionMenu';

// Stable empty values: a selector returning a fresh [] or {} re-renders forever.
const NONE_LIST: never[] = [];

const EMPTY: Comment[] = [];

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function CommentComposer({
  placeholder,
  onSubmit,
  autoFocus,
  onCancel,
  workspaceId,
}: {
  placeholder: string;
  onSubmit: (body: string) => Promise<unknown>;
  autoFocus?: boolean;
  onCancel?: () => void;
  /** In a session's workspace, "@" lists its AI teammates to call in. */
  workspaceId?: string | undefined;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const teammates = useTeammates(workspaceId);
  const mentions = useMentionMenu(body, setBody, teammates, input);
  const send = () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    void onSubmit(body.trim()).then((ok) => {
      setBusy(false);
      if (ok !== null && ok !== false) setBody('');
    });
  };
  return (
    <div className="comment-composer mention-anchor">
      <MentionMenu menu={mentions} />
      <textarea
        ref={input}
        className="input"
        rows={2}
        autoFocus={autoFocus}
        placeholder={teammates.length ? `${placeholder} · @ calls a teammate in` : placeholder}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          mentions.track(e.target);
        }}
        onSelect={(e) => mentions.track(e.currentTarget)}
        onKeyDown={(e) => {
          if (mentions.keyDown(e)) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      <div className="comment-composer-actions">
        <span className="muted small">⌘↵ to post · comments don't use any model</span>
        {onCancel && (
          <button className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary btn-sm" disabled={!body.trim() || busy} onClick={send}>
          Comment
        </button>
      </div>
    </div>
  );
}

/** Who wrote a comment: a person, or an AI teammate in its own colours. */
function Author({ comment, size }: { comment: Comment; size: number }) {
  if (comment.authorKind === 'agent')
    return (
      <>
        <span className="ai-avatar sm" title="AI teammate" style={{ width: size, height: size }}>
          <Bot size={size - 6} />
        </span>
        <b className="teammate-name">
          {comment.authorName}
          <span className="ai-badge">AI</span>
        </b>
      </>
    );
  return (
    <>
      <Avatar name={comment.authorName} src={comment.authorAvatar} size={size} />
      <b>{comment.authorName}</b>
    </>
  );
}

/** The live session a comment can turn into a plan step in: its own, else one in the workspace. */
function sessionFor(comment: Comment, sessions: Session[]): Session | null {
  return (
    sessions.find((s) => s.id === comment.sessionId && s.status === 'active') ??
    sessions.find((s) => s.status === 'active') ??
    null
  );
}

export function CommentCard({ comment, replies }: { comment: Comment; replies: Comment[] }) {
  const [replying, setReplying] = useState(false);
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === comment.workspaceId)?.role);
  const sessions = useStore((s) => s.sessions[comment.workspaceId] ?? NONE_LIST);
  const open = useStore((s) => activeTeamWorkspace(s)?.id === comment.workspaceId);
  const plans = useStore((s) => s.plans);
  const a = comment.anchor;
  const onCode = a.kind === 'file' || a.kind === 'hunk';
  const target = sessionFor(comment, sessions);
  const canComment = Boolean(role && can(role, 'comment.create'));
  const canPlan = Boolean(role && can(role, 'plan.manage') && target);
  const canPrompt = Boolean(role && can(role, 'agent.prompt') && open);
  const step = comment.stepId
    ? Object.values(plans)
        .flatMap((p) => p.steps)
        .find((s) => s.id === comment.stepId)
    : undefined;

  return (
    <div className={`comment ${comment.status === 'resolved' ? 'resolved' : ''}`}>
      <div className="comment-head">
        <Author comment={comment} size={18} />
        {comment.kind === 'suggestion' && <span className="tag">suggestion</span>}
        {comment.outdated && (
          <span className="tag tag-warn" title="The code it points at moved or changed since">
            outdated
          </span>
        )}
        {comment.status === 'resolved' && <span className="tag">resolved</span>}
        <span className="spacer" />
        <span className="muted small">{ago(comment.createdAt)}</span>
      </div>
      {onCode && (
        <button
          className="comment-anchor mono"
          onClick={() => open && void openFile(a.path, a.startLine)}
          title={open ? 'Open in the editor' : 'Open this workspace to jump to the code'}
        >
          {a.kind === 'hunk' ? 'diff · ' : ''}
          {a.path}:{a.startLine}
          {a.endLine !== a.startLine ? `-${a.endLine}` : ''}
        </button>
      )}
      {a.kind === 'transcript' && <div className="comment-excerpt">“{a.excerpt}”</div>}
      <div className="comment-body">{comment.body}</div>
      {comment.proposal !== null && <pre className="comment-proposal mono">{comment.proposal}</pre>}
      {(step || comment.promptedAt) && (
        <div className="comment-links muted small">
          {step && (
            <>
              → plan step “{step.title}” ({step.status}){' '}
            </>
          )}
          {comment.promptedAt && <>→ sent to an agent</>}
        </div>
      )}
      <div className="comment-actions">
        {canComment && (
          <button className="link-btn" onClick={() => setReplying(!replying)}>
            <MessageSquare size={12} /> Reply
          </button>
        )}
        {canComment &&
          (comment.status === 'open' ? (
            <button className="link-btn" onClick={() => void setCommentStatus(comment, 'resolved')}>
              <Check size={12} /> Resolve
            </button>
          ) : (
            <button className="link-btn" onClick={() => void setCommentStatus(comment, 'open')}>
              <RotateCcw size={12} /> Reopen
            </button>
          ))}
        {canPlan && !comment.stepId && (
          <button
            className="link-btn"
            title={`Add to the plan of “${target!.title}”`}
            onClick={() => void commentToStep(comment, target!.id)}
          >
            <ListPlus size={12} /> Plan step
          </button>
        )}
        {canPrompt && (
          <button className="link-btn" onClick={() => void promptFromComment(comment)}>
            <Bot size={12} /> Ask my agent
          </button>
        )}
        {open && (
          <button
            className="link-btn"
            title="Open a GitHub issue from this comment"
            onClick={() => issueFromComment(comment)}
          >
            <CircleDot size={12} /> Create issue…
          </button>
        )}
        {comment.kind === 'suggestion' &&
          comment.proposal !== null &&
          onCode &&
          open &&
          canPrompt && (
            <button className="link-btn" onClick={() => void applySuggestion(comment)}>
              <Wand2 size={12} /> Apply
            </button>
          )}
      </div>
      {replies.length > 0 && (
        <div className="comment-replies">
          {replies.map((r) => (
            <div key={r.id} className="comment reply">
              <div className="comment-head">
                <Author comment={r} size={16} />
                <span className="spacer" />
                <span className="muted small">{ago(r.createdAt)}</span>
              </div>
              <div className="comment-body">{r.body}</div>
            </div>
          ))}
        </div>
      )}
      {replying && (
        <CommentComposer
          autoFocus
          placeholder="Reply"
          workspaceId={comment.sessionId ? comment.workspaceId : undefined}
          onCancel={() => setReplying(false)}
          onSubmit={async (body) => {
            const made = await addComment(comment.workspaceId, {
              anchor: comment.anchor,
              body,
              sessionId: comment.sessionId,
              parentId: comment.id,
            });
            if (made) setReplying(false);
            return made;
          }}
        />
      )}
    </div>
  );
}

/** Top-level comments with their replies, oldest first. */
export function Threads({ comments, empty }: { comments: Comment[]; empty: string }) {
  const tops = comments.filter((c) => !c.parentId);
  if (tops.length === 0) return <div className="rail-empty">{empty}</div>;
  return (
    <div className="threads">
      {tops.map((c) => (
        <CommentCard key={c.id} comment={c} replies={comments.filter((r) => r.parentId === c.id)} />
      ))}
    </div>
  );
}

/** A session's own conversation: comments on the session and on moments of its lanes. */
export function SessionComments({ session }: { session: Session }) {
  const all = useStore((s) => s.comments[session.workspaceId] ?? EMPTY);
  const role = useStore((s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.role);
  const comments = useMemo(
    () =>
      all.filter(
        (c) =>
          c.sessionId === session.id &&
          (c.anchor.kind === 'session' || c.anchor.kind === 'transcript'),
      ),
    [all, session.id],
  );
  return (
    <div className="session-comments">
      <Threads
        comments={comments}
        empty="No comments yet. Comments don't spend anyone's model usage."
      />
      {role && can(role, 'comment.create') && (
        <CommentComposer
          placeholder="Comment on this session"
          workspaceId={session.workspaceId}
          onSubmit={(body) =>
            addComment(session.workspaceId, {
              anchor: { kind: 'session' },
              body,
              sessionId: session.id,
            })
          }
        />
      )}
    </div>
  );
}

/** Comments on one moment of a lane, shown right under it. */
export function TranscriptThread({
  session,
  laneUserId,
  index,
  excerpt,
  composing,
  onDone,
}: {
  session: Session;
  laneUserId: string;
  index: number;
  excerpt: string;
  composing: boolean;
  onDone: () => void;
}) {
  const all = useStore((s) => s.comments[session.workspaceId] ?? EMPTY);
  const comments = all.filter(
    (c) =>
      c.sessionId === session.id &&
      c.anchor.kind === 'transcript' &&
      c.anchor.laneUserId === laneUserId &&
      c.anchor.index === index,
  );
  if (comments.length === 0 && !composing) return null;
  return (
    <div className="transcript-thread">
      {comments.length > 0 && <Threads comments={comments} empty="" />}
      {composing && (
        <CommentComposer
          autoFocus
          placeholder="Comment on this moment"
          workspaceId={session.workspaceId}
          onCancel={onDone}
          onSubmit={async (body) => {
            const made = await addComment(session.workspaceId, {
              anchor: { kind: 'transcript', laneUserId, index, excerpt: excerpt.slice(0, 300) },
              body,
              sessionId: session.id,
            });
            if (made) onDone();
            return made;
          }}
        />
      )}
    </div>
  );
}

/** The workspace side panel: comments on this repository's code, grouped by file. */
export function CommentsPanel() {
  const ws = useStore(activeTeamWorkspace);
  const all = useStore((s) => (ws ? (s.comments[ws.id] ?? EMPTY) : EMPTY));
  const [showResolved, setShowResolved] = useState(false);
  if (!ws)
    return (
      <div className="side-panel">
        <div className="side-panel-head">Comments</div>
        <div className="panel-empty muted small">
          Comments are shared with your team. Open a shared workspace to see and add them.
        </div>
      </div>
    );
  const onCode = all.filter((c) => c.anchor.kind === 'file' || c.anchor.kind === 'hunk');
  const tops = onCode.filter((c) => !c.parentId && (showResolved || c.status === 'open'));
  const byFile = new Map<string, Comment[]>();
  for (const c of tops) {
    const path = (c.anchor as { path: string }).path;
    byFile.set(path, [...(byFile.get(path) ?? []), c]);
  }
  return (
    <div className="side-panel comments-panel">
      <div className="side-panel-head">
        <span>Comments</span>
        <label className="muted small">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />{' '}
          resolved
        </label>
      </div>
      {byFile.size === 0 && (
        <div className="panel-empty muted small">
          Select code in the editor and press ⌥⌘M (or right-click → Comment) to comment on it.
        </div>
      )}
      {[...byFile].map(([path, list]) => (
        <div key={path} className="comments-file">
          <div className="comments-file-name mono">{path}</div>
          {list
            .sort(
              (a, b) =>
                (a.anchor as { startLine: number }).startLine -
                (b.anchor as { startLine: number }).startLine,
            )
            .map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                replies={onCode.filter((r) => r.parentId === c.id)}
              />
            ))}
        </div>
      ))}
    </div>
  );
}

/** Writing a comment (or a suggestion) on lines of code, opened from the editor or a diff. */
export function CommentDialog() {
  const draft = useStore((s) => s.commentDraft);
  const [kind, setKind] = useState<'comment' | 'suggestion'>('comment');
  const [body, setBody] = useState('');
  const [proposal, setProposal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!draft || (draft.anchor.kind !== 'file' && draft.anchor.kind !== 'hunk')) return null;
  const a = draft.anchor;
  const close = () => {
    setState({ commentDraft: null });
    setBody('');
    setKind('comment');
    setProposal(null);
  };
  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    const made = await addComment(draft.workspaceId, {
      anchor: a,
      body: body.trim(),
      sessionId: draft.sessionId,
      kind,
      proposal: kind === 'suggestion' ? (proposal ?? a.snippet) : null,
    });
    setBusy(false);
    if (made) {
      close();
      setState({ panel: 'comments' });
    }
  };
  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form
        className="modal dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <h2 className="modal-title">
            {kind === 'suggestion' ? 'Suggest a change' : 'Comment'} on {a.path}:{a.startLine}
            {a.endLine !== a.startLine ? `-${a.endLine}` : ''}
          </h2>
          <p className="modal-desc">
            Your team sees it pinned to these lines. If the code moves or changes, it is labelled,
            not lost.
          </p>
          <button type="button" className="icon-btn modal-close" title="Close" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          <pre className="comment-proposal mono">{a.snippet}</pre>
          <div className="segmented">
            <button
              type="button"
              className={kind === 'comment' ? 'on' : ''}
              onClick={() => setKind('comment')}
            >
              Comment
            </button>
            <button
              type="button"
              className={kind === 'suggestion' ? 'on' : ''}
              onClick={() => setKind('suggestion')}
            >
              Suggestion
            </button>
          </div>
          <textarea
            className="input"
            rows={3}
            autoFocus
            placeholder={kind === 'suggestion' ? 'Why this change?' : 'What should the team know?'}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {kind === 'suggestion' && (
            <label className="field-label">
              Proposed code (replaces these lines)
              <textarea
                className="input mono"
                rows={Math.min(12, a.snippet.split('\n').length + 1)}
                value={proposal ?? a.snippet}
                onChange={(e) => setProposal(e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !body.trim()}>
            {busy ? 'Posting…' : 'Post'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Starts a comment on the given lines of the open file (from the editor or a diff). */
export function startCodeComment(
  path: string,
  startLine: number,
  endLine: number,
  snippet: string,
  kind: 'file' | 'hunk',
  commit: string | null,
): boolean {
  const s = getState();
  const ws = activeTeamWorkspace(s);
  if (!ws) return false;
  const me = s.user?.id;
  // Pinned to the session this person works in here, when there is one.
  const session = (s.sessions[ws.id] ?? []).find((x) =>
    x.participants.some((p) => p.userId === me && p.mode === 'join'),
  );
  setState({
    commentDraft: {
      workspaceId: ws.id,
      sessionId: session?.id ?? null,
      anchor: { kind, path, startLine, endLine, snippet, commit },
    },
  });
  return true;
}
