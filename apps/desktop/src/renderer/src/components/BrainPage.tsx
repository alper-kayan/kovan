import { can, type Learning, type Memory, type MemoryKind } from '@kovan/shared';
import {
  Brain,
  Check,
  ChevronsUpDown,
  Pencil,
  Plus,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { addMemory, loadMemories, loadRetired, updateMemory } from '../services/collab';
import { loadLearnings, updateLearning } from '../services/swarm';
import { addWorkspace, signIn } from '../services/team';
import { openFile } from '../services/editor';
import { activeTeamWorkspace, setState, useStore } from '../store';
import { PageHeader } from './PageHeader';
import { EmptyState, Segmented } from './ui';

const EMPTY: Memory[] = [];
const NO_LEARNINGS: Learning[] = [];

/** One learning: shared knowledge from a checked result, or the person's own preference. */
function LearningCard({ learning, canEdit }: { learning: Learning; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(learning.text);
  const mine = learning.kind === 'preference';
  const editable = mine || canEdit;
  return (
    <div className={`note learning ${learning.status === 'suggested' ? 'suggested' : ''}`}>
      <div className="note-head">
        <span className={`learning-kind ${learning.kind}`}>
          {mine ? 'Preference · only you' : 'Knowledge'}
        </span>
        {learning.verified ? (
          <span className="learning-verified" title={learning.evidence ?? ''}>
            <Check size={11} /> from a checked result
          </span>
        ) : (
          <span className="muted small">
            {learning.status === 'suggested'
              ? 'suggested · not used until you accept it'
              : 'accepted'}
          </span>
        )}
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void updateLearning(learning, { text: text.trim(), status: 'accepted' }).then(() =>
              setEditing(false),
            );
          }}
        >
          <textarea
            className="input"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="note-actions">
            <button className="btn btn-sm btn-primary" disabled={!text.trim()}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="note-text">{learning.text}</div>
      )}
      {learning.evidence && <div className="muted small">{learning.evidence}</div>}
      {editable && !editing && (
        <div className="note-actions">
          {learning.status === 'suggested' && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void updateLearning(learning, { status: 'accepted' })}
            >
              <Check size={12} /> Accept
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            <Pencil size={12} /> Correct
          </button>
          <button
            className="btn btn-sm"
            onClick={() => void updateLearning(learning, { status: 'forgotten' })}
          >
            <X size={12} /> Forget
          </button>
        </div>
      )}
    </div>
  );
}
const KINDS: MemoryKind[] = ['decision', 'gotcha', 'convention'];

function where(m: Memory): string | null {
  if (!m.path) return null;
  if (!m.startLine) return m.path;
  return `${m.path}:${m.startLine}${m.endLine && m.endLine !== m.startLine ? `-${m.endLine}` : ''}`;
}

