import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { reportError, setState, toast, useStore } from '../store';

type Similar = { number: number; title: string; url: string };

/**
 * A GitHub issue the person writes from a comment or an agent's reply: the same choices an
 * agent's draft gets (repository, text, labels, or a comment on an open issue that says the
 * same), sent as the person with git's credentials, to this checkout's repositories only.
 */
export function IssueDialog() {
  const draft = useStore((s) => s.issueDraft);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [repo, setRepo] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labels, setLabels] = useState('');
  const [similar, setSimilar] = useState<Similar[]>([]);
  const [commentOn, setCommentOn] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setBody(draft.body);
    setLabels('');
    setCommentOn(null);
    setRepos(null);
    void api
      .invoke('issue:draft', draft.title)
      .then((d) => {
        setRepos(d.repos);
        setRepo(d.repos[0] ?? '');
        setSimilar(d.similar);
      })
      .catch((error: unknown) => {
        setRepos([]);
        reportError(error);
      });
  }, [draft]);

  if (!draft) return null;
  const close = () => setState({ issueDraft: null });
  const pick = (next: string) => {
    setRepo(next);
    setCommentOn(null);
    setSimilar([]);
    void api
      .invoke('issue:similar', next, title)
      .then(setSimilar)
      .catch(() => {});
  };
  const send = () => {
    setBusy(true);
    void api
      .invoke('issue:file', {
        repo,
        title: title.trim(),
        body: body.trim(),
        labels: labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 10),
        commentOn,
        dontAsk: false,
      })
      .then((done) => {
        toast(`${done.text}: ${done.url}`);
        close();
      })
      .catch(reportError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form
        className="modal dialog issue-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="modal-head">
          <h2 className="modal-title">Create issue</h2>
          <p className="modal-desc">
            Goes to GitHub as you, with git&apos;s credentials. Secrets in the text are masked.
          </p>
          <button type="button" className="icon-btn modal-close" title="Close" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          {repos === null ? (
            <p className="setting-desc">Looking for this checkout&apos;s repositories…</p>
          ) : repos.length === 0 ? (
            <p className="setting-desc">
              This checkout has no GitHub remote, so there is nowhere to open the issue.
            </p>
          ) : (
            <>
              <label className="issue-field">
                <span>Repository</span>
                {repos.length > 1 ? (
                  <select value={repo} onChange={(e) => pick(e.target.value)}>
                    {repos.map((r) => (
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
                <input
                  autoFocus
                  value={title}
                  maxLength={240}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="issue-field">
                <span>Body</span>
                <textarea value={body} rows={10} onChange={(e) => setBody(e.target.value)} />
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
            </>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !repo || !title.trim() || !body.trim()}
          >
            {busy ? 'Sending…' : commentOn !== null ? `Comment on #${commentOn}` : 'Create issue'}
          </button>
        </div>
      </form>
    </div>
  );
}
