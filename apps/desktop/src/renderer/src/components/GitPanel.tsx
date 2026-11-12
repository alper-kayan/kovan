import type { BranchInfo, FileStatus } from '@kovan/git-engine';
import { pressable } from './ui';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { openDiff, openFile } from '../services/editor';
import {
  checkout,
  commit,
  createBranch,
  discard,
  refreshGitStatus,
  stage,
  unstage,
} from '../services/git';
import type { ChangeImpact, ImpactLink, Session } from '@kovan/shared';
import { createPr, pushBranch, refreshPr } from '../services/sync';
import { reportError, setState, useStore } from '../store';
import { CommitGraph } from './CommitGraph';
import { decoration } from './Explorer';
import {
  ArrowUp,
  Check,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
} from 'lucide-react';

const isStaged = (f: FileStatus) =>
  f.kind !== 'untracked' && f.kind !== 'conflicted' && f.index !== '.';
const isUnstaged = (f: FileStatus) =>
  f.kind === 'untracked' || f.kind === 'conflicted' || f.worktree !== '.';

function FileRow({ file, staged }: { file: FileStatus; staged: boolean }) {
  const deco = decoration(file);
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  const dir = file.path.slice(0, Math.max(0, file.path.lastIndexOf('/')));
  const deleted = (staged ? file.index : file.worktree) === 'D';

  return (
    <div
      className={`change-row ${deco.className}`}
      onClick={() => openDiff(file.path, staged)}
      title={file.path}
      {...pressable(() => openDiff(file.path, staged), `${file.path}: show the changes`)}
    >
      <span className="change-name">{name}</span>
      <span className="change-dir">{dir}</span>
      <span className="change-actions" onClick={(e) => e.stopPropagation()}>
        {!deleted && (
          <button className="icon-btn" title="Open file" onClick={() => void openFile(file.path)}>
            <FileText size={13} />
          </button>
        )}
        {staged ? (
          <button className="icon-btn" title="Unstage" onClick={() => void unstage([file.path])}>
            <Minus size={13} />
          </button>
        ) : (
          <>
            <button
              className="icon-btn"
              title="Discard changes"
              onClick={() => void discard([file.path])}
            >
              <Undo2 size={13} />
            </button>
            <button className="icon-btn" title="Stage" onClick={() => void stage([file.path])}>
              <Plus size={13} />
            </button>
          </>
        )}
      </span>
      <span className="tree-deco">
        {staged ? (file.index === 'A' ? 'A' : deco.letter) : deco.letter}
      </span>
    </div>
  );
}

function BranchPicker({ current }: { current: string | null }) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    api.invoke('git:branches').then(setBranches, reportError);
  }, [current]);

  if (creating) {
    return (
      <form
        className="branch-create"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void createBranch(name.trim()).then((ok) => {
            if (ok) {
              setCreating(false);
              setName('');
            }
          });
        }}
      >
        <input
          autoFocus
          className="input"
          placeholder="new-branch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
        />
      </form>
    );
  }

  return (
    <div className="branch-picker">
      <GitBranch size={14} />
      <select
        className="select"
        value={current ?? ''}
        onChange={(e) => {
          if (e.target.value === '__new__') setCreating(true);
          else void checkout(e.target.value);
        }}
      >
        {current === null && <option value="">(detached HEAD)</option>}
        {branches.map((b) => (
          <option key={b.name} value={b.name}>
            {b.name}
          </option>
        ))}
        <option value="__new__">+ Create branch…</option>
      </select>
    </div>
  );
}

/** The session this checkout belongs to, while it syncs one. */
function useCheckoutSession(): Session | null {
  const sessionId = useStore((s) => s.sync?.sessionId ?? s.workspace?.session?.id ?? null);
  return useStore((s) => {
    if (!sessionId) return null;
    if (s.room?.session?.id === sessionId) return s.room.session;
    for (const list of Object.values(s.sessions)) {
      const found = list.find((x) => x.id === sessionId);
      if (found) return found;
    }
    return null;
  });
}