function NoteCard({
  note,
  canEdit,
  isOpen,
  all,
}: {
  note: Memory;
  canEdit: boolean;
  isOpen: boolean;
  /** Every live note, to show the ones this one may disagree with. */
  all: Memory[];
}) {
  const [editing, setEditing] = useState(false);
  const disputes = (note.conflictsWith ?? [])
    .map((id) => all.find((m) => m.id === id))
    .filter((m): m is Memory => Boolean(m));
  const [text, setText] = useState(note.text);
  const place = where(note);
  return (
    <div className={`note note-${note.status}`}>
      <div className="note-head">
        <span className={`tag kind-${note.kind}`}>{note.kind}</span>
        {place && (
          <button
            className="comment-anchor mono"
            title={isOpen ? 'Open in the editor' : 'Open this workspace to jump to the code'}
            onClick={() =>
              isOpen && note.path && void openFile(note.path, note.startLine ?? undefined)
            }
          >
            {place}
          </button>
        )}
        <span className="spacer" />
        {note.verified ? (
          <span className="muted small" title="Written or accepted by a person">
            <Check size={12} /> verified
          </span>
        ) : (
          <span className="tag" title="Written by an agent; a person hasn't accepted it yet">
            unverified
          </span>
        )}
      </div>
      {note.status === 'flagged' && (
        <div className="note-flag">
          <TriangleAlert size={13} /> {note.flagReason ?? 'The code it points at changed.'} The next
          agent working nearby rewrites it.
        </div>
      )}
      {disputes.length > 0 && (
        <div className="note-dispute">
          <TriangleAlert size={13} /> May disagree with{' '}
          {disputes.length === 1 ? 'this note' : 'these notes'}; both are kept, and agents are told,
          until someone decides:
          {disputes.map((d) => (
            <div key={d.id} className="note-dispute-other">
              “{d.text}” ·{' '}
              {d.byAgent ? `${d.authorName ?? 'someone'}'s agent` : (d.authorName ?? 'someone')},{' '}
              {new Date(d.createdAt).toLocaleDateString()}
            </div>
          ))}
          {canEdit && (
            <div className="note-dispute-actions">
              <button
                className="btn btn-sm"
                title="They don't contradict each other"
                onClick={() => void updateMemory(note, { clearConflicts: true })}
              >
                <Check size={12} /> Both hold
              </button>
              <button
                className="btn btn-sm"
                title="This one is wrong or out of date"
                onClick={() => void updateMemory(note, { status: 'retired' })}
              >
                <X size={12} /> Retire this one
              </button>
            </div>
          )}
        </div>
      )}
      {editing ? (
        <div className="note-edit">
          <textarea
            className="input"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="comment-composer-actions">
            <button className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!text.trim()}
              onClick={() => {
                void updateMemory(note, { text: text.trim() });
                setEditing(false);
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="note-text">{note.text}</div>
      )}
      {note.kind === 'decision' &&
        (note.rationale || note.consequences || (note.affects ?? []).length > 0) && (
          <dl className="note-decision">
            {note.rationale && (
              <>
                <dt>Why</dt>
                <dd>{note.rationale}</dd>
              </>
            )}
            {note.consequences && (
              <>
                <dt>What follows</dt>
                <dd>{note.consequences}</dd>
              </>
            )}
            {(note.affects ?? []).length > 0 && (
              <>
                <dt>Governs</dt>
                <dd className="mono">{note.affects.join(', ')}</dd>
              </>
            )}
          </dl>
        )}
      <div className="note-foot">
        <span className="muted small">
          {note.byAgent
            ? `${note.authorName ?? 'someone'}'s agent (${note.byAgent})`
            : (note.authorName ?? 'someone')}
          {note.replacesId ? ' · rewrote a flagged note' : ''} ·{' '}
          {new Date(note.updatedAt).toLocaleDateString()}
        </span>
        <span className="spacer" />
        {canEdit && note.status !== 'retired' && (
          <>
            {!note.verified && (
              <button
                className="link-btn"
                onClick={() => void updateMemory(note, { verified: true })}
              >
                <Check size={12} /> Accept
              </button>
            )}
            {note.status === 'flagged' && (
              <button
                className="link-btn"
                title="The note still holds as written"
                onClick={() => void updateMemory(note, { status: 'active' })}
              >
                <Check size={12} /> Still holds
              </button>
            )}
            <button className="link-btn" onClick={() => setEditing(true)}>
              <Pencil size={12} /> Edit
            </button>
            <button
              className="link-btn"
              onClick={() => void updateMemory(note, { status: 'retired' })}
            >
              <X size={12} /> Retire
            </button>
          </>
        )}
        {canEdit && note.status === 'retired' && (
          <button
            className="link-btn"
            onClick={() => void updateMemory(note, { status: 'active' })}
          >
            <RotateCcw size={12} /> Restore
          </button>
        )}
      </div>
    </div>
  );
}

function NewNote({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [kind, setKind] = useState<MemoryKind>('decision');
  const [text, setText] = useState('');
  const [path, setPath] = useState('');
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="note new-note"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        void addMemory(workspaceId, {
          kind,
          text: text.trim(),
          path: path.trim() || null,
          line: Number(line) > 0 ? Number(line) : null,
        }).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <Segmented
        value={kind}
        options={KINDS.map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) }))}
        onChange={setKind}
      />
      <textarea
        className="input"
        rows={2}
        autoFocus
        placeholder="One or two sentences every agent should know"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="new-note-pin">
        <input
          className="input mono"
          placeholder="src/file.ts (optional)"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <input
          className="input mono"
          placeholder="line"
          value={line}
          onChange={(e) => setLine(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <div className="comment-composer-actions">
        <span className="muted small">
          Pinned to the code at that line, so a later change flags it.
        </span>
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
          Save note
        </button>
      </div>
    </form>
  );
}

/**
 * The Brain: short notes pinned to code — decisions, gotchas, conventions — that every agent
 * in the workspace reads. People read, edit, accept and retire them here.
 */
