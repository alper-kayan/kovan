import {
  effectiveMode,
  type AccountDeletionPlan,
  type ApiKey,
  type ApiKeyScope,
  type Machine,
  type Webhook,
  type WebhookDelivery,
  type WorkspaceEventType,
  type Invite,
  type Member,
  type Org,
  type PluginRecommendation,
  type Role,
  type ServerMessage,
  type User,
  type Workspace,
  type WorkspaceMode,
} from '@kovan/shared';
import { useMemo } from 'react';
import type { HttpMethod } from '../../../shared/api';
import {
  activeTeamWorkspace,
  getState,
  notify,
  reportError,
  setState,
  showView,
  toast,
  useStore,
  writeLocal,
} from '../store';
import { api } from './api';
import { completeFromAccount, completeStep } from './onboarding';
import { openWorkspace } from './workspace';

function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  return (
    body === undefined
      ? api.invoke('brain:request', method, path)
      : api.invoke('brain:request', method, path, body)
  ) as Promise<T>;
}

// ---------- account ----------

export async function initTeam(): Promise<void> {
  const status = await api.invoke('brain:status');
  setState({
    signedIn: status.signedIn,
    user: status.user,
    serverUrl: status.serverUrl,
    connection: status.connection,
  });
  api.on('brain:user', (user) => {
    setState({ user, signedIn: user !== null || getState().signedIn });
    if (user) void syncOnboarding(user);
    else setState({ signedIn: false, teamWorkspaces: [], orgs: [], presence: {}, members: {} });
  });
  api.on('brain:message', handleMessage);
  // Whatever was missed while offline (workspaces, roles) is read again on reconnect.
  api.on('connection:state', (state) => {
    if (state === 'online' && getState().signedIn) void loadTeam();
  });
  installErrorReporting();
  if (status.signedIn) await loadTeam();
}

