import { ROLES, type AiAgent, type Role } from '@kovan/shared';
import { Bot, ChevronDown, Layers, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { changeRole, invite, loadAllMembers, removeMember, revokeInvite } from '../services/team';
import {
  createAiAgent,
  loadAiAgents,
  retireAiAgent,
  updateAiAgent,
  type AiAgentInput,
} from '../services/swarm';
import { notify, setState, useStore } from '../store';
import { PageHeader } from './PageHeader';
import { Avatar } from './ui';

const ROLE_HELP: Record<Role, string> = {
  viewer: 'Sees sessions, transcripts, diffs and plans',
  commenter: 'Viewer, plus comments and holding work',
  editor: 'Commenter, plus everything with agents',
  owner: 'Editor, plus members, roles and settings',
};

function InviteDialog({ defaultWorkspace }: { defaultWorkspace: string | null }) {
  const open = useStore((s) => s.inviteOpen);
  const all = useStore((s) => s.teamWorkspaces);
  const workspaces = useMemo(() => all.filter((w) => w.role === 'owner'), [all]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [who, setWho] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setWorkspaceId(
        defaultWorkspace && workspaces.some((w) => w.id === defaultWorkspace)
          ? defaultWorkspace
          : (workspaces[0]?.id ?? ''),
      );
      setWho('');
    }
  }, [open]);

  if (!open) return null;
  const close = () => setState({ inviteOpen: false });
  const isEmail = who.includes('@') && !who.startsWith('@');
  const submit = async () => {
    const value = who.trim().replace(/^@/, '');
    if (!value || !workspaceId) return;
    setBusy(true);
    const ok = await invite(workspaceId, isEmail ? { email: value } : { githubLogin: value }, role);
    setBusy(false);
    if (ok) close();
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
          <h2 className="modal-title">Invite a teammate</h2>
          <p className="modal-desc">
            They join as soon as they sign in with that GitHub account or email.
          </p>
          <button type="button" className="icon-btn modal-close" title="Close" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          {workspaces.length === 0 ? (
            <p className="setting-desc">
              You need to own a workspace to invite people. Add one from the sidebar.
            </p>
          ) : (
            <>
              <label className="field-label">
                Workspace
                <select
                  className="select"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                GitHub username or email
                <input
                  autoFocus
                  className="input"
                  placeholder="octocat or ada@company.com"
                  value={who}
                  onChange={(e) => setWho(e.target.value)}
                />
              </label>
              <label className="field-label">
                Role
                <select
                  className="select"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r[0]!.toUpperCase() + r.slice(1)}: {ROLE_HELP[r]}
                    </option>
                  ))}
                </select>
              </label>
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
            disabled={busy || !who.trim() || !workspaceId}
          >
            {busy ? 'Inviting…' : 'Send invite'}
          </button>
        </div>
      </form>
    </div>
  );
}

const AI_MODES: { id: AiAgent['mode']; label: string }[] = [
  { id: 'allow', label: 'Allow edits: edits freely, asks before commands' },
  { id: 'request', label: 'Request: asks before every edit and command' },
  { id: 'full', label: 'Full: edits and runs commands without asking' },
  { id: 'plan', label: 'Plan: reads and plans, never edits' },
];

