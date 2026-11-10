import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Building2,
  FlaskConical,
  Plus,
  RefreshCw,
  Code,
  FolderGit2,
  Bot,
  Boxes,
  CreditCard,
  KeyRound,
  Keyboard,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_KEYBINDINGS, formatAccelerator } from '../../../shared/keybindings';
import { accountOf, limitLabel, limitNow, type LimitAccount } from '../../../shared/limits';
import type { Settings } from '../../../shared/settings';
import { COMMANDS, currentKeybindings } from '../commands';
import { doneCount, STEPS } from '../services/onboarding';
import { installUpdate, updateSettings } from '../services/settings';
import {
  auditLabel,
  BILLING_CONSENT,
  can,
  MAX_RETENTION_DAYS,
  type AgentSpendStats,
  type ApiKey,
  type ApiKeyScope,
  type AuditEntry,
  type Machine,
  type Webhook,
  type WebhookDelivery,
  type WorkspaceEventType,
  WORKSPACE_EVENTS,
  type BillingState,
  type OrgSettings,
  type UsageSummary,
  type Workspace,
  KOVAN_AVATAR,
} from '@kovan/shared';
import type {
  BackgroundStatus,
  ExternalAgentInfo,
  McpCheck,
  McpListing,
  McpServerInfo,
  McpServerInput,
  PluginContents,
  PluginInfo,
  PluginListing,
  PluginPreview,
  PluginSourceInput,
  PluginUpdate,
  SkillInfo,
  SkillListing,
  UpdateState,
} from '../../../shared/api';
import { addCard, loadBilling, retryInvoice, saveAllowance } from '../services/billing';
import { api } from '../services/api';
import { joinCommand, splitCommand } from '../commandLine';
import { connectAgents } from '../services/flow';
import { newTerminal } from '../services/terminal';
import {
  addAgentAccount,
  loadExternalAgents,
  loadModels,
  removeAgentAccount,
  loadProviders,
  saveOpenRouterKey,
} from '../services/agent';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  defaultOption,
  HARNESS_NAMES,
  JEV_MODEL_ID,
  optionLabel,
  parseCustomModelId,
  sameOption,
  type AgentAccount,
  type AgentOption,
  type CustomProviderInfo,
  type CustomProviderInput,
  type Harness,
  type ExternalHarness,
} from '../../../shared/agent';
import {
  createApiKey,
  integrationsOf,
  createWebhook,
  deleteWebhook,
  loadApiKeys,
  loadDeliveries,
  loadGitAccess,
  loadMachines,
  loadWebhooks,
  pingWebhook,
  removeMachine,
  setGitAccess,
  revokeApiKey,
  sendVerification,
  setRecommendedPlugins,
  createOrg,
  currentOrg,
  renameOrg,
  setWorkspaceGitSync,
  setWorkspaceMode,
  signIn,
  signOut,
  updateAccount,
  updateWorkspace,
  workspaceMode,
} from '../services/team';
import { MODES } from './AgentPanel';
import { forgetRecent } from '../services/workspace';
import { loadAgentSpend, setAgentMonthlyLimit } from '../services/swarm';
import { GithubMark } from './Logo';
import { ModelsPage } from './ModelsPage';
import { ArenaView } from './ArenaView';
import { DeleteAccountDialog } from './DeleteAccount';
import {
  activeTeamWorkspace,
  reportError,
  setState,
  showView,
  useStore,
  type SettingsSection,
} from '../store';
import { Avatar, OnOff, ProgressRing, Segmented, WORKSPACE_COLORS, WorkspaceIcon } from './ui';

const SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'Personal' | 'Kovan';
}[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, group: 'Personal' },
  { id: 'editor', label: 'Editor', icon: Code, group: 'Personal' },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal, group: 'Personal' },
  { id: 'keyboard', label: 'Keyboard', icon: Keyboard, group: 'Personal' },
  { id: 'providers', label: 'Providers & spend', icon: KeyRound, group: 'Personal' },
  { id: 'models', label: 'Models', icon: Boxes, group: 'Personal' },
  { id: 'agents', label: 'Agents', icon: Bot, group: 'Personal' },
  { id: 'arena', label: 'Arena', icon: FlaskConical, group: 'Personal' },
  { id: 'account', label: 'Account', icon: UserRound, group: 'Kovan' },
  { id: 'billing', label: 'Billing & usage', icon: CreditCard, group: 'Kovan' },
  { id: 'organization', label: 'Organization', icon: Building2, group: 'Kovan' },
  { id: 'workspaces', label: 'Workspaces', icon: FolderGit2, group: 'Kovan' },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck, group: 'Kovan' },
];

/** One settings row: title and description on the left, the control on the right. */
function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  const query = useStore((s) => s.settingsQuery);
  if (query && !`${title} ${desc ?? ''}`.toLowerCase().includes(query.toLowerCase())) return null;
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      className="input input-narrow mono"
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isInteger(v) && v >= min && v <= max) onChange(v);
      }}
    />
  );
}

function General({ s }: { s: Settings }) {
  return (
    <Group title="Appearance">
      <Row title="Theme" desc="Dark is the default. System follows your OS.">
        <Segmented
          value={s.theme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ]}
          onChange={(theme) => void updateSettings({ theme })}
        />
      </Row>
    </Group>
  );
}

const UPDATE_TEXT: Record<UpdateState['status'], (u: UpdateState) => string> = {
  unsupported: (u) => u.message ?? 'This build does not update itself.',
  idle: () => 'Not checked yet.',
  checking: () => 'Checking for updates…',
  current: () => 'You have the latest version.',
  downloading: (u) => `Downloading ${u.version ?? 'the update'}… ${u.percent ?? 0}%`,
  ready: (u) => `Version ${u.version} is downloaded and ready to install.`,
  error: (u) => u.message ?? 'The update check failed.',
};

function Updates({ s }: { s: Settings }) {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => {
    void api.invoke('update:state').then(setU);
    return api.on('update:state', setU);
  }, []);
  if (!u) return null;
  const busy = u.status === 'checking' || u.status === 'downloading';
  return (
    <Group title="Updates">
      <Row title={`Kovan ${u.currentVersion}`} desc={UPDATE_TEXT[u.status](u)}>
        {u.status === 'ready' ? (
          <button className="btn btn-primary" onClick={installUpdate}>
            <RefreshCw size={13} /> Restart to update
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy || u.status === 'unsupported'}
            onClick={() => void api.invoke('update:check').then(setU)}
          >
            Check for updates
          </button>
        )}
      </Row>
      <Row
        title="Update automatically"
        desc="Look for new versions in the background and download them. Installing still waits for you."
      >
        <OnOff
          value={s.autoUpdate && u.status !== 'unsupported'}
          onChange={(autoUpdate) => void updateSettings({ autoUpdate })}
        />
      </Row>
    </Group>
  );
}

const request = <T,>(method: 'GET' | 'PATCH', path: string, body?: unknown) =>
  (body === undefined
    ? api.invoke('brain:request', method, path)
    : api.invoke('brain:request', method, path, body)) as Promise<T>;

function auditLine(e: AuditEntry): string {
  const meta = e.meta ?? {};
  const change =
    meta['from'] !== undefined && meta['to'] !== undefined
      ? ` (${String(meta['from'])} → ${String(meta['to'])})`
      : meta['role'] !== undefined
        ? ` (${String(meta['role'])})`
        : '';
  return `${auditLabel(e.action)}${e.target ? ` ${e.target}` : ''}${change}`;
}

/** Another organization, for another team: the person owns it and it becomes the current one. */
function NewOrganization() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Group title="New organization">
      <Row
        title="Create an organization"
        desc="For another team or company: its own workspaces, members, billing and settings. You own it; workspaces you add while it is the current one go there."
      >
        <input
          className="input"
          placeholder="Name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn btn-sm btn-primary"
          disabled={!name.trim() || busy}
          onClick={() => {
            setBusy(true);
            void createOrg(name.trim()).then((org) => {
              setBusy(false);
              if (org) setName('');
            });
          }}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </Row>
    </Group>
  );
}