export async function signIn(intent: 'login' | 'link' = 'login'): Promise<boolean> {
  setState({ loginPending: intent });
  try {
    const user = await api.invoke('brain:login', intent);
    setState({ user, signedIn: true });
    await loadTeam();
    notify({
      kind: 'info',
      title: intent === 'link' ? 'Account connected' : `Signed in as ${user.name}`,
      message:
        intent === 'link' && user.githubLogin
          ? `GitHub @${user.githubLogin} is connected.`
          : 'Your workspaces and teammates are synced.',
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/cancelled/i.test(message)) reportError(error);
    return false;
  } finally {
    setState({ loginPending: null });
  }
}

export const cancelSignIn = () => void api.invoke('brain:cancelLogin');

/** What deleting the account would do (the server works it out). */
export function loadDeletionPlan(): Promise<AccountDeletionPlan> {
  return api
    .invoke('brain:request', 'GET', '/api/me/deletion')
    .then((r) => (r as { plan: AccountDeletionPlan }).plan);
}

/** Deletes the account for good, then signs this app out. */
export async function deleteAccount(): Promise<void> {
  await api.invoke('brain:request', 'POST', '/api/me/delete', { confirm: true });
  await signOut();
  toast('Your account was deleted.');
}

export async function signOut(): Promise<void> {
  await api.invoke('brain:logout');
  setState({
    signedIn: false,
    user: null,
    teamWorkspaces: [],
    orgs: [],
    presence: {},
    members: {},
  });
}

/** Loads orgs, shared workspaces and this machine's bindings. */
export async function loadTeam(): Promise<void> {
  try {
    const [{ user, orgs }, { workspaces }, bindings] = await Promise.all([
      request<{ user: User; orgs: Org[] }>('GET', '/api/me'),
      request<{ workspaces: Workspace[] }>('GET', '/api/workspaces'),
      api.invoke('bindings:get'),
    ]);
    setState({ user, orgs, teamWorkspaces: workspaces, bindings });
    for (const w of workspaces) void api.invoke('brain:subscribe', w.id);
    await syncOnboarding(user);
    updatePresence();
  } catch (error) {
    // Offline is fine: local work continues and we retry on the next change.
    if (!(error instanceof Error && /reach/.test(error.message))) reportError(error);
  }
}

async function syncOnboarding(user: User): Promise<void> {
  completeFromAccount(user);
  const local = getState().settings.onboarding;
  const merged = { ...user.onboarding, ...local };
  if (Object.keys(merged).length !== Object.keys(local).length) {
    setState((s) => ({ settings: { ...s.settings, onboarding: merged } }));
    await api.invoke('settings:update', { onboarding: merged });
  }
  const missing = Object.keys(local).some((k) => local[k] && !user.onboarding[k]);
  if (missing) await request('PATCH', '/api/me', { onboarding: local }).catch(() => undefined);
}

/** Records an onboarding step on the account too, when signed in. */
export function pushOnboarding(onboarding: Record<string, boolean>): void {
  if (getState().signedIn) void request('PATCH', '/api/me', { onboarding }).catch(() => undefined);
}

export async function updateAccount(patch: {
  errorReports?: boolean;
  name?: string;
  photo?: 'kovan' | 'github';
}): Promise<void> {
  try {
    const { user } = await request<{ user: User }>('PATCH', '/api/me', patch);
    setState({ user });
  } catch (error) {
    reportError(error);
  }
}

/** Sends the verification email; returns false when it couldn't. */
export async function sendVerification(): Promise<boolean> {
  try {
    const { retryAfter } = await request<{ retryAfter: number }>(
      'POST',
      '/api/me/verification-email',
    );
    setState({ verifyResendAt: Date.now() + retryAfter * 1000 });
    return true;
  } catch (error) {
    const wait = /Wait (\d+)s/.exec(error instanceof Error ? error.message : '');
    if (wait) setState({ verifyResendAt: Date.now() + Number(wait[1]) * 1000 });
    else reportError(error);
    return false;
  }
}

export async function refreshUser(): Promise<User | null> {
  try {
    const { user } = await request<{ user: User }>('GET', '/api/me');
    setState({ user });
    return user;
  } catch (error) {
    reportError(error);
    return null;
  }
}

// ---------- realtime ----------

function handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'presence':
      setState((s) => ({ presence: { ...s.presence, [message.workspaceId]: message.online } }));
      return;
    case 'membership':
      if (message.role === null) {
        const lost = getState().teamWorkspaces.find((w) => w.id === message.workspaceId);
        if (lost)
          notify({
            kind: 'info',
            title: 'Removed from a workspace',
            message: `You no longer have access to ${lost.name}.`,
          });
      }
      void loadTeam();
      void reloadMembers(message.workspaceId);
      return;
    case 'workspace': {
      const before = getState().teamWorkspaces.find((w) => w.id === message.workspace.id);
      // The Git sync switch is shared: a teammate flipping it stops or starts it here too.
      if (before && before.autoGitSync !== message.workspace.autoGitSync)
        void api
          .invoke('sync:setEnabled', message.workspace.id, message.workspace.autoGitSync)
          .catch(() => {});
      setState((s) => ({
        teamWorkspaces: s.teamWorkspaces.some((w) => w.id === message.workspace.id)
          ? s.teamWorkspaces.map((w) => (w.id === message.workspace.id ? message.workspace : w))
          : [...s.teamWorkspaces, message.workspace],
      }));
      return;
    }
    case 'members':
      void reloadMembers(message.workspaceId);
      return;
    case 'user':
      setState({ user: message.user });
      completeFromAccount(message.user);
      return;
    default:
      return;
  }
}

/** Tells teammates which workspace this machine has open, and whether the window is in use. */
export function updatePresence(): void {
  const s = getState();
  if (!s.signedIn) return;
  const active = s.view === 'workspace' ? activeTeamWorkspace(s) : null;
  void api.invoke('brain:presence', active?.id ?? null, document.hasFocus() ? 'active' : 'idle');
}