/** Finishing is ordinary git: a pull request; merging it completes the session. */
function FinishSession({ session }: { session: Session }) {
  const base = useStore(
    (s) => s.teamWorkspaces.find((w) => w.id === session.workspaceId)?.defaultBranch ?? 'main',
  );
  const [title, setTitle] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const pr = session.pr;

  // Merged on GitHub: noticed while this panel is open.
  useEffect(() => {
    if (!pr || pr.state !== 'open') return;
    const timer = setInterval(() => void refreshPr(session), 60_000);
    return () => clearInterval(timer);
  }, [pr, session]);

  if (pr)
    return (
      <div className="finish">
        <GitPullRequest size={14} />
        <a href={pr.url} target="_blank" rel="noreferrer" className="finish-link">
          PR #{pr.number} <ExternalLink size={11} />
        </a>
        <span className={`pr-state ${pr.state}`}>{pr.state}</span>
        <IssueTag session={session} />
        <span className="spacer" />
        {pr.state === 'open' && (
          <button
            className="icon-btn"
            title="Check on GitHub"
            onClick={() => void refreshPr(session)}
          >
            <RefreshCw size={13} />
          </button>
        )}
      </div>
    );
  return (
    <form
      className="finish finish-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void createPr(session, {
          title: title.trim() || session.title,
          body: `From the Kovan session "${session.title}".`,
          base,
        }).finally(() => setBusy(false));
      }}
    >
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button className="btn" disabled={busy || session.status !== 'active'} title={`Into ${base}`}>
        <GitPullRequest size={13} /> {busy ? 'Opening…' : 'Create pull request'}
      </button>
      <IssueTag session={session} />
    </form>
  );
}

/** The issue the session works on; its pull request closes it. */
function IssueTag({ session }: { session: Session }) {
  const issue = session.issue;
  if (!issue) return null;
  const text = `Closes #${issue.number}`;
  return issue.url ? (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      className="finish-link small muted"
      title="Merging the pull request closes this issue"
    >
      {text}
    </a>
  ) : (
    <span className="small muted">{text}</span>
  );
}

const CERTAINTY: Record<ImpactLink['certainty'], string> = {
  changed: 'changed',
  imports: 'imports it',
  imports_indirectly: 'imports it through others',
  mentions: 'only mentions its name',
};

/**
 * What the open changes can reach, from the code itself: tests and modules that import the
 * changed files, API routes among them, tests that only name them. A map for checking, not proof.
 */
function ImpactSection() {
  const [impact, setImpact] = useState<ChangeImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const look = () => {
    setBusy(true);
    void (api.invoke('impact:working') as Promise<ChangeImpact>)
      .then(setImpact)
      .catch(reportError)
      .finally(() => setBusy(false));
  };
  const group = (kind: ImpactLink['kind']) => impact?.links.filter((l) => l.kind === kind) ?? [];
  return (
    <div className="impact">
      <button className="btn btn-sm" disabled={busy} onClick={look}>
        {busy ? 'Looking…' : impact ? 'Look again' : 'What does this change touch?'}
      </button>
      {impact && impact.links.length === 0 && (
        <p className="muted small">
          Nothing in this repository imports or names the changed files.
        </p>
      )}
      {impact &&
        (['test', 'api', 'module'] as const).map((kind) =>
          group(kind).length ? (
            <div key={kind}>
              <div className="impact-title">
                {kind === 'test' ? 'Tests' : kind === 'api' ? 'API routes' : 'Modules'}
              </div>
              {group(kind).map((l) => (
                <div
                  key={l.path}
                  className={`impact-link certainty-${l.certainty}`}
                  title={l.via.join(' → ')}
                >
                  <span className="mono">{l.path}</span>{' '}
                  <span className="muted">{CERTAINTY[l.certainty]}</span>
                </div>
              ))}
            </div>
          ) : null,
        )}
      {impact && impact.notes.length > 0 && (
        <p className="muted small">
          {impact.notes.join(' ')} It shows what to check, not that the change is safe.
        </p>
      )}
    </div>
  );
}

