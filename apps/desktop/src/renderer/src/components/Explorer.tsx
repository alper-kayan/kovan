import type { FileStatus } from '@kovan/git-engine';
import { can, type Workspace } from '@kovan/shared';
import type { DirEntry } from '../../../shared/api';
import { openDraft, openFile } from '../services/editor';
import { loadDir, toggleDir } from '../services/explorer';
import { compareVersion, pickVersion, setSyncEnabled } from '../services/sync';
import { getState, setState, useStore, type AgentMark } from '../store';
import { Avatar, initials } from './ui';
import { ChevronDown, ChevronRight, GitCompare, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';

/** Single-letter git decoration for a file, like an editor's explorer shows. */
export function decoration(file: FileStatus): { letter: string; className: string } {
  if (file.kind === 'conflicted') return { letter: '!', className: 'git-conflict' };
  if (file.kind === 'untracked') return { letter: 'U', className: 'git-untracked' };
  const code = file.worktree !== '.' ? file.worktree : file.index;
  if (code === 'A') return { letter: 'A', className: 'git-added' };
  if (code === 'D') return { letter: 'D', className: 'git-deleted' };
  if (code === 'R') return { letter: 'R', className: 'git-modified' };
  return { letter: 'M', className: 'git-modified' };
}

interface Decorations {
  byPath: Map<string, { letter: string; className: string }>;
  dirtyDirs: Set<string>;
}

const EMPTY: Decorations = { byPath: new Map(), dirtyDirs: new Set() };
const cache = new WeakMap<FileStatus[], Decorations>();

/** Decorations for the current status, computed once per status object and shared by all rows. */
function useDecorations(): Decorations {
  const files = useStore((s) => s.gitStatus?.files);
  if (!files) return EMPTY;
  let decorations = cache.get(files);
  if (!decorations) {
    decorations = { byPath: new Map(), dirtyDirs: new Set() };
    for (const file of files) {
      decorations.byPath.set(file.path, decoration(file));
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) decorations.dirtyDirs.add(parts.slice(0, i).join('/'));
    }
    cache.set(files, decorations);
  }
  return decorations;
}

/** The agents that changed this file, newest last; for a folder, those that changed anything under it. */
function useMarks(entry: DirEntry): AgentMark[] {
  const files = useStore((s) => s.agentFiles);
  return useMemo(() => {
    if (entry.kind === 'file') return files[entry.path] ?? [];
    const prefix = `${entry.path}/`;
    const byAgent = new Map<string, AgentMark>();
    for (const [path, marks] of Object.entries(files))
      if (path.startsWith(prefix)) for (const m of marks) byAgent.set(m.key, m);
    return [...byAgent.values()];
  }, [files, entry.kind, entry.path]);
}

/**
 * The folder's entries on disk, and the files agents created under it that aren't in this copy yet (written in their own
 * copy of the repository): those show too, marked new, so all agents' work is in one tree.
 */
function Entries({ dir, depth }: { dir: string; depth: number }) {
  const entries = useStore((s) => s.dirs[dir]);
  const files = useStore((s) => s.agentFiles);
  const all = useMemo(() => {
    if (!entries) return null;
    const known = new Set(entries.map((e) => e.path));
    const prefix = dir ? `${dir}/` : '';
    const extra = new Map<string, DirEntry>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [first, ...more] = rest.split('/');
      const child = `${prefix}${first}`;
      if (!first || known.has(child) || extra.has(child)) continue;
      extra.set(child, { name: first, path: child, kind: more.length ? 'dir' : 'file' });
    }
    return [...entries, ...[...extra.values()].map((e) => ({ ...e, draft: true }))];
  }, [entries, files, dir]);
  if (!all) return null;
  return (
    <>
      {all.map((entry) => (
        <Row key={entry.path} entry={entry} depth={depth} />
      ))}
    </>
  );
}

/** The agents' initials on a row, in their colors. */
function AgentBadges({ marks }: { marks: AgentMark[] }) {
  if (!marks.length) return null;
  const names = [...new Set(marks.map((m) => (m.mine ? 'your agent' : m.name)))];
  return (
    <span className="tree-agents" title={`Changed by ${names.join(', ')}`}>
      {marks.slice(-3).map((m) => (
        <span key={m.key} className="tree-agent" style={{ background: m.color }}>
          {initials(m.name)}
        </span>
      ))}
    </span>
  );
}