/** Adds an AI teammate to a workspace, or edits one. */
function AiTeammateDialog({
  workspaceId,
  editing,
  onClose,
}: {
  workspaceId: string | null;
  editing: AiAgent | null;
  onClose: () => void;
}) {
  const all = useStore((s) => s.teamWorkspaces);
  const workspaces = useMemo(
    () => all.filter((w) => w.role === 'editor' || w.role === 'owner'),
    [all],
  );
  const models = useStore((s) => s.models);
  const defaultModel = useStore((s) => s.settings.agentModel);
  const [ws, setWs] = useState(editing?.workspaceId ?? workspaceId ?? workspaces[0]?.id ?? '');
  const [form, setForm] = useState<AiAgentInput>({
    name: editing?.name ?? '',
    model: editing?.model ?? defaultModel,
    effort: editing?.effort ?? null,
    mode: editing?.mode ?? 'allow',
    instructions: editing?.instructions ?? '',
    monthlyLimit: editing?.monthlyLimit ?? null,
  });
  const [limitText, setLimitText] = useState(editing?.monthlyLimit?.toString() ?? '');
  const owner = all.find((w) => w.id === (editing?.workspaceId ?? ws))?.role === 'owner';
  const limit = limitText.trim() ? Number(limitText) : null;
  const limitOk = limit === null || limit >= 0.01;
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<AiAgentInput>) => setForm((f) => ({ ...f, ...patch }));
  const submit = async () => {
    if (!form.name.trim() || !form.model.trim() || !ws || !limitOk) return;
    setBusy(true);
    // The limit is the owner's: others don't send it (the Brain would refuse the whole change).
    const rest = {
      name: form.name,
      model: form.model,
      effort: form.effort,
      mode: form.mode,
      instructions: form.instructions,
    };
    const ok = editing
      ? await updateAiAgent(editing, owner ? { ...rest, monthlyLimit: limit } : rest)
      : await createAiAgent(ws, { ...rest, monthlyLimit: owner ? limit : null });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <div className="overlay modal-overlay" onMouseDown={onClose}>
      <form
        className="modal dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <h2 className="modal-title">{editing ? `Edit ${editing.name}` : 'Add an AI teammate'}</h2>
          <p className="modal-desc">
            An AI teammate is a member of the workspace with its own name and lane. Give it work in
            a session or put it in a swarm; it runs on the machine of whoever does, on their
            provider key.
          </p>
          <button type="button" className="icon-btn modal-close" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          {!editing && (
            <label className="field-label">
              Workspace
              <select className="select" value={ws} onChange={(e) => setWs(e.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field-label">
            Name
            <input
              autoFocus
              className="input"
              placeholder="Bob"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label className="field-label">
            Model
            <input
              className="input mono"
              list="ai-models"
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
            />
            <datalist id="ai-models">
              {models.slice(0, 300).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </datalist>
          </label>
          <label className="field-label">
            Permissions
            <select
              className="select"
              value={form.mode}
              onChange={(e) => set({ mode: e.target.value as AiAgent['mode'] })}
            >
              {AI_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Monthly limit
            <input
              className="input mono"
              type="number"
              min={0.01}
              step="any"
              placeholder="no limit of its own"
              disabled={!owner}
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
            />
            <span className="small muted">
              USD a month for all its work: swarm tasks and tasks given to it directly. At the limit
              it stops, and the workspace's limit applies too.
              {editing ? ` $${editing.monthSpent.toFixed(4)} this month.` : ''}
              {owner ? '' : ' Only owners change it.'}
            </span>
          </label>
          <label className="field-label">
            What it does and how it works
            <textarea
              className="input"
              rows={4}
              placeholder="Writes tests first and keeps changes small. Asks before touching the public API."
              value={form.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
            />
          </label>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !form.name.trim() || !ws || !limitOk}
          >
            {busy ? 'Saving…' : editing ? 'Save' : 'Add AI teammate'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function PeoplePage() {
  const signedIn = useStore((s) => s.signedIn);
  const me = useStore((s) => s.user);
  const workspaces = useStore((s) => s.teamWorkspaces);
  const members = useStore((s) => s.members);
  const presence = useStore((s) => s.presence);
  const [filter, setFilter] = useState<string>('all');
  const aiByWorkspace = useStore((s) => s.aiAgents);
  const [aiDialog, setAiDialog] = useState<{ editing: AiAgent | null } | null>(null);

  useEffect(() => {
    if (signedIn) void loadAllMembers();
    if (signedIn) for (const w of workspaces) void loadAiAgents(w.id);
  }, [signedIn, workspaces.length]);
  const ai = (filter === 'all' ? workspaces.map((w) => w.id) : [filter]).flatMap(
    (id) => aiByWorkspace[id] ?? [],
  );

  const rows = useMemo(() => {
    const ids = filter === 'all' ? workspaces.map((w) => w.id) : [filter];
    const byUser = new Map<
      string,
      { member: (typeof members)[string]['members'][number]; in: string[]; online: boolean }
    >();
    for (const id of ids) {
      for (const m of (members[id]?.members ?? []).filter((x) => x.kind !== 'agent')) {
        const entry = byUser.get(m.userId) ?? { member: m, in: [], online: false };
        entry.in.push(id);
        entry.online ||= (presence[id] ?? []).some((p) => p.userId === m.userId);
        byUser.set(m.userId, entry);
      }
    }
    return [...byUser.values()].sort((a, b) =>
      a.member.userId === me?.id
        ? -1
        : b.member.userId === me?.id
          ? 1
          : a.member.name.localeCompare(b.member.name),
    );
  }, [filter, workspaces, members, presence, me]);

  const selected = workspaces.find((w) => w.id === filter) ?? null;
  const canManage = selected?.role === 'owner';
  // A workspace set to Solo takes no invites (an adaptive one does: that is how it becomes a
  // team); with "all" shown, only when every one is set to Solo.
  const soloHere = selected
    ? selected.mode === 'solo'
    : workspaces.length > 0 && workspaces.every((w) => w.mode === 'solo');
  const invites =
    filter === 'all'
      ? workspaces.flatMap((w) => members[w.id]?.invites ?? [])
      : (members[filter]?.invites ?? []);

  const onInvite = () => {
    if (!signedIn) {
      notify({
        kind: 'info',
        title: 'Sign in to invite',
        message:
          'Teammates join shared workspaces, which need an account. Sign in from Settings → Account.',
      });
      return;
    }
    setState({ inviteOpen: true });
  };

  return (
    <section className="page">
      <PageHeader title="People">
        {signedIn && (
          <button className="btn" onClick={() => setAiDialog({ editing: null })}>
            <Bot size={14} /> Add AI teammate
          </button>
        )}
        {soloHere ? (
          <span className="muted small" title="Owners switch it in Settings → Workspaces">
            Solo workspace · switch to Team or Adaptive to invite people
          </span>
        ) : (
          <button className="btn btn-primary" onClick={onInvite}>
            <Plus size={14} /> Invite
          </button>
        )}
      </PageHeader>
      <div className="page-sub">
        <label className="filter">
          <Layers size={13} />
          <select
            className="filter-select"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All workspaces</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {filter === 'all' && <span className="count">{workspaces.length} workspaces</span>}
          <ChevronDown size={12} />
        </label>
      </div>
      <div className="page-rule" />
      <div className="group-label">Members</div>
      {rows.length === 0 && <div>No members to show. Invite a teammate to a workspace.</div>}
      <div className="people">
        {rows.map(({ member, in: inWorkspaces, online }) => {
          const isMe = member.userId === me?.id;
          return (
            <div key={member.userId} className="person">
              <Avatar name={member.name} src={member.avatarUrl} size={30} online={isMe || online} />
              <div className="person-text">
                <div>
                  {member.name} {isMe && <span className="muted small">You</span>}
                </div>
                {member.githubLogin && <div className="mono small muted">{member.githubLogin}</div>}
              </div>
              <div className="person-meta">
                {filter === 'all' ? (
                  <span className="muted">
                    {inWorkspaces.length === workspaces.length
                      ? 'All workspaces'
                      : `${inWorkspaces.length} of ${workspaces.length} workspaces`}
                  </span>
                ) : canManage ? (
                  <select
                    className="select role-select"
                    value={member.role}
                    onChange={(e) => void changeRole(filter, member.userId, e.target.value as Role)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r[0]!.toUpperCase() + r.slice(1)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="muted">
                    {member.role[0]!.toUpperCase() + member.role.slice(1)}
                  </span>
                )}
                {filter !== 'all' && (canManage || isMe) && (
                  <button
                    className="icon-btn"
                    title={isMe ? 'Leave workspace' : 'Remove'}
                    onClick={() => void removeMember(filter, member)}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {signedIn && (
        <>
          <div className="group-label">AI teammates</div>
          {ai.length === 0 && (
            <div className="muted">
              No AI teammates yet. Add one to give it tasks in sessions or to run a swarm.
            </div>
          )}
          <div className="people">
            {ai.map((a) => (
              <div key={a.id} className="person">
                <span className="ai-avatar" title="AI teammate">
                  <Bot size={15} />
                </span>
                <div className="person-text">
                  <div>
                    {a.name} <span className="ai-badge">AI</span>
                  </div>
                  <div className="mono small muted">
                    {a.model} · {a.mode} · ${a.monthSpent.toFixed(4)} this month
                    {a.monthlyLimit !== null ? ` of $${a.monthlyLimit.toFixed(2)}` : ''}
                  </div>
                  {a.instructions && <div className="small muted ai-about">{a.instructions}</div>}
                </div>
                <div className="person-meta">
                  <span className="muted small">
                    {filter === 'all'
                      ? (workspaces.find((w) => w.id === a.workspaceId)?.name ?? '')
                      : a.createdByName
                        ? `Added by ${a.createdByName}`
                        : ''}
                  </span>
                  <button
                    className="icon-btn"
                    title="Edit"
                    onClick={() => setAiDialog({ editing: a })}
                  >
                    <Pencil size={13} />
                  </button>
                  <button className="icon-btn" title="Retire" onClick={() => void retireAiAgent(a)}>
                    <X size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {aiDialog && (
        <AiTeammateDialog
          workspaceId={filter === 'all' ? null : filter}
          editing={aiDialog.editing}
          onClose={() => setAiDialog(null)}
        />
      )}
      {invites.length > 0 && (
        <>
          <div className="group-label">Pending invites</div>
          <div className="people">
            {invites.map((inv) => (
              <div key={inv.id} className="person">
                <Avatar name={inv.githubLogin ?? inv.email ?? '?'} size={30} />
                <div className="person-text">
                  <div className="mono">{inv.githubLogin ? `@${inv.githubLogin}` : inv.email}</div>
                  <div className="small muted">
                    Invited as {inv.role}
                    {filter === 'all'
                      ? ` to ${workspaces.find((w) => w.id === inv.workspaceId)?.name ?? ''}`
                      : ''}
                  </div>
                </div>
                <div className="person-meta">
                  <button
                    className="btn btn-sm"
                    onClick={() => void revokeInvite(inv.workspaceId, inv.id)}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <InviteDialog defaultWorkspace={filter === 'all' ? null : filter} />
    </section>
  );
}