function Organization() {
  const orgs = useStore((s) => s.orgs);
  const signedIn = useStore((s) => s.signedIn);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [days, setDays] = useState('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [name, setName] = useState('');
  const current = useStore(currentOrg);
  const id = orgId ?? current?.id ?? null;

  useEffect(() => {
    setOrg(null);
    setEntries(null);
    if (!id) return;
    void request<{ org: OrgSettings }>('GET', `/api/orgs/${id}`)
      .then(({ org: loaded }) => {
        setOrg(loaded);
        setName(loaded.name);
        setDays(String(loaded.transcriptRetentionDays));
        if (loaded.role !== 'owner') return;
        return request<{ entries: AuditEntry[] }>('GET', `/api/orgs/${id}/audit?limit=50`).then(
          (r) => {
            setEntries(r.entries);
            setMore(r.entries.length === 50);
          },
        );
      })
      .catch(reportError);
  }, [id]);

  if (!signedIn) return <p className="setting-desc">Sign in to see your organization.</p>;
  if (!id) return <NewOrganization />;
  if (!org) return <p className="setting-desc">Loading…</p>;
  const owner = org.role === 'owner';
  const wanted = Number(days);
  const valid = Number.isInteger(wanted) && wanted >= 1 && wanted <= MAX_RETENTION_DAYS;

  const save = () =>
    void request<{ org: OrgSettings }>('PATCH', `/api/orgs/${org.id}`, {
      transcriptRetentionDays: wanted,
    })
      .then(async (r) => {
        setOrg(r.org);
        const log = await request<{ entries: AuditEntry[] }>(
          'GET',
          `/api/orgs/${org.id}/audit?limit=50`,
        );
        setEntries(log.entries);
      })
      .catch(reportError);

  const loadMore = () => {
    const last = entries?.at(-1);
    if (!last) return;
    void request<{ entries: AuditEntry[] }>(
      'GET',
      `/api/orgs/${org.id}/audit?limit=50&before=${encodeURIComponent(last.createdAt)}`,
    )
      .then((r) => {
        setEntries([...(entries ?? []), ...r.entries]);
        setMore(r.entries.length === 50);
      })
      .catch(reportError);
  };

  return (
    <>
      <Group title="Organization">
        {orgs.length > 1 && (
          <Row
            title="Organization"
            desc="Settings below apply to this one. The sidebar's switcher picks whose workspaces and sessions show."
          >
            <select className="select" value={org.id} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row
          title="Name"
          desc={owner ? 'How it shows for everyone in it.' : 'Only an owner can rename it.'}
        >
          <input
            className="input"
            value={name}
            maxLength={80}
            disabled={!owner}
            onChange={(e) => setName(e.target.value)}
          />
          {owner && (
            <button
              className="btn btn-sm"
              disabled={!name.trim() || name.trim() === org.name}
              onClick={() =>
                void renameOrg(org.id, name.trim()).then(
                  (ok) => ok && setOrg({ ...org, name: name.trim() }),
                )
              }
            >
              Save
            </button>
          )}
        </Row>
        <Row
          title="Keep transcripts for"
          desc={`Session transcripts are redacted for secrets, encrypted, and deleted for good after this many days. ${owner ? 'A shorter time deletes older transcripts right away.' : 'Only an owner can change this.'}`}
        >
          <div className="retention">
            <input
              className="input input-narrow mono"
              type="number"
              min={1}
              max={MAX_RETENTION_DAYS}
              value={days}
              disabled={!owner}
              onChange={(e) => setDays(e.target.value)}
            />
            <span className="muted small">days</span>
            {owner && (
              <button
                className="btn btn-sm btn-primary"
                disabled={!valid || wanted === org.transcriptRetentionDays}
                onClick={save}
              >
                Save
              </button>
            )}
          </div>
        </Row>
      </Group>
      <NewOrganization />
      {owner && (
        <Group title="Integrations: every workspace">
          <p className="setting-desc">
            One API key, one webhook and one event stream for all of {org.name}&apos;s workspaces,
            those made later too; machines registered here serve every workspace whose repository
            they hold.
          </p>
          <h3 className="settings-subhead">API keys</h3>
          <ApiKeyList key={`org-keys-${org.id}`} base={integrationsOf({ orgId: org.id })} />
          <h3 className="settings-subhead">Machines</h3>
          <MachineList key={`org-machines-${org.id}`} base={integrationsOf({ orgId: org.id })} />
          <h3 className="settings-subhead">Webhooks</h3>
          <WebhookList key={`org-hooks-${org.id}`} base={integrationsOf({ orgId: org.id })} />
        </Group>
      )}
      {owner && (
        <Group title="Audit log">
          <p className="setting-desc">
            Who changed members, roles, invites and settings in {org.name}. Kept for 400 days.
          </p>
          {entries?.length === 0 && <p className="setting-desc">Nothing yet.</p>}
          {entries?.map((e) => (
            <div key={e.id} className="audit-line">
              <span className="mono muted audit-time">
                {new Date(e.createdAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
              <span className="audit-text">
                <strong>{e.actorName}</strong> {auditLine(e)}
              </span>
            </div>
          ))}
          {more && (
            <button className="btn btn-sm" onClick={loadMore}>
              Show older
            </button>
          )}
        </Group>
      )}
    </>
  );
}

function Editor({ s }: { s: Settings }) {
  return (
    <Group title="Editor">
      <Row title="Font family" desc="Any installed font; Lilex ships with Kovan.">
        <input
          className="input"
          defaultValue={s.editorFontFamily}
          onBlur={(e) =>
            e.target.value.trim() && void updateSettings({ editorFontFamily: e.target.value })
          }
        />
      </Row>
      <Row title="Font size">
        <NumberInput
          value={s.editorFontSize}
          min={8}
          max={40}
          onChange={(editorFontSize) => void updateSettings({ editorFontSize })}
        />
      </Row>
      <Row title="Tab size" desc="Spaces per indentation level.">
        <NumberInput
          value={s.editorTabSize}
          min={1}
          max={8}
          onChange={(editorTabSize) => void updateSettings({ editorTabSize })}
        />
      </Row>
      <Row title="Word wrap" desc="Wrap long lines to the editor width.">
        <OnOff
          value={s.editorWordWrap}
          onChange={(editorWordWrap) => void updateSettings({ editorWordWrap })}
        />
      </Row>
      <Row title="Minimap" desc="A zoomed-out view of the file beside the scrollbar.">
        <OnOff
          value={s.editorMinimap}
          onChange={(editorMinimap) => void updateSettings({ editorMinimap })}
        />
      </Row>
    </Group>
  );
}

function Terminal({ s }: { s: Settings }) {
  return (
    <Group title="Terminal">
      <Row title="Font size">
        <NumberInput
          value={s.terminalFontSize}
          min={8}
          max={40}
          onChange={(terminalFontSize) => void updateSettings({ terminalFontSize })}
        />
      </Row>
    </Group>
  );
}

/** Turns a key press into an accelerator string, using "Mod" for the platform's primary modifier. */
function acceleratorFromEvent(e: React.KeyboardEvent, isMac: boolean): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (!isMac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) return null; // A bare key would swallow typing.
  const key = e.code.startsWith('Key')
    ? e.code.slice(3)
    : e.code.startsWith('Digit')
      ? e.code.slice(5)
      : e.key;
  return [...parts, key === ' ' ? 'Space' : key].join('+');
}

function KeybindingRow({ id, title }: { id: string; title: string }) {
  const isMac = useStore((s) => s.isMac);
  const overrides = useStore((s) => s.settings.keybindings);
  const query = useStore((s) => s.settingsQuery);
  const [recording, setRecording] = useState(false);
  const accelerator = currentKeybindings()[id];
  const isDefault = !(id in overrides);
  if (query && !title.toLowerCase().includes(query.toLowerCase())) return null;

  const set = (value: string | null) => {
    const next = { ...overrides };
    if (value === null || value === DEFAULT_KEYBINDINGS[id]) delete next[id];
    else next[id] = value;
    void updateSettings({ keybindings: next });
  };

  return (
    <tr>
      <td>{title}</td>
      <td style={{ textAlign: 'right' }}>
        <button
          className={`keybinding ${recording ? 'recording' : ''}`}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            if (!recording) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') return setRecording(false);
            const value = acceleratorFromEvent(e, isMac);
            if (value) {
              set(value);
              setRecording(false);
            }
          }}
        >
          {recording ? 'Press keys…' : accelerator ? formatAccelerator(accelerator, isMac) : '—'}
        </button>
      </td>
      <td className="keybinding-actions">
        {!isDefault && (
          <button className="link-btn" onClick={() => set(null)}>
            Reset
          </button>
        )}
        {accelerator && (
          <button className="link-btn" onClick={() => set('')}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function KeyboardSection({ s }: { s: Settings }) {
  return (
    <Group title="Keyboard shortcuts">
      <p className="setting-desc" style={{ margin: '0 0 8px' }}>
        Click a shortcut, then press the new key combination. Escape cancels.
      </p>
      <table className="keybindings">
        <tbody>
          {COMMANDS.filter((c) => c.id in DEFAULT_KEYBINDINGS || c.id in s.keybindings).map((c) => (
            <KeybindingRow key={c.id} id={c.id} title={c.title} />
          ))}
        </tbody>
      </table>
    </Group>
  );
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/**
 * Kovan managed usage: provider cost × 1.05, billed daily off-session to a saved card, up to an
 * allowance the person chooses (or explicitly unlimited). Nothing is charged before they choose.
 */
function Billing() {
  const signedIn = useStore((st) => st.signedIn);
  const [b, setB] = useState<BillingState | null>(null);
  const [amount, setAmount] = useState('10');
  const [uncapped, setUncapped] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const reload = () =>
    void loadBilling().then((x) => {
      setB(x);
      if (x?.allowance !== null && x?.allowance !== undefined) setAmount(String(x.allowance));
      if (x) setUncapped(x.uncapped);
    });
  useEffect(() => {
    if (!signedIn) return;
    reload();
    // Back from Stripe's page in the browser: show the saved card.
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [signedIn]);

  if (!signedIn)
    return (
      <Group title="Billing & usage">
        <Row title="Managed usage" desc="Sign in to use Kovan managed usage and see your invoices.">
          <span />
        </Row>
      </Group>
    );
  if (!b)
    return (
      <Group title="Billing & usage">
        <Row title="Managed usage" desc="Loading…">
          <span />
        </Row>
      </Group>
    );
  const value = Number(amount);
  const valid = uncapped || (Number.isFinite(value) && value >= 0.01);
  return (
    <>
      <Group title="Managed usage">
        <p className="setting-desc billing-intro">
          Optional: use models without your own provider key. You pay the provider's token cost ×
          1.05, applied once ($1.00 of provider usage costs $1.05, before any separately shown tax).
          Whoever starts a run pays for it, including its subagents, swarm agents and routing. No
          subscription or seat fee.
        </p>
        {!b.available && (
          <div className="billing-alert">This Kovan server doesn't offer managed usage.</div>
        )}
        {b.available && (
          <div className={`billing-alert ${b.ready ? 'ok' : ''}`}>
            {b.ready ? 'Managed usage is ready.' : b.reason}
          </div>
        )}
        <Row
          title="Allowance"
          desc="Shared across all your workspaces and runs, markup included. Changing it starts counting again; unpaid usage is still charged."
        >
          <div className="billing-allowance">
            <span className="mono">$</span>
            <input
              className="input mono"
              type="number"
              min={0.01}
              step="any"
              disabled={uncapped}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <label className="swarm-check">
              <input
                type="checkbox"
                checked={uncapped}
                onChange={(e) => setUncapped(e.target.checked)}
              />
              Unlimited
            </label>
          </div>
        </Row>
        <label className="billing-consent">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{BILLING_CONSENT}</span>
        </label>
        <div className="billing-actions">
          <button
            className="btn btn-primary"
            disabled={!agree || !valid || busy}
            onClick={() => {
              setBusy(true);
              void saveAllowance(uncapped ? null : value).then((x) => {
                setBusy(false);
                if (x) {
                  setB(x);
                  setAgree(false);
                }
              });
            }}
          >
            {b.consentAt ? 'Update allowance' : 'Accept and set allowance'}
          </button>
          {b.consentAt && (
            <span className="muted small">
              Accepted {new Date(b.consentAt).toLocaleDateString()} ·{' '}
              {b.uncapped ? 'unlimited' : `${usd(b.spent)} of ${usd(b.allowance ?? 0)} used`}
            </span>
          )}
        </div>
        <Row
          title="Payment method"
          desc={
            b.card
              ? `Charged once a day for the day's usage; balances under ${usd(b.minimum)} carry forward.`
              : 'Saved with Stripe; Kovan never sees your card number.'
          }
        >
          <div className="billing-card">
            {b.card && (
              <span className="mono">
                {b.card.brand} •••• {b.card.last4}
              </span>
            )}
            <button className="btn" disabled={!b.available} onClick={() => void addCard()}>
              <CreditCard size={13} /> {b.card ? 'Change card' : 'Add a card'}
            </button>
          </div>
        </Row>
        <Row title="Not charged yet" desc="Usage since the last charge, markup included.">
          <span className="mono">{usd(b.unbilled)}</span>
        </Row>
      </Group>
      <Group title="Invoices">
        {b.invoices.length === 0 && <p className="setting-desc">No charges yet.</p>}
        {b.invoices.map((inv) => (
          <div key={inv.id} className={`invoice ${inv.status}`}>
            <span className="mono">{new Date(inv.createdAt).toLocaleDateString()}</span>
            <span className="mono">{usd(inv.amount)}</span>
            <span className={`invoice-status ${inv.status}`}>{inv.status}</span>
            <span className="muted small invoice-note">
              {inv.status === 'failed' ? inv.failureReason : `usage ${usd(inv.usage)}`}
            </span>
            <span className="spacer" />
            {inv.receiptUrl && (
              <a className="link-btn" href={inv.receiptUrl} target="_blank" rel="noreferrer">
                Receipt
              </a>
            )}
            {inv.status === 'failed' && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void retryInvoice(inv.id).then((x) => x && setB(x))}
              >
                Retry payment
              </button>
            )}
          </div>
        ))}
      </Group>
      <Group title="Managed usage, last 30 days">
        {(['byRun', 'byModel', 'byWorkspace'] as const).map((k) => (
          <div key={k} className="billing-usage">
            <h3>{k === 'byRun' ? 'By run' : k === 'byModel' ? 'By model' : 'By workspace'}</h3>
            {b.usage[k].length === 0 && <p className="setting-desc">Nothing yet.</p>}
            {b.usage[k].slice(0, 8).map((u) => (
              <div key={u.key} className="billing-line">
                <span className="mono billing-label" title={u.label}>
                  {u.label}
                </span>
                <span className="muted small">{u.calls} calls</span>
                <span className="mono">{usd(u.cost)}</span>
              </div>
            ))}
          </div>
        ))}
      </Group>
    </>
  );
}

function Providers({ s }: { s: Settings }) {
  const providers = useStore((st) => st.providers);
  const models = useStore((st) => st.models);
  const conversations = useStore((st) => st.conversations);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const status = providers?.openrouter;
  const model = models.find((m) => m.id === s.agentModel);
  const spent = conversations.reduce((sum, c) => sum + c.cost, 0);

  return (
    <>
      <Group title="Who pays for Kovan's agent">
        <Row
          title="Billing"
          desc={
            s.modelBilling === 'own'
              ? 'Your OpenRouter key only.'
              : s.modelBilling === 'managed'
                ? 'Kovan managed usage: provider cost × 1.05, billed to you daily.'
                : 'Your OpenRouter key when you have one; otherwise Kovan managed usage.'
          }
        >
          <Segmented
            value={s.modelBilling}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'own', label: 'My key' },
              { value: 'managed', label: 'Managed' },
            ]}
            onChange={(v) => void updateSettings({ modelBilling: v }).then(() => loadProviders())}
          />
        </Row>
        {s.modelBilling !== 'own' && (
          <Row title="Managed usage" desc="Allowance, card, invoices and usage.">
            <button className="btn" onClick={() => setState({ settingsSection: 'billing' })}>
              Billing & usage
            </button>
          </Row>
        )}
      </Group>
      <Group title="OpenRouter">
        <Row
          title="API key"
          desc={
            status?.configured
              ? status.source === 'environment'
                ? 'Using OPENROUTER_API_KEY from the environment (development).'
                : 'Stored in the system keychain. Models are billed by OpenRouter to this key.'
              : 'One key gives the agent access to every model. Get one at openrouter.ai/keys.'
          }
        >
          <form
            style={{ display: 'flex', gap: 8 }}
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
              placeholder={status?.source === 'keychain' ? '•••••••• (saved)' : 'sk-or-v1-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="btn" disabled={busy || key.trim().length < 10}>
              {busy ? 'Checking…' : 'Save'}
            </button>
            {status?.source === 'keychain' && (
              <button type="button" className="btn" onClick={() => void saveOpenRouterKey(null)}>
                Remove
              </button>
            )}
          </form>
        </Row>
        <Row title="Model catalog" desc={`${models.length} models with tool use. Refreshed daily.`}>
          <button className="btn btn-sm" onClick={() => void loadModels(true)}>
            Refresh now
          </button>
        </Row>
      </Group>
      <CustomProvidersGroup />
      <Group title="Agent defaults">
        <Row title="Model" desc="New conversations start with the last model you picked.">
          <span className="mono small">{model?.name ?? s.agentModel}</span>
        </Row>
        <Row title="Permission mode" desc={MODES.find((m) => m.id === s.agentMode)?.hint ?? ''}>
          <Segmented
            value={s.agentMode}
            options={MODES.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(agentMode) => void updateSettings({ agentMode })}
          />
        </Row>
      </Group>
      <Group title="Spend">
        <Row
          title="This workspace"
          desc="Provider cost of the agent conversations in the open workspace, as OpenRouter reported it."
        >
          <span className="mono">${spent.toFixed(spent < 0.01 ? 6 : 4)}</span>
        </Row>
        <AccountUsage />
      </Group>
    </>
  );
}

/** The account's usage across machines and workspaces, from the Brain. */
function CustomProvidersGroup() {
  const [list, setList] = useState<CustomProviderInfo[]>([]);
  const [editing, setEditing] = useState<CustomProviderInput | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void api.invoke('providers:custom:list').then(setList, reportError);
  }, []);

  const run = async (label: string, action: () => Promise<CustomProviderInfo[]>) => {
    setBusy(label);
    try {
      setList(await action());
      setEditing(null);
      await Promise.all([loadModels(false), loadProviders()]);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group title="Custom providers">
      <p className="setting-desc" style={{ margin: '0 0 8px' }}>
        Any OpenAI-compatible endpoint: Ollama, LM Studio, vLLM, a company gateway. Its models join
        the model picker as <span className="mono">@name/model</span>, run with Kovan&apos;s agent
        and are billed (if at all) by that provider, not through Kovan.
      </p>
      {list.map((p) => (
        <div key={p.id} className="setting">
          <div className="setting-text">
            <div className="setting-title">
              {p.name} <span className="mono small muted">@{p.id}</span>
            </div>
            <div className="setting-desc">
              <span className="mono">{p.baseUrl}</span> · {p.models.length} models
              {p.hasKey ? ' · key in keychain' : ' · no key'}
            </div>
          </div>
          <div className="setting-control" style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run(`refresh:${p.id}`, () => api.invoke('providers:custom:refresh', p.id))
              }
            >
              {busy === `refresh:${p.id}` ? 'Checking…' : 'Refresh models'}
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => setEditing({ id: p.id, name: p.name, baseUrl: p.baseUrl })}
            >
              Edit
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() =>
                void run(`remove:${p.id}`, () => api.invoke('providers:custom:remove', p.id))
              }
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      {editing ? (
        <form
          className="custom-provider-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run('save', () => api.invoke('providers:custom:save', editing));
          }}
        >
          <input
            className="input"
            placeholder="Name (e.g. Ollama)"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          <input
            className="input mono"
            placeholder="http://localhost:11434/v1"
            value={editing.baseUrl}
            onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
          />
          <input
            className="input mono"
            type="password"
            placeholder={editing.id ? 'API key (leave empty to keep)' : 'API key (optional)'}
            value={editing.apiKey ?? ''}
            onChange={(e) => {
              const next: CustomProviderInput = { ...editing };
              if (e.target.value) next.apiKey = e.target.value;
              else delete next.apiKey;
              setEditing(next);
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn"
              disabled={busy !== null || !editing.name.trim() || !editing.baseUrl.trim()}
            >
              {busy === 'save' ? 'Listing models…' : editing.id ? 'Save' : 'Add provider'}
            </button>
            {editing.id && list.find((p) => p.id === editing.id)?.hasKey && (
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  void run('save', () =>
                    api.invoke('providers:custom:save', { ...editing, apiKey: null }),
                  )
                }
              >
                Remove key
              </button>
            )}
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <Row title="Add a provider" desc="Kovan checks the address by listing its models.">
          <button className="btn btn-sm" onClick={() => setEditing({ name: '', baseUrl: '' })}>
            Add provider
          </button>
        </Row>
      )}
    </Group>
  );
}

function AccountUsage() {
  const signedIn = useStore((st) => st.signedIn);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    api.invoke('brain:request', 'GET', '/api/usage?days=30').then(
      (s) => setSummary(s as UsageSummary),
      () => setFailed(true),
    );
  }, [signedIn]);
  if (!signedIn) {
    return (
      <Row
        title="Your account"
        desc="Sign in to see usage across all your machines and workspaces."
      >
        <span />
      </Row>
    );
  }
  if (!summary) {
    return (
      <Row
        title="Your account, last 30 days"
        desc={failed ? "Can't reach the Kovan server right now." : 'Loading…'}
      >
        <span />
      </Row>
    );
  }
  return (
    <>
      <Row
        title="Your account, last 30 days"
        desc={`${summary.calls} model calls across all workspaces, reported by your apps.`}
      >
        <span className="mono">${summary.total.toFixed(summary.total < 0.01 ? 6 : 4)}</span>
      </Row>
      {summary.byModel.length > 0 && (
        <table className="receipt mono usage-table">
          <tbody>
            {summary.byModel.slice(0, 8).map((m) => (
              <tr key={m.model}>
                <td>{m.model}</td>
                <td>{m.calls} calls</td>
                <td>${m.cost.toFixed(m.cost < 0.01 ? 6 : 4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * Connects the agent CLIs in the open repository to Kovan: hooks for
 * Claude Code, the MCP server, and coordination instructions, all kept local (never committed).
 */
function ConnectRepoRow() {
  const workspace = useStore((s) => s.workspace);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (workspace?.isRepo)
      void api.invoke('repo:agentsConnected').then(setConnected, () => setConnected(null));
  }, [workspace?.root, workspace?.isRepo]);
  if (!workspace?.isRepo) return null;
  return (
    <Row
      title={`Connect ${workspace.name} to agents`}
      desc="Hooks, the MCP server and coordination instructions in this repository, so a claude or codex you start yourself sees the team, locks and Brain notes. The files stay local: they're never committed, and tracked files are left alone."
    >
      <button
        className="btn btn-sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void connectAgents().finally(() => {
            setBusy(false);
            void api.invoke('repo:agentsConnected').then(setConnected);
          });
        }}
      >
        {busy ? 'Connecting…' : connected ? 'Connected · update' : 'Connect'}
      </button>
    </Row>
  );
}

/** "Limit reached · opens 19:00" or "62% of 5-hour limit used", when the agent has said. */
function LimitLine({ account }: { account: LimitAccount }) {
  const limit = useStore((st) => st.agentLimits.find((l) => l.account === account));
  const label = limitLabel(limit, Date.now());
  if (!limit || !label) return null;
  const status = limitNow(limit, Date.now()).status;
  return <div className={`setting-desc limit-${status}`}>{label}</div>;
}

/** "Ready", or "Out of usage" while the agent's account limit is reached. */
function AgentState({ agent }: { agent: ExternalAgentInfo }) {
  const limit = useStore((st) => st.agentLimits.find((l) => l.account === agent.id));
  const out = agent.supported && limit && limitNow(limit, Date.now()).status === 'full';
  return (
    <span
      className={`agent-state ${out ? 'planned' : agent.supported ? 'ok' : agent.path ? 'planned' : ''}`}
    >
      {out
        ? 'Out of usage'
        : agent.supported
          ? 'Ready'
          : agent.path
            ? 'Terminal only'
            : 'Not installed'}
    </span>
  );
}

/** Repositories where agents create GitHub issues without the card. */
function IssuesGroup() {
  const repos = useStore((st) => st.settings.issueNoAsk);
  return (
    <Group title="GitHub issues">
      <p className="setting-desc" style={{ margin: '0 0 8px' }}>
        Agents can draft a GitHub issue for something worth tracking. You see it first and can edit
        it, pick the repository or turn it into a comment. It goes to GitHub as you, with the
        credentials git already uses; only repositories you have open as workspaces can be chosen.
      </p>
      {repos.length === 0 ? (
        <Row
          title="Always ask"
          desc="Tick “Don't ask again” on an issue card to let agents file in that repository on their own."
        >
          <span className="agent-state ok">On</span>
        </Row>
      ) : (
        repos.map((repo) => (
          <Row key={repo} title={repo} desc="Agents create issues here without asking.">
            <button
              className="btn btn-sm"
              onClick={() => void updateSettings({ issueNoAsk: repos.filter((r) => r !== repo) })}
            >
              Ask again
            </button>
          </Row>
        ))
      )}
    </Group>
  );
}

const SKILL_SOURCES: Record<SkillInfo['source'], string> = {
  repo: 'This repository',
  'repo-claude': 'This repository (Claude Code)',
  user: 'Yours',
  plugin: 'Plugin',
  'claude-code': 'Your Claude Code',
};

/** The skills Kovan's agents see here, where each comes from, and switches for them. */
function SkillsGroup() {
  const s = useStore((st) => st.settings);
  const [listing, setListing] = useState<SkillListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    void api
      .invoke('skills:list')
      .then((l) => {
        setListing(l);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  // Settings change what is listed (switched off, Claude Code's on or off).
  useEffect(load, [s.skillsOff, s.claudeSkills]);
  const toggle = (name: string, on: boolean) =>
    void updateSettings({
      skillsOff: on ? s.skillsOff.filter((n) => n !== name) : [...s.skillsOff, name],
    });
  return (
    <Group title="Skills">
      <p className="setting-desc" style={{ margin: '0 0 8px' }}>
        A skill is a folder with a <span className="mono">SKILL.md</span>: instructions for a kind
        of task, in Claude Code&apos;s format. Kovan&apos;s agent sees each skill&apos;s name and
        description, loads the rest when a task matches, and you can call one directly with{' '}
        <span className="mono">/name</span>. Skills don&apos;t grant anything: what they ask for
        still goes through the lane&apos;s mode. A repository&apos;s{' '}
        <span className="mono">.kovan/skills</span> and <span className="mono">.claude/skills</span>{' '}
        come first, then yours.
      </p>
      {error && <p className="setting-desc danger-text">{error}</p>}
      {listing?.skills.length === 0 && (
        <Row
          title="No skills yet"
          desc={
            listing.root
              ? 'Add one to this repository or to your skills folder.'
              : 'Open a workspace to see its skills too, or add your own.'
          }
        >
          <span />
        </Row>
      )}
      {listing?.skills.map((skill) => (
        <Row
          key={skill.name}
          title={`/${skill.name}`}
          desc={`${skill.description} · ${SKILL_SOURCES[skill.source]}${skill.plugin ? ` ${skill.plugin}` : ''}: ${skill.path}`}
        >
          <OnOff value={skill.enabled} onChange={(on) => toggle(skill.name, on)} />
        </Row>
      ))}
      {listing?.warnings.map((w) => (
        <Row key={w.path} title="Skipped" desc={`${w.path}: ${w.problem}`}>
          <span className="agent-state planned">Not read</span>
        </Row>
      ))}
      <Row
        title="Use my Claude Code skills"
        desc="Also give Kovan's agents the skills in ~/.claude/skills. They are only read, never changed."
      >
        <OnOff
          value={s.claudeSkills}
          onChange={(claudeSkills) => void updateSettings({ claudeSkills })}
        />
      </Row>
      <Row
        title="Your skills folder"
        desc={listing ? listing.userDir : 'Skills here work in every workspace.'}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-sm" onClick={load}>
            Look again
          </button>
          <button
            className="btn btn-sm"
            onClick={() =>
              void api
                .invoke('skills:openFolder')
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            Open folder
          </button>
        </div>
      </Row>
    </Group>
  );
}

interface McpDraft {
  previousName: string | null;
  name: string;
  type: 'stdio' | 'http';
  commandLine: string;
  url: string;
  /** `saved`: a value is in the keychain; an empty `value` then keeps it. */
  env: { name: string; value: string; saved: boolean }[];
  headers: { name: string; value: string; saved: boolean }[];
}

const emptyDraft = (): McpDraft => ({
  previousName: null,
  name: '',
  type: 'stdio',
  commandLine: '',
  url: '',
  env: [],
  headers: [],
});

function draftInput(d: McpDraft): McpServerInput {
  const [command = '', ...args] = splitCommand(d.commandLine);
  const pairs = (list: McpDraft['env']) =>
    list
      .filter((p) => p.name.trim())
      .map((p) => ({ name: p.name.trim(), value: p.saved && !p.value ? null : p.value }));
  return {
    name: d.name.trim(),
    previousName: d.previousName,
    type: d.type,
    command,
    args,
    url: d.url.trim(),
    env: d.type === 'stdio' ? pairs(d.env) : [],
    headers: d.type === 'http' ? pairs(d.headers) : [],
  };
}

function checkText(c: McpCheck): string {
  if (c.ok)
    return `Connected · ${c.tools.length} tool${c.tools.length === 1 ? '' : 's'}${
      c.tools.length ? `: ${c.tools.slice(0, 8).join(', ')}${c.tools.length > 8 ? ', …' : ''}` : ''
    }`;
  return c.needsSignIn ? 'Needs sign-in' : (c.error ?? 'Failed');
}

function mcpStatus(s: McpServerInfo): { text: string; tone: '' | 'ok' | 'planned' } {
  if (s.hidden) return { text: 'Replaced here', tone: '' };
  switch (s.status) {
    case 'ready':
      return { text: `${s.tools.length} tools`, tone: 'ok' };
    case 'needs-auth':
      return { text: 'Signed out', tone: 'planned' };
    case 'failed':
      return { text: 'Failed', tone: 'planned' };
    case 'off':
      return { text: 'Off', tone: '' };
    case 'untrusted':
      return { text: s.trust === 'deny' ? 'Not allowed' : 'Not allowed yet', tone: 'planned' };
    case 'starting':
      return { text: 'Starting', tone: '' };
    default:
      return { text: 'Starts when needed', tone: '' };
  }
}

function PairRows({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: McpDraft['env'];
  onChange: (rows: McpDraft['env']) => void;
}) {
  return (
    <div className="mcp-pairs">
      {rows.map((row, i) => (
        <div key={i} className="mcp-pair">
          <input
            className="input mono"
            placeholder="NAME"
            value={row.name}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
            }
          />
          <input
            className="input mono"
            type="password"
            placeholder={row.saved ? 'Saved (leave empty to keep)' : 'Value'}
            value={row.value}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
            }
          />
          <button
            type="button"
            className="btn btn-sm"
            aria-label={`Remove ${row.name || label}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onChange([...rows, { name: '', value: '', saved: false }])}
      >
        Add {label}
      </button>
    </div>
  );
}

/** The MCP servers Kovan's agents use: the person's own and the open repository's. */
function McpGroup() {
  const [listing, setListing] = useState<McpListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [tested, setTested] = useState<McpCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, McpCheck>>({});
  const load = () =>
    api.invoke('mcp:list').then(
      (l) => {
        setListing(l);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  useEffect(() => void load(), []);

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      setError(null);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
      await load();
    }
  };
  const check = (name: string, action: () => Promise<McpCheck>, label = 'check') =>
    act(`${label}:${name}`, async () => {
      const result = await action();
      setChecks((c) => ({ ...c, [name]: result }));
    });

  const edit = (s: McpServerInfo) => {
    setTested(null);
    setDraft({
      previousName: s.name,
      name: s.name,
      type: s.type,
      commandLine: joinCommand([s.command, ...s.args].filter(Boolean)),
      url: s.url,
      env: s.envNames.map((name) => ({ name, value: '', saved: true })),
      headers: s.headerNames.map((name) => ({ name, value: '', saved: true })),
    });
  };

  const servers = listing?.servers ?? [];
  return (
    <Group title="MCP servers">
      <p className="setting-desc" style={{ margin: '0 0 8px' }}>
        An MCP server gives Kovan&apos;s agents more tools: GitHub, a database, a browser. Each call
        asks first in Request and Allow modes (or choose &quot;Always allow&quot; on the card). A
        repository&apos;s <span className="mono">.mcp.json</span> or{' '}
        <span className="mono">.kovan/mcp.json</span> starts only after you allow it, and asks again
        when it changes. Values you enter here are kept in the system keychain.
      </p>
      {listing && !listing.keychain && (
        <p className="setting-desc danger-text">
          This system has no keychain Kovan can use: secret values can&apos;t be saved, and sign-ins
          last until Kovan quits.
        </p>
      )}
      {error && <p className="setting-desc danger-text">{error}</p>}
      {servers.map((s) => {
        const status = mcpStatus(s);
        const last = checks[s.name];
        const where = s.type === 'http' ? s.url : joinCommand([s.command, ...s.args]);
        const secrets = [...s.envNames, ...s.headerNames];
        // A repository's or a plugin's: it runs once allowed, and isn't edited here.
        const repo = s.source !== 'personal';
        const trusted = repo ? s.trust === 'always' || s.trust === 'once' : s.enabled;
        return (
          <div key={`${s.source}:${s.name}`} className="setting">
            <div
              className="setting-text"
              style={s.hidden || !trusted ? { opacity: 0.55 } : undefined}
            >
              <div className="setting-title">
                {s.name}{' '}
                <span className="mono small muted">
                  {s.source === 'plugin' ? `plugin ${s.file}` : repo ? s.file : 'yours'}
                </span>
              </div>
              <div className="setting-desc">
                <span className="mono">{where}</span>
                {secrets.length > 0 &&
                  ` · ${secrets.join(', ')}${
                    repo
                      ? ''
                      : s.plainValues
                        ? ' (written in the file: Edit and Save to move them to the keychain)'
                        : ' in keychain'
                  }`}
                {s.signedIn && ' · signed in'}
                {repo && s.trust === 'once' && ' · allowed until Kovan quits'}
                {s.hidden && ' · this repository has a server with the same name, used instead'}
              </div>
              {(last || s.error) && s.status !== 'needs-auth' && !last?.needsSignIn && (
                <div className={`setting-desc${(last ? !last.ok : true) ? ' danger-text' : ''}`}>
                  {last ? checkText(last) : s.error}
                </div>
              )}
            </div>
            <div className="setting-control mcp-actions">
              <span className={`agent-state ${status.tone}`}>{status.text}</span>
              {repo && s.trustKey && !trusted && (
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act('trust', () => api.invoke('mcp:trust', s.trustKey!, 'always'))
                  }
                >
                  Allow
                </button>
              )}
              {repo && s.trustKey && trusted && (
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act('trust', () => api.invoke('mcp:trust', s.trustKey!, 'deny'))
                  }
                >
                  Don&apos;t allow
                </button>
              )}
              {repo && s.trust === 'deny' && s.trustKey && (
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  title="Ask again the next time an agent works here"
                  onClick={() =>
                    void act('trust', () => api.invoke('mcp:trust', s.trustKey!, null))
                  }
                >
                  Ask again
                </button>
              )}
              {trusted && !s.hidden && (
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => void check(s.name, () => api.invoke('mcp:check', s.name))}
                >
                  {busy === `check:${s.name}` ? 'Checking…' : 'Check'}
                </button>
              )}
              {trusted &&
                s.type === 'http' &&
                !s.hidden &&
                (s.status === 'needs-auth' || last?.needsSignIn) && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null}
                    title="Opens the sign-in page in your browser"
                    onClick={() =>
                      void check(s.name, () => api.invoke('mcp:signIn', s.name), 'signin')
                    }
                  >
                    {busy === `signin:${s.name}` ? 'Waiting for the browser…' : 'Sign in'}
                  </button>
                )}
              {s.signedIn && (
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => void act('signout', () => api.invoke('mcp:signOut', s.name))}
                >
                  Sign out
                </button>
              )}
              {!repo && (
                <>
                  <OnOff
                    value={s.enabled}
                    onChange={(on) =>
                      void act('toggle', () => api.invoke('mcp:setEnabled', s.name, on))
                    }
                  />
                  <button className="btn btn-sm" disabled={busy !== null} onClick={() => edit(s)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={busy !== null}
                    onClick={() => void act('remove', () => api.invoke('mcp:remove', s.name))}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
      {listing?.problems.map((p, i) => (
        <Row
          key={i}
          title={p.name || (p.source === 'repo' ? 'This repository' : 'Your list')}
          desc={p.problem}
        >
          <span className="agent-state planned">Not used</span>
        </Row>
      ))}
      {draft ? (
        <form
          className="custom-provider-form"
          onSubmit={(e) => {
            e.preventDefault();
            const input = draftInput(draft);
            void act('save', () => api.invoke('mcp:save', input)).then((ok) => {
              if (!ok) return;
              setDraft(null);
              setTested(null);
              // Start it once so the row says how it's doing (or that it wants a sign-in).
              void check(input.name, () => api.invoke('mcp:check', input.name));
            });
          }}
        >
          <div className="mcp-pair">
            <input
              className="input mono"
              placeholder="Name (e.g. github)"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Segmented
              value={draft.type}
              options={[
                { value: 'stdio', label: 'Command' },
                { value: 'http', label: 'URL' },
              ]}
              onChange={(type) => setDraft({ ...draft, type })}
            />
          </div>
          {draft.type === 'stdio' ? (
            <>
              <input
                className="input mono"
                placeholder="npx -y @modelcontextprotocol/server-github"
                value={draft.commandLine}
                onChange={(e) => setDraft({ ...draft, commandLine: e.target.value })}
              />
              <PairRows
                label="variable"
                rows={draft.env}
                onChange={(env) => setDraft({ ...draft, env })}
              />
            </>
          ) : (
            <>
              <input
                className="input mono"
                placeholder="https://mcp.example.com/mcp"
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              />
              <PairRows
                label="header"
                rows={draft.headers}
                onChange={(headers) => setDraft({ ...draft, headers })}
              />
            </>
          )}
          {tested && (
            <p className={`setting-desc${tested.ok ? '' : ' danger-text'}`} style={{ margin: 0 }}>
              {checkText(tested)}
              {tested.needsSignIn && ' — save it, then use Sign in.'}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={
                busy !== null ||
                (draft.type === 'stdio' ? !draft.commandLine.trim() : !draft.url.trim())
              }
              onClick={() =>
                void act('test', async () =>
                  setTested(await api.invoke('mcp:test', draftInput(draft))),
                )
              }
            >
              {busy === 'test' ? 'Starting…' : 'Test'}
            </button>
            <button className="btn btn-primary" disabled={busy !== null || !draft.name.trim()}>
              {draft.previousName ? 'Save' : 'Add server'}
            </button>
            <button type="button" className="btn" onClick={() => (setDraft(null), setTested(null))}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <Row
          title="Add a server"
          desc={
            listing?.root
              ? 'A command Kovan starts, or the URL of a remote server.'
              : 'A command Kovan starts, or the URL of a remote server. Open a workspace to see its servers too.'
          }
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-sm" onClick={() => void load()}>
              Look again
            </button>
            <button
              className="btn btn-sm"
              onClick={() => (setDraft(emptyDraft()), setTested(null))}
            >
              Add server
            </button>
          </div>
        </Row>
      )}
    </Group>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : String(e);
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return 'head';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  return undefined;
}

function contentsLine(c: PluginContents): string {
  const parts = [
    `${c.skills.length} skill${c.skills.length === 1 ? '' : 's'}`,
    `${c.mcpServers.length} MCP server${c.mcpServers.length === 1 ? '' : 's'}`,
  ];
  return `${parts.join(' · ')}${c.unused.length ? ` · not used by Kovan: ${c.unused.join(', ')}` : ''}`;
}

/** What a plugin brings, as the install and update cards show it. */
function PluginContentsView({ contents }: { contents: PluginContents }) {
  return (
    <div className="plugin-contents">
      {contents.skills.length > 0 && (
        <div>
          <div className="plugin-contents-head">Skills</div>
          {contents.skills.map((sk) => (
            <div key={sk.name} className="setting-desc">
              <span className="mono">/{sk.name}</span> · {sk.description}
            </div>
          ))}
        </div>
      )}
      {contents.mcpServers.length > 0 && (
        <div>
          <div className="plugin-contents-head">MCP servers (each asks before it first starts)</div>
          {contents.mcpServers.map((m) => (
            <div key={m.name} className="setting-desc">
              <span className="mono">{m.name}</span> · <span className="mono">{m.detail}</span>
            </div>
          ))}
        </div>
      )}
      {contents.unused.length > 0 && (
        <div className="setting-desc">
          Kovan doesn&apos;t use these parts yet (they are Claude Code&apos;s):{' '}
          {contents.unused.join(', ')}.
        </div>
      )}
      {contents.warnings.map((w) => (
        <div key={w} className="setting-desc danger-text">
          {w}
        </div>
      ))}
    </div>
  );
}

const emptySource = (): PluginSourceInput => ({ source: '', path: '', ref: '' });

/** Installed plugins, installing one, updates, and the team's recommendations. */
function PluginsGroup() {
  const [listing, setListing] = useState<PluginListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [input, setInput] = useState<PluginSourceInput>(emptySource());
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [updates, setUpdates] = useState<Record<string, PluginUpdate>>({});
  const [open, setOpen] = useState<string | null>(null);
  const team = useStore((st) => activeTeamWorkspace(st));
  const load = () =>
    api.invoke('plugins:list').then(
      (l) => setListing(l),
      (e: unknown) => setError(errorText(e)),
    );
  useEffect(() => void load(), []);

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await action();
      setError(null);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
      await load();
    }
  };
  const look = (source: PluginSourceInput) =>
    act('look', async () => {
      if (preview?.kind === 'plugin') void api.invoke('plugins:discard', preview.stagingId);
      setPreview(null);
      setPreview(await api.invoke('plugins:preview', source));
    });
  const closePreview = () => {
    if (preview?.kind === 'plugin') void api.invoke('plugins:discard', preview.stagingId);
    setPreview(null);
  };

  const plugins = listing?.plugins ?? [];
  const installed = new Set(plugins.map((p) => p.name));
  const recommended = team?.recommendedPlugins ?? [];
  const owner = team?.role === 'owner';
  const recommend = (p: PluginInfo, on: boolean) =>
    act('recommend', () =>
      setRecommendedPlugins(
        team!.id,
        on
          ? [
              ...recommended.filter((r) => r.name !== p.name),
              {
                name: p.name,
                source: p.source.source,
                path: p.source.path,
                ref: p.source.ref,
                description: p.description.slice(0, 300),
              },
            ]
          : recommended.filter((r) => r.name !== p.name),
      ),
    );

  return (
    <Group title="Plugins">
      <p className="setting-desc" style={{ margin: '0 0 8px' }} id="settings-plugins">
        A plugin bundles skills and MCP servers, in Claude Code&apos;s format, from git or a folder.
        Nothing in it runs when you install it: its MCP servers ask first, like a repository&apos;s.
        Updates show what changed before anything is replaced. Claude Code&apos;s commands, agents
        and hooks aren&apos;t used by Kovan yet; each plugin lists the ones it has.
      </p>
      {error && <p className="setting-desc danger-text">{error}</p>}
      {recommended
        .filter((r) => !installed.has(r.name))
        .map((r) => (
          <Row
            key={`rec:${r.name}`}
            title={r.name}
            desc={`Recommended for ${team!.name}${r.description ? ` · ${r.description}` : ''} · ${r.source}${r.path ? ` · ${r.path}` : ''}`}
          >
            <button
              className="btn btn-sm btn-primary"
              disabled={busy !== null}
              onClick={() => void look({ source: r.source, path: r.path, ref: r.ref })}
            >
              {busy === 'look' ? 'Fetching…' : 'Install…'}
            </button>
          </Row>
        ))}
      {plugins.map((p) => {
        const update = updates[p.name];
        const isRecommended = recommended.some((r) => r.name === p.name);
        return (
          <div key={p.name} className="plugin-item">
            <div className="setting">
              <div className="setting-text">
                <div className="setting-title">
                  {p.name} {p.version && <span className="mono small muted">{p.version}</span>}
                  {isRecommended && <span className="mono small muted"> · recommended</span>}
                </div>
                <div className="setting-desc">
                  {p.description ? `${p.description} · ` : ''}
                  <span className="mono">{p.source.label}</span>
                </div>
                <div className="setting-desc">{contentsLine(p.contents)}</div>
              </div>
              <div className="setting-control mcp-actions">
                {p.enabledHere !== null ? (
                  <OnOff
                    value={p.enabledHere}
                    onChange={(on) =>
                      void act('toggle', () => api.invoke('plugins:setEnabled', p.name, on))
                    }
                  />
                ) : (
                  <span className={`agent-state ${p.everywhere ? 'ok' : ''}`}>
                    {p.everywhere ? 'On' : 'Off'}
                  </span>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => setOpen(open === p.name ? null : p.name)}
                >
                  {open === p.name ? 'Less' : 'More'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`update:${p.name}`, async () => {
                      const result = await api.invoke('plugins:checkUpdate', p.name);
                      setUpdates((u) => ({ ...u, [p.name]: result }));
                    })
                  }
                >
                  {busy === `update:${p.name}` ? 'Checking…' : 'Check for update'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => void act('remove', () => api.invoke('plugins:remove', p.name))}
                >
                  Remove
                </button>
              </div>
            </div>
            {open === p.name && (
              <div className="plugin-panel">
                <PluginContentsView contents={p.contents} />
                <Row
                  title="On in other workspaces"
                  desc="Where you haven't switched it on or off yourself."
                >
                  <OnOff
                    value={p.everywhere}
                    onChange={(on) =>
                      void act('everywhere', () => api.invoke('plugins:setEverywhere', p.name, on))
                    }
                  />
                </Row>
                {team && owner && (
                  <Row
                    title={`Recommend to ${team.name}`}
                    desc={
                      p.source.kind === 'git'
                        ? "Members see an Install suggestion; it doesn't install by itself."
                        : 'Only plugins installed from git can be recommended (a folder is only on this machine).'
                    }
                  >
                    <OnOff
                      value={isRecommended}
                      onChange={(on) => p.source.kind === 'git' && void recommend(p, on)}
                    />
                  </Row>
                )}
                <div className="setting-desc mono">
                  {p.dir}
                  {p.commit ? ` · ${p.commit.slice(0, 10)}` : ''} · updated{' '}
                  {new Date(p.updatedAt).toLocaleDateString()}
                </div>
              </div>
            )}
            {update?.upToDate === true && (
              <p className="setting-desc" style={{ margin: '0 0 8px' }}>
                Up to date.
              </p>
            )}
            {update && !update.upToDate && (
              <div className="plugin-panel">
                <div className="setting-title">
                  Update {update.from.version ?? update.from.commit?.slice(0, 10) ?? ''} →{' '}
                  {update.to.version ?? update.to.commit?.slice(0, 10) ?? 'new'}
                </div>
                <pre className="plugin-diff">{update.stat}</pre>
                <details>
                  <summary className="setting-desc">The whole change</summary>
                  <pre className="plugin-diff">
                    {update.patch.split('\n').map((line, i) => (
                      <div key={i} className={diffLineClass(line)}>
                        {line || ' '}
                      </div>
                    ))}
                    {update.patchCut ? '… (cut: too long to show whole)' : ''}
                  </pre>
                </details>
                <PluginContentsView contents={update.contents} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void act('apply', async () => {
                        await api.invoke('plugins:update', p.name, update.stagingId);
                        setUpdates(({ [p.name]: _, ...rest }) => rest);
                      })
                    }
                  >
                    Update
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      void api.invoke('plugins:discard', update.stagingId);
                      setUpdates(({ [p.name]: _, ...rest }) => rest);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {preview?.kind === 'plugin' && (
        <div className="plugin-panel">
          <div className="setting-title">
            {preview.manifest.name}{' '}
            {preview.manifest.version && (
              <span className="mono small muted">{preview.manifest.version}</span>
            )}
          </div>
          <div className="setting-desc">
            {[
              preview.manifest.description,
              preview.manifest.author && `by ${preview.manifest.author}`,
              preview.commit && `commit ${preview.commit.slice(0, 10)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <PluginContentsView contents={preview.contents} />
          {preview.installed && (
            <p className="setting-desc danger-text" style={{ margin: 0 }}>
              A plugin with this name is installed: use its Check for update instead.
            </p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={busy !== null || preview.installed}
              onClick={() =>
                void act('install', async () => {
                  await api.invoke('plugins:install', preview.stagingId);
                  setPreview(null);
                  setInput(emptySource());
                })
              }
            >
              Install
            </button>
            <button className="btn" onClick={closePreview}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {preview?.kind === 'marketplace' && (
        <div className="plugin-panel">
          <div className="setting-title">{preview.name}: choose a plugin</div>
          {preview.plugins.length === 0 && <div className="setting-desc">It lists none.</div>}
          {preview.plugins.map((p) => (
            <Row key={p.name} title={p.name} desc={p.description || p.source.source}>
              <button
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => void look(p.source)}
              >
                Look
              </button>
            </Row>
          ))}
          <div>
            <button className="btn" onClick={closePreview}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <form
        className="custom-provider-form"
        onSubmit={(e) => {
          e.preventDefault();
          void look(input);
        }}
      >
        <div className="mcp-pair">
          <input
            className="input mono"
            placeholder="Git URL, owner/repo or a folder"
            value={input.source}
            onChange={(e) => setInput({ ...input, source: e.target.value })}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              void api
                .invoke('plugins:chooseFolder')
                .then((folder) => folder && setInput({ ...input, source: folder }))
            }
          >
            Choose folder…
          </button>
        </div>
        {more && (
          <div className="mcp-pair">
            <input
              className="input mono"
              placeholder="Folder inside it (optional)"
              value={input.path}
              onChange={(e) => setInput({ ...input, path: e.target.value })}
            />
            <input
              className="input mono"
              placeholder="Branch or tag (optional)"
              value={input.ref}
              onChange={(e) => setInput({ ...input, ref: e.target.value })}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" disabled={busy !== null || !input.source.trim()}>
            {busy === 'look' ? 'Fetching…' : 'Look at it'}
          </button>
          {!more && (
            <button type="button" className="btn" onClick={() => setMore(true)}>
              Folder or branch…
            </button>
          )}
        </div>
      </form>
    </Group>
  );
}

const MAX_ORDER = 24;

/**
 * Whether the CLI is signed in as the account. Asked again every few seconds while it isn't,
 * so finishing the sign-in in the terminal shows here.
 */
function useAccountStatus(harness: ExternalHarness, account: string) {
  const [status, setStatus] = useState<
    { signedIn: boolean; who: string | null } | null | 'checking'
  >('checking');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      void api
        .invoke('accounts:status', harness, account)
        .then((next) => {
          if (stopped) return;
          setStatus(next);
          if (next && !next.signedIn) timer = setTimeout(ask, 5_000);
        })
        .catch(() => !stopped && setStatus(null));
    ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [harness, account]);
  return status;
}

/** One added account: its sign-in, its usage, and a way to sign in only while it is signed out. */
function AccountRow({ account: a, installed }: { account: AgentAccount; installed: boolean }) {
  const status = useAccountStatus(a.harness, a.id);
  const limit = useStore((st) => st.agentLimits.find((l) => l.account === `${a.harness}#${a.id}`));
  const signedOut = status !== 'checking' && status !== null && !status.signedIn;
  return (
    <Row
      title={`${HARNESS_NAMES[a.harness]} · ${a.name}`}
      desc="Its own sign-in, in Kovan's data folder."
    >
      <div className="account-state">
        {status === 'checking' ? (
          <span className="small muted">Checking…</span>
        ) : !status ? (
          <span className="small muted">Not installed</span>
        ) : status.signedIn ? (
          <span className="small account-on" title={status.who ?? undefined}>
            Signed in{status.who ? ` · ${status.who}` : ''}
          </span>
        ) : (
          <span className="small account-off">Not signed in</span>
        )}
        {limit && limitLabel(limit, Date.now()) ? (
          <LimitLine account={`${a.harness}#${a.id}`} />
        ) : (
          status !== 'checking' &&
          status?.signedIn && <span className="setting-desc">Usage shows after its first turn</span>
        )}
      </div>
      {signedOut && (
        <button
          className="btn btn-sm"
          disabled={!installed}
          title="Opens a terminal to sign this account in"
          onClick={() =>
            void newTerminal(a.harness, { account: a.id, login: true, title: `${a.name}: sign in` })
          }
        >
          Sign in
        </button>
      )}
      <button className="icon-btn" title="Remove" onClick={() => void removeAgentAccount(a)}>
        <X size={14} />
      </button>
    </Row>
  );
}

/**
 * More than one Claude or OpenAI account: each signs in once, in its own folder, and can be
 * ranked in the order on its own (when one runs out, the next takes over).
 */
function AccountsGroup() {
  const accounts = useStore((st) => st.agentAccounts);
  const agents = useStore((st) => st.externalAgents);
  const [harness, setHarnessDraft] = useState<ExternalHarness>('claude-code');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const installed = (h: ExternalHarness) => agents.find((a) => a.id === h)?.supported ?? false;
  return (
    <Group title="Accounts">
      <p className="setting-desc" style={{ margin: '0 0 8px' }}>
        Claude Code and Codex run only as the accounts you add here; the sign-in they already have
        on this computer isn't used. Each account signs in once in a terminal here and keeps its own
        sign-in on this machine; rank it in your order below, and when one account reaches its limit
        the conversation goes on with the next.
      </p>
      {(['claude-code', 'codex'] as ExternalHarness[]).map((h) => (
        <Fragment key={h}>
          {accounts
            .filter((a) => a.harness === h)
            .map((a) => (
              <AccountRow key={a.id} account={a} installed={installed(h)} />
            ))}
        </Fragment>
      ))}
      <Row
        title="Add an account"
        desc={`A terminal opens with ${HARNESS_NAMES[harness]}'s own sign-in; finish it there (${harness === 'codex' ? 'it opens your browser' : 'type /login if it does not ask'}).`}
      >
        <select
          className="select"
          value={harness}
          onChange={(e) => setHarnessDraft(e.target.value as ExternalHarness)}
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <input
          className="input"
          placeholder="Name, like Work"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn btn-sm btn-primary"
          disabled={!name.trim() || busy || !installed(harness)}
          title={
            installed(harness) ? '' : `${HARNESS_NAMES[harness]} is not installed on this machine`
          }
          onClick={() => {
            setBusy(true);
            void addAgentAccount(harness, name.trim()).then((ok) => {
              setBusy(false);
              if (ok) setName('');
            });
          }}
        >
          <Plus size={13} /> Add
        </button>
      </Row>
    </Group>
  );
}

/** The agents and models the person ranked: Auto's preference and where a full account hands off. */
function OrderGroup() {
  const s = useStore((st) => st.settings);
  const agents = useStore((st) => st.externalAgents);
  const models = useStore((st) => st.models);
  const providers = useStore((st) => st.providers);
  const [draft, setDraft] = useState<AgentOption>(defaultOption('claude-code'));
  const accounts = useStore((st) => st.agentAccounts);
  const order = s.agentOrder;
  const accountName = (o: AgentOption) =>
    o.account
      ? (accounts.find((a) => a.id === o.account)?.name ?? 'removed account')
      : o.harness !== 'kovan'
        ? 'first account added'
        : undefined;

  useEffect(() => {
    if (models.length === 0) void loadModels();
  }, [models.length]);

  const save = (agentOrder: AgentOption[]) => void updateSettings({ agentOrder });
  const move = (index: number, by: number) => {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    save(next);
  };
  const modelOf = (id: string) => models.find((m) => m.id === id);
  /** Why a step is skipped right now, or null when it can run. */
  const skipped = (o: AgentOption): string | null => {
    if (o.harness !== 'kovan') {
      if (o.account && !accounts.some((a) => a.id === o.account)) return 'Account removed: skipped';
      if (!o.account && !accounts.some((a) => a.harness === o.harness))
        return 'No account added: skipped';
      return agents.find((a) => a.id === o.harness)?.supported ? null : 'Not installed: skipped';
    }
    if (parseCustomModelId(o.model))
      return models.length > 0 && !modelOf(o.model) ? 'Provider or model removed: skipped' : null;
    return providers && !providers.openrouter.configured && !providers.managed
      ? 'No OpenRouter key or managed usage: skipped'
      : null;
  };
  const hint = (o: AgentOption): string => {
    if (o.harness === 'claude-code') return 'Your Claude account';
    if (o.harness === 'codex') return 'Your OpenAI account';
    if (o.model === JEV_MODEL_ID) return 'Pay-per-use · JevRouter picks the model';
    return `Pay-per-use · ${parseCustomModelId(o.model) ? (modelOf(o.model)?.provider ?? 'your provider') : 'OpenRouter'}`;
  };

  const draftModel = draft.model.trim();
  const draftKnown =
    draft.harness !== 'kovan' || draftModel === JEV_MODEL_ID || Boolean(modelOf(draftModel));
  const draftTaken = order.some((o) => sameOption(o, { ...draft, model: draftModel }));
  const draftNoAccount =
    draft.harness !== 'kovan' && !accounts.some((a) => a.harness === draft.harness);
  return (
    <Group title="Your order">
      <p className="setting-desc" style={{ margin: '0 0 8px' }}>
        Rank the agents and models you want used, first to last. Auto starts a task with the first
        one that is ready, and when an account runs out the conversation continues with the next.
        The same agent can be ranked more than once with different models.
      </p>
      {order.map((o, i) => {
        const why = skipped(o);
        return (
          <div
            key={`${o.harness}:${o.model}:${o.account ?? ''}`}
            className={`setting ${why ? 'dimmed' : ''}`}
          >
            <div className="setting-text">
              <div className="setting-title">
                <span className="mono small muted">{i + 1}</span>{' '}
                {optionLabel(o, modelOf(o.model)?.name, accountName(o))}
              </div>
              <div className="setting-desc">{why ?? hint(o)}</div>
              <LimitLine account={accountOf(o)} />
            </div>
            <div className="setting-control">
              <button
                className="icon-btn"
                title="Try earlier"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                className="icon-btn"
                title="Try later"
                disabled={i === order.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={14} />
              </button>
              <button
                className="icon-btn"
                title="Remove from the order"
                disabled={order.length === 1}
                onClick={() => save(order.filter((_, at) => at !== i))}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
      <Row
        title="Add a step"
        desc={
          draft.harness === 'kovan'
            ? 'Any model from the catalog, including your custom providers (Providers & spend).'
            : `A model of ${HARNESS_NAMES[draft.harness]}; Default lets ${draft.harness === 'claude-code' ? 'Auto pick by how hard the task is' : 'Codex decide'}.`
        }
      >
        <select
          className="select"
          value={draft.harness}
          onChange={(e) => setDraft(defaultOption(e.target.value as Harness))}
        >
          {(['claude-code', 'codex', 'kovan'] as Harness[]).map((h) => (
            <option key={h} value={h}>
              {HARNESS_NAMES[h]}
            </option>
          ))}
        </select>
        {draft.harness === 'kovan' ? (
          <>
            <input
              className="input"
              style={{ width: 240 }}
              list="order-models"
              spellCheck={false}
              placeholder="Model id"
              value={draft.model}
              onChange={(e) => setDraft({ harness: 'kovan', model: e.target.value })}
            />
            <datalist id="order-models">
              <option value={JEV_MODEL_ID}>JevRouter</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </datalist>
          </>
        ) : (
          <>
            <select
              className="select"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            >
              {(draft.harness === 'claude-code' ? CLAUDE_MODELS : CODEX_MODELS).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {accounts.some((a) => a.harness === draft.harness) && (
              <select
                className="select"
                title="Which account runs it"
                value={draft.account ?? ''}
                onChange={(e) => setDraft({ ...draft, account: e.target.value || undefined })}
              >
                <option value="">First account added</option>
                {accounts
                  .filter((a) => a.harness === draft.harness)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            )}
          </>
        )}
        <button
          className="btn"
          disabled={!draftKnown || draftTaken || draftNoAccount || order.length >= MAX_ORDER}
          title={
            draftNoAccount
              ? `Add a ${HARNESS_NAMES[draft.harness]} account first, under Accounts`
              : draftTaken
                ? 'Already in your order'
                : draftKnown
                  ? ''
                  : 'Pick a model from the catalog'
          }
          onClick={() =>
            save([
              ...order,
              {
                harness: draft.harness,
                model: draftModel,
                ...(draft.account && draft.harness !== 'kovan' ? { account: draft.account } : {}),
              },
            ])
          }
        >
          <Plus size={13} /> Add
        </button>
      </Row>
      <Row
        title="Continue with the next when an account runs out"
        desc="When an account hits its usage limit mid-task, the same conversation goes on with the next step of your order. It is told what you asked, what was done and what must not be repeated."
      >
        <OnOff
          value={s.agentFailover}
          onChange={(agentFailover) => void updateSettings({ agentFailover })}
        />
      </Row>
      <Row
        title="Ask before pay-per-use"
        desc="Once per conversation, before a switch moves it from a subscription (Claude Code, Codex) to Kovan's pay-per-use models."
      >
        <OnOff
          value={s.agentFailoverAskPaid}
          onChange={(agentFailoverAskPaid) => void updateSettings({ agentFailoverAskPaid })}
        />
      </Row>
    </Group>
  );
}

function AgentsSection() {
  const agents = useStore((st) => st.externalAgents);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <>
      <Group title="Agents on this machine">
        <p className="setting-desc" style={{ margin: '0 0 8px' }}>
          Kovan runs the coding agents you already pay for. It doesn't change their configuration:
          sessions it starts get Kovan's coordination tools (MCP), and Claude Code's permission
          prompts show up as approval cards. Your own terminal sessions stay exactly as they were.
        </p>
        <div className="setting">
          <div className="setting-text">
            <div className="setting-title">Kovan</div>
            <div className="setting-desc">Built in · any model through OpenRouter</div>
          </div>
          <div className="setting-control">
            <span className="agent-state ok">Ready</span>
          </div>
        </div>
        {agents.map((a) => (
          <div key={a.id} className={`setting ${a.supported ? '' : 'dimmed'}`}>
            <div className="setting-text">
              <div className="setting-title">
                {a.name} {a.version && <span className="mono small muted">{a.version}</span>}
              </div>
              <div className="setting-desc">
                {a.supported ? <span className="mono">{a.path}</span> : a.reason}
              </div>
              {a.supported && <LimitLine account={a.id as Harness} />}
            </div>
            <div className="setting-control">
              <AgentState agent={a} />
            </div>
          </div>
        ))}
        <ConnectRepoRow />
        <Row title="Look again" desc="After installing or updating an agent CLI.">
          <button
            className="btn btn-sm"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void loadExternalAgents(true).finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? 'Checking…' : 'Detect agents'}
          </button>
        </Row>
        <BackgroundAgentsRow />
      </Group>
      <AccountsGroup />
      <OrderGroup />
      <SkillsGroup />
      <McpGroup />
      <PluginsGroup />
      <IssuesGroup />
    </>
  );
}

function Account() {
  const user = useStore((s) => s.user);
  const signedIn = useStore((s) => s.signedIn);
  const serverUrl = useStore((s) => s.serverUrl);
  const pending = useStore((s) => s.loginPending);
  const connection = useStore((s) => s.connection);
  const [deleting, setDeleting] = useState(false);

  if (!signedIn || !user) {
    return (
      <Group title="Account">
        <Row
          title="Not signed in"
          desc="Sign in to share workspaces, see teammates and invite people. Your code stays on this machine."
        >
          <button
            className="btn btn-primary"
            disabled={pending !== null}
            onClick={() => void signIn('login')}
          >
            {pending ? 'Waiting for the browser…' : 'Sign in'}
          </button>
        </Row>
        <Row title="Server" desc="Where accounts and coordination live.">
          <span className="mono small muted">{serverUrl}</span>
        </Row>
      </Group>
    );
  }
  return (
    <Group title="Account">
      <div className="setting">
        <Avatar name={user.name} src={user.avatarUrl} size={36} />
        <div className="setting-text">
          <div className="setting-title">{user.name}</div>
          <div className="setting-desc">{user.email ?? 'No email address'}</div>
        </div>
        <div className="setting-control">
          <button className="btn" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </div>
      <Row title="Name" desc="How your teammates see you in sessions, comments and invites.">
        <input
          key={user.name}
          className="input"
          maxLength={80}
          defaultValue={user.name}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (!name) e.target.value = user.name;
            else if (name !== user.name) void updateAccount({ name });
          }}
        />
      </Row>
      <Row
        title="Photo"
        desc={
          user.githubLogin
            ? "Kovan's picture, or the one on your GitHub account."
            : "Kovan's picture. Connect GitHub to use its photo."
        }
      >
        <Segmented<'kovan' | 'github' | 'none'>
          value={user.avatarUrl === KOVAN_AVATAR ? 'kovan' : user.avatarUrl ? 'github' : 'none'}
          options={[
            { value: 'kovan', label: 'Kovan' },
            ...(user.githubLogin ? [{ value: 'github' as const, label: 'GitHub' }] : []),
          ]}
          onChange={(photo) => photo !== 'none' && void updateAccount({ photo })}
        />
      </Row>
      <Row
        title="Email"
        desc={
          user.email
            ? user.emailVerified
              ? 'Verified'
              : 'Not verified yet: invites and alerts may not reach you.'
            : 'Add one by signing in with email or Google.'
        }
      >
        {user.email && !user.emailVerified && (
          <button className="btn btn-sm" onClick={() => void sendVerification()}>
            Send verification link
          </button>
        )}
      </Row>
      <Row
        title="GitHub"
        desc={
          user.githubLogin
            ? `Connected as @${user.githubLogin}`
            : 'Connect to be invited by GitHub username.'
        }
      >
        {!user.githubLogin && (
          <button
            className="btn btn-sm"
            disabled={pending !== null}
            onClick={() => void signIn('link')}
          >
            <GithubMark size={13} /> {pending === 'link' ? 'Waiting…' : 'Connect GitHub'}
          </button>
        )}
      </Row>
      <Row title="Server" desc={`Connection: ${connection}`}>
        <span className="mono small muted">{serverUrl}</span>
      </Row>
      <Row
        title="Delete account"
        desc="Deletes your account and the workspaces only you are in. Shared workspaces stay with your teammates."
      >
        <button className="btn btn-sm btn-danger-ghost" onClick={() => setDeleting(true)}>
          Delete account…
        </button>
        {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
      </Row>
    </Group>
  );
}

function Privacy() {
  const user = useStore((s) => s.user);
  const site = useStore((s) => s.serverUrl).replace(/\/$/, '');
  return (
    <Group title="Privacy">
      <Row
        title="Share error reports"
        desc="When something fails, send the error and app version, linked to your account. Prompts and code are never included."
      >
        {user ? (
          <OnOff
            value={user.errorReports}
            onChange={(errorReports) => void updateAccount({ errorReports })}
          />
        ) : (
          <span className="small muted">Only when signed in</span>
        )}
      </Row>
      <Row
        title="Where your code lives"
        desc="Repositories stay in your local clones. Kovan's server stores accounts, workspaces and membership, never your source."
      >
        <span />
      </Row>
      <Row title="Policies" desc="What Kovan's server keeps and the terms for using it.">
        <span className="row-links">
          <a className="link-btn" href={`${site}/privacy/`} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
          <a className="link-btn" href={`${site}/terms/`} target="_blank" rel="noreferrer">
            Terms
          </a>
          <a className="link-btn" href={`${site}/contact/`} target="_blank" rel="noreferrer">
            Contact
          </a>
        </span>
      </Row>
    </Group>
  );
}

/** An owner's name, color and base branch for a workspace; others see them. */
function WorkspaceDetails({ workspace }: { workspace: Workspace }) {
  const owner = workspace.role === 'owner';
  const [name, setName] = useState(workspace.name);
  const [branch, setBranch] = useState(workspace.defaultBranch);
  useEffect(() => setName(workspace.name), [workspace.name]);
  useEffect(() => setBranch(workspace.defaultBranch), [workspace.defaultBranch]);
  const only = owner ? '' : ' Only owners change it.';
  return (
    <>
      <Row title="Name" desc={`How the workspace shows for everyone in it.${only}`}>
        <input
          className="input"
          value={name}
          maxLength={80}
          disabled={!owner}
          onChange={(e) => setName(e.target.value)}
        />
        {owner && (
          <button
            className="btn btn-sm"
            disabled={!name.trim() || name.trim() === workspace.name}
            onClick={() => void updateWorkspace(workspace.id, { name: name.trim() })}
          >
            Save
          </button>
        )}
      </Row>
      <Row title="Color" desc={`Its icon in the sidebar.${only}`}>
        <span className="ws-swatches" role="radiogroup" aria-label="Workspace color">
          <button
            type="button"
            role="radio"
            aria-checked={workspace.color === null}
            className={`ws-swatch auto ${workspace.color === null ? 'on' : ''}`}
            title="Picked from the name"
            disabled={!owner}
            onClick={() => void updateWorkspace(workspace.id, { color: null })}
          >
            <WorkspaceIcon name={workspace.name} />
          </button>
          {WORKSPACE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={workspace.color === c}
              aria-label={c}
              className={`ws-swatch ${workspace.color === c ? 'on' : ''}`}
              style={{ background: c }}
              disabled={!owner}
              onClick={() => void updateWorkspace(workspace.id, { color: c })}
            />
          ))}
        </span>
      </Row>
      <Row
        title="Base branch"
        desc={`A session's changes are shown against it, and Kovan never pushes to it for you: that takes a pull request.${only}`}
      >
        <input
          className="input input-narrow mono"
          value={branch}
          maxLength={200}
          disabled={!owner}
          onChange={(e) => setBranch(e.target.value)}
        />
        {owner && (
          <button
            className="btn btn-sm"
            disabled={!branch.trim() || branch.trim() === workspace.defaultBranch}
            onClick={() => void updateWorkspace(workspace.id, { defaultBranch: branch.trim() })}
          >
            Save
          </button>
        )}
      </Row>
    </>
  );
}

/** One switch for everyone in the workspace; anyone who works in it may flip it. */
function GitSyncRow({ workspace }: { workspace: Workspace }) {
  const mayFlip = can(workspace.role, 'workspace.gitSync');
  const by =
    workspace.gitSyncChangedBy && workspace.gitSyncChangedAt
      ? ` Turned ${workspace.autoGitSync ? 'on' : 'off'} by ${workspace.gitSyncChangedBy}, ${new Date(workspace.gitSyncChangedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`
      : '';
  return (
    <Row
      title="Automatic Git sync"
      desc={`Saved changes in a session go to its teammates every few seconds, and theirs come in. One switch for everyone in the workspace.${by}${mayFlip ? '' : ' Editors and owners change it.'}`}
    >
      {mayFlip ? (
        <OnOff
          value={workspace.autoGitSync}
          onChange={(on) => void setWorkspaceGitSync(workspace.id, on)}
        />
      ) : (
        <span className="small muted">{workspace.autoGitSync ? 'On' : 'Off'}</span>
      )}
    </Row>
  );
}

const MODE_HINT: Record<Workspace['mode'], string> = {
  solo: 'One person with their AI agents: no invites, no hand-offs, small swarms.',
  team: 'People work together: shared sessions, plans, approvals by role.',
  adaptive: 'Solo while you are the only person in it, Team once others join.',
};

/** How a workspace works; owners choose. */
function ModeRow({ workspace }: { workspace: Workspace }) {
  const owner = workspace.role === 'owner';
  return (
    <Row
      title="How it works"
      desc={`${MODE_HINT[workspace.mode]}${workspace.mode === 'adaptive' ? ` Now: ${workspaceMode(workspace) === 'solo' ? 'Solo' : 'Team'}.` : ''}${owner ? '' : ' Only owners change it.'}`}
    >
      <select
        className="select"
        value={workspace.mode}
        disabled={!owner}
        onChange={(e) => void setWorkspaceMode(workspace.id, e.target.value as Workspace['mode'])}
      >
        <option value="adaptive">Adaptive</option>
        <option value="solo">Solo</option>
        <option value="team">Team</option>
      </select>
    </Row>
  );
}

/** An owner's monthly cap on what the workspace's agent swarms spend together. */
function AgentLimitRow({ workspace }: { workspace: Workspace }) {
  const owner = workspace.role === 'owner';
  const [value, setValue] = useState(workspace.agentMonthlyLimit?.toString() ?? '');
  const [spend, setSpend] = useState<AgentSpendStats | null>(null);
  useEffect(() => {
    void loadAgentSpend(workspace.id).then(setSpend);
  }, [workspace.id, workspace.agentMonthlyLimit]);
  const limit = value.trim() ? Number(value) : null;
  const changed = limit !== workspace.agentMonthlyLimit;
  const used = spend ? `$${spend.monthSpent.toFixed(4)} spent this month` : '';
  return (
    <Row
      title="Monthly limit for agent swarms"
      desc={`All sessions together; at it, swarms pause. ${used}${owner ? '' : ' · Only owners change it.'}`}
    >
      <input
        className="input input-narrow mono"
        type="number"
        min={0.01}
        step="any"
        placeholder="no limit"
        disabled={!owner}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {owner && (
        <button
          className="btn btn-sm"
          disabled={!changed || (limit !== null && !(limit >= 0.01))}
          onClick={() => void setAgentMonthlyLimit(workspace.id, limit)}
        >
          Save
        </button>
      )}
    </Row>
  );
}

const SCOPE_TEXT: Record<ApiKeyScope, string> = {
  read: 'Read sessions, plans and swarms',
  dispatch: 'Start sessions and launch swarms',
  control: 'Stop, steer and reassign running work',
  machine: 'Be a machine that runs agents (agentd)',
};

function lastUsed(iso: string | null): string {
  if (!iso) return 'never used';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return 'used just now';
  if (minutes < 120) return `used ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `used ${hours} hours ago` : `used ${Math.round(hours / 24)} days ago`;
}

/**
 * How other systems drive and follow a workspace: API keys to call Kovan, webhooks Kovan
 * calls. Its owners set them up.
 */
function IntegrationsGroup({ owned }: { owned: Workspace[] }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const workspace = owned.find((w) => w.id === chosen) ?? owned[0];
  if (!workspace) return null;
  const base = integrationsOf({ workspaceId: workspace.id });
  return (
    <Group title="Integrations">
      {owned.length > 1 && (
        <Row title="Workspace" desc="Keys and webhooks belong to one workspace.">
          <select
            className="select"
            value={workspace.id}
            onChange={(e) => setChosen(e.target.value)}
          >
            {owned.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Row>
      )}
      <h3 className="settings-subhead">API keys</h3>
      <p className="setting-desc">
        For other systems that start and follow work here. A key acts as its own member, so it keeps
        working when people leave; it can never change members, settings or billing.
      </p>
      <ApiKeyList key={`keys-${workspace.id}`} base={base} />
      <h3 className="settings-subhead">Machines</h3>
      <p className="setting-desc">
        Computers that run agents without anyone at them (<span className="mono">agentd</span>),
        each with a key that has the <span className="mono">machine</span> scope. Work sent here
        goes to one that holds the repository.
      </p>
      <MachineList key={`machines-${workspace.id}`} base={base} />
      <h3 className="settings-subhead">Git for machines</h3>
      <p className="setting-desc">
        With an access token for the repository (read and write contents; a fine-grained GitHub
        token for this one repository is enough), machines fetch and push through Kovan with their
        own key, so none of them needs a GitHub key. Kovan keeps the token encrypted, checks it
        against the repository first, and never pushes to {workspace.defaultBranch} for them.
      </p>
      <GitAccess key={`git-${workspace.id}`} workspace={workspace} />
      <h3 className="settings-subhead">Webhooks</h3>
      <p className="setting-desc">
        Kovan posts what happens here to these addresses, signed with{' '}
        <span className="mono">X-Kovan-Signature</span>, and retries for a few hours when they
        don&apos;t answer.
      </p>
      <WebhookList key={`hooks-${workspace.id}`} base={base} />
    </Group>
  );
}

function GitAccess({ workspace }: { workspace: Workspace }) {
  const [access, setAccess] = useState<Awaited<ReturnType<typeof loadGitAccess>> | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    loadGitAccess(workspace.id)
      .then(setAccess)
      .catch((e: unknown) => setError(errorText(e)));
  useEffect(() => {
    void reload();
  }, [workspace.id]);
  const save = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await setGitAccess(workspace.id, value);
      setToken('');
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!workspace.repoUrl)
    return <p className="setting-desc">This workspace has no repository yet.</p>;
  return (
    <>
      <Row
        title={access?.configured ? 'Set up' : 'Not set up'}
        desc={
          access?.configured
            ? `Since ${access.setAt ? new Date(access.setAt).toLocaleString() : 'earlier'}. On a machine: KOVAN_GIT_RELAY=1.`
            : `Machines use their own git keys for ${workspace.repoUrl}.`
        }
      >
        {access?.configured && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void save(null)}>
            Remove
          </button>
        )}
      </Row>
      <Row title={access?.configured ? 'Replace the token' : 'Access token'}>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder="github_pat_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          className="btn btn-sm btn-primary"
          disabled={busy || token.trim().length < 8}
          onClick={() => void save(token.trim())}
        >
          {busy ? 'Checking…' : 'Save'}
        </button>
      </Row>
      {error && <p className="setting-desc danger-text">{error}</p>}
    </>
  );
}

/** This computer's own agentd, so swarms sent to it keep going after the app quits. */
function BackgroundAgentsRow() {
  const signedIn = useStore((s) => s.signedIn);
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.invoke('background:status').then(setStatus);
  }, []);
  if (!signedIn) return null;
  const set = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.invoke('background:set', enabled));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        title="Background agents"
        desc={
          status?.enabled
            ? `${status.running ? 'Running' : 'Not running'} as the machine "${status.name}". Swarms sent to it (Run on) keep going after you quit Kovan. Log: ${status.log}`
            : "Runs this computer's agents in a background process of their own, as a machine of your organization, so work you send to it goes on after you quit Kovan. It offers the checkouts opened here and works with Claude Code on your subscription."
        }
      >
        <button
          className={`btn btn-sm${status?.enabled ? '' : ' btn-primary'}`}
          disabled={busy || !status}
          onClick={() => void set(!status?.enabled)}
        >
          {busy ? '…' : status?.enabled ? 'Turn off' : 'Turn on'}
        </button>
      </Row>
      {error && <p className="setting-desc danger-text">{error}</p>}
    </>
  );
}

function MachineList({ base }: { base: string }) {
  const orgView = base.startsWith('/api/orgs/');
  const [list, setList] = useState<Machine[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    loadMachines(base)
      .then(setList)
      .catch((e: unknown) => setError(errorText(e)));
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 30_000);
    return () => clearInterval(timer);
  }, [base]);
  const remove = async (id: string) => {
    setConfirm(null);
    try {
      await removeMachine(base, id);
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <>
      {list?.length === 0 && <p className="setting-desc">No machines yet.</p>}
      {list?.map((m) => (
        <Row
          key={m.id}
          title={`${m.name} · ${m.online ? 'online' : 'offline'}${m.scope === 'organization' ? ' · whole organization' : ''}`}
          desc={`${
            m.agents.length
              ? m.agents
                  .map(
                    (a) =>
                      `${a.name}${a.version ? ` ${a.version}` : ''}${a.ready ? '' : ' (not signed in)'}`,
                  )
                  .join(', ')
              : 'no agents reported'
          } · ${m.repos.length ? m.repos.map((r) => `${r.remote} → ${r.path}`).join(', ') : 'no checkouts'} · ${m.platform} · ${m.running} of ${m.slots} running · ${m.online ? 'reported just now' : `last seen ${new Date(m.lastSeenAt).toLocaleString()}`}${m.keyName ? ` · key ${m.keyName}` : ''}`}
        >
          {/* Removed where it was registered: an organization's machine from the organization. */}
          {(orgView ? m.scope !== 'organization' : m.scope === 'organization') ? (
            <span className="small muted">
              {orgView ? 'in a workspace’s settings' : 'in Organization settings'}
            </span>
          ) : confirm === m.id ? (
            <>
              <button className="btn btn-sm btn-danger-ghost" onClick={() => void remove(m.id)}>
                Remove now
              </button>
              <button className="btn btn-sm" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => setConfirm(m.id)}>
              Remove
            </button>
          )}
        </Row>
      ))}
      {error && <p className="setting-desc danger-text">{error}</p>}
    </>
  );
}

const EVENT_TEXT: Record<WorkspaceEventType, string> = {
  'session.started': 'Session started',
  'session.finished': 'Session finished',
  'session.failed': 'A turn failed',
  'approval.requested': 'Approval asked for',
  'swarm.status_changed': 'Swarm started, paused or stopped',
  'swarm.message': 'Swarm chat message',
  'pr.opened': 'Pull request opened',
  'pr.merged': 'Pull request merged',
};

function deliveryLine(d: WebhookDelivery): string {
  const when = new Date(d.createdAt).toLocaleString();
  const tries = `${d.attempts} ${d.attempts === 1 ? 'try' : 'tries'}`;
  if (d.status === 'delivered') return `${when} · delivered (${d.lastCode}) · ${tries}`;
  const why = d.lastError ?? 'not sent yet';
  if (d.status === 'failed') return `${when} · gave up · ${tries} · ${why}`;
  const next = d.nextAttemptAt ? ` · next ${new Date(d.nextAttemptAt).toLocaleTimeString()}` : '';
  return `${when} · ${d.attempts ? why : 'sending'} · ${tries}${next}`;
}

function WebhookList({ base }: { base: string }) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WorkspaceEventType[]>([]);
  const [made, setMade] = useState<{ url: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () =>
    loadWebhooks(base)
      .then(setHooks)
      .catch((e: unknown) => setError(errorText(e)));
  const showDeliveries = (hookId: string) =>
    Promise.all([loadDeliveries(base, hookId), reload()])
      .then(([d]) => {
        setDeliveries(d);
        setOpen(hookId);
      })
      .catch((e: unknown) => setError(errorText(e)));
  useEffect(() => {
    void reload();
  }, [base]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await createWebhook(base, url.trim(), events);
      setMade({ url: out.webhook.url, secret: out.secret });
      setCopied(false);
      setUrl('');
      setEvents([]);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const ping = async (hookId: string) => {
    setError(null);
    try {
      await pingWebhook(base, hookId);
      // The ping goes out right away; show how it went.
      await new Promise((r) => setTimeout(r, 1200));
      await showDeliveries(hookId);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const remove = async (hookId: string) => {
    setConfirm(null);
    try {
      await deleteWebhook(base, hookId);
      if (open === hookId) setOpen(null);
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <>
      {made && (
        <div className="plugin-panel">
          <strong>Copy the signing secret now. Kovan won&apos;t show it again.</strong>
          <div className="api-key-token">
            <code className="mono">{made.secret}</code>
            <button
              className="btn btn-sm"
              onClick={() =>
                void navigator.clipboard.writeText(made.secret).then(() => setCopied(true))
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn btn-sm" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
          <span className="small muted">
            Check each request: <span className="mono">X-Kovan-Signature</span> is{' '}
            <span className="mono">sha256=</span> and the HMAC-SHA256 of the body with this secret.
          </span>
        </div>
      )}
      {hooks?.length === 0 && <p className="setting-desc">No webhooks yet.</p>}
      {hooks?.map((h) => (
        <Fragment key={h.id}>
          <Row
            title={h.url}
            desc={`${h.events.length ? h.events.join(', ') : 'all events'} · ${
              h.last
                ? h.last.status === 'delivered'
                  ? `last delivered ${new Date(h.last.at).toLocaleString()}`
                  : h.last.status === 'failed'
                    ? 'last delivery failed'
                    : 'last delivery is being retried'
                : 'nothing sent yet'
            }`}
          >
            <button className="btn btn-sm" onClick={() => void ping(h.id)}>
              Send test
            </button>
            <button
              className="btn btn-sm"
              onClick={() => (open === h.id ? setOpen(null) : void showDeliveries(h.id))}
            >
              {open === h.id ? 'Hide deliveries' : 'Deliveries'}
            </button>
            {confirm === h.id ? (
              <>
                <button className="btn btn-sm btn-danger-ghost" onClick={() => void remove(h.id)}>
                  Remove now
                </button>
                <button className="btn btn-sm" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setConfirm(h.id)}>
                Remove
              </button>
            )}
          </Row>
          {open === h.id && (
            <div className="plugin-panel webhook-deliveries">
              {deliveries.length === 0 && <span className="small muted">Nothing sent yet.</span>}
              {deliveries.map((d) => (
                <div key={d.id} className={`webhook-delivery ${d.status}`}>
                  <span className="mono">{d.type}</span>
                  <span className="small muted">{deliveryLine(d)}</span>
                </div>
              ))}
            </div>
          )}
        </Fragment>
      ))}
      <Row title="New webhook" desc="Leave every box empty to get all events.">
        <div className="api-key-form">
          <input
            className="input"
            placeholder="https://example.com/kovan-hook"
            maxLength={500}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {WORKSPACE_EVENTS.map((t) => (
            <label key={t} className="issue-similar-row">
              <input
                type="checkbox"
                checked={events.includes(t)}
                onChange={(e) =>
                  setEvents((now) => (e.target.checked ? [...now, t] : now.filter((x) => x !== t)))
                }
              />
              <span>
                <span className="mono">{t}</span> · {EVENT_TEXT[t]}
              </span>
            </label>
          ))}
          <button
            className="btn btn-sm btn-primary"
            disabled={busy || !url.trim()}
            onClick={() => void add()}
          >
            {busy ? 'Adding…' : 'Add webhook'}
          </button>
        </div>
      </Row>
      {error && <p className="setting-desc danger-text">{error}</p>}
    </>
  );
}

function ApiKeyList({ base }: { base: string }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['read']);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () =>
    loadApiKeys(base)
      .then(setKeys)
      .catch((e: unknown) => setError(errorText(e)));
  useEffect(() => {
    void reload();
  }, [base]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await createApiKey(base, name.trim(), scopes);
      setMade({ name: out.key.name, token: out.token });
      setCopied(false);
      setName('');
      setScopes(['read']);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setConfirm(null);
    try {
      await revokeApiKey(base, id);
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <>
      {made && (
        <div className="plugin-panel">
          <strong>Copy the key for {made.name} now. Kovan won&apos;t show it again.</strong>
          <div className="api-key-token">
            <code className="mono">{made.token}</code>
            <button
              className="btn btn-sm"
              onClick={() =>
                void navigator.clipboard.writeText(made.token).then(() => setCopied(true))
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn btn-sm" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
          <span className="small muted">
            Send it as <span className="mono">Authorization: Bearer kv_live_…</span>
          </span>
        </div>
      )}
      {keys?.length === 0 && <p className="setting-desc">No keys yet.</p>}
      {keys?.map((k) => (
        <Row
          key={k.id}
          title={k.name}
          desc={`${k.prefix} · ${k.scopes.join(', ')} · made by ${k.createdByName ?? 'someone who left'} · ${lastUsed(k.lastUsedAt)}`}
        >
          {confirm === k.id ? (
            <>
              <button className="btn btn-sm btn-danger-ghost" onClick={() => void revoke(k.id)}>
                Revoke now
              </button>
              <button className="btn btn-sm" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => setConfirm(k.id)}>
              Revoke
            </button>
          )}
        </Row>
      ))}
      <Row title="New key" desc="Name it after the system that will use it.">
        <div className="api-key-form">
          <input
            className="input"
            placeholder="FounderOS"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {(Object.keys(SCOPE_TEXT) as ApiKeyScope[]).map((s) => (
            <label key={s} className="issue-similar-row" title={SCOPE_TEXT[s]}>
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) =>
                  setScopes((now) => (e.target.checked ? [...now, s] : now.filter((x) => x !== s)))
                }
              />
              <span>
                <span className="mono">{s}</span> · {SCOPE_TEXT[s]}
              </span>
            </label>
          ))}
          <button
            className="btn btn-sm btn-primary"
            disabled={busy || !name.trim() || scopes.length === 0}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </Row>
      {error && <p className="setting-desc danger-text">{error}</p>}
    </>
  );
}

function Workspaces() {
  const recent = useStore((s) => s.recent);
  const home = useStore((s) => s.appInfo?.homeDir);
  const team = useStore((s) => s.teamWorkspaces);
  return (
    <>
      {team.map((w) => (
        <Group key={w.id} title={w.name}>
          <WorkspaceDetails workspace={w} />
          <GitSyncRow workspace={w} />
          <ModeRow workspace={w} />
          <AgentLimitRow workspace={w} />
        </Group>
      ))}
      <IntegrationsGroup owned={team.filter((w) => w.role === 'owner')} />
      <Group title="Workspaces on this machine">
        {recent.length === 0 && (
          <p className="setting-desc">No workspaces yet. Add one from the sidebar.</p>
        )}
        {recent.map((r) => (
          <Row
            key={r.root}
            title={r.name}
            desc={home && r.root.startsWith(home) ? `~${r.root.slice(home.length)}` : r.root}
          >
            <button className="btn btn-sm" onClick={() => void forgetRecent(r.root)}>
              <X size={13} /> Remove
            </button>
          </Row>
        ))}
      </Group>
    </>
  );
}

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const section = useStore((s) => s.settingsSection);
  const query = useStore((s) => s.settingsQuery);
  const lastView = useStore((s) => s.lastAppView);
  const done = doneCount(settings.onboarding);
  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]!;

  // While searching, every section is shown and rows filter themselves.
  const shown = query ? SECTIONS : [current];

  return (
    <div className="settings-layout">
      <aside className="settings-nav">
        <button className="nav-item" onClick={() => showView(lastView)}>
          <ArrowLeft size={15} className="nav-icon" /> Back to app
        </button>
        <label className="settings-search">
          <Search size={13} />
          <input
            placeholder="Search settings"
            value={query}
            onChange={(e) => setState({ settingsQuery: e.target.value })}
          />
        </label>
        <button className="nav-item" onClick={() => setState({ gettingStartedOpen: true })}>
          <ProgressRing value={done} total={STEPS.length} />
          <span>Onboarding checklist</span>
          <span className="nav-meta">
            {done}/{STEPS.length}
          </span>
        </button>
        {(['Personal', 'Kovan'] as const).map((group) => (
          <div key={group}>
            <div className="nav-heading" style={{ paddingLeft: 8 }}>
              {group}
            </div>
            {SECTIONS.filter((x) => x.group === group).map(({ id, label, icon: SectionIcon }) => (
              <button
                key={id}
                className={`nav-item ${!query && id === section ? 'active' : ''}`}
                onClick={() => setState({ settingsSection: id, settingsQuery: '' })}
              >
                <SectionIcon size={15} className="nav-icon" />
                {label}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <main className="settings-main">
        <div className="settings-inner">
          {!query && (
            <h1 className="settings-title">
              <current.icon size={17} /> {current.label}
            </h1>
          )}
          {shown.map(({ id }) => (
            <div key={id}>
              {id === 'general' && <General s={settings} />}
              {id === 'general' && <Updates s={settings} />}
              {id === 'editor' && <Editor s={settings} />}
              {id === 'terminal' && <Terminal s={settings} />}
              {id === 'keyboard' && <KeyboardSection s={settings} />}
              {id === 'providers' && <Providers s={settings} />}
              {id === 'models' && <ModelsPage />}
              {id === 'arena' && <ArenaView />}
              {id === 'agents' && <AgentsSection />}
              {id === 'account' && <Account />}
              {id === 'billing' && <Billing />}
              {id === 'organization' && <Organization />}
              {id === 'workspaces' && <Workspaces />}
              {id === 'privacy' && <Privacy />}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