function Row({ entry, depth }: { entry: DirEntry & { draft?: boolean }; depth: number }) {
  const expanded = useStore((s) => s.expanded[entry.path] === true);
  const marks = useMarks(entry);
  const active = useStore((s) => s.activeTabId === `file:${entry.path}`);
  const { byPath, dirtyDirs } = useDecorations();
  const deco = byPath.get(entry.path);
  const dirDirty = entry.kind === 'dir' && dirtyDirs.has(entry.path);
  const versions = useStore((s) =>
    entry.kind === 'file' ? (s.sync?.versions.filter((v) => v.path === entry.path).length ?? 0) : 0,
  );
  const editors = useStore((s) =>
    entry.kind === 'file' ? s.sync?.editors[entry.path] : undefined,
  );

  const onClick = () =>
    entry.kind === 'dir'
      ? entry.draft
        ? setState((st) => ({
            expanded: { ...st.expanded, [entry.path]: !st.expanded[entry.path] },
          }))
        : void toggleDir(entry.path)
      : entry.draft
        ? openDraft(entry.path)
        : void openFile(entry.path);

  return (
    <>
      <div
        className={`tree-row ${active ? 'active' : ''} ${deco?.className ?? ''} ${dirDirty ? 'git-dir-dirty' : ''} ${entry.draft ? 'tree-draft' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={onClick}
        title={
          entry.draft
            ? `${entry.path}: new, written by ${[...new Set(marks.map((m) => (m.mine ? 'your agent' : m.name)))].join(', ')} in another copy; not in yours yet`
            : entry.path
        }
      >
        <span className="tree-twisty">
          {entry.kind === 'dir' &&
            (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        </span>
        <span className="tree-name">{entry.name}</span>
        {versions > 0 && (
          <span className="versions-chip" title="You and a teammate changed the same lines">
            {versions + 1} versions
          </span>
        )}
        {editors && (
          <span
            className="tree-editors"
            title={`Changed by ${editors.map((e) => e.name).join(', ')}`}
          >
            {editors.slice(0, 3).map((e) => (
              <Avatar key={e.userId} name={e.name} size={14} />
            ))}
          </span>
        )}
        <AgentBadges marks={marks} />
        {entry.draft && entry.kind === 'file' && <span className="tree-deco tree-new">new</span>}
        {deco && <span className="tree-deco">{deco.letter}</span>}
        {dirDirty && <span className="tree-deco tree-dot">●</span>}
      </div>
      {entry.kind === 'dir' && expanded && <Entries dir={entry.path} depth={depth + 1} />}
    </>
  );
}

/** Files both you and a teammate changed in the same place: compare and pick. */
function Conflicts() {
  const versions = useStore((s) => s.sync?.versions);
  if (!versions?.length)
    return (
      <p className="empty-note">
        No conflicts. When you and a teammate change the same lines, both versions are kept here to
        compare and pick; nothing is overwritten.
      </p>
    );
  return (
    <div className="conflicts">
      {versions.map((v) => (
        <div key={v.id} className="conflict-row">
          <div className="conflict-head">
            <span className="conflict-path" title={v.path}>
              {v.path}
            </span>
            <span className="versions-chip">2 versions</span>
          </div>
          <div className="muted small">
            Yours and {v.peerName}'s{v.deleted ? ' (they deleted it)' : ''}
          </div>
          <div className="conflict-actions">
            {!v.deleted && (
              <button className="btn btn-sm" onClick={() => compareVersion(v)}>
                <GitCompare size={12} /> Compare
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void pickVersion(v, 'mine')}>
              Keep mine
            </button>
            <button className="btn btn-sm" onClick={() => void pickVersion(v, 'theirs')}>
              {v.deleted ? 'Delete it' : `Take ${v.peerName}'s`}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Who last flipped the shared switch, for its tooltip: " · Turned off by Ana at 14:02". */
function changedBy(workspace: Workspace | undefined): string {
  if (!workspace?.gitSyncChangedBy || !workspace.gitSyncChangedAt) return '';
  const at = new Date(workspace.gitSyncChangedAt).toLocaleString([], {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return ` · Turned ${workspace.autoGitSync ? 'on' : 'off'} by ${workspace.gitSyncChangedBy}, ${at}`;
}

/**
 * The workspace's automatic Git sync switch, while a session checkout syncs. One switch for
 * everyone in the workspace: flipping it here flips it for the team.
 */
function SyncSwitch() {
  const sync = useStore((s) => s.sync);
  const workspace = useStore((s) => s.teamWorkspaces.find((w) => w.id === s.sync?.workspaceId));
  if (!sync) return null;
  const label = sync.status === 'paused' ? 'Paused' : sync.status === 'off' ? 'Off' : 'On';
  const mayFlip = !workspace || can(workspace.role, 'workspace.gitSync');
  return (
    <button
      className={`sync-switch ${sync.status}`}
      disabled={!mayFlip}
      title={
        sync.paused?.reason ??
        `${
          sync.enabled
            ? `Saved changes sync with the session every few seconds${sync.lastPushAt ? ` · last sent ${new Date(sync.lastPushAt).toLocaleTimeString()}` : ''}`
            : 'Off for everyone in this workspace: nothing goes out or comes in'
        }${changedBy(workspace)}${mayFlip ? '' : ' · Editors and owners turn it on or off'}`
      }
      onClick={() => void setSyncEnabled(!sync.enabled)}
    >
      <span className="sync-dot" />
      Git sync <b>{label}</b>
    </button>
  );
}

export function Explorer() {
  const workspace = useStore((s) => s.workspace);
  const tab = useStore((s) => s.explorerTab);
  const conflicts = useStore((s) => s.sync?.versions.length ?? 0);
  if (!workspace) return null;
  return (
    <div className="side-panel explorer">
      <div className="side-panel-head">
        <div className="seg">
          <button
            className={tab === 'files' ? 'on' : ''}
            onClick={() => setState({ explorerTab: 'files' })}
          >
            Files
          </button>
          <button
            className={tab === 'conflicts' ? 'on' : ''}
            onClick={() => setState({ explorerTab: 'conflicts' })}
          >
            Conflicts <span className={`count-pill ${conflicts ? 'warn' : ''}`}>{conflicts}</span>
          </button>
        </div>
        <span className="spacer" />
        <SyncSwitch />
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => Object.keys(getState().dirs).forEach((dir) => void loadDir(dir))}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {tab === 'conflicts' ? (
        <Conflicts />
      ) : (
        <div className="tree">
          <Entries dir="" depth={0} />
        </div>
      )}
    </div>
  );
}