export function GitPanel() {
  const workspace = useStore((s) => s.workspace);
  const status = useStore((s) => s.gitStatus);
  const isMac = useStore((s) => s.isMac);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const tab = useStore((s) => s.gitTab);
  const session = useCheckoutSession();
  const [local, setLocal] = useState(false);
  useEffect(() => {
    api.invoke('repo:agentsConnected').then(setLocal, () => setLocal(false));
  }, [workspace?.root]);

  if (!workspace) return null;
  if (!workspace.isRepo) {
    return (
      <div className="side-panel">
        <div className="side-panel-head">Changes</div>
        <p className="empty-note">This folder is not a git repository.</p>
      </div>
    );
  }

  const files = status?.files ?? [];
  const staged = files.filter(isStaged);
  const unstaged = files.filter(isUnstaged);
  // Nothing staged: Commit takes every change, as most people expect (staging stays optional).
  const committing = staged.length > 0 ? staged : unstaged;
  const canCommit = committing.length > 0 && message.trim() !== '' && !busy;
  const whyNot =
    busy || canCommit
      ? null
      : committing.length === 0
        ? 'Nothing to commit: no changes.'
        : `Write a commit message (or ✨ writes one) to commit ${committing.length === 1 ? 'the change' : `${committing.length} files`}.`;

  // A small model writes the message from the staged changes (or all of them).
  const writeMessage = async () => {
    setWriting(true);
    try {
      const { message: written } = await api.invoke('git:suggestMessage');
      setMessage(written);
    } catch (error) {
      reportError(error);
    } finally {
      setWriting(false);
    }
  };

  const doCommit = async (andPush = false) => {
    if (!canCommit) return;
    setBusy(true);
    if (!staged.length && !(await stage(unstaged.map((f) => f.path)))) {
      setBusy(false);
      return;
    }
    if (await commit(message)) {
      setMessage('');
      if (andPush) await pushBranch();
    }
    setBusy(false);
  };

  return (
    <div className="side-panel">
      <div className="side-panel-head">
        <div className="seg">
          <button
            className={tab === 'changes' ? 'on' : ''}
            onClick={() => setState({ gitTab: 'changes' })}
          >
            Changes <span className="count-pill">{files.length}</span>
          </button>
          <button
            className={tab === 'graph' ? 'on' : ''}
            onClick={() => setState({ gitTab: 'graph' })}
          >
            Graph
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-btn" title="Refresh" onClick={() => void refreshGitStatus()}>
          <RefreshCw size={13} />
        </button>
      </div>
      {tab === 'graph' ? (
        <CommitGraph />
      ) : (
        <>
          <div className="git-top">
            <BranchPicker current={status?.branch ?? null} />
            {status && (status.ahead > 0 || status.behind > 0) && (
              <div className="muted small mono">
                ↑{status.ahead} ↓{status.behind} {status.upstream}
              </div>
            )}
            <div className="commit-box">
              <textarea
                className="input commit-input"
                placeholder={
                  writing
                    ? 'Writing a message from your changes…'
                    : `Commit message (${isMac ? '⌘' : 'Ctrl'}+Enter to commit)`
                }
                value={message}
                rows={3}
                disabled={writing}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void doCommit();
                  }
                }}
              />
              <button
                className={`icon-btn commit-write ${writing ? 'busy' : ''}`}
                title={
                  staged.length
                    ? 'Write the message from the staged changes'
                    : 'Write the message from your changes'
                }
                aria-label="Write the commit message with AI"
                disabled={writing || files.length === 0}
                onClick={() => void writeMessage()}
              >
                <Sparkles size={13} />
              </button>
            </div>
            <div className="commit-actions">
              <button
                className="btn btn-primary"
                disabled={!canCommit}
                onClick={() => void doCommit()}
              >
                <Check size={14} /> Commit
                {staged.length > 0
                  ? ` ${staged.length} file${staged.length > 1 ? 's' : ''}`
                  : committing.length > 0
                    ? ` all ${committing.length}`
                    : ''}
              </button>
              <button
                className="btn"
                disabled={!canCommit}
                title={`Commit${staged.length ? '' : ' every change'}, then push with your Git credentials`}
                onClick={() => void doCommit(true)}
              >
                Commit &amp; Push
              </button>
              <button
                className="btn"
                disabled={busy || !status?.branch}
                title={
                  status?.upstream ? `Push to ${status.upstream}` : 'Push and set the upstream'
                }
                onClick={() => {
                  setBusy(true);
                  void pushBranch().finally(() => setBusy(false));
                }}
              >
                <ArrowUp size={13} /> Push{status && status.ahead > 0 ? ` ${status.ahead}` : ''}
              </button>
            </div>
            {whyNot && <p className="muted small commit-why">{whyNot}</p>}
            {local && (
              <p className="muted small setup-note">
                Kovan's agent setup files are kept local and excluded from commits.
              </p>
            )}
            {session && <FinishSession session={session} />}
            {files.length > 0 && <ImpactSection key={files.length} />}
          </div>

          <div className="changes">
            {staged.length > 0 && (
              <section>
                <div className="changes-header">
                  <span>Staged Changes</span>
                  <span className="count-pill">{staged.length}</span>
                  <button
                    className="icon-btn"
                    title="Unstage all"
                    onClick={() => void unstage(staged.map((f) => f.path))}
                  >
                    <Minus size={13} />
                  </button>
                </div>
                {staged.map((f) => (
                  <FileRow key={`s:${f.path}`} file={f} staged />
                ))}
              </section>
            )}
            <section>
              <div className="changes-header">
                <span>Changes</span>
                <span className="count-pill">{unstaged.length}</span>
                {unstaged.length > 0 && (
                  <>
                    <button
                      className="icon-btn"
                      title="Discard all"
                      onClick={() => void discard(unstaged.map((f) => f.path))}
                    >
                      <Undo2 size={13} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Stage all"
                      onClick={() => void stage(unstaged.map((f) => f.path))}
                    >
                      <Plus size={13} />
                    </button>
                  </>
                )}
              </div>
              {unstaged.length === 0 && <p className="empty-note">No changes.</p>}
              {unstaged.map((f) => (
                <FileRow key={`w:${f.path}`} file={f} staged={false} />
              ))}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