export function BrainPage() {
  const workspaces = useStore((s) => s.teamWorkspaces);
  const active = useStore(activeTeamWorkspace);
  const signedIn = useStore((s) => s.signedIn);
  const [chosen, setChosen] = useState<string | null>(null);
  const [tab, setTab] = useState<
    'live' | 'flagged' | 'disputed' | 'decisions' | 'retired' | 'learning'
  >('live');
  const [retired, setRetired] = useState<Memory[]>([]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const ws = workspaces.find((w) => w.id === chosen) ?? active ?? workspaces[0] ?? null;
  const notes = useStore((s) => (ws ? (s.memories[ws.id] ?? EMPTY) : EMPTY));
  const learnings = useStore((s) => (ws ? (s.learnings[ws.id] ?? NO_LEARNINGS) : NO_LEARNINGS));

  useEffect(() => {
    if (!ws) return;
    void loadMemories(ws.id);
    void loadLearnings(ws.id);
    if (tab === 'retired' || tab === 'decisions') void loadRetired(ws.id).then(setRetired);
  }, [ws, tab]);

  const shown = useMemo(() => {
    // Decisions are the project's history: live and replaced ones together, oldest first.
    if (tab === 'decisions')
      return [...notes, ...retired.filter((r) => !notes.some((n) => n.id === r.id))]
        .filter((n) => n.kind === 'decision')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const list =
      tab === 'retired'
        ? retired
        : tab === 'disputed'
          ? notes.filter((n) => (n.conflictsWith ?? []).length > 0)
          : notes.filter((n) => tab === 'live' || n.status === 'flagged');
    const q = query.toLowerCase();
    return list
      .filter(
        (n) => !q || n.text.toLowerCase().includes(q) || (n.path ?? '').toLowerCase().includes(q),
      )
      .sort(
        (a, b) =>
          Number(b.status === 'flagged') - Number(a.status === 'flagged') ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
  }, [tab, notes, retired, query]);

  const flagged = notes.filter((n) => n.status === 'flagged').length;
  const disputed = notes.filter((n) => (n.conflictsWith ?? []).length > 0).length;
  const canEdit = Boolean(ws && can(ws.role, 'memory.edit'));
  const isOpen = Boolean(ws && active?.id === ws.id);
  const cycle = () => {
    if (workspaces.length < 2 || !ws) return;
    const i = workspaces.findIndex((w) => w.id === ws.id);
    setChosen(workspaces[(i + 1) % workspaces.length]!.id);
  };

  return (
    <section className="page">
      <PageHeader title="Brain">
        {/* Six tabs over nothing read as broken: they come once there's something to sort. */}
        {ws && (notes.length > 0 || learnings.length > 0 || tab !== 'live') && (
          <Segmented
            value={tab}
            options={[
              { value: 'live', label: `Notes (${notes.length})` },
              { value: 'flagged', label: `Flagged (${flagged})` },
              { value: 'disputed', label: `Disputed (${disputed})` },
              { value: 'decisions', label: 'Decisions' },
              { value: 'retired', label: 'Retired' },
              {
                value: 'learning',
                label: `Learning (${learnings.length})${learnings.some((l) => l.status === 'suggested') ? ' •' : ''}`,
              },
            ]}
            onChange={setTab}
          />
        )}
        {ws && (
          <button className="filter" onClick={cycle} title="Workspace">
            {ws.name}
            <ChevronsUpDown size={12} />
          </button>
        )}
        <input
          className="input board-search"
          placeholder="Search notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Note
          </button>
        )}
      </PageHeader>
      {!signedIn || !ws ? (
        <EmptyState icon={<Brain size={40} strokeWidth={1.2} />} title="Your team's memory">
          <p className="empty-text">
            The Brain keeps what your team decided and learned (conventions, gotchas, why the code
            is the way it is), and every AI agent working in the workspace reads it.{' '}
            {signedIn
              ? 'Add a workspace to start one.'
              : 'It is shared with your team, so it needs an account.'}
          </p>
          {signedIn ? (
            <button className="btn btn-primary btn-sm" onClick={() => void addWorkspace()}>
              Add a workspace
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => void signIn('login')}>
              Sign in
            </button>
          )}
        </EmptyState>
      ) : tab === 'learning' ? (
        <div className="notes">
          <p className="muted small learning-intro">
            Swarms turn checked task results into knowledge every agent here reads. What they notice
            about how you like to work stays private to you, and isn't used until you accept it.
          </p>
          {learnings
            .filter((l) => !query || l.text.toLowerCase().includes(query.toLowerCase()))
            .map((l) => (
              <LearningCard key={`${l.id}:${l.updatedAt}`} learning={l} canEdit={canEdit} />
            ))}
          {learnings.length === 0 && (
            <EmptyState icon={<Brain size={40} strokeWidth={1.2} />} title="Nothing learned yet">
              <p className="empty-text">
                Run a swarm; what passes its checks becomes knowledge here.
              </p>
            </EmptyState>
          )}
        </div>
      ) : (
        <div className="notes">
          {adding && <NewNote workspaceId={ws.id} onDone={() => setAdding(false)} />}
          {shown.map((n) => (
            <NoteCard
              all={notes}
              key={`${n.id}:${n.updatedAt}`}
              note={n}
              canEdit={canEdit}
              isOpen={isOpen}
            />
          ))}
          {shown.length === 0 && !adding && (
            <EmptyState icon={<Brain size={40} strokeWidth={1.2} />} title="Nothing here yet">
              <p className="empty-text">
                Agents write decisions, gotchas and conventions here as they work; so can you. Every
                agent in {ws.name} reads them, and a note is flagged when the code it points at
                moves.
              </p>
            </EmptyState>
          )}
        </div>
      )}
    </section>
  );
}

export function openBrain(): void {
  setState({ view: 'brain', lastAppView: 'brain' });
}