function installErrorReporting(): void {
  window.addEventListener('error', (event) => {
    void api.invoke(
      'brain:reportError',
      String(event.message),
      event.error instanceof Error ? (event.error.stack ?? null) : null,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    void api.invoke('brain:reportError', error.message, error.stack ?? null);
  });
  window.addEventListener('focus', updatePresence);
  window.addEventListener('blur', updatePresence);
}

// ---------- organizations ----------

/** The organization the sidebar and Sessions show: the one picked, else the person's own. */
export function currentOrg(s: { orgs: Org[]; currentOrgId: string | null }): Org | null {
  return (
    s.orgs.find((o) => o.id === s.currentOrgId) ??
    s.orgs.find((o) => o.role === 'owner') ??
    s.orgs[0] ??
    null
  );
}

/** The team workspaces of the current organization (all of them for someone in just one). */
export function useOrgWorkspaces(): Workspace[] {
  const team = useStore((s) => s.teamWorkspaces);
  const orgs = useStore((s) => s.orgs);
  const orgId = useStore((s) => currentOrg(s)?.id ?? null);
  return useMemo(
    () => (orgs.length > 1 ? team.filter((w) => w.orgId === orgId) : team),
    [team, orgs.length, orgId],
  );
}

export function switchOrg(orgId: string): void {
  writeLocal('kovan.org', orgId);
  setState({ currentOrgId: orgId, boardWorkspace: null });
}

/** A new organization for a team: the person owns it, and it becomes the current one. */
export async function createOrg(name: string): Promise<Org | null> {
  try {
    const { org } = await request<{ org: Org }>('POST', '/api/orgs', { name });
    setState((s) => ({ orgs: [...s.orgs, org] }));
    switchOrg(org.id);
    toast(`${org.name} created. Workspaces you add now go there.`);
    return org;
  } catch (error) {
    reportError(error);
    return null;
  }
}

export async function renameOrg(orgId: string, name: string): Promise<boolean> {
  try {
    await request('PATCH', `/api/orgs/${orgId}`, { name });
    setState((s) => ({ orgs: s.orgs.map((o) => (o.id === orgId ? { ...o, name } : o)) }));
    toast('Organization renamed');
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

// ---------- workspaces ----------

/** Adds a repository: shared on the server when signed in, otherwise opened locally. */
export async function addWorkspace(): Promise<void> {
  try {
    const folder = await api.invoke('repo:choose');
    if (!folder) return;
    const info = await api.invoke('repo:inspect', folder);
    const { signedIn } = getState();
    if (!signedIn) {
      await openWorkspace(info.root);
      return;
    }
    const org = currentOrg(getState());
    if (!org) throw new Error('Your account has no organization yet');
    const { workspace, existing } = await request<{ workspace: Workspace; existing: boolean }>(
      'POST',
      '/api/workspaces',
      {
        orgId: org.id,
        name: info.name,
        repoUrl: info.remoteUrl,
        defaultBranch: info.branch ?? 'main',
      },
    );
    setState({ bindings: await api.invoke('bindings:set', workspace.id, info.root) });
    void api.invoke('brain:subscribe', workspace.id);
    await loadTeam();
    if (existing)
      notify({
        kind: 'info',
        title: 'Already shared',
        message: `${workspace.name} was already a workspace; this folder is now linked to it.`,
      });
    await openWorkspace(info.root);
  } catch (error) {
    reportError(error);
  }
}

/** Opens a shared workspace from its local folder, or asks where that folder is. */
export async function openTeamWorkspace(workspace: Workspace): Promise<void> {
  const path = getState().bindings[workspace.id];
  if (path) {
    await openWorkspace(path);
    updatePresence();
    return;
  }
  setState({ setupWorkspaceId: workspace.id });
  showView('setup');
}

async function bindAndOpen(workspace: Workspace, root: string): Promise<void> {
  setState({
    bindings: await api.invoke('bindings:set', workspace.id, root),
    setupWorkspaceId: null,
  });
  await openWorkspace(root);
  updatePresence();
}

/** Links an existing clone, checking that its origin is the workspace's repository. */
export async function chooseLocalClone(workspace: Workspace): Promise<void> {
  try {
    const folder = await api.invoke('repo:choose');
    if (!folder) return;
    const info = await api.invoke('repo:inspect', folder);
    if (!info.isRepo) throw new Error(`${info.name} is not a git repository`);
    if (workspace.repoUrl && info.remoteUrl !== workspace.repoUrl) {
      throw new Error(
        `That clone points at ${info.remoteUrl ?? 'no remote'}, but ${workspace.name} is ${workspace.repoUrl}.`,
      );
    }
    await bindAndOpen(workspace, info.root);
  } catch (error) {
    reportError(error);
  }
}

export async function cloneWorkspace(workspace: Workspace): Promise<void> {
  if (!workspace.repoUrl) return;
  try {
    notify({ kind: 'info', message: `Cloning ${workspace.repoUrl}…` });
    const dest = await api.invoke('repo:clone', `https://${workspace.repoUrl}.git`, workspace.name);
    if (dest) await bindAndOpen(workspace, dest);
  } catch (error) {
    reportError(error);
  }
}

// ---------- people ----------

export async function reloadMembers(workspaceId: string): Promise<void> {
  if (!getState().teamWorkspaces.some((w) => w.id === workspaceId)) return;
  try {
    const data = await request<{ members: Member[]; invites: Invite[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/members`,
    );
    setState((s) => ({ members: { ...s.members, [workspaceId]: data } }));
  } catch {
    setState((s) => {
      const members = { ...s.members };
      delete members[workspaceId];
      return { members };
    });
  }
}

export async function loadAllMembers(): Promise<void> {
  await Promise.all(getState().teamWorkspaces.map((w) => reloadMembers(w.id)));
}

export async function invite(
  workspaceId: string,
  who: { githubLogin?: string; email?: string },
  role: Role,
): Promise<boolean> {
  try {
    const result = await request<{ member?: Member; invite?: Invite }>(
      'POST',
      `/api/workspaces/${workspaceId}/invites`,
      { ...who, role },
    );
    completeStep('invite');
    await reloadMembers(workspaceId);
    notify({
      kind: 'info',
      title: result.member ? `${result.member.name} joined` : 'Invite sent',
      message: result.member
        ? 'They already had an account, so they were added straight away.'
        : `They'll join when they sign in${who.githubLogin ? ` with GitHub @${who.githubLogin}` : ''}.`,
    });
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export async function changeRole(workspaceId: string, userId: string, role: Role): Promise<void> {
  try {
    await request('PATCH', `/api/workspaces/${workspaceId}/members/${userId}`, { role });
    await reloadMembers(workspaceId);
  } catch (error) {
    reportError(error);
  }
}

export async function removeMember(workspaceId: string, member: Member): Promise<void> {
  const self = member.userId === getState().user?.id;
  if (
    !window.confirm(self ? 'Leave this workspace?' : `Remove ${member.name} from this workspace?`)
  )
    return;
  try {
    await request('DELETE', `/api/workspaces/${workspaceId}/members/${member.userId}`);
    if (self) await loadTeam();
    else await reloadMembers(workspaceId);
  } catch (error) {
    reportError(error);
  }
}

export async function revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
  try {
    await request('DELETE', `/api/workspaces/${workspaceId}/invites/${inviteId}`);
    await reloadMembers(workspaceId);
  } catch (error) {
    reportError(error);
  }
}

/**
 * What a workspace acts as now: Solo or Team. Adaptive follows who is in it; until its members
 * are loaded it counts as Team, so nothing team-related is hidden by mistake.
 */
export function workspaceMode(workspace: Workspace | undefined): 'solo' | 'team' {
  if (!workspace) return 'team';
  const members = getState().members[workspace.id]?.members;
  if (workspace.mode === 'adaptive' && !members) return 'team';
  return effectiveMode(workspace.mode, members?.filter((m) => m.kind === 'human').length ?? 1);
}

/** Owners choose how a workspace works. */
export async function setWorkspaceMode(workspaceId: string, mode: WorkspaceMode): Promise<void> {
  try {
    await request<{ workspace: Workspace }>('PATCH', `/api/workspaces/${workspaceId}`, { mode });
    toast(`Workspace set to ${mode[0]!.toUpperCase()}${mode.slice(1)}`);
  } catch (error) {
    reportError(error);
  }
}

/** An owner renames a workspace, or changes its color or base branch. */
export async function updateWorkspace(
  workspaceId: string,
  patch: Partial<Pick<Workspace, 'name' | 'color' | 'defaultBranch'>>,
): Promise<boolean> {
  try {
    await request<{ workspace: Workspace }>('PATCH', `/api/workspaces/${workspaceId}`, patch);
    toast('Workspace saved');
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

/** Automatic Git sync, for everyone in the workspace (anyone who works in it may flip it). */
export async function setWorkspaceGitSync(workspaceId: string, on: boolean): Promise<void> {
  try {
    await request<{ workspace: Workspace }>('PUT', `/api/workspaces/${workspaceId}/git-sync`, {
      on,
    });
    toast(
      on
        ? 'Git sync is on for everyone in this workspace.'
        : 'Git sync is off for everyone in this workspace: nothing goes out or comes in.',
    );
  } catch (error) {
    reportError(error);
  }
}

// ---------- integrations: API keys, machines, webhooks ----------
// Each belongs to one workspace or to a whole organization; `base` says which:
// `/api/workspaces/<id>` or `/api/orgs/<id>`.

export const integrationsOf = (scope: { workspaceId: string } | { orgId: string }): string =>
  'orgId' in scope ? `/api/orgs/${scope.orgId}` : `/api/workspaces/${scope.workspaceId}`;

export async function loadApiKeys(base: string): Promise<ApiKey[]> {
  return (await request<{ keys: ApiKey[] }>('GET', `${base}/api-keys`)).keys;
}

/** Makes a key; the token comes back this once. */
export function createApiKey(
  base: string,
  name: string,
  scopes: ApiKeyScope[],
): Promise<{ key: ApiKey; token: string }> {
  return request('POST', `${base}/api-keys`, { name, scopes });
}

export async function revokeApiKey(base: string, keyId: string): Promise<void> {
  await request('DELETE', `${base}/api-keys/${keyId}`);
}

/** Whether machines can fetch and push through Kovan (the workspace's own git access). */
export async function loadGitAccess(
  workspaceId: string,
): Promise<{ configured: boolean; setAt: string | null; relayUrl: string }> {
  return (
    await request<{
      access: { configured: boolean; setAt: string | null; relayUrl: string };
    }>('GET', `/api/workspaces/${workspaceId}/git-access`)
  ).access;
}

/** Sets (checked against the repository first) or clears the workspace's git access token. */
export async function setGitAccess(workspaceId: string, token: string | null): Promise<void> {
  await request('PUT', `/api/workspaces/${workspaceId}/git-access`, { token });
}

/** Machines that run agents (agentd). */
export async function loadMachines(base: string): Promise<Machine[]> {
  return (await request<{ machines: Machine[] }>('GET', `${base}/machines`)).machines;
}

export async function removeMachine(base: string, machineId: string): Promise<void> {
  await request('DELETE', `${base}/machines/${machineId}`);
}

export async function loadWebhooks(base: string): Promise<Webhook[]> {
  return (await request<{ webhooks: Webhook[] }>('GET', `${base}/webhooks`)).webhooks;
}

/** Adds a webhook; its signing secret comes back this once. */
export function createWebhook(
  base: string,
  url: string,
  events: WorkspaceEventType[],
): Promise<{ webhook: Webhook; secret: string }> {
  return request('POST', `${base}/webhooks`, { url, events });
}

export async function deleteWebhook(base: string, hookId: string): Promise<void> {
  await request('DELETE', `${base}/webhooks/${hookId}`);
}

export async function pingWebhook(base: string, hookId: string): Promise<void> {
  await request('POST', `${base}/webhooks/${hookId}/ping`);
}

export async function loadDeliveries(base: string, hookId: string): Promise<WebhookDelivery[]> {
  return (
    await request<{ deliveries: WebhookDelivery[] }>('GET', `${base}/webhooks/${hookId}/deliveries`)
  ).deliveries;
}

/** The plugins a workspace's owner suggests to its members (the whole list). */
export async function setRecommendedPlugins(
  workspaceId: string,
  recommendedPlugins: PluginRecommendation[],
): Promise<void> {
  await request<{ workspace: Workspace }>('PATCH', `/api/workspaces/${workspaceId}`, {
    recommendedPlugins,
  });
}
