import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BranchFile } from '../../../shared/api';
import { monaco } from '../monaco';
import { api } from '../services/api';
import { useStore, type Tab } from '../store';
import { editorOptions } from './CodeEditor';

let counter = 0;

/** A session's file as its machine pushed it: read-only, with where it comes from. */
export function BranchFileView({ tab }: { tab: Extract<Tab, { kind: 'branch' }> }) {
  const host = useRef<HTMLDivElement>(null);
  const settings = useStore((s) => s.settings);
  const [got, setGot] = useState<BranchFile | { error: string } | null>(null);
  const [asks, setAsks] = useState(0);

  useEffect(() => {
    let live = true;
    setGot(null);
    api
      .invoke('git:branchFile', tab.workspaceId, tab.branch, tab.path, asks > 0)
      .then((r) => live && setGot(r))
      .catch((e: unknown) => live && setGot({ error: (e as Error).message ?? String(e) }));
    return () => {
      live = false;
    };
  }, [tab.workspaceId, tab.branch, tab.path, asks]);

  const text = got && 'file' in got && got.file.kind === 'text' ? got.file.content : null;
  useEffect(() => {
    if (!host.current || text === null) return;
    // The file name at the end of the URI still drives language detection.
    const model = monaco.editor.createModel(
      text,
      undefined,
      monaco.Uri.parse(`kovan-branch:/${++counter}/${tab.path}`),
    );
    const editor = monaco.editor.create(host.current, {
      ...editorOptions(settings),
      model,
      readOnly: true,
      automaticLayout: true,
    });
    if (tab.line) {
      editor.revealLineInCenter(tab.line);
      editor.setPosition({ lineNumber: tab.line, column: 1 });
    }
    return () => {
      editor.dispose();
      model.dispose();
    };
  }, [text, tab.path, tab.line, settings]);

  const commit = got && 'commit' in got ? got.commit : null;
  let message: string | null = null;
  if (!got) message = `Fetching ${tab.branch}…`;
  else if ('error' in got) message = got.error;
  else if ('missing' in got && got.missing === 'branch')
    message = `${tab.where} hasn't pushed ${tab.branch} yet. It pushes the branch when the swarm finishes.`;
  else if ('missing' in got)
    message = `${tab.path} isn't on ${tab.branch} yet. It shows here once ${tab.where} pushes that work.`;
  else if (got.file.kind === 'binary') message = "This file is binary and can't be shown.";
  else if (got.file.kind === 'tooLarge') message = 'This file is too large to open in the editor.';

  return (
    <div className="branch-file">
      <div className="branch-file-bar">
        <span>
          Read-only: <b>{tab.path}</b> on <b className="mono">{tab.branch}</b>
          {commit ? <span className="mono muted"> @ {commit}</span> : null}, written on{' '}
          <b>{tab.where}</b>
        </span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setAsks((n) => n + 1)}>
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {message ? (
        <div className="editor-message">{message}</div>
      ) : (
        <div className="branch-file-code" ref={host} />
      )}
    </div>
  );
}
